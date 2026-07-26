/**
 * Provider teardown (#262): remove a DB provider row AND the pipeline sync-state it
 * owns, atomically.
 *
 * Why this is not just `deleteProvider`: the pipeline's cursors are keyed by
 * `type:container`, not by provider id (`git_last_sync:bitbucket:acme`, plus the
 * earliest-synced watermark and the stall counter). Deleting only the `git_providers`
 * row therefore leaves those rows behind, and a provider later re-added for the SAME
 * container silently inherits them: `runSync` resolves a stored cursor, so the
 * first-sync history window the admin picked is discarded and only the delta since the
 * old cursor is imported.
 *
 * ⚠️ DOUBLE-COUNT HAZARD — READ BEFORE CHANGING THIS FILE.
 * Purging the forward cursor is NOT free, and the issue's premise that "the projection
 * guard and idempotent merges handle re-imported overlap" is only half true.
 * `mergeDailyAcrossRuns` (`raw-author-daily.ts`) ADDS `commits`, `lines_added`,
 * `lines_removed`, `files_changed` and `commit_burst_count` against the stored row —
 * its own docstring names the licensing invariant: "commit windows ARE disjoint (each
 * run fetches commits on a committer-date window that advances)". The forward cursor is
 * the ONLY thing that enforces that disjointness. `raw_author_daily` is keyed
 * `(provider TYPE, raw_author_key, date)`, so the rows a deleted provider wrote survive
 * the delete and are not even attributable to its container — they cannot be retracted
 * here. Consequently a container that has completed a sync and then gets deleted,
 * re-added, and re-synced over the same window has every commit-derived metric in that
 * window permanently doubled, and `git_snapshots` is a pure projection of those rows so
 * the inflation propagates to every aggregate downstream. Only `prs_opened`,
 * `prs_merged` and `review_comments_given` are genuinely idempotent (`max`).
 * See the escalation on PR #263 — this is a known, unresolved conflict between
 * acceptance criteria 1/3 and data integrity, NOT an oversight.
 *
 * Why it lives in its own module rather than in `store.ts`: the key formats belong to
 * `sync.ts`, and `sync.ts` already imports the store (via `resolve.ts`) — so the store
 * cannot import them back without a cycle. This module sits above both.
 */
import type Database from 'better-sqlite3';
import {deleteProvider, getProvider, listProviders} from './store.js';
import {providerContainer} from './config.js';
import type {GitProviderConfig} from './types.js';
import {deleteProviderSyncState, syncStateKey} from '../sync.js';

/** Why a delete left the container's sync-state in place. */
export type SyncStateRetainedReason = 'claimed-by-another-provider';

/** What {@link deleteProviderAndSyncState} did. */
export interface ProviderDeleteResult {
    /** True when a `git_providers` row was actually removed (false ⇒ unknown id). */
    deleted: boolean;
    /** How many `sync_state` rows the purge actually removed (0 when it was skipped). */
    syncStateRowsCleared: number;
    /**
     * Null when the container's sync-state was purged. Otherwise why it was kept —
     * currently only "another provider still resolves to the same `type:container`",
     * whose cursors are live state that this delete must not touch.
     */
    syncStateRetainedReason: SyncStateRetainedReason | null;
}

/**
 * Delete a provider by id and, when nothing else claims its container, that
 * container's sync-state rows — both in ONE transaction, so the row and its cursors can
 * never end up half-removed.
 *
 * `configProviders` is the resolved set of read-only config-file providers; it is
 * REQUIRED rather than defaulted because "no config providers" is the permissive answer
 * to a safety question, and a caller that forgot the argument would silently strip the
 * cursors of a container a config-file provider is still syncing. A registration with
 * no git config passes `[]` explicitly.
 *
 * Sharing is decided on the resolved sync-state key, which is what the pipeline
 * actually reads. A config entry whose container does not resolve to a non-empty string
 * (a malformed YAML block the loose resolver still admits) is SKIPPED from the claim
 * set only after being counted as a claimant — see the guard below — because a
 * half-parsed entry must not be able to unprotect rows by resolving to `undefined`.
 */
export function deleteProviderAndSyncState(
    db: Database.Database,
    id: string,
    configProviders: readonly GitProviderConfig[],
): ProviderDeleteResult {
    return db.transaction((): ProviderDeleteResult => {
        const record = getProvider(db, id);
        if (record === undefined) {
            return {deleted: false, syncStateRowsCleared: 0, syncStateRetainedReason: null};
        }
        // Same transaction as the read above, so the row cannot vanish in between.
        deleteProvider(db, id);

        const orphanedKey = syncStateKey(record.type, record.container);
        // Resolved AFTER the delete, in one query plus the in-memory config list, so the
        // deleted row cannot count as its own claimant. `listProviders` returns rows
        // regardless of `enabled`: a DISABLED sibling still protects the container,
        // deliberately — it can be re-enabled, and its cursor is the record of what it
        // already imported. (The sync resolver filters to `enabled = 1`; that divergence
        // is intentional and conservative.)
        const claimedKeys = new Set<string>(
            listProviders(db).map((row) => syncStateKey(row.type, row.container)),
        );
        let malformedConfigClaim = false;
        for (const config of configProviders) {
            const container = providerContainer(config);
            // A malformed entry resolves to no container. It cannot be matched against
            // the orphaned key, so treat its mere presence as a claim (fail closed)
            // rather than letting it drop silently out of the claim set.
            if (typeof container !== 'string' || container === '') {
                malformedConfigClaim = true;
                continue;
            }
            claimedKeys.add(syncStateKey(config.type, container));
        }
        if (malformedConfigClaim || claimedKeys.has(orphanedKey)) {
            return {
                deleted: true,
                syncStateRowsCleared: 0,
                syncStateRetainedReason: 'claimed-by-another-provider',
            };
        }

        return {
            deleted: true,
            syncStateRowsCleared: deleteProviderSyncState(db, record.type, record.container),
            syncStateRetainedReason: null,
        };
    })();
}
