/**
 * `raw_commits` — the sha-keyed SOURCE OF RECORD for git ingestion (IG1.2 / #318, epic #316).
 *
 * Design: `dev-docs/Idempotent_Git_Ingestion_Design.md` §1 and §2 (canonical).
 *
 * WHAT THIS REPLACES. `raw_author_daily`'s commit counters used to be ADDED across sync runs,
 * which is correct only if every run's window is provably disjoint from everything already
 * stored — a proof carried by the sync cursors, which every feature since #229 had to be
 * individually prevented from invalidating. The pipeline aggregated commits BEFORE persisting
 * them, discarding the sha that would have made the write idempotent. This module keeps the sha:
 * a commit is named by the hash of its own content, so a re-observed sha is the SAME fact and
 * `INSERT … ON CONFLICT` makes overlap a no-op (with the one narrow upgrade
 * {@link insertRawCommit} documents). The same argument `commit_diffstats`
 * (#273) and `pr_records` (#264) already run on.
 *
 * WHAT A CELL IS. `raw_author_daily` is now a PROJECTION at the
 * `(provider, container, raw_author_key, date)` grain — the same move #253 made for
 * `git_snapshots`. {@link projectRawAuthorDailyCell} recomputes one cell from ALL of its stored
 * commits and writes it with a REPLACE, never a `+=`. Because the recompute always sees every
 * commit of the cell rather than a delta, there is no commit-count weighting left anywhere.
 *
 * WHICH FIELDS ARE PROJECTED, AND WHICH ARE NOT — read this before adding a field.
 * Design §2 lists four derived fields as recomputed here. Two of them are NOT derivable from the
 * §1 schema, and pretending otherwise would silently change what the numbers mean:
 *   * PROJECTED from `raw_commits`: `commits`, `lines_added`, `lines_removed`, `files_changed`,
 *     `avg_commit_size` (arithmetic over those), `commit_burst_count` (over `committed_at`).
 *   * NOT projected — supplied by the caller from its own observation of the cell:
 *     `code_churn_rate` needs per-FILE paths and a 48h cross-day window
 *     (`calculateDailyChurnRates`), and §1 stores no paths — the epic's locked out-of-scope list
 *     keeps them in `commit_diffstats`; `ai_signature_score` is a 0–100 score read from the
 *     commit MESSAGE and per-file status (`scoreAiSignature`), and §1 stores a 0/1 `ai_signature`
 *     flag and no message. The PR counters are exempt in the design's own text — they keep their
 *     `pr_records`-derived path.
 * The discrepancy is recorded on epic #316 as a drift notice and annotated in design §2; it is
 * the user's call to amend, not this module's to improvise. Nothing here is additive either way,
 * so the epic's actual guarantee — a re-observed commit cannot inflate a counter — holds whole.
 *
 * WHY THAT IS NOT A "scoped write into a multi-source row". The graduated rule says a write that
 * runs over a SUBSET of sources must merge rather than replace. It does not bite here: a cell is
 * keyed by `(provider, container)`, so exactly ONE provider instance ever writes it, and the two
 * unprojected rates describe that instance's own commits on that day. The multi-source fold lives
 * one level up, in `projection.ts`, which combines cells into a `git_snapshots` row.
 */

import type Database from 'better-sqlite3';
import {addDays, isUtcDay, isUtcIsoInstant} from '../../aggregation/dates.js';
import {detectBursts} from './analyzer.js';
import {
    RawAuthorDailyError,
    assertValidAuthorDay,
    assertValidIdentityColumns,
    assertValidRunScope,
    metricDefectCode,
    normalizeEmail,
    upsertRawAuthorDaily,
    type RawAuthorDailyRecord,
    type RawAuthorIdentity,
} from './raw-author-daily.js';
import type {GitProviderType} from './providers/types.js';

/**
 * One commit as stored. `is_merge` and `ai_signature` are booleans here and 0/1 in SQLite —
 * the schema CHECK is `IN (0,1)`, so the coercion happens once, at the bind.
 *
 * `repo` is part of the PK and is threaded in from the repo loop (`sync.ts`), which is the one
 * frame that knows it; `AnalysisCommit` carries it for exactly that reason and for no other.
 */
export interface RawCommitInput extends RawAuthorIdentity {
    repo: string;
    sha: string;
    /** UTC day, `YYYY-MM-DD` — sliced from the RAW author timestamp, exactly as before. */
    author_day: string;
    /** The author instant, normalized to UTC ISO by {@link toUtcInstant}. */
    committed_at: string;
    lines_added: number;
    lines_removed: number;
    files_changed: number;
    is_merge: boolean;
    ai_signature: boolean;
}

/** The grain a projected `raw_author_daily` cell is recomputed at. */
export interface RawCommitCellKey {
    provider: GitProviderType;
    container: string;
    raw_author_key: string;
    date: string;
}

/** What one cell's commits sum to — the projected half of a `raw_author_daily` row. */
interface RawCommitCellTotals {
    commits: number;
    lines_added: number;
    lines_removed: number;
    files_changed: number;
    avg_commit_size: number;
}

/**
 * Everything a caller must supply that `raw_commits` cannot answer: the cell's identity columns
 * plus the four PR counters and the two unprojectable rates (see the module header).
 */
export interface RawAuthorDailyCellObservation extends RawCommitCellKey {
    author_login: string | null;
    author_email: string | null;
    author_display_name: string | null;
    prs_opened: number;
    prs_merged: number;
    review_comments_given: number;
    avg_time_to_merge_hours: number | null;
    code_churn_rate: number;
    ai_signature_score: number;
}

/**
 * Normalize an author timestamp to the UTC ISO instant `committed_at` is contracted to hold, or
 * `''` when the value cannot be one.
 *
 * OFFSET FORMS ARE REAL, not hypothetical: GitLab's `authored_date` is offset-bearing
 * (`…T10:00:00.000+02:00`), which is why `raw_author_daily`'s future-day horizon is a whole day
 * wide. Storing that verbatim would break the `first_seen`-style string comparisons the codebase
 * makes over instants, so it is converted once, here.
 *
 * The DAY KEY is deliberately NOT re-derived from the result. `author_day` is sliced from the raw
 * string upstream, exactly as `analyzer.ts` and `churn.ts` slice it today, so an offset-bearing
 * date keys to the same day it always has. Re-deriving it from the UTC instant would silently
 * move some commits a day — a semantics change wearing a normalization's clothes.
 *
 * `''` rather than a throw so the caller can still build the row and let the ONE validator refuse
 * and REPORT it, instead of losing it in a frame with no advisory surface. `typeof` first for the
 * coercion reason `toDateString` documents: `Date.parse` stringifies its argument, so an array
 * carrying one instant would parse cleanly.
 */
export function toUtcInstant(value: unknown): string {
    if (typeof value !== 'string') return '';
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) return '';
    const iso = new Date(ms).toISOString();
    // Expanded/negative ISO years round-trip through `toISOString()` yet sort BEFORE ordinary
    // years, inverting every string comparison of an instant — the rule `isUtcIsoInstant` owns.
    return isUtcIsoInstant(iso) ? iso : '';
}

/**
 * Refuse this commit unless `raw_commits` can accept it, by throwing the SAME
 * {@link RawAuthorDailyError} vocabulary the author-day boundary throws (criterion D). The sync
 * catches a `ROW_LEVEL_REFUSALS` code and skips the one commit; anything else rolls the run back.
 *
 * NO NEW CODES, deliberately. The refusal vocabulary is a closed, runtime-checked allowlist that
 * crosses a process boundary (it is interpolated into an operator advisory), and criterion D
 * pins it. So `repo` and `sha` — both row-carried, both returned byte-identical by every
 * re-fetch — are refused as `invalid_identity`, the existing code for "a column THIS row alone
 * carries and this pipeline cannot use". They are not `invalid_key`: that code is decided partly
 * by `provider` (the namespacing rule), so it refuses every row of a provider at once and must
 * stay on the throwing side.
 *
 * ORDERED run/provider-level FIRST, for the reason `assertValidInput` spells out: a corrupt clock
 * or a bad provider must not be swallowed as a heap of row-level skips while the cursor advances.
 */
function assertValidRawCommit(row: RawCommitInput, observedAt: string): void {
    assertValidRunScope(row, observedAt);
    // `typeof` FIRST on both, not `!row.repo || !row.repo.trim()`. Neither value is validated
    // anywhere upstream: `repo` is `listRepos()`'s `r.name` and `sha` is the commit body's `sha`,
    // both read off a response cast rather than parsed. A non-string, non-falsy value (`42`, `{}`,
    // `[]`) passes the truthiness disjunct and makes `.trim()` throw a bare `TypeError` — which is
    // NOT a `RawAuthorDailyError`, so the sync's catch rethrows it, rolls back every provider's
    // window and does it again identically on the next run. That is the permanent-stall geometry
    // this whole refusal vocabulary exists to close, reached by the one field that skipped the
    // check; `assertValidIdentityColumns` puts `typeof` first for exactly this reason, as do
    // `toDateString` and {@link toUtcInstant}.
    if (typeof row.repo !== 'string' || !row.repo.trim()) {
        throw new RawAuthorDailyError(
            'invalid_identity',
            `repo must be a non-blank string, got: ${typeof row.repo}`,
        );
    }
    if (typeof row.sha !== 'string' || !row.sha.trim()) {
        throw new RawAuthorDailyError(
            'invalid_identity',
            `sha must be a non-blank string, got: ${typeof row.sha}`,
        );
    }
    assertValidAuthorDay(row.author_day, observedAt);
    assertValidIdentityColumns(row);
    // Row-level, and `invalid_date` rather than `invalid_instant`: the operand is this commit's
    // OWN author timestamp (`invalid_instant` is the run-constant `observedAt`), so re-fetching
    // returns it unchanged and holding the cursor would brick the provider for one commit.
    if (!isUtcIsoInstant(row.committed_at)) {
        throw new RawAuthorDailyError(
            'invalid_date',
            `committed_at must be a UTC ISO instant, got: ${String(row.committed_at)}`,
        );
    }
    // `lines_added`/`lines_removed` flow VERBATIM out of a provider diffstat body and
    // `files_changed` is a length this codebase computes — the same provenance split
    // `metricDefectCode` already owns, asked here so the classification cannot drift between the
    // two write boundaries.
    for (const field of ['lines_added', 'lines_removed', 'files_changed'] as const) {
        const value = row[field];
        if (!Number.isInteger(value) || value < 0) {
            throw new RawAuthorDailyError(
                metricDefectCode(field),
                `${field} must be a non-negative integer, got: ${String(value)}`,
            );
        }
    }
}

/**
 * The per-commit INSERT, prepared ONCE per database and reused for the whole run.
 *
 * This fires per COMMIT — tens of thousands of times on a full-history sync — and better-sqlite3
 * does not cache, so preparing it inside {@link insertRawCommit} compiled the same SQL once per
 * commit. `diffstat-cache.ts`, the other per-commit store at the same grain in the same run,
 * hoists its statement for exactly this reason and says so; this is the same move.
 *
 * LAZY and keyed by the DATABASE HANDLE, not a module-level constant: a statement is bound to the
 * connection that prepared it, and a `Database` is per-process in production but per-TEST in the
 * suite (each case opens its own `:memory:` db). The `WeakMap` also lets a closed database's
 * statement be collected rather than pinned for the life of the module.
 */
const INSERT_STATEMENTS = new WeakMap<Database.Database, Database.Statement>();

function insertStatement(db: Database.Database): Database.Statement {
    const cached = INSERT_STATEMENTS.get(db);
    if (cached) return cached;
    const prepared = db.prepare(
        `INSERT INTO raw_commits
         (provider, container, repo, sha, raw_author_key, author_login, author_email,
          author_display_name, author_day, committed_at, lines_added, lines_removed,
          files_changed, is_merge, ai_signature, first_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, container, repo, sha) DO UPDATE SET
           lines_added   = excluded.lines_added,
           lines_removed = excluded.lines_removed,
           files_changed = excluded.files_changed,
           ai_signature  = excluded.ai_signature,
           is_merge      = excluded.is_merge
         WHERE excluded.files_changed + excluded.lines_added + excluded.lines_removed
             > raw_commits.files_changed + raw_commits.lines_added + raw_commits.lines_removed`,
    );
    INSERT_STATEMENTS.set(db, prepared);
    return prepared;
}

/**
 * Record one observed commit. Returns `true` when the row was written (inserted, or upgraded by
 * the rule below), `false` when the stored row already said at least as much.
 *
 * `INSERT … ON CONFLICT DO NOTHING` is the design's rule and is right for the ordinary case: a
 * commit is named by the hash of its own content, so a re-observed sha is the same fact and the
 * stored row is as good as the incoming one. `first_seen` therefore keeps meaning "when this
 * pipeline first saw this commit", with no second read.
 *
 * THE ONE EXCEPTION, and why it is not a hedge. The sha identifies the COMMIT, but these columns
 * hold this pipeline's OBSERVATION of it, and an observation can be degraded: a commit whose
 * diffstat endpoint 404s or answers without `stats` is imported with zeroed lines and files, and
 * a later run that re-asks gets the real numbers (#288 raises an advisory saying exactly that,
 * and #273's ratchet deliberately does NOT memoize the degraded answer so the re-ask can happen).
 * Under a bare DO NOTHING the zeros would be frozen forever on the first sighting, and — worse
 * than the loss — the later run WOULD observe the churn, so its advisory would clear while the
 * stored value stayed 0: a recovery reported to an operator that did not happen. That is both the
 * graduated "never memoize a value derived from a response you have just judged unusable" rule
 * and the "a completion signal is not a currency claim" rule, in one row.
 *
 * So the conflict clause is monotone rather than absolute: a strictly MORE INFORMATIVE
 * observation (a greater `files_changed + lines_added + lines_removed`) replaces a less
 * informative one, and nothing else ever does. That keeps every property the epic needs —
 * re-observing the same row is a no-op, so a repeated window still writes byte-identical tables
 * (V1) — while making information about a commit only ever increase, the same rule `bestKnown`
 * already applies to the identity columns. `first_seen` is deliberately NOT touched by the
 * upgrade: it records the first sighting, which is still true.
 *
 * Recorded on the epic's drift notice, since the design's text says DO NOTHING flatly.
 */
export function insertRawCommit(
    db: Database.Database,
    row: RawCommitInput,
    observedAt: string,
): boolean {
    assertValidRawCommit(row, observedAt);
    return (
        insertStatement(db)
            .run(
                row.provider,
                row.container,
                row.repo,
                row.sha,
                row.raw_author_key,
                row.author_login,
                // Lowercased at the write boundary — the contract §1 states as a comment and
                // leaves to the writer, because the column carries no CHECK (its
                // `raw_author_daily` counterpart does not either). THE SAME function that
                // canonicalizes the `raw_author_daily` column, imported rather than restated: a
                // second copy would let a later change to one canonicalization silently apply to
                // one of the two columns, which is precisely what the comment above claims cannot
                // happen.
                normalizeEmail(row.author_email),
                row.author_display_name,
                row.author_day,
                row.committed_at,
                row.lines_added,
                row.lines_removed,
                row.files_changed,
                row.is_merge ? 1 : 0,
                row.ai_signature ? 1 : 0,
                observedAt,
            ).changes > 0
    );
}

interface CellTotalsRow {
    commits: number;
    lines_added: number | null;
    lines_removed: number | null;
    files_changed: number | null;
}

/**
 * Everything one cell's stored commits sum to. ONE aggregate query on the
 * `(provider, container, raw_author_key, author_day)` index — a left-prefix seek, never a scan.
 *
 * `SUM` is NULL over an empty set, so each is coalesced to 0: a cell with no commits is a real
 * state (a PR-only author-day), not an unknown.
 */
function readCellCommitTotals(db: Database.Database, key: RawCommitCellKey): RawCommitCellTotals {
    const row = db
        .prepare(
            `SELECT COUNT(*) AS commits,
                    SUM(lines_added)   AS lines_added,
                    SUM(lines_removed) AS lines_removed,
                    SUM(files_changed) AS files_changed
               FROM raw_commits
              WHERE provider = ? AND container = ? AND raw_author_key = ? AND author_day = ?`,
        )
        .get(key.provider, key.container, key.raw_author_key, key.date) as CellTotalsRow;

    const commits = row.commits;
    const linesAdded = row.lines_added ?? 0;
    const linesRemoved = row.lines_removed ?? 0;
    return {
        commits,
        lines_added: linesAdded,
        lines_removed: linesRemoved,
        files_changed: row.files_changed ?? 0,
        // The same expression `aggregateDailyMetrics` computes, over the same operands — it is
        // only ever a mean of the cell's OWN commits, so no weighting is possible or needed.
        avg_commit_size: commits > 0 ? (linesAdded + linesRemoved) / commits : 0,
    };
}

/**
 * Burst counts per day for one author within one provider instance, recomputed from the stored
 * commit stream.
 *
 * Read at the AUTHOR grain rather than the cell grain because a burst may span midnight and is
 * attributed to the day of its first commit — the property `detectBursts` exists to preserve. The
 * read is one index seek per author per run, and the row set is that author's commits in that
 * container, not the table.
 *
 * BOUNDED to `[min(days) - 1, max(days) + 1]`, not the author's whole history. `raw_commits` is a
 * source of record with no prune path — unlike `commit_diffstats`, which has one — so an
 * unbounded read here would grow monotonically with the install's age, for every author, on every
 * run, forever. One day of padding on each side is exactly what the midnight case needs:
 * `COMMIT_BURST_WINDOW_MINUTES` is half an hour, so no burst can reach past the adjacent day, and
 * the clamp is a left-prefix range on `idx_raw_commits_author_day` rather than a scan.
 *
 * Ordered `(committed_at, sha)` so the sort the detector applies is total and the result is
 * deterministic across runs regardless of insertion order.
 *
 * MALFORMED DAYS ARE FILTERED, NOT TRUSTED. `days` comes from cell observations that have not yet
 * reached the write boundary, and a malformed author-day is a real, reachable input — a provider
 * body with a null or expanded-year PR date yields `toDateString(...) === ''` (#302). That value
 * is a ROW-level refusal, which `assertValidAuthorDay` raises as `invalid_date` when the cell is
 * projected. Feeding it to `addDays` first would turn it into a `RangeError` thrown from inside
 * the run's write transaction — rolling back every provider's window over one bad row, which is
 * the exact failure #302 exists to prevent. Filtering here leaves the refusal where it belongs and
 * costs the bad cell only its own burst count, which the store is about to refuse anyway.
 */
export function readAuthorBurstsByDay(
    db: Database.Database,
    provider: GitProviderType,
    container: string,
    rawAuthorKey: string,
    days: readonly string[],
): Map<string, number> {
    const sorted = days.filter(isUtcDay).sort();
    if (sorted.length === 0) return new Map();
    const rows = db
        .prepare(
            `SELECT committed_at, author_day FROM raw_commits
              WHERE provider = ? AND container = ? AND raw_author_key = ?
                AND author_day >= ? AND author_day <= ?
              ORDER BY committed_at ASC, sha ASC`,
        )
        .all(
            provider,
            container,
            rawAuthorKey,
            addDays(sorted[0], -1),
            addDays(sorted[sorted.length - 1], 1),
        ) as Array<{committed_at: string; author_day: string}>;

    return detectBursts(
        rows.map((r) => ({instantMs: Date.parse(r.committed_at), day: r.author_day})),
    );
}

/**
 * Recompute ONE `raw_author_daily` cell from `raw_commits` and write it — the canonical cell
 * projection, and the single implementation IG1.3's cascade and backfill reuse rather than
 * cloning (the canonical-helper rule; the tracker names it explicitly).
 *
 * `INSERT OR REPLACE` semantics via `upsertRawAuthorDaily`, which preserves `first_seen` and
 * advances `last_seen` — never `+=`, and never a merge of stored+new. That is what makes a
 * re-observed window a no-op: the cell's value is a function of the stored commits, so running
 * the same ingest twice writes the same number twice.
 *
 * `bursts` is passed in rather than read here so a caller projecting many cells for one author
 * pays ONE burst read instead of one per day (the no-per-row-fan-out rule).
 *
 * Throws {@link RawAuthorDailyError} exactly as before — the write boundary's refusal contract is
 * unchanged for every caller (criterion D).
 */
export function projectRawAuthorDailyCell(
    db: Database.Database,
    cell: RawAuthorDailyCellObservation,
    bursts: Map<string, number>,
    observedAt: string,
): RawAuthorDailyRecord {
    const totals = readCellCommitTotals(db, cell);
    return upsertRawAuthorDaily(
        db,
        {
            provider: cell.provider,
            container: cell.container,
            raw_author_key: cell.raw_author_key,
            author_login: cell.author_login,
            author_email: cell.author_email,
            author_display_name: cell.author_display_name,
            date: cell.date,
            commits: totals.commits,
            lines_added: totals.lines_added,
            lines_removed: totals.lines_removed,
            files_changed: totals.files_changed,
            avg_commit_size: totals.avg_commit_size,
            commit_burst_count: bursts.get(cell.date) ?? 0,
            prs_opened: cell.prs_opened,
            prs_merged: cell.prs_merged,
            review_comments_given: cell.review_comments_given,
            avg_time_to_merge_hours: cell.avg_time_to_merge_hours,
            code_churn_rate: cell.code_churn_rate,
            ai_signature_score: cell.ai_signature_score,
        },
        observedAt,
    );
}
