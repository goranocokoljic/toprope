import type Database from 'better-sqlite3';
import {declareEarliestSyncedFloor} from '../connectors/git/sync';
import type {GitProviderType} from '../connectors/git/providers/types.js';

/**
 * `toprope git set-history-floor` — the admin half of migration 040 (#233).
 *
 * A provider first synced before #229 has a forward cursor but no record of how far
 * back that first sync actually reached, and the floor is unrecoverable from stored
 * data (see migration 040). Rather than guess — the old guess was systematically too
 * recent, which silently double-counts on the first backfill — "sync older history"
 * refuses such a provider outright. This command is how an admin who knows the real
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
}

export type SetHistoryFloorResult =
    | {ok: true; message: string}
    | {ok: false; message: string};

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
    // A blank container would build a well-formed key for a provider that cannot
    // exist — reject it here rather than write a row that hides the typo.
    if (input.container.trim() === '') {
        return {ok: false, message: '--container must not be empty'};
    }

    const result = declareEarliestSyncedFloor(db, providerType, input.container, input.at, now);
    if (result.ok) {
        return {
            ok: true,
            message: `${providerType}:${input.container} — history floor set to ${input.at}; "sync older history" can now extend below it`,
        };
    }
    // Each refusal names the correction: these are admin mistakes, not internal errors.
    const reasons: Record<typeof result.reason, string> = {
        invalid_floor: `invalid --at value: ${input.at} (expected a UTC ISO instant, e.g. 2025-01-01T00:00:00.000Z)`,
        future_floor: `--at must be in the past: ${input.at} is at or after now`,
        not_legacy: `${providerType}:${input.container} is not a legacy provider — its earliest-synced floor is already recorded exactly (or it has never synced), so there is nothing to declare`,
    };
    return {ok: false, message: reasons[result.reason]};
}
