/**
 * Provider delete cascade (#264) — removing one provider removes exactly its own data.
 *
 * Since migration 042 the attribution key of every imported git row is
 * `(provider, container)`: the same pair the pipeline's cursors have always been keyed by
 * (`git_last_sync:<type>:<container>`). Data and cursors finally agree on one grain, which
 * is what makes a provider an independent unit — deleting one Bitbucket workspace removes
 * that workspace's commits, PRs and snapshot contribution and leaves every sibling
 * workspace, and every developer, untouched.
 *
 * THE RETRACTION ENGINE ALREADY EXISTS. `projectSnapshots(db, {dates})` (#253) in whole-day
 * rebuild mode rebuilds every cell on those days from the SURVIVING `raw_author_daily`
 * rows, retracts projection-owned cells that lost their raw provenance, and refuses to
 * touch legacy (`is_projected = 0`) cells. This module adds no retraction logic — it
 * composes what is there, in the one order that is correct:
 *
 *   1. collect the affected dates            — BEFORE the delete; afterwards they are unknowable
 *   2. delete the container's raw_commits rows (the source of record, IG1.3 / #319)
 *  2b. delete the container's raw_author_daily rows — the projection of what step 2 just emptied
 *   3. delete the container's pr_records rows
 *  3b. delete the container's commit_diffstats cache rows (#273)
 *   4. projectSnapshots(db, {dates})         — rewrites survivors, retracts orphans
 *   5. purge the container's git_* cursors
 *   6. delete the git_providers row
 *
 * Three details are easy to get wrong and are load-bearing:
 *
 *   - **Dates come from step 1, not step 4.** Once the rows are gone nothing records which
 *     days they covered, so a later scope would silently miss days and leave stale cells.
 *   - **`{dates}` (whole-day) mode, not `{cells}`.** Retraction only happens in whole-day
 *     mode; `cells` mode deliberately declines to widen its scope and so can never REMOVE a
 *     row. Whole-day rebuild also recomputes untouched developers' cells on those days —
 *     wider than strictly necessary, but idempotent and correct, and the only mode that can
 *     retract.
 *   - **Step 2b IS the per-cell recompute, evaluated in closed form** (IG1.3 / #319). Since
 *     the epic, `raw_author_daily` is a projection of `raw_commits` at the
 *     `(provider, container, raw_author_key, date)` grain, so retracting a container means
 *     recomputing every cell it owns and deleting the ones whose commit set is now empty.
 *     Every one of them is: a cell is keyed by `(provider, container)`, `projectRawAuthorDailyCell`
 *     reads `raw_commits` under that same key, and step 2 has just emptied it — as step 3 has
 *     emptied the container's PR side. So the recompute's answer is "delete", uniformly, and one
 *     scoped `DELETE` is that answer rather than a second implementation of it (the
 *     canonical-helper rule: looping the projection here would write a zero-commit row per cell
 *     and then have to delete it anyway).
 *
 * Everything runs in ONE `db.transaction`, so a failure anywhere leaves every table
 * unchanged: no half-retracted container, and never a purged cursor whose data survived
 * (the #262 double-count hazard). `projectSnapshots` opens its own transaction; better-sqlite3
 * promotes a nested one to a SAVEPOINT, so it joins this unit rather than committing early.
 *
 * WHAT THIS DOES *NOT* COVER, and the caller must. `weekly_aggregates` / `monthly_aggregates`
 * / quarterly / yearly / `pr_review_metrics` are a SECOND projection, UPSERTed per period key
 * from the rows retracted here, and the aggregation scheduler only ever recomputes the
 * just-closed period. So every older period keeps the deleted container's totals until
 * something recomputes it — see `aggregation/retract.ts`, which the admin route runs right
 * after this commits. {@link ProviderDeleteResult.earliest_date}/`latest_date` are reported
 * for exactly that purpose.
 *
 * COST. The re-projection is a WHOLE-DAY rebuild (the only mode that can retract), so it
 * recomputes every developer's cell on every day the container touched — bounded by the day
 * set, not by the container's size. A provider with years of history therefore drives a large
 * synchronous transaction; that is accepted for a rare, explicitly-confirmed admin action, and
 * the confirmation dialog states the day count up front so the operator knows the scale.
 *
 * DEVELOPERS, IDENTITIES AND TEAM MEMBERSHIP ARE NEVER TOUCHED. A provider delete removes
 * imported activity, not people: `developers`, their `external_ids` and their team rows are
 * outside every statement below, and a developer left with no remaining activity simply
 * shows no git history.
 */

import type Database from 'better-sqlite3';
import {
    containerRawAuthorIdentities,
    containerRawDailyDates,
    deleteContainerRawDaily,
    summarizeContainerRawDaily,
} from '../raw-author-daily.js';
import {deleteContainerRawCommits} from '../raw-commits.js';
import {buildDevLookupMap, projectSnapshots, resolveRawAuthor} from '../projection.js';
import {deleteContainerDiffstats} from '../diffstat-cache.js';
import {earliestSyncStateKey, rowRefusalStateKey, stallStateKey, syncStateKey} from '../sync.js';
import {deleteProvider, getProvider, GitProviderStoreError, type GitProviderRecord} from './store.js';
import {containerKeyOf} from './config.js';

import type {GitProviderType} from './types.js';

/**
 * What deleting a provider would remove — the preview the admin confirmation states before
 * anything is destroyed (AC9). Read-only: computing this changes nothing.
 */
export interface ProviderDeleteImpact {
    provider: GitProviderType;
    container: string;
    /** Retained (author, day) rows attributed to this container. */
    raw_author_rows: number;
    /** Distinct UTC days of history those rows cover. */
    days: number;
    /** Oldest / newest day covered, or null when nothing has been imported yet. */
    earliest_date: string | null;
    latest_date: string | null;
    /** Total commits recorded for this container. */
    commits: number;
    /** `pr_records` rows attributed to this container. */
    pr_records: number;
    /** Distinct raw git authors that committed under this container. */
    authors: number;
    /**
     * Registered developers whose git history this container contributes to. Developers
     * themselves are NEVER deleted — this is "whose numbers will change".
     */
    developers_affected: number;
    /**
     * True when a config-file provider still resolves to this same `(type, container)`: it
     * continues to own the data, so the cascade is SKIPPED and only the DB row is removed.
     */
    cascade_skipped: boolean;
}

/** What a completed delete actually removed. */
export interface ProviderDeleteResult {
    id: string;
    provider: GitProviderType;
    container: string;
    raw_author_rows: number;
    pr_records: number;
    /** Distinct UTC days re-projected after the retraction. */
    days: number;
    /**
     * The UTC day bounds of the retracted activity, or null when nothing was retracted. The
     * caller feeds these to `recomputeAggregatesForRange` — the derived weekly/monthly
     * rollups covering these days still hold the removed provider's totals until they are
     * recomputed (see the module doc).
     */
    earliest_date: string | null;
    latest_date: string | null;
    /** `git_snapshots` cells removed because they lost all raw provenance. */
    snapshot_cells_retracted: number;
    /** `git_snapshots` cells rewritten from the surviving raw rows. */
    snapshot_cells_rewritten: number;
    /**
     * Cells the re-projection refused to touch because they are legacy (`is_projected = 0`).
     * Always 0 on a store built by migration 042 (which empties `git_snapshots` precisely so
     * every rebuilt row is projection-owned and therefore retractable) — surfaced anyway so
     * a partial retraction can never look like a complete one.
     */
    snapshot_cells_legacy_skipped: number;
    developers_affected: number;
    cursor_keys_purged: number;
    cascade_skipped: boolean;
}

/** The four sync-state keys a container owns — the canonical builders, never a prefix guess. */
function containerCursorKeys(type: GitProviderType, container: string): string[] {
    return [
        syncStateKey(type, container),
        earliestSyncStateKey(type, container),
        stallStateKey(type, container),
        // The systemic-refusal marker (#306). It reports on a window whose rows this cascade
        // has just retracted, so leaving it behind would fail `toprope doctor` forever against
        // a provider that no longer exists — and re-adding the container would inherit the
        // deleted provider's verdict.
        rowRefusalStateKey(type, container),
    ];
}

/**
 * Registered developers this container's activity resolves to.
 *
 * Resolved at the SAME grain attribution is decided at — each observed
 * `(raw_author_key, login, email)` variant against the shared identity map — so an author
 * committing from two addresses is not collapsed to whichever one byte-sorts higher. One
 * grouped query plus one lookup-map build; no per-identity round trip.
 */
function developersAffectedByContainer(
    db: Database.Database,
    type: GitProviderType,
    container: string,
): number {
    const identities = containerRawAuthorIdentities(db, type, container);
    if (identities.length === 0) return 0;
    const lookup = buildDevLookupMap(db);
    const developers = new Set<string>();
    for (const identity of identities) {
        const developerId = resolveRawAuthor(
            lookup,
            type,
            identity.raw_author_key,
            identity.login,
            identity.email,
        );
        if (developerId) developers.add(developerId);
    }
    return developers.size;
}

/**
 * Preview what deleting `record` would remove.
 *
 * `configContainerKeys` is the set of `${type}:${container}` keys owned by config-file
 * providers (see {@link containerKeyOf}). A hit means the container's data has another live
 * owner, so the cascade would be skipped — the caller states that instead of promising a
 * retraction that will not happen.
 */
export function providerDeleteImpact(
    db: Database.Database,
    record: GitProviderRecord,
    configContainerKeys: ReadonlySet<string>,
): ProviderDeleteImpact {
    const {type, container} = record;

    // On the skipped path nothing is removed, so every count is honestly 0 rather than "what
    // would have gone" — the confirmation must not describe a retraction the config sibling
    // prevents. Returned early rather than as a per-field ternary so the two queries below are
    // not run just to be discarded, and so this reads like the cascade's own skip branch.
    if (configContainerKeys.has(containerKeyOf(type, container))) {
        return {
            provider: type,
            container,
            raw_author_rows: 0,
            days: 0,
            earliest_date: null,
            latest_date: null,
            commits: 0,
            pr_records: 0,
            authors: 0,
            developers_affected: 0,
            cascade_skipped: true,
        };
    }

    const raw = summarizeContainerRawDaily(db, type, container);
    const prRecords = (
        db
            .prepare('SELECT COUNT(*) AS n FROM pr_records WHERE provider = ? AND container = ?')
            .get(type, container) as {n: number}
    ).n;

    return {
        provider: type,
        container,
        raw_author_rows: raw.rows,
        days: raw.days,
        earliest_date: raw.earliestDate,
        latest_date: raw.latestDate,
        commits: raw.commits,
        pr_records: prRecords,
        authors: raw.authors,
        developers_affected: developersAffectedByContainer(db, type, container),
        cascade_skipped: false,
    };
}

/**
 * Delete a provider and retract exactly its container's imported data, in one transaction.
 * See the module doc for the ordering and why each step is where it is.
 *
 * @throws {GitProviderStoreError} `not_found` when no provider has that id.
 */
export function deleteProviderWithCascade(
    db: Database.Database,
    id: string,
    configContainerKeys: ReadonlySet<string>,
): ProviderDeleteResult {
    return db.transaction((): ProviderDeleteResult => {
        // Existence is re-read INSIDE the transaction so the cascade acts on the row it
        // verified rather than on one a caller looked up earlier. That is a serialization
        // property of running on this process's single synchronous connection (and, across
        // connections, of SQLite ordering the two transactions) — NOT of holding a write
        // lock: `db.transaction()` issues a DEFERRED BEGIN, so no lock exists at this read.
        const record = getProvider(db, id);
        if (record === undefined) {
            throw new GitProviderStoreError('not_found', `Git provider not found: ${id}`);
        }
        const {type, container} = record;

        if (configContainerKeys.has(containerKeyOf(type, container))) {
            // A config-file provider still resolves to this (type, container) and continues
            // to sync it, so its data and cursors must survive verbatim: retracting them
            // would delete history the surviving owner is actively maintaining, and purging
            // its cursor would make the next scheduled run re-import an already-counted
            // window. Only the DB row goes.
            deleteProvider(db, id);
            return {
                id,
                provider: type,
                container,
                raw_author_rows: 0,
                pr_records: 0,
                days: 0,
                earliest_date: null,
                latest_date: null,
                snapshot_cells_retracted: 0,
                snapshot_cells_rewritten: 0,
                snapshot_cells_legacy_skipped: 0,
                developers_affected: 0,
                cursor_keys_purged: 0,
                cascade_skipped: true,
            };
        }

        // 1. The affected days — read BEFORE the delete; afterwards they cannot be recovered.
        // Sorted ascending, so first/last are the day bounds the caller recomputes over.
        const dates = containerRawDailyDates(db, type, container);
        // Resolved before the rows go too: after step 2 there is nothing left to resolve.
        const developersAffected = developersAffectedByContainer(db, type, container);

        // 2 + 2b + 3. Retract the container's own rows. Scoped by the FULL (provider,
        // container) key, so a sibling workspace of the same family is untouched.
        //
        // THE SOURCE OF RECORD GOES FIRST (IG1.3 / #319). `raw_commits` is where the commit
        // facts live since the epic; `raw_author_daily` is a projection of it. Retracting only
        // the projection would leave the facts on disk — every commit's login, email and
        // display name for a container the admin just deleted — and leave them LIVE: the
        // projection reads them by (provider, container, raw_author_key, author_day), so a
        // re-added container's next sync would resurrect the retracted counts on any day its
        // window touched. Ordered before the projection delete so the two can never be read as
        // independent steps; both are inside this one transaction either way.
        //
        // Deliberately NOT reported on {@link ProviderDeleteResult}. The DTO enumerates the
        // history being destroyed in the operator's own terms — author-days and commits — and
        // the preview's `commits` figure is the same facts at the cell grain, since
        // `raw_author_daily.commits` is a `COUNT(*)` over these rows. A second, finer count of
        // the same facts would read as a second thing being deleted. The two can diverge in one
        // direction only: a cell refused at the write boundary (#302/#307) leaves its commits
        // stored with no cell, so the preview UNDERstates by those rows and never overstates.
        deleteContainerRawCommits(db, type, container);
        const rawRows = deleteContainerRawDaily(db, type, container);
        const prRows = db
            .prepare('DELETE FROM pr_records WHERE provider = ? AND container = ?')
            .run(type, container).changes;

        // 3b. The per-commit diffstat cache (#273). Not imported DATA — an immutable memo of a
        // remote read, so nothing about the retraction's correctness depends on it and nothing
        // downstream reads it. It is dropped so the cascade's claim ("this container's
        // contribution is gone") stays literally true: a container re-added later must not
        // inherit file-level detail its credentials may no longer justify. The cost of being
        // wrong in the other direction is only that the next sync re-fetches, which is exactly
        // what a fresh provider should do. Deliberately NOT reported on
        // {@link ProviderDeleteResult}: the admin confirmation enumerates what history is being
        // destroyed, and a re-derivable fetch cache is not history.
        //
        // This one NORMALIZES `container` while the two statements above use it verbatim, and
        // the asymmetry is deliberate. The rows above were written under whatever spelling the
        // pipeline used and must be matched byte-for-byte (see `containerKeyOf`'s note on why a
        // normalizing key would be actively worse for the cascade); the diffstat rows are always
        // written through `createCommitDiffstatCache`, which normalizes, so matching them means
        // normalizing here too. Same rule — "compare the value that was stored" — reaching two
        // different spellings because the two writers differ.
        deleteContainerDiffstats(db, type, container);

        // 4. Rebuild the affected days WHOLE from what survives: a day another container
        // also contributed to keeps that contribution (recomputed), and a day that had only
        // this container's activity loses its cell entirely.
        // An empty date set needs no special case: `projectSnapshots` returns its own zeroed
        // result for one, so re-inlining that literal here would just be a second copy of
        // `ProjectionResult`'s zero value to keep in sync.
        const projection = projectSnapshots(db, {dates});

        // 5. Purge the cursors. Safe now, and ONLY now: the data they licensed is gone, so a
        // re-added provider for this container starts genuinely fresh — its first-sync window
        // is honored and there is no imported overlap left to double-count (#262).
        const cursorKeys = containerCursorKeys(type, container);
        const purge = db.prepare('DELETE FROM sync_state WHERE key = ?');
        let cursorKeysPurged = 0;
        for (const key of cursorKeys) {
            cursorKeysPurged += purge.run(key).changes;
        }

        // 6. Finally the row itself.
        deleteProvider(db, id);

        return {
            id,
            provider: type,
            container,
            raw_author_rows: rawRows,
            pr_records: prRows,
            days: dates.length,
            earliest_date: dates[0] ?? null,
            latest_date: dates[dates.length - 1] ?? null,
            snapshot_cells_retracted: projection.cellsRetracted,
            snapshot_cells_rewritten: projection.cellsWritten,
            snapshot_cells_legacy_skipped: projection.cellsSkippedLegacy,
            developers_affected: developersAffected,
            cursor_keys_purged: cursorKeysPurged,
            cascade_skipped: false,
        };
    })();
}
