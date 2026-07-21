/**
 * raw_author_daily — the retained authorship spine (DO1.2 / #252, Epic DO1 / #250).
 *
 * `git_snapshots` is keyed by the MUTABLE `developer_id`, so a commit whose author
 * has no developer record at sync time is dropped and can never be recovered — the
 * incremental cursor never re-fetches its window. This module persists one daily
 * fact row for EVERY author, matched and unmatched alike, keyed by the IMMUTABLE raw
 * git identity. Attributing a newly-added developer then becomes a re-projection over
 * retained rows (DO1.3 / #253) rather than a re-fetch, which is what makes it
 * additive-safe and idempotent.
 *
 * This file also owns the ONE copy of the cross-run daily-metric merge rule
 * ({@link mergeDailyAcrossRuns}) and its commit-count weighting
 * ({@link commitWeightedAvg}). Both were relocated here from `sync.ts`, which now
 * imports them: the rule is keyed by the raw identity here and by `developer_id`
 * there, but the arithmetic must never diverge between the two.
 *
 * No sync wiring and no projection live here — those are #253.
 */

import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import type {GitProviderType} from './providers/types.js';

/**
 * Provider families this store accepts, as a runtime allowlist. A compile-time
 * union does not protect the write boundary once a value arrives from a DB row or
 * a request, so the check is made here (and again by the schema CHECK) rather than
 * trusted from TypeScript.
 */
const RAW_AUTHOR_PROVIDERS: readonly GitProviderType[] = ['github', 'bitbucket', 'gitlab'];

/** Anchored UTC-day shape (YYYY-MM-DD), matching the schema's GLOB. */
const UTC_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Anchored UTC-ISO-instant shape. Deliberately stricter than `Date.parse`: expanded
 * / negative ISO years ('+010000-01-01T00:00:00.000Z') round-trip cleanly through
 * `toISOString()` yet sort BEFORE ordinary years, which would invert every string
 * comparison of `first_seen`/`last_seen` (including the MIN/MAX in
 * {@link distinctRawAuthors}). Pinning the shape at the write boundary is what makes
 * those comparisons sound.
 */
const UTC_ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * How many bind parameters one batched read packs into a single statement. Well
 * under SQLite's variable limit, so a large key/date set costs a handful of
 * statements — never a per-row round trip.
 */
export const READ_CHUNK_SIZE = 500;

/** Why a raw-author write refused. Typed so callers map it instead of leaking a raw DB error. */
export type RawAuthorDailyErrorCode =
    | 'invalid_provider'
    | 'invalid_key'
    | 'invalid_date'
    | 'invalid_instant'
    | 'invalid_metric';

/** A fail-closed refusal from the raw-author store — the input never reached SQLite. */
export class RawAuthorDailyError extends Error {
    readonly code: RawAuthorDailyErrorCode;
    constructor(code: RawAuthorDailyErrorCode, message: string) {
        super(message);
        this.name = 'RawAuthorDailyError';
        this.code = code;
    }
}

/**
 * The daily git metrics a single (author, day) row carries — exactly the fields
 * `aggregateDailyMetrics` produces, with no identity columns. Shared by
 * `raw_author_daily` rows and `git_snapshots` rows so the cross-run merge rule can
 * be written once and applied to both.
 */
export interface DailyGitMetrics {
    commits: number;
    lines_added: number;
    lines_removed: number;
    files_changed: number;
    prs_opened: number;
    prs_merged: number;
    review_comments_given: number;
    avg_time_to_merge_hours: number | null;
    code_churn_rate: number;
    ai_signature_score: number;
    avg_commit_size: number;
    commit_burst_count: number;
}

/** The raw identity a `raw_author_daily` row is keyed and pre-filled by. */
export interface RawAuthorIdentity {
    provider: GitProviderType;
    /** `${provider}:login:${login}` or `${provider}:email:${lowercased-email}`. */
    raw_author_key: string;
    author_login: string | null;
    /** Lowercased at the write boundary. */
    author_email: string | null;
    author_display_name: string | null;
}

/** What a caller hands {@link upsertRawAuthorDaily}: identity + day + the run's metrics. */
export interface RawAuthorDailyInput extends RawAuthorIdentity, DailyGitMetrics {
    /** UTC day, YYYY-MM-DD. */
    date: string;
}

/** A full `raw_author_daily` row as stored. */
export interface RawAuthorDailyRecord extends RawAuthorDailyInput {
    id: string;
    /** UTC ISO; the earliest run that recorded this (provider, key, date). */
    first_seen: string;
    /** UTC ISO; the most recent run that touched it. */
    last_seen: string;
}

/** One distinct raw author across all their retained days — the replay feed (DO1.3). */
export interface DistinctRawAuthor {
    provider: GitProviderType;
    raw_author_key: string;
    login: string | null;
    email: string | null;
    display_name: string | null;
    /** Total commits across every retained day for this key. */
    commit_count: number;
    first_seen: string;
    last_seen: string;
}

/**
 * Derive the stable raw-author key. Total by construction:
 *   - a non-blank login wins (`${provider}:login:${login}`), matching the
 *     `${providerType}:${login}` identifier `resolveDeveloperId` maps against — so
 *     login case is preserved VERBATIM here, never normalized;
 *   - otherwise a non-blank email, lowercased (`${provider}:email:${email}`),
 *     matching the lowercased email lookup;
 *   - both blank → `null`, so a truly-anonymous commit is SKIPPED by the caller
 *     rather than collapsing every anonymous author into one `""` bucket.
 */
export function rawAuthorKeyFor(
    provider: GitProviderType,
    login: string | null | undefined,
    email: string | null | undefined,
): string | null {
    const trimmedLogin = (login ?? '').trim();
    if (trimmedLogin) return `${provider}:login:${trimmedLogin}`;

    const trimmedEmail = (email ?? '').trim().toLowerCase();
    if (trimmedEmail) return `${provider}:email:${trimmedEmail}`;

    return null;
}

/**
 * Commit-count-weighted mean of a rate/score field. When two rows' commit counts
 * add, a straight average would ignore that one side may represent far more commits
 * than the other. total===0 (no commits on either side) yields 0 — the neutral value
 * for these per-commit metrics.
 *
 * Relocated here from `sync.ts` (#252); `mergeSnapshots` imports it so the weighting
 * exists in exactly one place.
 */
export function commitWeightedAvg(aVal: number, aCommits: number, bVal: number, bCommits: number): number {
    const total = aCommits + bCommits;
    return total > 0 ? (aVal * aCommits + bVal * bCommits) / total : 0;
}

/**
 * Merge an incoming per-run set of daily metrics against the STORED row for the same
 * (identity, day). This is the ACROSS-RUNS rule — the two sides are NOT disjoint:
 *
 *   - Commit windows ARE disjoint (each run fetches commits on a committer-date
 *     window that advances), so commit-derived counts are ADDED. That accumulation is
 *     the point.
 *   - PR / review activity is RE-DELIVERED: providers fetch PRs by updated_at/
 *     updated_on, so a PR merely touched since the last cursor is re-fetched and
 *     re-aggregated on the next run, and its review comments are re-fetched
 *     unconditionally. Additively summing prs_opened/prs_merged/review_comments_given
 *     would inflate them on essentially every scheduled sync of an active PR. They are
 *     combined with max(): idempotent under re-delivery, and never below the stored
 *     value, so a scoped single-provider run cannot drop already-recorded PRs.
 *   - Rate/score fields are commit-count-weighted so a small delta cannot drag a large
 *     accumulated row halfway (the exponential-recency skew a plain mean would cause).
 *
 * Relocated from `sync.ts`'s `remergeStoredSnapshot` (#252), which is now a thin
 * identity-preserving wrapper around this function — one copy of the arithmetic.
 */
export function mergeDailyAcrossRuns(stored: DailyGitMetrics, incoming: DailyGitMetrics): DailyGitMetrics {
    return {
        commits: stored.commits + incoming.commits,
        lines_added: stored.lines_added + incoming.lines_added,
        lines_removed: stored.lines_removed + incoming.lines_removed,
        files_changed: stored.files_changed + incoming.files_changed,
        prs_opened: Math.max(stored.prs_opened, incoming.prs_opened),
        prs_merged: Math.max(stored.prs_merged, incoming.prs_merged),
        review_comments_given: Math.max(stored.review_comments_given, incoming.review_comments_given),
        // avg_time_to_merge pairs with prs_merged (which we take via max). Source it
        // from the SAME side that owns the larger merge count so the (count, TTM) pair
        // always matches a real observation — never a maxed count paired with a stale
        // first-observed average from a different run. On a tie (the common same-PR
        // re-delivery case) keep the first-observed value.
        avg_time_to_merge_hours:
            incoming.prs_merged > stored.prs_merged
                ? incoming.avg_time_to_merge_hours ?? stored.avg_time_to_merge_hours
                : stored.avg_time_to_merge_hours ?? incoming.avg_time_to_merge_hours,
        code_churn_rate: commitWeightedAvg(stored.code_churn_rate, stored.commits, incoming.code_churn_rate, incoming.commits),
        ai_signature_score: commitWeightedAvg(stored.ai_signature_score, stored.commits, incoming.ai_signature_score, incoming.commits),
        avg_commit_size: commitWeightedAvg(stored.avg_commit_size, stored.commits, incoming.avg_commit_size, incoming.commits),
        commit_burst_count: stored.commit_burst_count + incoming.commit_burst_count,
    };
}

/**
 * Keep the most-informative of two optional identity fields: a non-blank incoming
 * observation wins (it is the newer sighting), but a blank/absent one NEVER erases a
 * value already known. `author_*` therefore only ever gains information.
 */
function bestKnown(stored: string | null, incoming: string | null): string | null {
    const trimmed = (incoming ?? '').trim();
    if (trimmed) return trimmed;
    return stored;
}

/**
 * Canonicalize a commit email to the SAME form the identity map is keyed by
 * (`buildDevLookupMap`/`resolveDeveloperId` both lowercase before lookup) and that
 * `rawAuthorKeyFor` already bakes into an email-derived key. Without this the stored
 * column would keep provider casing verbatim, so a consumer matching on it would miss
 * `Alice@Example.COM`, and `MAX(author_email)` in distinctRawAuthors would roll the
 * same author up to whichever casing byte-sorts higher rather than to one canonical
 * value.
 */
function normalizeEmail(email: string | null): string | null {
    const trimmed = (email ?? '').trim().toLowerCase();
    return trimmed || null;
}

/**
 * Later of two UTC ISO instants, as a TOTAL comparator: an unparseable operand loses
 * rather than propagating NaN through a `>` that silently compares false. Used so
 * `last_seen` only ever advances, even if a run hands back a skewed clock reading.
 */
function laterInstant(stored: string, incoming: string): string {
    const storedMs = Date.parse(stored);
    const incomingMs = Date.parse(incoming);
    if (Number.isNaN(incomingMs)) return stored;
    if (Number.isNaN(storedMs)) return incoming;
    return incomingMs > storedMs ? incoming : stored;
}

/** Counters that must be non-negative integers; the schema CHECKs these too. */
const COUNTER_FIELDS: readonly (keyof DailyGitMetrics)[] = [
    'commits', 'lines_added', 'lines_removed', 'files_changed',
    'prs_opened', 'prs_merged', 'review_comments_given', 'commit_burst_count',
];

/** Rate/score fields: any finite real, but never NaN/Infinity. */
const RATE_FIELDS: readonly (keyof DailyGitMetrics)[] = [
    'code_churn_rate', 'ai_signature_score', 'avg_commit_size',
];

function assertValidInput(row: RawAuthorDailyInput, observedAt: string): void {
    if (!RAW_AUTHOR_PROVIDERS.includes(row.provider)) {
        throw new RawAuthorDailyError('invalid_provider', `Unknown git provider: ${String(row.provider)}`);
    }
    if (!row.raw_author_key || !row.raw_author_key.trim()) {
        throw new RawAuthorDailyError('invalid_key', 'raw_author_key must be a non-blank string');
    }
    // The key must carry the SAME provider as the column. readRawDailyForKeys relies on
    // a key embedding its own provider to justify querying without a provider predicate;
    // that invariant has to be ENFORCED at the write boundary, not merely assumed, or a
    // mismatched pair writes a second row (the UNIQUE triple includes provider) that the
    // key-read would then return as cross-provider contamination.
    if (!row.raw_author_key.startsWith(`${row.provider}:`)) {
        throw new RawAuthorDailyError(
            'invalid_key',
            `raw_author_key must be namespaced by its provider (${row.provider}:…), got: ${row.raw_author_key}`,
        );
    }
    if (!UTC_DAY_RE.test(row.date)) {
        throw new RawAuthorDailyError('invalid_date', `date must be a UTC YYYY-MM-DD day, got: ${row.date}`);
    }
    if (!UTC_ISO_INSTANT_RE.test(observedAt)) {
        throw new RawAuthorDailyError('invalid_instant', `observedAt must be a UTC ISO instant, got: ${observedAt}`);
    }
    // Range-validate the metrics here rather than letting the schema CHECKs surface a raw
    // SQLITE_CONSTRAINT — and because NaN binds as NULL into a NOT NULL column, which
    // would fail with an error that names the wrong problem.
    for (const field of COUNTER_FIELDS) {
        const value = row[field];
        if (!Number.isInteger(value) || (value as number) < 0) {
            throw new RawAuthorDailyError('invalid_metric', `${field} must be a non-negative integer, got: ${String(value)}`);
        }
    }
    for (const field of RATE_FIELDS) {
        if (!Number.isFinite(row[field])) {
            throw new RawAuthorDailyError('invalid_metric', `${field} must be a finite number, got: ${String(row[field])}`);
        }
    }
    if (row.avg_time_to_merge_hours !== null && !Number.isFinite(row.avg_time_to_merge_hours)) {
        throw new RawAuthorDailyError(
            'invalid_metric',
            `avg_time_to_merge_hours must be a finite number or null, got: ${String(row.avg_time_to_merge_hours)}`,
        );
    }
}

const SELECT_COLUMNS = `id, provider, raw_author_key, author_login, author_email, author_display_name,
     date, commits, lines_added, lines_removed, files_changed, prs_opened, prs_merged,
     review_comments_given, avg_time_to_merge_hours, code_churn_rate, ai_signature_score,
     avg_commit_size, commit_burst_count, first_seen, last_seen`;

/**
 * Record one run's contribution for a (provider, raw_author_key, date), merging it
 * against whatever is already stored under {@link mergeDailyAcrossRuns}'s rules.
 *
 * Read-modify-write, so it runs inside a `db.transaction` — the graduated rule is
 * that a check-then-act mutation must be serialized by a transaction, not merely
 * backstopped by the UNIQUE constraint (which fails fast on a race, it does not
 * order it). Nesting is safe: better-sqlite3 promotes an inner transaction to a
 * savepoint, so a caller that already holds the sync transaction still gets one
 * atomic unit.
 *
 * `first_seen` is PRESERVED from the stored row (a later run's clock can never move
 * it backward); `last_seen` advances via a total comparator.
 */
export function upsertRawAuthorDaily(
    db: Database.Database,
    row: RawAuthorDailyInput,
    observedAt: string = new Date().toISOString(),
): RawAuthorDailyRecord {
    assertValidInput(row, observedAt);

    return db.transaction((): RawAuthorDailyRecord => {
        const stored = db
            .prepare(`SELECT ${SELECT_COLUMNS} FROM raw_author_daily
                      WHERE provider = ? AND raw_author_key = ? AND date = ?`)
            .get(row.provider, row.raw_author_key, row.date) as RawAuthorDailyRecord | undefined;

        const merged: RawAuthorDailyRecord = stored
            ? {
                  ...stored,
                  ...mergeDailyAcrossRuns(stored, row),
                  author_login: bestKnown(stored.author_login, row.author_login),
                  author_email: bestKnown(stored.author_email, normalizeEmail(row.author_email)),
                  author_display_name: bestKnown(stored.author_display_name, row.author_display_name),
                  first_seen: stored.first_seen,
                  last_seen: laterInstant(stored.last_seen, observedAt),
              }
            : {
                  ...row,
                  author_login: bestKnown(null, row.author_login),
                  author_email: normalizeEmail(row.author_email),
                  author_display_name: bestKnown(null, row.author_display_name),
                  id: randomUUID(),
                  first_seen: observedAt,
                  last_seen: observedAt,
              };

        db.prepare(
            `INSERT INTO raw_author_daily
             (id, provider, raw_author_key, author_login, author_email, author_display_name,
              date, commits, lines_added, lines_removed, files_changed, prs_opened, prs_merged,
              review_comments_given, avg_time_to_merge_hours, code_churn_rate, ai_signature_score,
              avg_commit_size, commit_burst_count, first_seen, last_seen)
             VALUES
             (@id, @provider, @raw_author_key, @author_login, @author_email, @author_display_name,
              @date, @commits, @lines_added, @lines_removed, @files_changed, @prs_opened, @prs_merged,
              @review_comments_given, @avg_time_to_merge_hours, @code_churn_rate, @ai_signature_score,
              @avg_commit_size, @commit_burst_count, @first_seen, @last_seen)
             ON CONFLICT(provider, raw_author_key, date) DO UPDATE SET
               author_login = excluded.author_login,
               author_email = excluded.author_email,
               author_display_name = excluded.author_display_name,
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
               last_seen = excluded.last_seen`,
        ).run(merged);

        return merged;
    })();
}

/**
 * Split `items` into fixed-size chunks so one batched statement never exceeds SQLite's
 * bind limit. Exported (with {@link READ_CHUNK_SIZE}) so the projection (#253) batches
 * its own `IN (…)` scans by the same rule instead of cloning this — one splitter, one
 * chunk size, no chance of the two drifting apart.
 */
export function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        out.push(items.slice(i, i + size));
    }
    return out;
}

/**
 * Deterministic order for every batched read: by day, then by the (provider, key)
 * identity. Total — `(provider, raw_author_key, date)` is UNIQUE, so no two rows tie.
 *
 * The SQL clause orders each CHUNK; {@link sortReadRows} re-applies the same order to
 * the concatenated result, because a chunked read would otherwise return a sequence of
 * independently-sorted runs (chunk 2's earliest day following chunk 1's latest) — right
 * on a small org and silently wrong past READ_CHUNK_SIZE keys.
 */
const READ_ORDER_BY = 'ORDER BY date ASC, provider ASC, raw_author_key ASC';

/**
 * The JS twin of {@link READ_ORDER_BY} — same total order, applied across chunks.
 * Deliberately code-unit comparison (`<`/`>`) rather than `localeCompare`, to match
 * SQLite's BINARY collation; a locale-aware sort would order the same rows differently
 * from the SQL clause it is supposed to mirror.
 */
function compareText(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function sortReadRows(rows: RawAuthorDailyRecord[]): RawAuthorDailyRecord[] {
    return rows.sort(
        (a, b) =>
            compareText(a.date, b.date) ||
            compareText(a.provider, b.provider) ||
            compareText(a.raw_author_key, b.raw_author_key),
    );
}

/**
 * Every retained row for the given raw-author keys. One statement per chunk of keys —
 * never a query per key. A key embeds its own provider, so `raw_author_key IN (…)` is
 * unambiguous.
 */
export function readRawDailyForKeys(db: Database.Database, keys: string[]): RawAuthorDailyRecord[] {
    const wanted = keys.filter((k) => k && k.trim());
    if (wanted.length === 0) return [];

    const rows: RawAuthorDailyRecord[] = [];
    for (const batch of chunk(wanted, READ_CHUNK_SIZE)) {
        const placeholders = batch.map(() => '?').join(', ');
        rows.push(
            ...(db
                .prepare(
                    `SELECT ${SELECT_COLUMNS} FROM raw_author_daily
                     WHERE raw_author_key IN (${placeholders}) ${READ_ORDER_BY}`,
                )
                .all(...batch) as RawAuthorDailyRecord[]),
        );
    }
    return sortReadRows(rows);
}

/**
 * Every retained row on the given UTC days — the set a re-projection must rewrite.
 * One statement per chunk of dates; served by `idx_raw_author_daily_date`.
 */
export function readRawDailyForDates(db: Database.Database, dates: string[]): RawAuthorDailyRecord[] {
    const wanted = dates.filter((d) => UTC_DAY_RE.test(d));
    if (wanted.length === 0) return [];

    const rows: RawAuthorDailyRecord[] = [];
    for (const batch of chunk(wanted, READ_CHUNK_SIZE)) {
        const placeholders = batch.map(() => '?').join(', ');
        rows.push(
            ...(db
                .prepare(
                    `SELECT ${SELECT_COLUMNS} FROM raw_author_daily
                     WHERE date IN (${placeholders}) ${READ_ORDER_BY}`,
                )
                .all(...batch) as RawAuthorDailyRecord[]),
        );
    }
    return sortReadRows(rows);
}

/**
 * One raw author under ONE of the identities their rows were observed with — the feed
 * the candidate derivation (DO1.4 / #254) reads. Same shape as {@link DistinctRawAuthor};
 * aliased rather than restated so the two can never drift apart. What differs is the
 * GRAIN: a key with two observed emails yields two of these and one of those.
 */
export type RawAuthorIdentityVariant = DistinctRawAuthor;

/**
 * The rollup arithmetic, written ONCE and shared by both groupings below so a change to
 * how a day-set is summarised can never apply to one grain and not the other.
 *
 * `MAX(author_display_name)` picks a non-null when any day has one (SQLite's MAX ignores
 * NULLs) — a deterministic pick of a known value, not a meaningful ranking.
 */
const ROLLUP_AGGREGATES = `MAX(author_display_name) AS display_name,
                    SUM(commits) AS commit_count,
                    MIN(first_seen) AS first_seen,
                    MAX(last_seen) AS last_seen`;

/**
 * One row per distinct raw author, rolled up across every retained day. A single grouped
 * query, no per-author fan-out.
 *
 * `MAX(author_login)` / `MAX(author_email)` collapse the key's days to ONE identity. That
 * is sound for the login (rows under a login-derived key carry the same login by
 * construction) but LOSSY for the email: `sync.ts` stamps one run's sample commit email
 * onto every date row that run writes, so a person committing from two addresses leaves
 * different emails on different days under one login key, and this picks whichever
 * byte-sorts higher. Callers that must not lose the other addresses — anything deciding
 * whether an author is attributed — want {@link distinctRawAuthorIdentities} instead.
 *
 * Ordering is explicit and total: busiest author first, then most-recently-seen, with
 * the UNIQUE (provider, raw_author_key) identity as the final tiebreak — never a
 * nondeterministic rowid or UUID.
 */
export function distinctRawAuthors(db: Database.Database): DistinctRawAuthor[] {
    return db
        .prepare(
            `SELECT provider,
                    raw_author_key,
                    MAX(author_login) AS login,
                    MAX(author_email) AS email,
                    ${ROLLUP_AGGREGATES}
             FROM raw_author_daily
             GROUP BY provider, raw_author_key
             ORDER BY commit_count DESC, last_seen DESC, provider ASC, raw_author_key ASC`,
        )
        .all() as DistinctRawAuthor[];
}

/**
 * One row per (author key, observed login, observed email) — the SAME rollup as
 * {@link distinctRawAuthors} at a finer grain, keeping every distinct identity a key was
 * ever seen with instead of collapsing them to one.
 *
 * This grain exists because attribution is decided PER ROW: `foldRawRows` (the projection)
 * and the sync write loop both resolve `(row.author_login, row.author_email)`, so a key
 * whose days carry two different emails can be attributed on some days and unattributed
 * on others. Resolving a collapsed one-email-per-key rollup would answer that question
 * with an identity half the rows never had — hiding a partially-unattributed author, or
 * reporting an attributed one as a candidate with an inflated commit count.
 *
 * Still ONE query. The row count is bounded by the number of distinct identities observed,
 * which is the author count plus the handful of authors who use a second address — not the
 * row count of the table.
 *
 * Ordering is total: `commit_count DESC` first (so a key's BUSIEST variant is the first one
 * a caller folding by key encounters), then the full group key as the tiebreak.
 */
export function distinctRawAuthorIdentities(db: Database.Database): RawAuthorIdentityVariant[] {
    return db
        .prepare(
            `SELECT provider,
                    raw_author_key,
                    author_login AS login,
                    author_email AS email,
                    ${ROLLUP_AGGREGATES}
             FROM raw_author_daily
             GROUP BY provider, raw_author_key, author_login, author_email
             ORDER BY commit_count DESC, provider ASC, raw_author_key ASC,
                      author_email ASC, author_login ASC`,
        )
        .all() as RawAuthorIdentityVariant[];
}
