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
 * old cursor is imported — while the surviving `git_earliest_sync` watermark keeps
 * CLAIMING the old window is covered, which makes the gap unreachable by both forward
 * sync (never looks below the cursor) and "sync older history" (only fetches below the
 * watermark).
 *
 * Why it lives in its own module rather than in `store.ts`: the key formats belong to
 * `sync.ts`, and `sync.ts` already imports the store (via `resolve.ts`) — so the store
 * cannot import them back without a cycle. This module sits above both.
 *
 * NOT in scope (issue decision): the imported data itself (`raw_author_daily`,
 * `git_snapshots`, `pr_records`) is left untouched — snapshots are append-only by
 * project constraint, and clearing the cursors alone is what makes re-adding safe,
 * because the projection guard and the idempotent merges absorb re-imported overlap.
 */
import type Database from 'better-sqlite3';
import {deleteProvider, getProvider, listProviders} from './store.js';
import {providerContainer} from './config.js';
import type {GitProviderConfig} from './types.js';
import {deleteProviderSyncState, syncStateKey} from '../sync.js';

/** What {@link deleteProviderAndSyncState} did. */
export interface ProviderDeleteResult {
    /** True when a `git_providers` row was actually removed (false ⇒ unknown id). */
    deleted: boolean;
    /**
     * True when the container's sync-state rows were purged too. False when the row
     * was deleted but another provider still resolves to the same `type:container`
     * (its cursors must survive), and false when nothing was deleted at all.
     */
    syncStateCleared: boolean;
}

/**
 * Delete a provider by id and, when nothing else claims its container, that
 * container's sync-state rows — both in ONE transaction, so the row and its cursors
 * can never end up half-removed.
 *
 * `configProviders` is the resolved set of read-only config-file providers. They have
 * no DB row but DO drive the same container-keyed cursors, so a config entry for the
 * deleted container is exactly as disqualifying as a surviving DB row; both are
 * checked. Sharing is decided by comparing the resolved sync-state KEY rather than the
 * `(type, container)` fields, because the key is what the pipeline actually reads — so
 * a sibling whose container differs only in case (a distinct key) correctly does not
 * protect rows it never touches.
 */
export function deleteProviderAndSyncState(
    db: Database.Database,
    id: string,
    configProviders: readonly GitProviderConfig[] = [],
): ProviderDeleteResult {
    return db.transaction((): ProviderDeleteResult => {
        const record = getProvider(db, id);
        if (record === undefined) return {deleted: false, syncStateCleared: false};
        // Same transaction as the read above, so the row cannot vanish in between.
        deleteProvider(db, id);

        const orphanedKey = syncStateKey(record.type, record.container);
        // Resolved AFTER the delete, in one query plus the in-memory config list, so
        // the deleted row can't count as its own claimant.
        const claimedKeys = new Set<string>([
            ...listProviders(db).map((row) => syncStateKey(row.type, row.container)),
            ...configProviders.map((config) => syncStateKey(config.type, providerContainer(config))),
        ]);
        if (claimedKeys.has(orphanedKey)) return {deleted: true, syncStateCleared: false};

        deleteProviderSyncState(db, record.type, record.container);
        return {deleted: true, syncStateCleared: true};
    })();
}
