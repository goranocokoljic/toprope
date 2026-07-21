/**
 * git_snapshots as a PROJECTION of raw_author_daily (DO1.3 / #253, Epic DO1 / #250).
 *
 * Before this module, `git_snapshots` was accumulated directly: each sync run merged
 * its own metrics into the stored (developer_id, date) row. That made a developer's
 * history unrecoverable once they were added LATE — the commits of an unmatched author
 * were dropped at write time and the forward cursor never re-fetched their window.
 *
 * #252 fixed the retention half (every author's daily facts are now kept in
 * `raw_author_daily`, keyed by the IMMUTABLE raw git identity). This module fixes the
 * attribution half: `git_snapshots` becomes a pure function of
 *
 *     (raw_author_daily, identity map)  ->  git_snapshots
 *
 * so attributing a newly-created developer is just RE-RUNNING that function over the
 * dates their retained rows touch ({@link replayDeveloper}) — no re-fetch, and
 * idempotent by construction, so it can never double-count.
 *
 * The identity map (`buildDevLookupMap`/`resolveDeveloperId`) and the within-cell merge
 * (`mergeSnapshots`) live HERE rather than in `sync.ts` because they are the
 * projection's two inputs; `sync.ts` imports them so exactly one copy exists (it still
 * resolves developers for `pr_records`, which is keyed per-PR and not projected).
 *
 * WHAT THIS MODULE DOES NOT OWN: the cross-RUN merge rule (commit deltas ADD,
 * re-delivered PR fields max(), rate fields commit-weighted). That accumulation now
 * happens entirely inside `raw_author_daily` (see `mergeDailyAcrossRuns`), one level
 * below. By the time a row reaches the projection it is already the accumulated total
 * for that (raw author, day), so the projection REPLACES a cell rather than adding to
 * it — a deterministic rebuild, not a second accumulator.
 */

import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import {
    chunk,
    commitWeightedAvg,
    distinctRawAuthors,
    readRawDailyForDates,
    readRawDailyForKeys,
    READ_CHUNK_SIZE,
    type DailyGitMetrics,
    type RawAuthorDailyRecord,
} from './raw-author-daily.js';
import type {GitProviderType} from './providers/types.js';

/** Anchored UTC-day shape (YYYY-MM-DD) — the same pin `raw_author_daily` enforces. */
const UTC_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

interface DeveloperLookupRow {
    id: string;
    email: string | null;
    external_ids: string | null;
}

/**
 * A `git_snapshots` row: the shared daily metric set ({@link DailyGitMetrics}, #252)
 * plus the columns specific to this table. Declared by EXTENSION rather than by
 * restating the metric fields, so the shape can never drift from what the merge rules
 * merge.
 */
export interface GitSnapshotRow extends DailyGitMetrics {
    developer_id: string;
    date: string;
    data_source: string;
}

/** One projected cell of `git_snapshots`. */
export interface SnapshotCell {
    developer_id: string;
    date: string;
}

/**
 * What to re-project.
 *
 * - `cells` — rebuild EXACTLY these (developer, date) cells and nothing else. The sync
 *   path uses this: a run knows precisely which cells its raw writes touched, and must
 *   not disturb any other developer's row for the same day. Never retracts.
 * - `dates` — rebuild these whole UTC days across EVERY developer, retracting any
 *   projection-owned cell on them that no longer has raw provenance. This is the mode
 *   an identity change needs: moving an author from developer A to developer B both
 *   ADDS to B's cells and must REMOVE from A's, and only a whole-day rebuild sees both
 *   sides. {@link replayDeveloper} is its caller.
 */
export type ProjectionTarget =
    | {cells: readonly SnapshotCell[]}
    | {dates: readonly string[]};

export interface ProjectionResult {
    /** Cells written (inserted or overwritten) by this projection. */
    cellsWritten: number;
    /**
     * Projection-owned cells DELETED because no raw row resolves to them any more.
     * Always 0 in `cells` mode, which never retracts.
     */
    cellsRetracted: number;
    /** Distinct UTC days the projection covered. */
    datesCovered: number;
}

/** Why a projection/replay refused. Typed so callers map it instead of leaking a DB error. */
export type ProjectionErrorCode = 'developer_not_found';

/** A fail-closed refusal from the projection — nothing was written. */
export class ProjectionError extends Error {
    readonly code: ProjectionErrorCode;
    constructor(code: ProjectionErrorCode, message: string) {
        super(message);
        this.name = 'ProjectionError';
        this.code = code;
    }
}

/**
 * Build a map from identifier → developer_id, covering:
 *   - `email:<lowercased email>` (from `developers.email` and the `git_emails` list)
 *   - `github:<login>`, `bitbucket:<login>`, `gitlab:<login>` (from `external_ids` JSON)
 *
 * One query, no per-developer fan-out — every caller resolves a whole run's authors
 * against a single in-memory map.
 */
export function buildDevLookupMap(db: Database.Database): Map<string, string> {
    const rows = db.prepare('SELECT id, email, external_ids FROM developers').all() as DeveloperLookupRow[];
    const map = new Map<string, string>();

    for (const row of rows) {
        if (row.email) {
            map.set(`email:${row.email.toLowerCase()}`, row.id);
        }
        if (!row.external_ids) continue;
        try {
            const ext = JSON.parse(row.external_ids) as Record<string, string | undefined>;
            for (const [key, value] of Object.entries(ext)) {
                if (!value) continue;
                // git_emails holds a comma-separated list of additional commit
                // emails; register each as an email-lookup rather than a username.
                if (key === 'git_emails') {
                    for (const raw of value.split(',')) {
                        const email = raw.trim().toLowerCase();
                        if (email) map.set(`email:${email}`, row.id);
                    }
                    continue;
                }
                // `email:` is a RESERVED namespace in this map, filled only from the
                // columns above. A raw `{"email": "victim@corp.com"}` entry would
                // otherwise register as `email:victim@corp.com` and silently capture
                // another person's commits — attributing one developer's activity to
                // another, which this product treats as a privacy boundary. No writer
                // produces such a key today (registry/developers.ts allowlists the
                // provider keys), but the projection is the trust boundary that consumes
                // it, so the guard belongs here rather than in every writer.
                if (key === 'email') continue;
                map.set(`${key}:${value}`, row.id);
            }
        } catch {
            // malformed external_ids — skip
        }
    }

    return map;
}

/**
 * Resolve one raw git identity to a developer: provider login first (the strong
 * signal), commit email second. Returns null when the author has no developer record —
 * which since #253 is a RETAINED state (the raw row is kept and will attribute the
 * moment a matching developer exists), not a dropped one.
 */
export function resolveDeveloperId(
    lookup: Map<string, string>,
    providerType: GitProviderType,
    login: string | null,
    email: string | null,
): string | null {
    if (login) {
        const byLogin = lookup.get(`${providerType}:${login}`);
        if (byLogin) return byLogin;
    }
    if (email) {
        const byEmail = lookup.get(`email:${email.toLowerCase()}`);
        if (byEmail) return byEmail;
    }
    return null;
}

/**
 * Merge two contributions to the SAME (developer_id, date) cell that come from
 * DIFFERENT raw authors — distinct providers, or distinct identities of one person
 * (a github login plus a bitbucket login, or a login plus an email-keyed identity).
 *
 * Every field is additive/combinable because the two sides are genuinely DISJOINT:
 * `raw_author_daily` is keyed by (provider, raw_author_key, date), so no commit and no
 * PR can appear under two keys. This is NOT the rule for combining across RUNS under
 * one key — that is `mergeDailyAcrossRuns`, which lives one level down in the raw store
 * and has already been applied by the time a row gets here.
 */
export function mergeSnapshots(a: GitSnapshotRow, b: GitSnapshotRow): GitSnapshotRow {
    const totalCommits = a.commits + b.commits;
    const totalPrs = a.prs_merged + b.prs_merged;

    let avgTTM: number | null;
    if (a.avg_time_to_merge_hours !== null && b.avg_time_to_merge_hours !== null && totalPrs > 0) {
        avgTTM = (a.avg_time_to_merge_hours * a.prs_merged + b.avg_time_to_merge_hours * b.prs_merged) / totalPrs;
    } else {
        avgTTM = a.avg_time_to_merge_hours ?? b.avg_time_to_merge_hours;
    }

    // Cross-identity churn cannot be recomputed without the full commit set; simple average is an approximation.
    const avgChurn = (a.code_churn_rate + b.code_churn_rate) / 2;

    return {
        developer_id: a.developer_id,
        date: a.date,
        commits: totalCommits,
        lines_added: a.lines_added + b.lines_added,
        lines_removed: a.lines_removed + b.lines_removed,
        files_changed: a.files_changed + b.files_changed,
        prs_opened: a.prs_opened + b.prs_opened,
        prs_merged: totalPrs,
        review_comments_given: a.review_comments_given + b.review_comments_given,
        avg_time_to_merge_hours: avgTTM,
        code_churn_rate: avgChurn,
        ai_signature_score: commitWeightedAvg(a.ai_signature_score, a.commits, b.ai_signature_score, b.commits),
        avg_commit_size: commitWeightedAvg(a.avg_commit_size, a.commits, b.avg_commit_size, b.commits),
        commit_burst_count: a.commit_burst_count + b.commit_burst_count,
        data_source: a.data_source === b.data_source ? a.data_source : 'multi',
    };
}

/** Stable composite key for a (developer, date) cell. */
function cellKey(developerId: string, date: string): string {
    // `date` is shape-pinned (YYYY-MM-DD, no ':'), so the separator cannot be ambiguous.
    return `${developerId}:${date}`;
}

/** One retained raw row, viewed as this developer's contribution to that day's cell. */
function rawRowToSnapshot(row: RawAuthorDailyRecord, developerId: string): GitSnapshotRow {
    return {
        developer_id: developerId,
        date: row.date,
        commits: row.commits,
        lines_added: row.lines_added,
        lines_removed: row.lines_removed,
        files_changed: row.files_changed,
        prs_opened: row.prs_opened,
        prs_merged: row.prs_merged,
        review_comments_given: row.review_comments_given,
        avg_time_to_merge_hours: row.avg_time_to_merge_hours,
        code_churn_rate: row.code_churn_rate,
        ai_signature_score: row.ai_signature_score,
        avg_commit_size: row.avg_commit_size,
        commit_burst_count: row.commit_burst_count,
        data_source: row.provider,
    };
}

/**
 * Fold every retained raw row on `dates` into the (developer, date) cells they resolve
 * to. Rows whose key resolves to no developer are simply absent from the result — they
 * stay retained in `raw_author_daily` and will project the moment a matching developer
 * exists.
 *
 * `readRawDailyForDates` returns a totally-ordered sequence (date, provider, key), so
 * the fold order — and therefore the result of the order-sensitive `code_churn_rate`
 * average when three or more identities share a cell — is deterministic.
 */
function foldRawRows(
    rows: RawAuthorDailyRecord[],
    lookup: Map<string, string>,
): Map<string, GitSnapshotRow> {
    const projected = new Map<string, GitSnapshotRow>();
    for (const row of rows) {
        const developerId = resolveDeveloperId(lookup, row.provider, row.author_login, row.author_email);
        if (!developerId) continue;

        const snap = rawRowToSnapshot(row, developerId);
        const key = cellKey(developerId, row.date);
        const existing = projected.get(key);
        projected.set(key, existing ? mergeSnapshots(existing, snap) : snap);
    }
    return projected;
}

const WRITE_SQL = `INSERT INTO git_snapshots
     (id, developer_id, date, commits, lines_added, lines_removed, files_changed,
      prs_opened, prs_merged, review_comments_given, avg_time_to_merge_hours,
      code_churn_rate, ai_signature_score, avg_commit_size, commit_burst_count,
      data_source, is_projected)
     VALUES (@id, @developer_id, @date, @commits, @lines_added, @lines_removed, @files_changed,
             @prs_opened, @prs_merged, @review_comments_given, @avg_time_to_merge_hours,
             @code_churn_rate, @ai_signature_score, @avg_commit_size, @commit_burst_count,
             @data_source, 1)
     ON CONFLICT(developer_id, date) DO UPDATE SET
       commits = excluded.commits,
       lines_added = excluded.lines_added,
       lines_removed = excluded.lines_removed,
       files_changed = excluded.files_changed,
       prs_opened = excluded.prs_opened,
       prs_merged = excluded.prs_merged,
       review_comments_given = excluded.review_comments_given,
       avg_time_to_merge_hours = excluded.avg_time_to_merge_hours,
       code_churn_rate = excluded.code_churn_rate,
       ai_signature_score = excluded.ai_signature_score,
       avg_commit_size = excluded.avg_commit_size,
       commit_burst_count = excluded.commit_burst_count,
       data_source = excluded.data_source,
       is_projected = 1`;

/**
 * Rebuild `git_snapshots` from `raw_author_daily` for the requested scope.
 *
 * The projected value REPLACES the cell's commit/PR-derived columns — it is not added
 * to them. That is what makes the operation idempotent: running it twice over the same
 * raw store and identity map writes the same bytes, so a replay can never double-count.
 * The accumulation that used to live here now happens under the raw key, one level
 * down (`mergeDailyAcrossRuns`).
 *
 * Runs in a single `db.transaction`, so a whole-day rebuild's writes and retractions
 * commit or roll back together and no reader ever sees a half-rebuilt day. Nesting is
 * safe (better-sqlite3 promotes an inner transaction to a savepoint), so the sync path
 * can call this inside the run's own write transaction and still get one atomic unit
 * with its cursor advance.
 *
 * KNOWN UPGRADE CAVEAT, stated at its true blast radius — a cell written before #253
 * (`is_projected = 0`) holds an accumulated total that NO raw row can account for,
 * because raw authorship was not retained then. Such a cell is left completely alone
 * until the projection produces a value for it, at which point it is OVERWRITTEN by the
 * raw-derived value rather than merged with. The affected set is not "a sliver of today":
 * it is the CURSOR DAY. A provider whose cursor sits at `D 23:00` re-covers only
 * `[D 23:00, …]` on its first post-upgrade run, so day `D` projects from that final hour
 * alone and replaces a legacy cell that held the whole of `D` — up to ~23 hours of that
 * day's activity, per developer, gone for good (the forward cursor never re-fetches `D`).
 * Bounded to ONE calendar day per provider and never recurring, but silent and
 * unrecoverable, so it is called out here rather than discovered.
 *
 * Merging into a legacy cell instead was considered and rejected: it is not idempotent
 * (the second projection of the same cell would have to either re-add the legacy residue
 * or drop it), and idempotent re-projection is the property the whole replay design rests
 * on. Retraction, unlike overwrite, is strict and never touches a legacy row at all (see
 * `is_projected`, migration 041).
 */
export function projectSnapshots(db: Database.Database, target: ProjectionTarget): ProjectionResult {
    const empty: ProjectionResult = {cellsWritten: 0, cellsRetracted: 0, datesCovered: 0};

    const wholeDayRebuild = 'dates' in target;
    // Drop malformed days rather than letting one bad string widen or corrupt the scan;
    // `raw_author_daily.date` is shape-pinned, so a non-matching day can match nothing.
    const requestedDates = wholeDayRebuild
        ? target.dates.filter((d) => UTC_DAY_RE.test(d))
        : target.cells.map((c) => c.date).filter((d) => UTC_DAY_RE.test(d));
    const dates = [...new Set(requestedDates)].sort();
    if (dates.length === 0) return empty;

    const wantedCells = wholeDayRebuild
        ? null
        : new Set(target.cells.map((c) => cellKey(c.developer_id, c.date)));

    const lookup = buildDevLookupMap(db);
    // One batched read for the whole scope — never a query per cell or per author.
    const projected = foldRawRows(readRawDailyForDates(db, dates), lookup);

    return db.transaction((): ProjectionResult => {
        const write = db.prepare(WRITE_SQL);
        let cellsWritten = 0;
        for (const [key, snap] of projected) {
            // In `cells` mode a cell outside the requested set belongs to a developer this
            // run never touched; rebuilding it would be correct but is not this call's
            // business, and doing so would silently widen a scoped sync into a global one.
            if (wantedCells && !wantedCells.has(key)) continue;
            write.run({id: randomUUID(), ...snap});
            cellsWritten++;
        }

        let cellsRetracted = 0;
        if (wholeDayRebuild) {
            // Retract only PROJECTION-OWNED cells that lost their raw provenance (the
            // author was re-mapped to another developer, or their raw rows were removed).
            // `is_projected = 0` rows — pre-#253 history and fixture/import rows — are
            // never reconstructible from the raw store, so they are never deleted.
            const del = db.prepare('DELETE FROM git_snapshots WHERE developer_id = ? AND date = ?');
            for (const batch of chunk([...dates], READ_CHUNK_SIZE)) {
                const placeholders = batch.map(() => '?').join(', ');
                const owned = db
                    .prepare(
                        `SELECT developer_id, date FROM git_snapshots
                         WHERE date IN (${placeholders}) AND is_projected = 1`,
                    )
                    .all(...batch) as SnapshotCell[];
                for (const cell of owned) {
                    if (projected.has(cellKey(cell.developer_id, cell.date))) continue;
                    del.run(cell.developer_id, cell.date);
                    cellsRetracted++;
                }
            }
        }

        return {cellsWritten, cellsRetracted, datesCovered: dates.length};
    })();
}

/**
 * Re-attribute a developer's RETAINED history — the entry point the onboarding surfaces
 * (DO1.5/DO1.6) call right after a developer is created or their identities are edited.
 *
 * Rebuilds the WHOLE of every UTC day in the union of:
 *   - the days this developer's CURRENTLY-resolving raw keys touch (what they GAIN), and
 *   - the days they already hold a projection-owned cell on (what they may LOSE).
 *
 * Both halves are required, and whole days rather than this developer's cells alone,
 * because an identity change is two-sided. Re-mapping an author from developer A to
 * developer B must add the history to B *and* retract it from A:
 *   - replaying B is covered by the first half (B's new key brings the days with it);
 *   - replaying A is covered ONLY by the second half — A no longer resolves that key, so
 *     its days are invisible to a key-derived scope, and A's stale cells would survive
 *     as a permanent double-count. A may even end up with no keys at all, which is
 *     precisely the case a "no keys, nothing to do" early return would get wrong.
 * With both halves, replaying EITHER side of a re-map fixes both sides.
 *
 * Idempotent: the projection is a pure function of (raw store, identity map), so
 * replaying twice writes the same bytes. It re-fetches nothing.
 *
 * @throws {ProjectionError} `developer_not_found` if no such developer exists — a typo'd
 * or already-deleted id must fail loudly rather than silently rebuild nothing.
 */
export function replayDeveloper(db: Database.Database, developerId: string): ProjectionResult {
    const exists = db.prepare('SELECT id FROM developers WHERE id = ?').get(developerId) as
        | {id: string}
        | undefined;
    if (!exists) {
        throw new ProjectionError('developer_not_found', `No developer with id: ${developerId}`);
    }

    const lookup = buildDevLookupMap(db);
    // distinctRawAuthors is ONE grouped query returning one row per author (small), so
    // finding this developer's keys costs a single scan — not a query per key.
    const keys = distinctRawAuthors(db)
        .filter((author) => resolveDeveloperId(lookup, author.provider, author.login, author.email) === developerId)
        .map((author) => author.raw_author_key);

    const dates = new Set(keys.length > 0 ? readRawDailyForKeys(db, keys).map((row) => row.date) : []);
    // The retract side: days this developer is currently attributed on. Restricted to
    // projection-owned cells — a legacy row is not ours to rebuild or retract, and
    // pulling its day in would only widen the rebuild for no gain.
    const attributed = db
        .prepare('SELECT DISTINCT date FROM git_snapshots WHERE developer_id = ? AND is_projected = 1')
        .all(developerId) as {date: string}[];
    for (const row of attributed) dates.add(row.date);

    if (dates.size === 0) return {cellsWritten: 0, cellsRetracted: 0, datesCovered: 0};
    return projectSnapshots(db, {dates: [...dates]});
}
