import type Database from 'better-sqlite3';
import {declareEarliestSyncedFloor} from '../connectors/git/sync';
import {parseContainer, parseProviderType} from './git-args';

/**
 * `toprope git set-history-floor` — the admin correction for a git provider's history floor
 * (#233), typically a LEGACY one first synced before #229 began recording it.
 *
 * A provider first synced before #229 has a forward cursor but no record of how far back that
 * first sync actually reached, and that floor is unrecoverable from stored data, so
 * "sync older history" falls back to the default first-sync window for it.
 *
 * WHAT THIS IS FOR SINCE IG1.3 (#319). It is no longer a gate being unlocked: the backfill runs
 * either way, because commits are sha-keyed in `raw_commits` and re-asking a span that is already
 * imported changes no counter. What the floor still decides is where the backfill STOPS asking —
 * it walks only BELOW this value. A floor that is too recent costs API calls; a floor that is too
 * OLD strands the history in between, silently, which is the direction this command can create and
 * the reason it refuses to overwrite an earned floor without --force (see
 * `declareEarliestSyncedFloor`).
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
    // Both terms go through the shared `./git-args` parsers (#286), which own the runtime
    // allowlist and the container canonicalization for every git admin command. An
    // unrecognized provider would otherwise key a sync_state row matching no provider — a
    // write that "succeeds" while doing nothing — and a trim-only container would build
    // `…:Wireless_Media`, find nothing, and report "has never synced" about a provider that
    // has, which is the exact false state claim the canonicalization exists to prevent.
    const provider = parseProviderType(input.provider);
    if (!provider.ok) {
        return {ok: false, message: provider.message};
    }
    const providerType = provider.value;
    const parsedContainer = parseContainer(input.container);
    if (!parsedContainer.ok) {
        return {ok: false, message: parsedContainer.message};
    }
    const container = parsedContainer.value;

    const result = declareEarliestSyncedFloor(db, providerType, container, input.at, now, {
        force: input.force,
    });
    if (result.ok) {
        // State what was ARMED, not just what was written. This value silently decides where
        // the next backfill stops asking, and the admin typed it from memory — echoing the
        // consequence is the only chance they get to catch a wrong year.
        return {
            ok: true,
            message:
                `${providerType}:${container} — history floor set to ${input.at}. ` +
                `"Sync older history" will now import activity strictly OLDER than that instant. ` +
                `If the provider's real history starts LATER than this, the span in between will ` +
                `never be fetched — re-run with --force to correct the floor BEFORE backfilling.`,
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
        not_legacy: `${providerType}:${container} already has an exact history floor recorded, so there is nothing to declare. Re-run with --force ONLY to replace it — a floor a real sync earned describes what that sync actually reached, and replacing it with an older value strands every day in between.`,
    };
    return {ok: false, message: reasons[result.reason]};
}
