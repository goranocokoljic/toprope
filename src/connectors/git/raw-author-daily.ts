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
import {isBlankContainer} from './providers/container.js';
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
 * {@link distinctRawAuthorIdentities}). Pinning the shape at the write boundary is what makes
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
    | 'invalid_container'
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
    /**
     * The provider INSTANCE this row was imported from — org (github) / workspace
     * (bitbucket) / group (gitlab), i.e. `providerContainer(config)`. REQUIRED, and
     * required by TYPE rather than by convention (#264): `(provider, container)` is the
     * attribution key a provider delete retracts by, so a write path that could omit it
     * would silently produce rows no delete can ever remove. Non-optional here is what
     * makes "no write path can omit the container" a compile-time property, with the
     * runtime allowlist below and the schema CHECK as the two backstops.
     */
    container: string;
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
    /** UTC ISO; the earliest run that recorded this (provider, container, key, date). */
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
 * Is this key the LOGIN form — i.e. did the provider report an actual account username
 * for the author, rather than only a commit address?
 *
 * The distinction is a TRUST boundary, not a formatting detail. A provider login comes
 * from the provider's own account linkage; a commit email is whatever the committer put in
 * `git config user.email` and is verified by nobody. Any path that acts on an author
 * WITHOUT a human reviewing them (#256's auto-create) needs to tell the two apart, and the
 * key shape is the authoritative record of which one was present at retention time —
 * `author_login` alone is not, because `toAnalysisCommit` fills it as `username || email`
 * and `listAuthorCandidates` may fold a login in from another variant of the same key.
 */
export function isLoginKey(provider: GitProviderType, rawAuthorKey: string): boolean {
    return rawAuthorKey.startsWith(`${provider}:login:`);
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
 * Merge two DISJOINT contributions to the same day — sides that share no commit and no
 * PR, so every field is genuinely additive. The counterpart to
 * {@link mergeDailyAcrossRuns}: same day, but the two inputs are known not to overlap,
 * which is what makes summing (rather than max()-ing) the re-delivered PR fields correct.
 *
 * Two situations produce genuinely-disjoint sides, and both must use THIS rule:
 *   - one run's contributions from two DIFFERENT provider instances of the same family
 *     (two GitHub orgs, two Bitbucket workspaces). They resolve to the same
 *     `raw_author_key` and day, but their PRs are different PRs — see `sync.ts`, which
 *     accumulates with this before a single store write, precisely so the across-runs
 *     `max()` never sees them and silently keeps only the larger org's PR count;
 *   - two different raw authors folding into one `git_snapshots` cell (see
 *     `mergeSnapshots`, which delegates the arithmetic here).
 *
 * Rate/score fields are commit-count-weighted so the result does not depend on fold
 * ORDER — which matters because three or more identities can share a cell.
 */
export function mergeDailyDisjoint(a: DailyGitMetrics, b: DailyGitMetrics): DailyGitMetrics {
    const totalCommits = a.commits + b.commits;
    const totalPrs = a.prs_merged + b.prs_merged;

    let avgTTM: number | null;
    if (a.avg_time_to_merge_hours !== null && b.avg_time_to_merge_hours !== null && totalPrs > 0) {
        avgTTM = (a.avg_time_to_merge_hours * a.prs_merged + b.avg_time_to_merge_hours * b.prs_merged) / totalPrs;
    } else {
        avgTTM = a.avg_time_to_merge_hours ?? b.avg_time_to_merge_hours;
    }

    return {
        commits: totalCommits,
        lines_added: a.lines_added + b.lines_added,
        lines_removed: a.lines_removed + b.lines_removed,
        files_changed: a.files_changed + b.files_changed,
        prs_opened: a.prs_opened + b.prs_opened,
        prs_merged: totalPrs,
        review_comments_given: a.review_comments_given + b.review_comments_given,
        avg_time_to_merge_hours: avgTTM,
        // Commit-weighted like every other rate field. Cross-identity churn cannot be
        // recomputed exactly without the full commit set, so this stays an approximation
        // — but a commit-weighted one, which is both closer and (unlike a plain two-way
        // mean) independent of the order identities are folded in.
        code_churn_rate: commitWeightedAvg(a.code_churn_rate, a.commits, b.code_churn_rate, b.commits),
        ai_signature_score: commitWeightedAvg(a.ai_signature_score, a.commits, b.ai_signature_score, b.commits),
        avg_commit_size: commitWeightedAvg(a.avg_commit_size, a.commits, b.avg_commit_size, b.commits),
        commit_burst_count: a.commit_burst_count + b.commit_burst_count,
    };
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
 * Like {@link bestKnown}, but a value once observed is never REPLACED by a different one —
 * a blank incoming still cannot erase it, and a blank stored is still filled.
 *
 * Used for `author_email`, where latest-wins is not a harmless preference but a way to
 * lose already-attributed history. `sync.ts` stamps ONE sample commit email per (login,
 * run) onto every date row that run writes, so under a LOGIN-derived key the stored
 * address is whichever address the most recent overlapping run happened to sample —
 * neither observation is more correct than the other. Letting it churn means a row that
 * resolved to a developer (registered under the first address) can silently stop
 * resolving, and the next whole-day rebuild covering that date RETRACTS their cell:
 * history shrinking on its own, reported to nobody.
 *
 * Stability costs nothing here. Under an EMAIL-derived key the address is part of the key
 * and cannot change anyway; under a login key, login resolution is tried first, so the
 * email is only the fallback path — and a stable fallback is strictly better than an
 * oscillating one. (Capturing EVERY address a key was seen with, rather than one per row,
 * needs a schema change — see the `raw_author_daily` retention notes; this keeps the
 * existing grain and removes the loss.)
 */
function firstKnown(stored: string | null, incoming: string | null): string | null {
    if (stored !== null && stored.trim()) return stored;
    const trimmed = (incoming ?? '').trim();
    return trimmed || stored;
}

/**
 * Canonicalize a commit email to the SAME form the identity map is keyed by
 * (`buildDevLookupMap`/`resolveDeveloperId` both lowercase before lookup) and that
 * `rawAuthorKeyFor` already bakes into an email-derived key. Without this the stored
 * column would keep provider casing verbatim, so a consumer matching on it would miss
 * `Alice@Example.COM`, and the rollups' email grouping would split the
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
    // The container is half the attribution key (#264). A blank one would merge two
    // provider instances back into one bucket — the exact defect the column removes — and
    // would leave rows that no per-container delete can retract. Refused at the write
    // boundary, not just by the schema CHECK, so the caller gets a message naming the
    // problem instead of a raw SQLITE_CONSTRAINT. Blankness goes through the SHARED
    // `isBlankContainer` (#266) rather than a local `.trim()`, so this boundary and the
    // duplicate guard cannot disagree about what an empty container is — and it is total over a
    // non-string too (`normalizeContainer` yields `''`), so no separate `typeof` disjunct is needed.
    if (isBlankContainer(row.container)) {
        throw new RawAuthorDailyError(
            'invalid_container',
            `container must be a non-blank string (the provider's org/workspace/group), got: ${String(row.container)}`,
        );
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

const SELECT_COLUMNS = `id, provider, container, raw_author_key, author_login, author_email, author_display_name,
     date, commits, lines_added, lines_removed, files_changed, prs_opened, prs_merged,
     review_comments_given, avg_time_to_merge_hours, code_churn_rate, ai_signature_score,
     avg_commit_size, commit_burst_count, first_seen, last_seen`;

/**
 * Record one run's contribution for a (provider, container, raw_author_key, date), merging
 * it against whatever is already stored under {@link mergeDailyAcrossRuns}'s rules.
 *
 * The key includes the CONTAINER (#264): two provider instances of one family (two GitHub
 * orgs, two Bitbucket workspaces) contributing to the same author-day are two independent
 * rows, not one row to be merged. That is what makes a per-provider delete able to retract
 * exactly its own contribution — and it also removes the old hazard of handing two
 * workspaces' genuinely-different PRs to the across-runs `max()` rule.
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
                      WHERE provider = ? AND container = ? AND raw_author_key = ? AND date = ?`)
            .get(row.provider, row.container, row.raw_author_key, row.date) as
            | RawAuthorDailyRecord
            | undefined;

        const merged: RawAuthorDailyRecord = stored
            ? {
                  ...stored,
                  ...mergeDailyAcrossRuns(stored, row),
                  author_login: bestKnown(stored.author_login, row.author_login),
                  author_email: firstKnown(stored.author_email, normalizeEmail(row.author_email)),
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
             (id, provider, container, raw_author_key, author_login, author_email, author_display_name,
              date, commits, lines_added, lines_removed, files_changed, prs_opened, prs_merged,
              review_comments_given, avg_time_to_merge_hours, code_churn_rate, ai_signature_score,
              avg_commit_size, commit_burst_count, first_seen, last_seen)
             VALUES
             (@id, @provider, @container, @raw_author_key, @author_login, @author_email, @author_display_name,
              @date, @commits, @lines_added, @lines_removed, @files_changed, @prs_opened, @prs_merged,
              @review_comments_given, @avg_time_to_merge_hours, @code_churn_rate, @ai_signature_score,
              @avg_commit_size, @commit_burst_count, @first_seen, @last_seen)
             ON CONFLICT(provider, container, raw_author_key, date) DO UPDATE SET
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
 * Deterministic order for every batched read: by day, then by the full
 * (provider, container, key) identity. Total — `(provider, container, raw_author_key,
 * date)` is UNIQUE, so no two rows tie. `container` is part of the clause precisely
 * because it is part of that key: omitting it would leave two workspaces' rows for one
 * author-day ordered arbitrarily, and the fold order decides the value of the
 * order-sensitive rate averages downstream.
 *
 * The SQL clause orders each CHUNK; {@link sortReadRows} re-applies the same order to
 * the concatenated result, because a chunked read would otherwise return a sequence of
 * independently-sorted runs (chunk 2's earliest day following chunk 1's latest) — right
 * on a small org and silently wrong past READ_CHUNK_SIZE keys.
 */
const READ_ORDER_BY = 'ORDER BY date ASC, provider ASC, container ASC, raw_author_key ASC';

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
            compareText(a.container, b.container) ||
            compareText(a.raw_author_key, b.raw_author_key),
    );
}

/**
 * Every retained row for the given raw-author keys. One statement per chunk of keys —
 * never a query per key. A key embeds its own provider, so `raw_author_key IN (…)` is
 * unambiguous.
 *
 * Deliberately NOT scoped by container: WHO a raw identity is does not depend on which
 * org/workspace they committed in, so a replay must cover every container the key was seen
 * in or it would rebuild only part of that developer's days.
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
 * One row per (author key, observed login, observed email) — the SAME rollup as
 * the per-key rollup at a finer grain, keeping every distinct identity a key was
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
 *
 * `container` is deliberately NOT in the GROUP BY (#264). This grain exists to match the
 * grain attribution is DECIDED at, and attribution resolves `(login, email)` — the
 * container plays no part in it. Splitting by container would list one person twice for
 * committing in two workspaces, which is a finer grain than any consumer's question.
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

// ─── Per-container reads/deletes — the provider-delete cascade's raw half (#264) ──
//
// All SQL against `raw_author_daily` lives in this module, so the cascade composes these
// helpers instead of hand-rolling a second set of queries over the same table (the
// canonical-helper rule). The cascade itself — ordering, the re-projection, the cursor
// purge — is in `providers/delete-cascade.ts`.

/** What one container has imported into `raw_author_daily`. Every field is a plain count. */
export interface ContainerRawDailySummary {
    /** Retained (author, day) rows attributed to this container. */
    rows: number;
    /** Distinct UTC days those rows cover. */
    days: number;
    /** Oldest / newest day covered, or null when the container has no rows. */
    earliestDate: string | null;
    latestDate: string | null;
    /** Total commits recorded for this container. */
    commits: number;
    /** Distinct raw author identities that committed under this container. */
    authors: number;
}

interface ContainerSummaryRow {
    rows: number;
    days: number;
    earliest_date: string | null;
    latest_date: string | null;
    commits: number | null;
    authors: number;
}

/**
 * Summarize exactly what a `(provider, container)` pair has imported — the impact preview
 * the admin delete confirmation states before anything is removed (#264 AC9).
 *
 * ONE aggregate query, no per-row fan-out. `SUM(commits)` is NULL on an empty set, so it is
 * coalesced to 0 here rather than surfacing null as "unknown".
 */
export function summarizeContainerRawDaily(
    db: Database.Database,
    provider: GitProviderType,
    container: string,
): ContainerRawDailySummary {
    const row = db
        .prepare(
            `SELECT COUNT(*) AS rows,
                    COUNT(DISTINCT date) AS days,
                    MIN(date) AS earliest_date,
                    MAX(date) AS latest_date,
                    SUM(commits) AS commits,
                    COUNT(DISTINCT raw_author_key) AS authors
               FROM raw_author_daily
              WHERE provider = ? AND container = ?`,
        )
        .get(provider, container) as ContainerSummaryRow;
    return {
        rows: row.rows,
        days: row.days,
        earliestDate: row.earliest_date,
        latestDate: row.latest_date,
        commits: row.commits ?? 0,
        authors: row.authors,
    };
}

/**
 * The distinct raw identities a container's rows were observed with — the input for
 * "how many developers does deleting this affect?".
 *
 * Grouped at the SAME (key, login, email) grain attribution is decided at (see
 * {@link distinctRawAuthorIdentities}), so each returned tuple is one thing the identity map
 * either resolves or does not. One query; the caller resolves in memory against a single
 * lookup map rather than querying per identity.
 */
export function containerRawAuthorIdentities(
    db: Database.Database,
    provider: GitProviderType,
    container: string,
): Array<{raw_author_key: string; login: string | null; email: string | null}> {
    return db
        .prepare(
            `SELECT DISTINCT raw_author_key,
                    author_login AS login,
                    author_email AS email
               FROM raw_author_daily
              WHERE provider = ? AND container = ?
              ORDER BY raw_author_key ASC, author_email ASC, author_login ASC`,
        )
        .all(provider, container) as Array<{
        raw_author_key: string;
        login: string | null;
        email: string | null;
    }>;
}

/**
 * The distinct UTC days a container's retained rows touch — the exact date scope a
 * re-projection must rebuild after those rows are removed.
 *
 * MUST be read BEFORE the delete: once the rows are gone there is no way to learn which
 * days were affected, and a re-projection over the wrong scope silently leaves stale cells
 * behind. Sorted so the returned scope is deterministic.
 */
export function containerRawDailyDates(
    db: Database.Database,
    provider: GitProviderType,
    container: string,
): string[] {
    return (
        db
            .prepare(
                `SELECT DISTINCT date FROM raw_author_daily
                  WHERE provider = ? AND container = ? ORDER BY date ASC`,
            )
            .all(provider, container) as Array<{date: string}>
    ).map((r) => r.date);
}

/**
 * Retract every retained row belonging to one `(provider, container)`. Returns the number
 * of rows removed.
 *
 * Scoped by the FULL attribution key, never by `provider` alone: a sibling workspace of the
 * same family shares the provider column and must survive byte-identical.
 */
export function deleteContainerRawDaily(
    db: Database.Database,
    provider: GitProviderType,
    container: string,
): number {
    return db
        .prepare('DELETE FROM raw_author_daily WHERE provider = ? AND container = ?')
        .run(provider, container).changes;
}
