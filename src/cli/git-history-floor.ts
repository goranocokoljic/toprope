import type Database from 'better-sqlite3';
import {declareEarliestSyncedFloor} from '../connectors/git/sync';
import {normalizeContainer} from '../connectors/git/providers/container';
import {GIT_PROVIDER_TYPES} from '../connectors/git/providers/types';

/**
 * `toprope git set-history-floor` — the admin recovery path for a LEGACY git provider's
 * unknown history floor (#233).
 *
 * A provider first synced before #229 has a forward cursor but no record of how far
 * back that first sync actually reached, and that floor is unrecoverable from stored
 * data — so "sync older history" refuses it rather than guess (the full rationale lives
 * on `getEarliestSyncedWatermark`). This command is how an admin who knows the real
 * floor supplies it, restoring backward extension for that provider.
 *
 * Lives here (not inline in cli.ts) so the trust-boundary parsing and the outcome
 * messaging are unit-testable, matching {@link ../cli/doctor}'s split.
 */

export interface SetHistoryFloorInput {
    provider: string;
    container: string;
    at: string;
    force?: boolean;
}

export interface SetHistoryFloorResult {
    ok: boolean;
    message: string;
}

/**
 * Validate the CLI input and apply it. Returns the outcome rather than printing or
 * exiting, so the caller owns the process contract and tests can assert the messages.
 */
export function setHistoryFloor(
    db: Database.Database,
    input: SetHistoryFloorInput,
    now: string,
): SetHistoryFloorResult {
    // Runtime allowlist: the value arrives as an arbitrary CLI string, so the
    // compile-time union proves nothing at this trust boundary. An unrecognized one
    // would otherwise key a sync_state row matching no provider — a write that
    // "succeeds" while doing nothing.
    const providerType = GIT_PROVIDER_TYPES.find((t) => t === input.provider);
    if (!providerType) {
        return {
            ok: false,
            message: `unknown provider type: ${input.provider} (expected one of: ${GIT_PROVIDER_TYPES.join(', ')})`,
        };
    }
    // Canonicalize before the key is built: '--container " acme "' would otherwise key
    // a provider that cannot exist, and the miss would be reported as a state fact
    // ("floor already recorded") rather than as the typo it is.
    //
    // Through the SHARED `normalizeContainer` (#266), not a local `.trim()`: every
    // `git_last_sync:`/`git_earliest_sync:` key is built from the casefolded container, so a
    // trim-only canonicalization here would read `…:Wireless_Media`, find nothing, and report
    // "has never synced" about a provider that has — the exact false state claim this
    // canonicalization exists to prevent, and a second copy of the container rule (#266 AC9).
    const container = normalizeContainer(input.container);
    if (container === '') {
        return {ok: false, message: '--container must not be empty'};
    }

    const result = declareEarliestSyncedFloor(db, providerType, container, input.at, now, {
        force: input.force,
    });
    if (result.ok) {
        // State what was ARMED, not just what was written. This value silently decides
        // whether the next backfill double-counts, and the admin typed it from memory —
        // echoing the consequence is the only chance they get to catch a wrong year.
        return {
            ok: true,
            message:
                `${providerType}:${container} — history floor set to ${input.at}. ` +
                `"Sync older history" will now import activity strictly OLDER than that instant. ` +
                `If the provider already holds activity from before it, that overlap will be ` +
                `double-counted — re-run with --force to correct the floor BEFORE backfilling.`,
        };
    }
    // Each refusal names ITS OWN correction. Splitting never_synced from not_legacy
    // matters: one message covering both would end in "re-run with --force", which is
    // right for a recorded floor and precisely wrong for a mistyped container — it would
    // walk the admin into inventing a floor for a provider that doesn't exist.
    const reasons: Record<typeof result.reason, string> = {
        invalid_floor: `invalid --at value: ${input.at} (expected a UTC ISO instant, e.g. 2025-01-01T00:00:00.000Z)`,
        future_floor: `--at must be in the past: ${input.at} is at or after now`,
        never_synced: `${providerType}:${container} has never synced — there is no history floor to describe. Check the --provider/--container spelling (it must match a connected provider exactly), then sync it once.`,
        not_legacy: `${providerType}:${container} already has an exact history floor recorded, so there is nothing to declare. Re-run with --force ONLY to replace it — overwriting a floor a real sync earned will corrupt the backfill's disjointness.`,
    };
    return {ok: false, message: reasons[result.reason]};
}
