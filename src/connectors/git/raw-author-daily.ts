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
 * Since IG1.2 (#318, epic #316) this table is itself a PROJECTION, at the
 * `(provider, container, raw_author_key, date)` grain, of the sha-keyed `raw_commits` source of
 * record — so this file owns the write boundary (validation, identity carry-forward, the REPLACE)
 * while `raw-commits.ts` owns what the metric values are recomputed FROM. The cross-run merge
 * rule this file used to own is deleted; see the note where it stood.
 *
 * No sync wiring and no `git_snapshots` projection live here — those are #253.
 */

import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import {addDays, isUtcDay, isUtcIsoInstant} from '../../aggregation/dates.js';
import {isBlankContainer} from './providers/container.js';
import type {GitProviderType} from './providers/types.js';

/**
 * Provider families this store accepts, as a runtime allowlist. A compile-time
 * union does not protect the write boundary once a value arrives from a DB row or
 * a request, so the check is made here (and again by the schema CHECK) rather than
 * trusted from TypeScript.
 */
const RAW_AUTHOR_PROVIDERS: readonly GitProviderType[] = ['github', 'bitbucket', 'gitlab'];

// The anchored UTC-day shape (YYYY-MM-DD) this store enforces — matching the schema's GLOB — is
// {@link isUtcDay}, imported rather than restated (#290). It was a local `UTC_DAY_RE` here, a
// byte-identical one in `projection.ts`, and a third in `aggregation/dates.ts`; the provider gates
// that keep an unusable day OUT of this validator were documented as agreeing with this copy, but
// the agreement was enforced only by a comment. Tightening one copy silently diverged the gate
// from the refusal it exists to prevent — which is a permanent stall of the whole git connector,
// since this refusal throws inside the run's all-providers write transaction.
//
// SCOPED TO THIS PIPELINE, not a repo-wide census. The chain that had to agree is provider gate →
// this validator → projection scan → the schema CHECK, and that chain now shares one predicate.
// Unrelated `^\d{4}-\d{2}-\d{2}$` literals still exist at other boundaries (the dashboard range
// params, self-report, the cursor transformer); they validate different inputs against their own
// extra rules and are deliberately not folded in here.

// The UTC-ISO-instant pin this store enforces on `observedAt` is {@link isUtcIsoInstant},
// imported rather than restated (#309) — the same move #290 made for the day shape one line up.
// It was a local `UTC_ISO_INSTANT_RE` here and a byte-identical anchored regex inside `sync.ts`'s
// own `isUtcIsoInstant`, which is a second copy of the ONE rule that actually matters: expanded /
// negative ISO years ('+010000-01-01T00:00:00.000Z') round-trip cleanly through `toISOString()`
// yet sort BEFORE ordinary years, which would invert every string comparison of
// `first_seen`/`last_seen` (including the MIN/MAX in {@link distinctRawAuthorIdentities}). That
// rule now has one home (`isPlainYearInstant`, in `aggregation/dates.ts`) and this boundary
// composes it. Slightly STRICTER than the old regex, deliberately: the shared predicate also
// round-trips, so a shape-valid impossible instant ('2025-02-30T00:00:00.000Z') is refused here
// too rather than silently normalizing to a different day inside `laterInstant`.

/**
 * How far past the run's own UTC day a commit's day key may legitimately sit — see
 * {@link assertValidInput}'s future-day refusal for why the answer is one day and not zero (#309).
 *
 * The pipeline derives a day key by slicing the RAW author timestamp (`isoDate.slice(0, 10)` in
 * `analyzer.ts` / `churn.ts`), and `isAttributableDate` deliberately admits an offset form because
 * the store does — GitLab's `authored_date` really is offset-bearing (`…T10:00:00.000+02:00`). So
 * a commit made at this very instant in the easternmost zone (UTC+14) keys to TOMORROW's UTC day,
 * legitimately. One day is exactly that maximum offset rounded up, which is why the horizon is a
 * derived quantity rather than a fudge factor: it is the largest gap the offset slice can open,
 * and nothing beyond it can be explained by a timezone.
 */
const FUTURE_DAY_HORIZON_DAYS = 1;

/**
 * How many bind parameters one batched read packs into a single statement. Well
 * under SQLite's variable limit, so a large key/date set costs a handful of
 * statements — never a per-row round trip.
 */
export const READ_CHUNK_SIZE = 500;

/**
 * Every reason this store can refuse a row, as a RUNTIME allowlist.
 *
 * An array rather than a bare union because the code now travels out of this module and is
 * interpolated into an operator-facing advisory line (`AUTHOR_DAYS_SKIPPED_PREFIX` in
 * `sync.ts`, #302). The graduated rule is explicit that a TypeScript union is not a control at
 * a boundary a value crosses, and this one crosses two — module and process, since the line is
 * printed to a terminal, persisted into `sync_logs.errors` and stored on
 * `git_providers.last_sync_advisories`. `sync.ts` checks membership here before rendering.
 *
 * The union is DERIVED from this array rather than declared beside it, so the compile-time
 * type and the runtime allowlist cannot drift: adding a code to one adds it to both.
 */
export const RAW_AUTHOR_DAILY_ERROR_CODES = [
    'invalid_provider',
    'invalid_container',
    'invalid_key',
    'invalid_identity',
    'invalid_date',
    'future_date',
    'invalid_instant',
    'invalid_metric',
    'invalid_computed_metric',
] as const;

/** Why a raw-author write refused. Typed so callers map it instead of leaking a raw DB error. */
export type RawAuthorDailyErrorCode = (typeof RAW_AUTHOR_DAILY_ERROR_CODES)[number];

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
 *
 * TOTAL OVER A NON-STRING, not merely over null/undefined (#302 review cycle 3, SO-1/SEC-1).
 * `unknown` rather than `string | null` because the values arrive from a cast response body:
 * `analysis-types.ts` builds `authorLogin` as `username || email` and `authorEmail` as
 * `email || null`, and `||` filters only FALSY — so `{}` / `[]` / `42` survive. `.trim()` on
 * one of those is a `TypeError` raised from `sync.ts`'s post-fetch loop, which sits in NO
 * `try`: the per-provider catch closed at the fetch and the write transaction's has not
 * opened. It therefore escapes the whole run — no provider's cursor advances, no advisory is
 * emitted, and the next run replays the identical body. That is the permanent stall this
 * issue exists to close, one field over from the dates it closed it for, and STRICTLY WORSE
 * than the rollback: a rollback at least reports itself.
 *
 * A non-string is treated as ABSENT, exactly like `null`, so the key falls through to the
 * other field. That keeps the row alive and carrying its offending value, which
 * {@link assertValidInput} then refuses as `invalid_identity` at the write boundary
 * — so the loss costs one author-day and reaches the advisory surface, instead of the run.
 * (Both non-string → `null` → the caller skips the author, the same as a truly-anonymous
 * one; there is no identity left to report the day under.)
 */
export function rawAuthorKeyFor(
    provider: GitProviderType,
    login: unknown,
    email: unknown,
): string | null {
    const trimmedLogin = typeof login === 'string' ? login.trim() : '';
    if (trimmedLogin) return `${provider}:login:${trimmedLogin}`;

    const trimmedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
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
 * THE CROSS-RUN MERGE IS GONE (IG1.2 / #318, epic #316), and this note is here so nobody
 * reintroduces it. The three cross-run merge helpers — the additive across-runs rule, its
 * genuinely-disjoint twin, and the commit-count weighting both used — stood at this point in the
 * file. They existed to ADD each run's commit counters onto the stored
 * row, which is correct only while every run's window is provably disjoint from everything
 * already stored — the invariant the sync cursors carried, and the one every feature since #229
 * had to be individually prevented from invalidating.
 *
 * `raw_commits` (`raw-commits.ts`) makes the question moot: commits are stored per sha, and a
 * cell is RECOMPUTED from all of them (`projectRawAuthorDailyCell`) rather than accumulated. A
 * re-observed window re-inserts nothing and recomputes the same number, so there is no delta to
 * weight and no disjointness to prove. {@link upsertRawAuthorDaily} below is now a REPLACE.
 *
 * The one merge that survives is a genuinely different rule at a different grain: folding several
 * raw AUTHORS into one `git_snapshots` cell. It lives in `projection.ts`, which owns it outright.
 */

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

/**
 * The nullable identity columns. Every one is dereferenced with `.trim()` by the upsert, inside
 * the run's shared write transaction — see the check for why that makes them validator business.
 */
const IDENTITY_FIELDS: readonly (keyof RawAuthorIdentity)[] = [
    'author_login', 'author_email', 'author_display_name',
];

/** Rate/score fields: any finite real, but never NaN/Infinity. */
const RATE_FIELDS: readonly (keyof DailyGitMetrics)[] = [
    'code_churn_rate', 'ai_signature_score', 'avg_commit_size',
];

/**
 * The metric fields whose value flows VERBATIM out of a provider response body, and the reason
 * a bad metric has two codes rather than one (#306).
 *
 * These four are the only ones whose operands this pipeline does not compute — every one of them
 * bottoms out in a per-file `additions`/`deletions` number a provider handed over uncast.
 * Bitbucket's `getCommitDiff` maps `e.lines_added` / `e.lines_removed` straight into
 * `GitFileDiff`, so a `"40"` or a `null` in a diffstat page arrives intact. (GitHub is the
 * exception: it runs the shared `isCommitCount` predicate over `stats` at its own boundary.)
 *
 * They reach this row by TWO routes, and the distinction matters for anyone classifying a future
 * metric — the rule is "does a provider number reach it?", not "is it arithmetic over
 * lines_added?":
 * - `lines_added` / `lines_removed` sum each commit's `additions` / `deletions`, which
 *   `resolveCommitDiffstat` itself `reduce`s out of the per-file entries; `avg_commit_size` is
 *   `(lines_added + lines_removed) / commits`, so it rides the same two numbers.
 * - `code_churn_rate` does NOT read those two at all. `calculateDailyChurnRates` (`churn.ts`)
 *   walks `commit.fileDiffs` and sums `file.additions + file.deletions` per file, so it reaches
 *   the same provider values one level lower down. An earlier draft of this comment claimed it
 *   was arithmetic over `lines_added`/`lines_removed`; it is not, and the classification happens
 *   to be right for a different reason.
 *
 * Provenance is what decides the split, because it decides whether re-asking helps. A defect in
 * one of these is a property of a response body that is immutable under re-fetch — holding the
 * cursor would replay it forever and never write the row — so it is a row-level refusal the
 * sync may skip ({@link ROW_LEVEL_REFUSALS}). Every OTHER metric field is produced by this
 * codebase from counts and guarded values (`commits`/`files_changed`/`prs_*`/
 * `review_comments_given`/`commit_burst_count` are lengths and increments; `ai_signature_score`
 * is our scorer's mean; `avg_time_to_merge_hours` comes from `prMergeDurationHours`, which is
 * total and returns `null` rather than NaN). Nothing a provider can send makes one of those
 * invalid — only a code regression can — and a code regression is repaired by shipping a patch,
 * after which re-fetching DOES yield a writable row. Those therefore carry
 * `invalid_computed_metric` and stay on the throwing side, so the cursor is held over a window
 * that re-covers intact instead of being skipped past and reported clean.
 */
const RESPONSE_DERIVED_METRIC_FIELDS: readonly (keyof DailyGitMetrics)[] = [
    'lines_added', 'lines_removed', 'code_churn_rate', 'avg_commit_size',
];

/**
 * Which refusal code an out-of-range metric field carries — see
 * {@link RESPONSE_DERIVED_METRIC_FIELDS} for why the answer is per FIELD and not per rule.
 *
 * One function, asked by all three metric loops, so the classification cannot drift between
 * the counter rule and the rate rule for two fields that share a provenance.
 */
export function metricDefectCode(field: keyof DailyGitMetrics): RawAuthorDailyErrorCode {
    return RESPONSE_DERIVED_METRIC_FIELDS.includes(field)
        ? 'invalid_metric'
        : 'invalid_computed_metric';
}

/**
 * The refusals that are a property of the ROW, as opposed to of the run or the provider (#302).
 *
 * The distinction decides whether a caller may SKIP the row or must let the refusal throw.
 * These are the ones evaluated against a value the row ALONE carries AND that this
 * pipeline cannot change by re-asking: a day key sliced from that PR's own timestamp, an
 * identity column off that author's own commit, and — since #306 — a metric field whose
 * operands come out of a provider response body uncast. Re-fetching returns the identical
 * unusable value, so holding the cursor for them would brick the provider without saving
 * anything, and skipping is the lesser loss.
 *
 * `future_date` (#309) joins them on the same test and is worth calling out because it is the one
 * whose comparison reads a run-constant operand (`observedAt`). The DEFECT is still the row's —
 * an author date years ahead of the clock comes back byte-identical on every re-fetch — and
 * `observedAt` is itself refused as `invalid_instant` (run-level, above) before this check runs.
 * The case where the run-constant side is the broken one, a host clock skewed BACKWARD, refuses
 * every row rather than one, which is exactly the shape `isSystemicRowRefusal` escalates.
 *
 * WHICH FIELDS `invalid_metric`'s premise ACTUALLY HOLDS FOR — the second half of #306, because
 * it did not hold for the whole code. `invalid_metric` used to cover every metric field, and for
 * most of them the premise was false: `commits`, `files_changed`, `prs_opened`, `prs_merged`,
 * `review_comments_given`, `commit_burst_count`, `ai_signature_score` and
 * `avg_time_to_merge_hours` are all computed HERE, from lengths, increments and
 * `prMergeDurationHours` (which is total and yields `null`, never NaN). No response body can
 * make one of them invalid, so their only realistic trigger is a code regression — and a code
 * regression IS repaired, after which re-fetching yields a writable row. Skipping them advanced
 * the cursor past every affected window first, so the branch that exists to avoid a fail-open
 * inversion caused one. They now carry `invalid_computed_metric` and throw.
 * `invalid_metric` is left holding exactly {@link RESPONSE_DERIVED_METRIC_FIELDS} —
 * `lines_added`, `lines_removed`, `code_churn_rate`, `avg_commit_size` — the four whose value
 * flows from a diffstat body two of the three providers do not validate.
 *
 * SKIPPING IS NOT SILENT ANY MORE (#306). A row-level refusal is still an advisory when it is
 * incidental, but a provider instance whose refusals reach `isSystemicRowRefusal`'s threshold
 * (`sync.ts`) now raises a genuine error and a durable `toprope doctor` failure —
 * so "the cause refuses 100% of a provider's rows" can no longer settle as a green run.
 *
 * The others are evaluated against operands that are CONSTANT for a whole run (`observedAt`) or
 * a whole provider (`provider`, `container`, and the namespacing half of `raw_author_key`). A
 * defect in one of those refuses EVERY row, so skipping would discard the entire window
 * fail-open with the cursor advanced and the run reported clean — the exact inversion of the
 * fail-closed behaviour that made a config typo loud. Those must still throw, roll the
 * transaction back and hold the cursor: unlike a bad date, they describe something an operator
 * can fix, after which the window re-covers intact.
 *
 * `tests/git/raw-author-daily.test.ts` fails if any code in {@link RAW_AUTHOR_DAILY_ERROR_CODES}
 * appears in neither class, so a new refusal cannot become fail-closed by omission.
 */
export const ROW_LEVEL_REFUSALS: readonly RawAuthorDailyErrorCode[] = [
    'invalid_date',
    'future_date',
    'invalid_identity',
    'invalid_metric',
];

/**
 * Refuse this row unless the store can accept it, by throwing {@link RawAuthorDailyError} with a
 * typed {@link RawAuthorDailyErrorCode} — the ONE validator the write boundary has, and the shape
 * every caller of {@link upsertRawAuthorDaily} is written against.
 *
 * WHY THE CALLER CATCHES IT (#302/#307). This runs inside the git sync's SINGLE all-providers
 * write transaction, so a throw does not cost one row: it rolls back every provider's window, no
 * cursor advances, and the identical input recurs on the next run — a permanent stall of the
 * whole git connector. #275/#290 closed that door for the commit author date by gating it at each
 * provider, but three more dates reach here ungated (`pr.createdAt`, `pr.mergedAt`,
 * `comment.createdAt`, keyed into a day by `analyzer.ts`) plus the NaN `avg_time_to_merge_hours`
 * those timestamps compute. A fourth and fifth provider gate would not close the class; refusing
 * HERE is total over every field this validates and over every future provider. The sync
 * therefore CATCHES this throw and — for a {@link ROW_LEVEL_REFUSALS} code only — skips the one
 * row rather than letting it roll the run back. #307 collapsed the old separate pre-check
 * (`findRawAuthorDailyDefect`, a non-throwing twin that had to be kept byte-for-byte in step with
 * this one) into exactly that catch: one validator, run once at the write, with no second body to
 * drift.
 *
 * FAIL-CLOSED, and ordered so the caller's split is a property of the RULES, not of the row mix.
 * The run- and provider-level rules run FIRST: this throws the FIRST defect it finds, and the
 * caller skips a row-level refusal but lets a run/provider-level one throw — so if a run whose
 * clock is corrupt (`observedAt`) ALSO carries a bad date on every row, checking `observedAt`
 * first is what stops every row being skipped as `invalid_date` while the run-level fault the
 * split exists to make loud advances the cursor and reports `ok`.
 *
 * THE MESSAGE EMBEDS THE OFFENDING VALUE, which is response-derived and unvalidated. It is fine
 * in a thrown `Error`; it is NOT fine pasted into a line that reaches a terminal,
 * `sync_logs.errors` or the admin UI. A caller rendering an advisory interpolates the typed
 * `.code` (a closed vocabulary — {@link RAW_AUTHOR_DAILY_ERROR_CODES}) there, never `.message`.
 */
function assertValidInput(row: RawAuthorDailyInput, observedAt: string): void {
    assertValidRunScope(row, observedAt);
    assertValidAuthorDay(row.date, observedAt);
    assertValidIdentityColumns(row);
    // Range-validate the metrics here rather than letting the schema CHECKs surface a raw
    // SQLITE_CONSTRAINT — and because NaN binds as NULL into a NOT NULL column, an error that
    // names the wrong problem. The code is per FIELD (#306): see {@link metricDefectCode}.
    for (const field of COUNTER_FIELDS) {
        const value = row[field];
        if (!Number.isInteger(value) || (value as number) < 0) {
            throw new RawAuthorDailyError(metricDefectCode(field), `${field} must be a non-negative integer, got: ${String(value)}`);
        }
    }
    for (const field of RATE_FIELDS) {
        if (!Number.isFinite(row[field])) {
            throw new RawAuthorDailyError(metricDefectCode(field), `${field} must be a finite number, got: ${String(row[field])}`);
        }
    }
    if (row.avg_time_to_merge_hours !== null && !Number.isFinite(row.avg_time_to_merge_hours)) {
        throw new RawAuthorDailyError(
            metricDefectCode('avg_time_to_merge_hours'),
            `avg_time_to_merge_hours must be a finite number or null, got: ${String(row.avg_time_to_merge_hours)}`,
        );
    }
}

/**
 * The RUN- and PROVIDER-level half of the write boundary: `observedAt`, `provider`, `container`
 * and the `raw_author_key` namespacing rule.
 *
 * Split out (IG1.2 / #318) so the `raw_commits` boundary can compose the SAME rules instead of
 * restating them — the canonical-helper rule applied to a validator, and the specific drift this
 * codebase has already paid for twice (#290's three copies of the day shape, #307's non-throwing
 * twin of this very function). Every operand here is constant for a whole run or a whole
 * provider, which is exactly why none of these codes is in {@link ROW_LEVEL_REFUSALS}: a defect
 * in one refuses EVERY row, so skipping would discard the window fail-open with the cursor
 * advanced. They must throw.
 *
 * Called FIRST by both boundaries, deliberately: this throws the first defect it finds, and the
 * caller skips a row-level refusal but lets a run/provider-level one through — so a run whose
 * clock is corrupt is reported as the run-level fault it is rather than as a heap of skipped rows.
 */
export function assertValidRunScope(row: RawAuthorIdentity, observedAt: string): void {
    if (!isUtcIsoInstant(observedAt)) {
        throw new RawAuthorDailyError('invalid_instant', `observedAt must be a UTC ISO instant, got: ${observedAt}`);
    }
    if (!RAW_AUTHOR_PROVIDERS.includes(row.provider)) {
        throw new RawAuthorDailyError('invalid_provider', `Unknown git provider: ${String(row.provider)}`);
    }
    // The container is half the attribution key (#264). A blank one would merge two provider
    // instances back into one bucket — the exact defect the column removes — and would leave rows
    // no per-container delete can retract. Refused here, not just by the schema CHECK, so the
    // caller gets a message naming the problem instead of a raw SQLITE_CONSTRAINT. Blankness goes
    // through the SHARED `isBlankContainer` (#266) rather than a local `.trim()`, so this boundary
    // and the duplicate guard cannot disagree about what an empty container is — and it is total
    // over a non-string too (`normalizeContainer` yields `''`), so no separate `typeof` disjunct
    // is needed.
    if (isBlankContainer(row.container)) {
        throw new RawAuthorDailyError(
            'invalid_container',
            `container must be a non-blank string (the provider's org/workspace/group), got: ${String(row.container)}`,
        );
    }
    if (!row.raw_author_key || !row.raw_author_key.trim()) {
        throw new RawAuthorDailyError('invalid_key', 'raw_author_key must be a non-blank string');
    }
    // The key must carry the SAME provider as the column. readRawDailyForKeys relies on a key
    // embedding its own provider to justify querying without a provider predicate; that invariant
    // has to be ENFORCED here, not merely assumed, or a mismatched pair writes a second row (the
    // UNIQUE triple includes provider) that the key-read would then return as cross-provider
    // contamination.
    if (!row.raw_author_key.startsWith(`${row.provider}:`)) {
        throw new RawAuthorDailyError(
            'invalid_key',
            `raw_author_key must be namespaced by its provider (${row.provider}:…), got: ${row.raw_author_key}`,
        );
    }
}

/**
 * The DAY-KEY half of the write boundary: shape, then the future-day horizon. Both are
 * {@link ROW_LEVEL_REFUSALS} codes — the defect is in the row and re-fetching returns it
 * unchanged — so the caller skips the one row and reports it.
 *
 * Composed by BOTH write boundaries (IG1.2 / #318): `raw_author_daily`'s `date` and
 * `raw_commits`' `author_day` are the same key derived the same way, and #290 is what a second
 * copy of this rule costs — three copies of the day shape, with the provider gate agreeing with
 * one of them only by comment.
 */
export function assertValidAuthorDay(date: string, observedAt: string): void {
    if (!isUtcDay(date)) {
        throw new RawAuthorDailyError('invalid_date', `date must be a UTC YYYY-MM-DD day, got: ${String(date)}`);
    }
    // A FUTURE DEVELOPER-DAY, refused here for every provider at once (#309).
    //
    // WHAT ARRIVES. `git commit --date="2099-01-01"` — and any rebase or import of rewritten
    // history — sets the AUTHOR date far ahead while leaving the COMMITTER date at now. GitHub and
    // GitLab push the run's window to the server, and that server window filters on the COMMITTER
    // date, so the row is RETURNED; the day key this pipeline derives comes from the author date;
    // and `isAttributableDate` is a bare shape-plus-parseability test with no upper bound. So
    // before this check the row was written as a `2099-01-01` developer-day and projected into
    // `git_snapshots`, where the append-only rule means it could never be corrected. Bitbucket
    // REPORTS the same physical commit (its in-memory `until` filter can see it —
    // `FUTURE_AUTHOR_DATE_DROP_REASON`, #304) and the other two IMPORTED it, which is the
    // asymmetry this closes.
    //
    // WHY THE WRITE BOUNDARY AND NOT A FOURTH PROVIDER GATE — the same argument #302 made for the
    // PR/review dates. The bound is a property of the RUN (`observedAt`), which no provider knows,
    // and the three PR/comment dates that reach `row.date` never pass a provider gate at all. One
    // check here is total over every provider, present and future, and over every route into
    // `metrics.date`.
    //
    // IT IS THE GRADUATED "bound and clamp ranges driven by external timestamps" RULE, and #106 is
    // what it costs when it is missing: one future-dated snapshot made `buildTrajectory` walk
    // week-by-week to it and emit thousands of zero-weeks.
    //
    // SKIP, NOT CLAMP. Clamping would silently attribute someone else's commits to today, and the
    // day key is part of the row's identity — a clamped row MERGES into a real day and is then
    // indistinguishable from it forever. Refusing costs the one author-day and says so:
    // `future_date` is a {@link ROW_LEVEL_REFUSALS} code, so the sync skips the row and reports it
    // under `AUTHOR_DAYS_SKIPPED_PREFIX` rather than rolling the run back.
    //
    // ROW-LEVEL DESPITE READING A RUN-CONSTANT OPERAND, which is the one thing to check against
    // that list's own rule. The DEFECT is in the row — re-fetching returns the identical author
    // date — and `observedAt` has already been validated as a real instant two checks up. The
    // residual case where the run-constant side is the broken one (a host clock skewed BACKWARD,
    // making every row look future) refuses everything, and that is precisely what
    // `isSystemicRowRefusal` (`sync.ts`, #306) escalates from an advisory into a genuine run
    // failure and a durable `toprope doctor` alert. It is not left to settle as a green run.
    //
    // Compared as `YYYY-MM-DD` STRINGS, which is sound because both operands are shape-pinned by
    // the two checks above it: zero-padded day keys byte-sort chronologically.
    const futureDayHorizon = addDays(observedAt.slice(0, 10), FUTURE_DAY_HORIZON_DAYS);
    if (date > futureDayHorizon) {
        throw new RawAuthorDailyError(
            'future_date',
            `date is a future developer-day (later than ${futureDayHorizon}, the run's own UTC ` +
                `day plus the maximum timezone offset), got: ${date}`,
        );
    }
}

/**
 * The IDENTITY-COLUMN half of the write boundary, composed by both boundaries (IG1.2 / #318) —
 * `raw_commits` carries the same three nullable columns and dereferences them the same way.
 *
 * Both writes DEREFERENCE all three inside the shared write transaction — `bestKnown` and
 * `normalizeEmail` both do `(x ?? '').trim()` — so a non-string, non-null value is a `TypeError`
 * from inside the write: the exact permanent-stall geometry a bad date has, reached by a
 * different field. Reachable, not theoretical: `analysis-types.ts` builds
 * `authorName`/`authorLogin`/`authorEmail` with `||`, which only filters falsy, so `{}` / `[]` /
 * `42` survive from a cast response body.
 *
 * ITS OWN CODE, not `invalid_key`, even though both are about identity: `invalid_key` is decided
 * partly by `provider` (the namespacing rule), so it refuses every row of a provider at once and
 * is NOT row-level. This one is — the value comes from one author's own commit and re-fetching
 * returns the identical body — so folding it into `invalid_key` would make a single odd display
 * name roll back every provider's window, the failure this whole issue exists to close.
 */
export function assertValidIdentityColumns(row: RawAuthorIdentity): void {
    for (const field of IDENTITY_FIELDS) {
        const value = row[field];
        if (value !== null && typeof value !== 'string') {
            throw new RawAuthorDailyError(
                'invalid_identity',
                `${field} must be a string or null, got: ${typeof value}`,
            );
        }
    }
}

const SELECT_COLUMNS = `id, provider, container, raw_author_key, author_login, author_email, author_display_name,
     date, commits, lines_added, lines_removed, files_changed, prs_opened, prs_merged,
     review_comments_given, avg_time_to_merge_hours, code_churn_rate, ai_signature_score,
     avg_commit_size, commit_burst_count, first_seen, last_seen`;

/**
 * REPLACE the (provider, container, raw_author_key, date) cell with the values handed in, except
 * the four PR counters ({@link mergePRCounters}) — the
 * write half of the projection (IG1.2 / #318). It used to MERGE against the stored row, adding the
 * commit counters on a premise of disjoint windows; every
 * metric field is now simply the value the caller computed, because the caller computed it from
 * ALL of the cell's stored commits (`projectRawAuthorDailyCell` in `raw-commits.ts`) rather than
 * from one run's delta. Re-running the same ingest therefore writes the same number twice.
 *
 * DO NOT reintroduce a merge here to "protect" a scoped run. The graduated rule about scoped
 * writes into multi-source rows is about `git_snapshots`, whose cell folds every provider; THIS
 * row is keyed by `(provider, container)`, so exactly one provider instance ever writes it and a
 * replace can never drop another source's contribution.
 *
 * The key includes the CONTAINER (#264): two provider instances of one family (two GitHub
 * orgs, two Bitbucket workspaces) contributing to the same author-day are two independent
 * rows. That is what makes a per-provider delete able to retract exactly its own contribution.
 *
 * STILL a read-modify-write, so it still runs inside a `db.transaction`: the metrics are
 * replaced, but `first_seen` and the three identity columns are carried forward from the stored
 * row (identity only ever GAINS information — a blank observation never erases a known value, and
 * `author_email` is stable-on-first-known so a row that resolved to a developer cannot silently
 * stop resolving). Nesting is safe: better-sqlite3 promotes an inner transaction to a savepoint,
 * so a caller that already holds the sync transaction still gets one atomic unit.
 *
 * `first_seen` is PRESERVED from the stored row (a later run's clock can never move
 * it backward); `last_seen` advances via a total comparator.
 */
/** The four PR-derived counters — the only fields this write still combines with the stored row. */
type PRCounters = Pick<
    DailyGitMetrics,
    'prs_opened' | 'prs_merged' | 'review_comments_given' | 'avg_time_to_merge_hours'
>;

/**
 * THE ONE RULE THAT SURVIVED IG1.2, and the design says so: "PR counters keep their existing
 * `pr_records`-derived path". Everything else on this row is now REPLACED with a value recomputed
 * from `raw_commits`; these four are not, because `raw_commits` is commits only and the PR
 * counters have no sha to be keyed by.
 *
 * WHY THEY CANNOT SIMPLY BE REPLACED — this is a regression that was caught by an existing test
 * (#247 SO-1), not a hypothetical. Providers list PRs by `updated_at`/`updated_on`, so what a run
 * observes for a day is "the PRs of that day that were touched inside this run's window", NOT the
 * day's whole population: a catch-up-capped or narrowed later run legitimately sees FEWER PRs for
 * a day it already recorded. Replacing would silently lower the count every time that happens.
 * `max()` is idempotent under re-delivery (the common case: the same PR re-listed run after run)
 * and never falls below what is already recorded.
 *
 * WHY NOT DERIVE THEM FROM `pr_records` INSTEAD, which is the genuinely idempotent PR store: two
 * of the four are not in it. `pr_records` is keyed by `developer_id`, so an UNMATCHED author's PRs
 * are never written there at all — and this table's entire purpose is retaining unmatched authors
 * — while `review_comments_given` is a REVIEWER's activity on the day they commented, which
 * `pr_records.review_comment_count` (comments ON a PR) does not express. Recorded on the epic's
 * drift notice.
 *
 * `avg_time_to_merge_hours` is sourced from the SAME side that owns the larger `prs_merged`, so
 * the (count, mean) pair always matches a real observation rather than pairing a maxed count with
 * a mean from a different run. On a tie — the common same-PR re-delivery case — the
 * first-observed value stays.
 */
function mergePRCounters(stored: PRCounters, incoming: PRCounters): PRCounters {
    return {
        prs_opened: Math.max(stored.prs_opened, incoming.prs_opened),
        prs_merged: Math.max(stored.prs_merged, incoming.prs_merged),
        review_comments_given: Math.max(stored.review_comments_given, incoming.review_comments_given),
        avg_time_to_merge_hours:
            incoming.prs_merged > stored.prs_merged
                ? incoming.avg_time_to_merge_hours ?? stored.avg_time_to_merge_hours
                : stored.avg_time_to_merge_hours ?? incoming.avg_time_to_merge_hours,
    };
}

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
                  ...row,
                  ...mergePRCounters(stored, row),
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
    const wanted = dates.filter((d) => isUtcDay(d));
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
