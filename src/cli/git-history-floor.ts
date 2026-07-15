import type Database from 'better-sqlite3';
import {declareEarliestSyncedFloor} from '../connectors/git/sync';
import type {GitProviderType} from '../connectors/git/providers/types.js';

/**
 * `toprope git set-history-floor` — the admin half of migration 040 (#233).
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

// Runtime allowlist for --provider. The compile-time GitProviderType union proves
// nothing here: the value arrives as an arbitrary CLI string, and an unrecognized one
// would otherwise be written into a sync_state key matching no provider — a write that
// "succeeds" while doing nothing.
export const GIT_PROVIDER_TYPES: readonly GitProviderType[] = ['github', 'bitbucket', 'gitlab'];

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
    const container = input.container.trim();
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
    // Each refusal names the correction: these are admin mistakes, not internal errors.
    const reasons: Record<typeof result.reason, string> = {
        invalid_floor: `invalid --at value: ${input.at} (expected a UTC ISO instant, e.g. 2025-01-01T00:00:00.000Z)`,
        future_floor: `--at must be in the past: ${input.at} is at or after now`,
        not_legacy: `${providerType}:${container} has no unknown history floor to declare — it already has an exact floor recorded, or it has never synced (check the type/container spelling). Re-run with --force to overwrite a recorded floor.`,
    };
    return {ok: false, message: reasons[result.reason]};
}
