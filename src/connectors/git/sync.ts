import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import {aggregateDailyMetrics} from './analyzer.js';
import {toAnalysisCommit, toAnalysisPR, toAnalysisReviewComment} from './analysis-types.js';
import type {AnalysisCommit, AnalysisPR, AnalysisReviewComment} from './analysis-types.js';
import {
    mergeDailyDisjoint,
    rawAuthorKeyFor,
    upsertRawAuthorDaily,
    type RawAuthorDailyInput,
} from './raw-author-daily.js';
import {
    buildDevLookupMap,
    projectSnapshots,
    resolveDeveloperId,
    resolveRawAuthor,
    type SnapshotCell,
} from './projection.js';
import {createGitProvider} from './providers/factory.js';
import {providerContainer} from './providers/config.js';
import {resolveAllGitProviders} from './providers/resolve.js';
import {loadServerKey} from './providers/secret.js';
import type {GitProviderConfig, GitProviderType, GitCommit, GitFileDiff, GitPR} from './providers/types.js';
import {promoteAllCandidates} from './onboarding.js';
import {ensureTeam} from '../../registry/teams.js';
import {resolveAutoCreateSettings, type AutoCreateSettings} from '../../config/git-auto-create.js';
import type {ConnectorInterface, SyncResult} from '../types.js';
import type {GitConnectorConfig} from '../../config/types.js';

const CONNECTOR_NAME = 'git';

/**
 * Prefix of the advisory pushed into a SyncResult's `errors` when some commit
 * authors have no developer record. This is NOT a sync failure — unmatched
 * authors (CI bots, external contributors, not-yet-mapped humans) are the
 * expected steady state and their commits are simply dropped. Callers that
 * classify a run's outcome (e.g. the sync-now API) must exclude this advisory
 * from genuine errors; exported so there is a single source of truth for the
 * sentinel rather than a matched string literal that can drift.
 */
export const UNMATCHED_AUTHORS_PREFIX = 'Unmatched authors (no developer record found):';

/**
 * Prefix of the run summary pushed into a SyncResult's `errors` when opt-in auto-create
 * (#256) ran. Like {@link UNMATCHED_AUTHORS_PREFIX} this is an ADVISORY, not a failure —
 * it reports what the run onboarded — so outcome classifiers must exclude it.
 *
 * Auto-create FAILURES are deliberately NOT given this prefix: a promotion that could not
 * complete is a genuine error the operator must see turn a provider red, and hiding it
 * behind the same sentinel as the success summary is how a half-onboarded run reads as
 * an all-clear.
 */
export const AUTO_CREATE_SUMMARY_PREFIX = 'auto-created';

/**
 * Prefix of the advisory pushed when the projection REFUSED to write cells because their
 * stored rows are legacy (`is_projected = 0`, pre-#253) — accumulated totals no retained
 * raw row can reconstruct, so overwriting them would replace a real number with a partial
 * one.
 *
 * An ADVISORY rather than a failure: the run itself succeeded and the refusal is the safe
 * choice. But it must be SAID, because it is the one case where "the sync completed" stops
 * implying "the data for those days is current" — an upgraded deployment's straddling day,
 * or a backfill over a window that predates retention. A full distinctive sentence, not a
 * bare word, so a future error can never collide with it.
 */
export const LEGACY_CELLS_SKIPPED_PREFIX = 'Legacy snapshot cells left untouched:';

/** Every sentinel that marks an `errors` entry as advisory rather than a failure. */
const ADVISORY_PREFIXES: readonly string[] = [
    UNMATCHED_AUTHORS_PREFIX,
    AUTO_CREATE_SUMMARY_PREFIX,
    LEGACY_CELLS_SKIPPED_PREFIX,
];

/**
 * Is this `SyncResult.errors` entry an ADVISORY (something the run wants to report) rather
 * than a FAILURE (something that went wrong)?
 *
 * `errors` carries both, because advisories describe the steady state of a healthy sync —
 * unmatched CI bots and external contributors exist in nearly every real repo — and a run
 * that reports them synced perfectly well. Every consumer that classifies a run's outcome
 * must agree on which is which, so the rule lives here, once, beside the sentinels it
 * matches. Two consumers previously disagreed: the sync-now route excluded advisories, the
 * scheduler did not, so a repo with one bot author had every scheduled run retried in full
 * (a second complete network fetch) and logged as an error.
 *
 * Auto-create FAILURE lines deliberately match nothing here: a promotion that could not
 * complete is authorship left unattributed, and the operator must see it turn a provider
 * red rather than have it hidden behind the success summary's sentinel.
 */
export function isAdvisoryError(error: string): boolean {
    return ADVISORY_PREFIXES.some((prefix) => error.startsWith(prefix));
}

/**
 * The line auto-create emits when it could NOT onboard some candidates.
 *
 * Extracted so the classification test can assert against the string the code actually
 * produces rather than a copy of it. The distinction it carries — this line is a genuine
 * failure, the summary beside it is an advisory — is enforced only by wording, so a test
 * holding its own literal would keep passing through exactly the reword that breaks it.
 */
export function autoCreateFailureLine(failed: number, detail: string): string {
    return `Auto-create could not onboard ${failed} author(s): ${detail}`;
}

/**
 * The stages a sync run passes through, in pipeline order (GC#209). The network
 * fetch dominates wall time, so `listing_repos`/`fetching` are what a 1s HTTP
 * poll realistically observes; `analyzing`/`writing` are synchronous and brief —
 * part of the wire contract and visible to a direct listener, but a poll will
 * rarely catch them.
 */
export type GitSyncStage = 'listing_repos' | 'fetching' | 'analyzing' | 'writing';

/**
 * A live progress snapshot of an in-flight sync run, emitted through the
 * optional listener {@link GitSync.syncProviders} accepts (GC#209). Field names
 * are wire-shaped (snake_case) because the admin API serves each snapshot
 * verbatim on the provider list's `active_sync.progress` — one shape end to
 * end, nothing to drift. Counters are cumulative across the whole run; the
 * per-provider "sync now" trigger passes exactly one provider, so there they
 * read as that provider's counts.
 */
export interface GitSyncProgress {
    stage: GitSyncStage;
    /** Repos selected for the run; null until listing has completed. */
    repos_total: number | null;
    repos_processed: number;
    /** The repo currently being fetched (fetching stage only). */
    current_repo: string | null;
    commits_fetched: number;
    prs_fetched: number;
    /** Distinct developers resolved from the fetched activity (analyzing stage on). */
    developers_matched: number;
}

/**
 * Listener for progress snapshots. Called synchronously between pipeline steps
 * with a fresh copy each time — it must be cheap and must not block (the
 * sync-now API just stores the latest snapshot for the list endpoint to serve).
 */
export type GitSyncProgressListener = (progress: GitSyncProgress) => void;

// Hard bounds for the first-sync history window (in whole months), enforced at the
// API trust boundary AND defensively here. Integer, inclusive on both ends: the
// lower bound keeps the window meaningful (a 0-month window would import nothing on
// the first sync), the upper bound stops "6 months" quietly becoming "walk the
// org's entire history" and re-draining the very rate-limit quota this feature
// exists to protect.
export const FIRST_SYNC_WINDOW_MIN_MONTHS = 1;
export const FIRST_SYNC_WINDOW_MAX_MONTHS = 60;
export const FIRST_SYNC_WINDOW_DEFAULT_MONTHS = 6;

// The earliest-synced watermark sentinel meaning "history synced back to the repo's
// first commit" (#229). A walk-all first sync (no window clamp → `since === ''`)
// imported everything, so nothing older exists to backfill; we record this epoch
// instant as the floor rather than '' (which the watermark accessor would read as
// "unset" and fall through to the lazy default). The overlap guard then rejects any
// backfill against such a provider, because every real target is `>=` the epoch.
export const EARLIEST_SYNC_EPOCH = new Date(0).toISOString();

/**
 * Hard cap (in whole days) on the span a SINGLE run re-fetches when a provider's
 * cursor has been held back (#235).
 *
 * #231 holds a provider's cursor whenever its window was not fully covered, so the
 * span still to re-cover is `[storedCursor, now]` — which GROWS every run the
 * provider stays broken. Left uncapped, a provider stalled for months eventually
 * asks each run to walk a months-long commit window across every repo (and one
 * `getCommitDiff` call PER commit), so the cost of a stall compounds into the very
 * rate-limit drain the first-sync window cap exists to prevent.
 *
 * Capping `until` (never `since`) is what keeps this gap-free: the window is
 * CHUNKED, not skipped. A held cursor advances at most one cap-width per complete
 * run and the next run resumes exactly where this one stopped, so a recovering
 * provider catches up over consecutive runs. Clamping `since` forward instead would
 * bound the cost by silently dropping `[storedCursor, now - cap]` — the permanent
 * snapshot gap #231 exists to prevent.
 *
 * 30 days: wide enough that a healthy daily/weekly sync NEVER hits it (an
 * uncapped `until === now` is the unchanged normal path), narrow enough that one
 * catch-up run stays a bounded fetch.
 *
 * WHAT THIS DOES AND DOES NOT BOUND — the honest scope, because "a stalled run costs
 * a constant amount" is NOT true in general:
 *   - BOUNDED everywhere: the commit walk's `[since, until]` span, and with it the
 *     per-commit `getCommitDiff` fan-out (one API call PER COMMIT — usually the
 *     largest single cost of a catch-up).
 *   - BOUNDED since #247: the per-PR review FAN-OUT. `getPullRequests(repo, state,
 *     since)` still takes no `until` (see GitProvider), so a run lists every PR touched
 *     since the cursor — the list rows all still feed the snapshot (prs_opened/prs_merged
 *     stay whole) — but the fan-out that dominates its cost (getReviewComments +
 *     getPRReviews, 2 API calls PER PR) is filtered to the same `[since, until]` window as
 *     the commit walk (prWithinFetchWindow, keyed on the `updatedAt` #247 added to GitPR).
 *     This collapses the recovery amplification the cap used to ADD — a 200-day recovery
 *     no longer re-fans 200+170+…+20 = 770 PR-days of reviews across 7 chunks, only the
 *     ~1x disjoint total (each PR is fanned out in exactly one chunk) — and bounds the
 *     stalled case. Lossless for the fan-out: a PR deferred for `updatedAt > until` is
 *     re-listed and fanned out on the next chunk (whose `since` IS this `until`). The one
 *     residual, on the multi-chunk recovery/backfill path only: `review_comments_given` is
 *     a per-day aggregate built from the fetched comments and max()-merged, so same-day
 *     comments on PRs whose `updatedAt` straddles a chunk boundary can undercount that day
 *     — a bounded, conservative error of the same class git_snapshots already accepts for
 *     lacking a provider/PR dimension (#192 SEC-2). See prWithinFetchWindow.
 *   - STILL UNBOUNDED: the PR LIST paging itself. github/bitbucket page PRs by
 *     `updated_at` DESC, so the out-of-window (newest) PRs sort FIRST and must be paged
 *     through to reach `[since, until]` — an upper bound on the list call cannot skip
 *     them. That paging is one list request per ~50–100 PRs though, far cheaper than the
 *     2-per-PR fan-out #247 bounds; the dominant cost is handled.
 *   - PROVIDER-DEPENDENT (commit walk): github/gitlab push `since`+`until` to the server,
 *     so the cap really does shrink what is listed. Bitbucket's getCommits pages from HEAD
 *     newest-first and breaks only when it crosses `since`, filtering `until` in memory —
 *     so for Bitbucket the cap bounds the diff fan-out but NOT the commit paging, and a
 *     chunked recovery re-pages HEAD→since once per chunk.
 */
export const GIT_CATCHUP_WINDOW_MAX_DAYS = 30;

/**
 * The upper bound a forward run should actually fetch to, given the cursor it is
 * resuming from (#235): `now` normally, or `since + GIT_CATCHUP_WINDOW_MAX_DAYS`
 * when a held cursor left a wider span to re-cover.
 *
 * Total by construction — an unparseable bound, or a `since` at/after `now` (a
 * clock skew or a hand-edited cursor), degrades to `now`, i.e. the uncapped
 * behavior this replaced. Never returns an instant after `now`, so a future-dated
 * cursor can't push the window past the present. Exported for tests.
 */
export function catchUpUntil(since: string, now: string): string {
    const sinceMs = Date.parse(since);
    const nowMs = Date.parse(now);
    if (Number.isNaN(sinceMs) || Number.isNaN(nowMs)) return now;
    const capMs = GIT_CATCHUP_WINDOW_MAX_DAYS * 86_400_000;
    if (nowMs - sinceMs <= capMs) return now;
    return new Date(sinceMs + capMs).toISOString();
}

/**
 * Whether a PR's expensive review FAN-OUT (getReviewComments + getPRReviews) should run
 * this run (#247) — i.e. its last activity is at or before the run's upper bound `until`.
 *
 * This gates the FAN-OUT ONLY, never whether the PR feeds the snapshot. The list row is
 * already in hand and cheap, so the caller pushes EVERY listed PR into `allPRs`
 * (keeping prs_opened/prs_merged whole — see the SO-1 note at the call site); this
 * predicate only decides whether to spend the two per-PR review API calls now.
 *
 * `getPullRequests(repo, state, since)` takes no upper bound (see GitProvider), so a run
 * lists every PR touched since the cursor and — before this gate — fanned out two API
 * calls PER PR over the whole `[since, now]` span, unbounded while a cursor is held and
 * AMPLIFIED chunk-by-chunk on a capped recovery. Gating on `updatedAt <= until` fans each
 * PR out in EXACTLY ONE chunk (its `updatedAt` lands in exactly one contiguous
 * `[since, until]`), collapsing the amplification to ~1x.
 *
 * LOSSLESS for the fan-out: a PR touched in `(until, now]` has `updatedAt > until`, and a
 * capped run advances the cursor to exactly `until` (see forwardCursorTarget), so the next
 * run's `since` IS this run's `until` and re-lists it (`getPullRequests` fetches
 * `updatedAt >= since`); it is fanned out then. The final uncapped chunk (`until === now`)
 * defers nothing. On backfill, `until` is the earliest watermark, so a PR updated after it
 * is already covered by the forward window.
 *
 * KNOWN RESIDUAL (recovery/backfill only): `review_comments_given` is a per-day aggregate
 * built from the fetched comments and max()-merged across runs. Because each PR is fanned
 * out in only one chunk, two same-day comments on PRs whose `updatedAt` straddles a chunk
 * boundary are seen in different runs, so max() can undercount that day. Bounded, rare
 * (multi-chunk catch-up with same-day cross-PR comment activity), and the same class of
 * conservative undercount git_snapshots already accepts for lacking a provider/PR
 * dimension (#192 SEC-2). prs_opened/prs_merged are NOT affected — they come from the
 * always-complete `allPRs` list, whose widest first chunk captures the full set. The
 * per-PR `pr_records` review fields do NOT durably undercount either: each PR is fanned
 * out in exactly one chunk (writing its full counts then), a deferred PR carries prior
 * counts forward via upsertPRRecord, and a first-seen deferred PR's transient zeros
 * converge on the re-fan next chunk.
 *
 * Compared as PARSED INSTANTS, never as strings: provider `updatedAt` values are raw API
 * timestamps (github `...:00Z`, no millis) while `until` is a `toISOString()` value
 * (`...:00.000Z`), so a lexical `<=` would mis-order equal instants. Total and FAIL-OPEN:
 * an unparseable `until` (no usable bound) or an unparseable `updatedAt` (can't place the
 * PR) runs the fan-out — a bounded extra fetch, never a silent drop.
 */
export function prWithinFetchWindow(updatedAt: string, until: string): boolean {
    const untilMs = Date.parse(until);
    if (Number.isNaN(untilMs)) return true;
    const updatedMs = Date.parse(updatedAt);
    if (Number.isNaN(updatedMs)) return true;
    return updatedMs <= untilMs;
}

/** Knobs a sync run accepts beyond the provider set. */
export interface SyncRunOptions {
    /**
     * On a provider's FIRST sync (no stored cursor yet) clamp the history window to
     * `now - firstSyncWindowMonths` instead of walking all history from ''. This is
     * the lever that stops run #1 draining a provider's whole rate-limit budget.
     *
     * IGNORED once a provider has a stored cursor: `since` is cursor-derived and the
     * snapshot upsert is additive, so re-widening the window on a later run would
     * double-count the already-recorded span. Omitting it (undefined) preserves the
     * legacy "walk all history on first sync" behavior — the scheduled path passes
     * nothing and is deliberately unchanged. Residual exposure (out of scope for
     * #228, which scoped the cap to the "Sync now" button): a fresh org first synced
     * by the scheduler or `toprope sync all` — including config-file providers, which
     * can ONLY sync that way — still walks all history and drains the quota. Bounding
     * the automated path is a follow-up, not this issue.
     */
    firstSyncWindowMonths?: number;
    /**
     * "Sync older history" backfill (#229): extend a provider's synced window
     * BACKWARD by fetching the fixed, strictly-older commit slice [since, until]
     * and additively merging it. `until` is the provider's current earliest
     * watermark and `since` the new (older) target; the caller (the backfill route)
     * computes both and enforces `since < until` (the overlap guard) BEFORE
     * dispatching, so the slice is always disjoint from already-stored activity and
     * the additive snapshot merge stays correct — no double-count.
     *
     * In this mode the run does NOT advance the forward cursor (normal "Sync now"
     * must keep resuming from now); instead it LOWERS the earliest watermark to
     * `since`. `firstSyncWindowMonths` is IGNORED. Omitted on every non-backfill
     * path (first/incremental/scheduled sync), which is unchanged.
     */
    backfill?: {since: string; until: string};
}

/**
 * The `since` cursor for a provider's FIRST sync given a window in whole months:
 * `now - months`, in UTC ISO. `undefined` months (or a value outside the hard
 * bounds / a bad `now`) falls back to '' — i.e. walk all history — so a caller that
 * skips the window, or an out-of-range value that slipped past validation, degrades
 * to the legacy behavior rather than importing a wrong window. Exported for tests.
 *
 * The bounds/integer/NaN checks are a DELIBERATE belt-and-suspenders backstop: the
 * only production caller is the API route, which already rejects out-of-range values
 * fail-closed (parseFirstSyncWindowMonths). Keeping this a total, self-defending pure
 * function lets it stand alone and honors the project rule to range-validate numeric
 * config on both bounds even if a future caller forgets to.
 */
export function firstSyncSince(now: string, months: number | undefined): string {
    if (
        months === undefined ||
        !Number.isInteger(months) ||
        months < FIRST_SYNC_WINDOW_MIN_MONTHS ||
        months > FIRST_SYNC_WINDOW_MAX_MONTHS
    ) {
        return '';
    }
    // '' when `now` is unparseable (an out-of-range/bad value degrades to walk-all,
    // matching the pre-refactor behavior).
    return subtractUtcMonths(now, months) ?? '';
}

/**
 * `now` minus `months` whole months, in UTC ISO — or null if `now` is unparseable.
 * The single home for this arithmetic, shared by the first-sync window
 * ({@link firstSyncSince}) and the "sync older history" backfill target (#229,
 * {@link getEarliestSyncedWatermark} and the backfill route). `months` must be a
 * validated non-negative integer; callers own range-validation.
 *
 * UTC month arithmetic (all toprope timestamps are UTC); JS handles the year
 * rollover when the subtraction crosses January. Day-of-month is preserved, so a
 * long-month `now` (e.g. Mar 31) minus 1 lands on the normalized short-month date
 * (Mar 3), making the window a few days SHORTER than a strict calendar month —
 * never longer. That direction is safe (it can only under-import, never re-drain
 * quota / re-cover an already-synced span), and the window edge is inherently
 * coarse, so we accept the drift.
 */
export function subtractUtcMonths(now: string, months: number): string | null {
    const start = new Date(now);
    if (Number.isNaN(start.getTime())) return null;
    start.setUTCMonth(start.getUTCMonth() - months);
    return start.toISOString();
}

// Mutate-then-emit reporter threaded through the pipeline: applies `mutate` to
// the run's single progress state, then emits a defensive copy so a listener
// can never mutate pipeline state. Undefined when no listener was passed, so
// the scheduled path pays nothing.
type ProgressReporter = (mutate: (progress: GitSyncProgress) => void) => void;

export function syncStateKey(providerType: GitProviderType, identifier: string): string {
    return `git_last_sync:${providerType}:${identifier}`;
}

/**
 * The sync_state key for a provider's EARLIEST-synced watermark (#229) — the
 * oldest instant whose activity has been imported. Parallel to the forward cursor
 * {@link syncStateKey} (`git_last_sync:…`); only the "sync older history" backfill
 * reads/writes it. Disjoint namespace so it can never be confused with the cursor.
 */
export function earliestSyncStateKey(providerType: GitProviderType, identifier: string): string {
    return `git_earliest_sync:${providerType}:${identifier}`;
}

/**
 * Whether a provider's earliest-synced floor is UNKNOWN and unrecoverable (#233) —
 * i.e. it is LEGACY, first synced before #229 began recording the floor.
 *
 * DERIVED, not stored. `cursor present ∧ watermark absent` ⟺ legacy, because a
 * post-#229 first sync writes BOTH inside the same deferred closure, applied in the
 * same snapshot transaction (see the `cursorAdvances` push in {@link GitSync.syncProviders});
 * and that closure is the ONLY writer of a `git_last_sync:` cursor. So for any provider
 * synced by this build the two keys can never be out of step — only a provider whose
 * first sync predates that build can hold a cursor with no floor.
 *
 * Deriving beats seeding a marker row at upgrade time: a marker freezes the legacy set
 * at one instant and then needs reconciling whenever a real floor is recorded, which is
 * a second source of truth that can drift. The predicate is true at EVERY instant, so it
 * also fails closed on a cursor-without-floor that appears later (a partial restore, a
 * hand-edited row, a future code path) — states a migration-seeded marker would miss and
 * silently fall back to the too-recent guess for.
 */
function isEarliestFloorUnknown(
    db: Database.Database,
    providerType: GitProviderType,
    identifier: string,
): boolean {
    // Falsy, not just null: a blank-valued floor row is no floor at all, and treating it
    // as present here (while getEarliestSyncedWatermark's `if (stored)` treats it as
    // absent) would disagree with that reader and fail OPEN — back to the too-recent
    // guess for a provider that has a cursor, the exact defect this exists to close.
    return (
        !getSyncStateValue(db, earliestSyncStateKey(providerType, identifier)) &&
        getSyncStateValue(db, syncStateKey(providerType, identifier)) !== null
    );
}

/**
 * Every git sync-state cursor key currently stored, resolved in ONE query. The
 * admin list uses this to tell whether a provider's FIRST sync is still pending
 * (no cursor yet) — the real gate the "Sync now" window input keys off. Read once
 * per list request and membership-tested in memory, never per-row: a stored cursor
 * (written by the pipeline on EVERY path — sync-now, scheduler, and CLI) is the
 * authoritative "has synced" signal, and it diverges from the row's `last_sync_at`
 * column (which only the sync-now route writes).
 */
export function loadProviderCursorKeys(db: Database.Database): Set<string> {
    const rows = db
        .prepare("SELECT key FROM sync_state WHERE key LIKE 'git_last_sync:%'")
        .all() as Array<{key: string}>;
    return new Set(rows.map((r) => r.key));
}

// ─── Stalled-provider detection (#235) ────────────────────────────────────────
//
// #231 made a provider's cursor advance atomic with — and conditional on — a
// COMPLETE fetch: any `listRepos`/`getCommits` failure holds the WHOLE provider's
// cursor so its window re-covers next run rather than leaving a silent snapshot
// gap. That is the right correctness trade-off, but it has an operational cost this
// tracks: one repo that fails permanently (oversized, permission drift,
// deleted-but-still-listed) holds the cursor forever, so no developer on ANY of
// that provider's other repos gets a new snapshot until a human excludes it.
//
// `errors[]` alone cannot say that. In a multi-provider run a healthy sibling still
// writes, so a permanent stall is shaped exactly like a transient per-repo hiccup —
// the run "succeeded". The counter below is the missing distinct signal: it makes
// "provider X's cursor has not advanced for N consecutive runs" queryable, which is
// what `toprope status` / `toprope doctor` report.

/**
 * Consecutive held-cursor runs before a provider is REPORTED as stalled.
 *
 * Not 1: a single held run is the common, self-healing case (a rate-limit blip, a
 * flaky 502) and alerting on it would train the reader to ignore the signal. Three
 * consecutive runs cannot be explained away — whatever the repo is doing, it is not
 * transient, and every run since the first has imported nothing.
 */
export const GIT_STALL_ALERT_RUNS = 3;

/**
 * The sync_state key for a provider's consecutive-stalled-runs counter (#235).
 * A THIRD namespace, disjoint from both the forward cursor {@link syncStateKey}
 * (`git_last_sync:…`) and the earliest watermark {@link earliestSyncStateKey}
 * (`git_earliest_sync:…`), so a stall row can never be read as either.
 */
export function stallStateKey(providerType: GitProviderType, identifier: string): string {
    return `git_stall:${providerType}:${identifier}`;
}

/** A provider's current consecutive-stall streak (#235). */
export interface GitProviderStall {
    /** Consecutive runs that held this provider's cursor. Always >= 1. */
    runs: number;
    /** UTC ISO instant of the FIRST run in the current streak — "stalled since". */
    since: string;
}

/**
 * Decode a stored stall row, or null when there is no usable streak.
 *
 * `sync_state.value` is an unconstrained TEXT column, so the stored JSON is parsed
 * and RANGE-VALIDATED rather than cast: a row that is absent, unparseable, or
 * carries a non-positive/non-integer `runs` or an unparseable `since` is treated as
 * "no streak". That is deliberately self-healing rather than fail-closed — this is
 * a diagnostic counter, not an authorization gate, and the alternative (reporting a
 * corrupt row as a stall of `NaN` runs) is a false alarm that no remedy clears. The
 * next incomplete run rewrites the row from scratch; the next complete run deletes
 * it.
 */
function parseStall(value: string | null): GitProviderStall | null {
    if (!value) return null;
    let raw: unknown;
    try {
        raw = JSON.parse(value);
    } catch {
        return null;
    }
    if (typeof raw !== 'object' || raw === null) return null;
    const {runs, since} = raw as {runs?: unknown; since?: unknown};
    if (!Number.isInteger(runs) || (runs as number) < 1) return null;
    if (typeof since !== 'string' || Number.isNaN(Date.parse(since))) return null;
    return {runs: runs as number, since};
}

/** The current stall streak for one provider (#235), or null if it is not stalled. */
export function getProviderStall(
    db: Database.Database,
    providerType: GitProviderType,
    identifier: string,
): GitProviderStall | null {
    return parseStall(getSyncStateValue(db, stallStateKey(providerType, identifier)));
}

/**
 * Record that this run HELD this provider's cursor (#231's incomplete-fetch path):
 * open a streak at 1, or extend the open one, preserving its original `since`.
 *
 * Read-modify-write — MUST run inside the sync write transaction (see the
 * `stallUpdates` push in {@link GitSync.syncProviders}), which is also what makes it
 * atomic with the cursor decision it mirrors.
 *
 * On concurrency, precisely: better-sqlite3's `db.transaction()` issues a DEFERRED
 * BEGIN, so it does NOT serialize two concurrent runs — both can read `runs: 2`. What
 * it guarantees is that the second one to WRITE fails fast (SQLITE_BUSY) and rolls
 * back whole, so the outcome is "one run's accounting, or none" rather than a lost
 * update. Correct, but by fail-fast, not by mutual exclusion — don't read this as a
 * lock.
 */
function recordProviderStallRun(
    db: Database.Database,
    providerType: GitProviderType,
    identifier: string,
    now: string,
): void {
    const open = getProviderStall(db, providerType, identifier);
    const next: GitProviderStall = open
        ? {runs: open.runs + 1, since: open.since}
        : {runs: 1, since: now};
    setSyncStateValue(db, stallStateKey(providerType, identifier), JSON.stringify(next));
}

/**
 * Clear a provider's stall streak — its window was covered completely, so the
 * cursor is advancing again. A no-op DELETE when it was never stalled, which is the
 * overwhelmingly common case and cheaper than reading first to decide.
 */
function clearProviderStall(
    db: Database.Database,
    providerType: GitProviderType,
    identifier: string,
): void {
    db.prepare('DELETE FROM sync_state WHERE key = ?').run(stallStateKey(providerType, identifier));
}

/**
 * Delete the three `sync_state` rows this pipeline keys to ONE provider container
 * (#262) — the forward cursor ({@link syncStateKey}), the earliest-synced watermark
 * ({@link earliestSyncStateKey}) and the stall counter ({@link stallStateKey}) — so a
 * REMOVED provider does not leave cursors behind for a later provider on the same
 * `type:container` to silently inherit. Returns the number of rows removed.
 *
 * Keys are matched EXACTLY, never by prefix: a `LIKE 'git_last_sync:github:acme%'` scan
 * would also delete `acme-labs`' cursor, stranding a sibling's history.
 *
 * UNGUARDED. These keys are container-scoped, not row-scoped, so they are SHARED state,
 * and the forward cursor is the pipeline's proof that already-imported commit windows
 * are disjoint. Callers must establish both preconditions — no other provider resolves
 * to this container, and re-importing the cursor's window cannot double-count retained
 * `raw_author_daily` rows. See `deleteProviderAndSyncState` in providers/delete.ts,
 * which owns the guard, the hazard analysis and the surrounding transaction.
 */
export function deleteProviderSyncState(
    db: Database.Database,
    providerType: GitProviderType,
    identifier: string,
): number {
    return db
        .prepare('DELETE FROM sync_state WHERE key IN (?, ?, ?)')
        .run(
            syncStateKey(providerType, identifier),
            earliestSyncStateKey(providerType, identifier),
            stallStateKey(providerType, identifier),
        ).changes;
}

/**
 * A provider that is ADVANCING but is still more than one cap-width behind the
 * present (#235) — a bounded catch-up in progress.
 *
 * This state is CREATED by {@link GIT_CATCHUP_WINDOW_MAX_DAYS}. Before the cap, a
 * complete run always reached `now`, so "the run completed" and "the data is
 * current" were the same statement. They no longer are: a provider recovering from
 * a 200-day stall completes every run and clears its stall streak while its cursor
 * is still ~170 days back, and needs ~6 more runs to catch up. Reporting only the
 * stall streak would call that provider healthy and print "advancing" — technically
 * true, and exactly the false all-clear an operator would act on right after
 * excluding the broken repo that caused the stall.
 */
export interface LaggingProvider {
    type: GitProviderType;
    identifier: string;
    /** The provider's current forward cursor (UTC ISO) — the instant it has synced to. */
    cursor: string;
    /** Whole days between {@link cursor} and now. Always > GIT_CATCHUP_WINDOW_MAX_DAYS. */
    daysBehind: number;
}

/** A provider whose cursor has been stuck long enough to report (#235). */
export interface StalledProvider {
    type: GitProviderType;
    identifier: string;
    /** Consecutive runs that held the cursor — always >= {@link GIT_STALL_ALERT_RUNS}. */
    runs: number;
    /** UTC ISO instant this streak began. */
    since: string;
}

/**
 * The complete git-sync health of an already-resolved provider set (#248), as ONE
 * classification rather than three separate readers over the same two row sets.
 *
 * Every configured provider lands in exactly one of four disjoint states, decided in
 * a single pass:
 * - {@link stalled}: an open streak of >= {@link GIT_STALL_ALERT_RUNS} held runs —
 *   cursor held, importing nothing. The most specific, most actionable signal, so it
 *   wins over every other classification.
 * - {@link lagging}: advancing (no open streak) but with a cursor still more than one
 *   {@link GIT_CATCHUP_WINDOW_MAX_DAYS} cap-width behind `now` — a bounded catch-up.
 * - {@link current}: the POSITIVE check — a cursor within one cap-width of now (and not
 *   ahead of it), with no open streak. This is the only state that lets `doctor` claim
 *   the data is actually current instead of inferring it from two readers coming back
 *   empty (#248).
 * - {@link neverSynced}: no stored cursor at all — a pending first sync.
 *
 * A provider can also be NONE of these: an open sub-threshold streak (1-2 held runs)
 * holds the cursor, so it is neither advancing (excluded from lagging) nor current,
 * and an unreadable or future-dated cursor cannot prove currency either. Those fall
 * through every bucket — which is exactly the point of the positive check: `current`
 * is COUNTED, never inferred, so a held-but-not-yet-reported provider is correctly not
 * counted as healthy. `current + lagging + neverSynced + stalled` therefore need NOT
 * equal the provider count; the remainder is the "not yet current" set doctor names.
 */
export interface GitSyncHealth {
    stalled: StalledProvider[];
    lagging: LaggingProvider[];
    /** Count of providers proven current — cursor within one cap-width of now, no open streak. */
    current: number;
    /** Count of providers with no stored cursor — a pending first sync. */
    neverSynced: number;
}

/**
 * Classify every CONFIGURED provider's sync health in ONE pass (#248) — the single
 * canonical reader shared by `toprope doctor` and `toprope status`, so both report the
 * identical set on the identical thresholds.
 *
 * Collapses the former three readers (`loadStalledProviders`, `loadLaggingProviders`,
 * `countNeverSyncedProviders`), which every production caller invoked together over the
 * same `providerConfigs` and which read the `git_stall:%` set twice per run. The two
 * row sets are resolved in exactly ONE query each and membership-tested in memory
 * against the caller's already-resolved provider set — never a query per provider.
 * Filtering to that set (rather than returning every stored row) is what stops a stall
 * or cursor row orphaned by a deleted/renamed provider being reported forever against a
 * target that no longer exists. Order of {@link GitSyncHealth.stalled} and
 * {@link GitSyncHealth.lagging} follows `providerConfigs`, so output is deterministic.
 *
 * Total by construction: an unparseable `now`, or an unparseable/future-dated cursor,
 * yields no lagging entry and no `current` credit for that provider — a garbage or
 * skewed timestamp can never prove currency. See {@link GitSyncHealth} for the full
 * state machine and why the four states need not sum to the provider count.
 */
export function loadGitSyncHealth(
    db: Database.Database,
    providerConfigs: GitProviderConfig[],
    now: string,
): GitSyncHealth {
    const nowMs = Date.parse(now);
    const nowValid = !Number.isNaN(nowMs);

    const cursorByKey = new Map(
        (
            db
                .prepare("SELECT key, value FROM sync_state WHERE key LIKE 'git_last_sync:%'")
                .all() as Array<{key: string; value: string}>
        ).map((r) => [r.key, r.value]),
    );
    const stallByKey = new Map(
        (
            db
                .prepare("SELECT key, value FROM sync_state WHERE key LIKE 'git_stall:%'")
                .all() as Array<{key: string; value: string}>
        ).map((r) => [r.key, r.value]),
    );

    const capMs = GIT_CATCHUP_WINDOW_MAX_DAYS * 86_400_000;
    const stalled: StalledProvider[] = [];
    const lagging: LaggingProvider[] = [];
    let current = 0;
    let neverSynced = 0;

    for (const pc of providerConfigs) {
        const identifier = providerIdentifier(pc);
        const stall = parseStall(stallByKey.get(stallStateKey(pc.type, identifier)) ?? null);

        // Reportable stall wins over every other state — the most specific, most
        // actionable signal, and reported even when the provider also has no cursor.
        if (stall && stall.runs >= GIT_STALL_ALERT_RUNS) {
            stalled.push({type: pc.type, identifier, runs: stall.runs, since: stall.since});
            continue;
        }

        const cursor = cursorByKey.get(syncStateKey(pc.type, identifier));
        if (!cursor) {
            // No cursor at all — a pending first sync, not evidence of health.
            neverSynced++;
            continue;
        }

        // An OPEN sub-threshold streak (1-2 held runs) holds the cursor: not advancing
        // (so not lagging) and not current (its data may be months old), it falls
        // through to the "not yet current" remainder until it recovers or trips the
        // stall alert at run GIT_STALL_ALERT_RUNS. Same exclusion the old lagging
        // reader applied — keyed on an OPEN streak, not the reporting threshold.
        if (stall) continue;

        const cursorMs = Date.parse(cursor);
        if (Number.isNaN(cursorMs) || !nowValid) continue; // Cannot place the cursor.

        const behindMs = nowMs - cursorMs;
        if (behindMs > capMs) {
            lagging.push({
                type: pc.type,
                identifier,
                cursor,
                daysBehind: Math.floor(behindMs / 86_400_000),
            });
            continue;
        }
        // A future-dated cursor (behindMs < 0) is clock skew, not proof of currency —
        // clamp it out rather than crediting it. Everything remaining is a cursor within
        // one cap-width of now with no open streak: the positive currency check.
        if (behindMs < 0) continue;
        current++;
    }

    return {stalled, lagging, current, neverSynced};
}

interface SyncStateRow {
    value: string;
}

// The single read/write pair for every `sync_state` row this module owns — the
// forward cursor, the earliest-synced watermark, and the stall counter. Named for
// the VALUE they move rather than for any one caller's meaning: not every row here
// holds a timestamp (the stall counter is JSON), and a `…LastSyncTime` name on the
// generic accessor would make those call sites read as a lie.
function getSyncStateValue(db: Database.Database, key: string): string | null {
    const row = db
        .prepare('SELECT value FROM sync_state WHERE key = ?')
        .get(key) as SyncStateRow | undefined;
    return row?.value ?? null;
}

function setSyncStateValue(db: Database.Database, key: string, value: string): void {
    db.prepare(
        'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
}

// Read/write the per-provider earliest-synced watermark (#229). Thin semantic
// wrappers over the generic sync_state accessors above so the "earliest" intent
// is explicit at call sites and the key derivation lives in exactly one place
// ({@link earliestSyncStateKey}) rather than being spelled out per call.
function getProviderEarliestSyncTime(
    db: Database.Database,
    providerType: GitProviderType,
    identifier: string,
): string | null {
    return getSyncStateValue(db, earliestSyncStateKey(providerType, identifier));
}

function setProviderEarliestSyncTime(
    db: Database.Database,
    providerType: GitProviderType,
    identifier: string,
    time: string,
): void {
    setSyncStateValue(db, earliestSyncStateKey(providerType, identifier), time);
}

/**
 * Whether a provider's earliest-synced floor is known (#233). `unknown` is the LEGACY
 * case — a provider whose first sync predates #229's floor recording. Callers must
 * branch on `kind` rather than treat a missing watermark as "guess a default": the
 * guess is systematically too recent, which is the additive double-count direction.
 */
export type EarliestSyncedWatermark =
    | {kind: 'exact'; watermark: string}
    | {kind: 'unknown'};

/**
 * The current earliest-synced watermark for a provider — the oldest instant whose
 * activity has already been imported — as UTC ISO. The "sync older history"
 * backfill (#229) extends BELOW this edge: it fetches the strictly-older slice
 * [new_target, watermark], disjoint from everything already stored, so the
 * additive snapshot merge stays correct. The backfill route calls this to both
 * enforce the overlap guard (`new_target < watermark`) and set the fetch's upper
 * bound.
 *
 * The watermark is recorded at FIRST-SYNC time (runSync writes the real floor the
 * first forward sync reached — the clamped window start, or {@link
 * EARLIEST_SYNC_EPOCH} for a walk-all sync) and lowered by every backfill, so for
 * any provider synced by this build it is EXACT — the overlap guard never overlaps
 * an already-imported span. That is the `exact` result.
 *
 * LEGACY PROVIDERS return `unknown` (#233) — see {@link isEarliestFloorUnknown} for how
 * they are identified. Such a provider's true floor (`first_sync_time − window`) is
 * unrecoverable: sync_state stores neither the first-sync instant nor the window it
 * used, and git_snapshots merges every provider into UNIQUE(developer_id, date) rows,
 * so the earliest activity date can't be attributed back to one provider.
 *
 * THIS IS THE RATIONALE THE REST OF THE FEATURE POINTS AT. The previous lazy default
 * (`now` − the #228 window) was a guess, and it is systematically TOO RECENT — the true
 * floor is older by however long ago the provider first synced. Too-recent is precisely
 * the direction that makes the backfill slice OVERLAP already-imported activity, which
 * the additive merge then double-counts, permanently and silently. Guessing too-old is
 * no better (it makes the span between the guess and the true floor un-importable
 * forever), so there is no safe guess: we fail closed and let an admin who knows the
 * real floor declare it ({@link declareEarliestSyncedFloor}, `toprope git
 * set-history-floor`).
 *
 * A provider with NO cursor and no floor is ASSUMED never-synced, and returns the window
 * its first sync would use. Two caveats on that assumption, neither introduced here:
 *  - It is the DEFAULT window. The first sync's window is caller-supplied (1–60 months),
 *    so a backfill run BEFORE that first sync (API-only — the UI hides the control until
 *    a provider has synced) can leave a gap or an overlap against whatever window the
 *    later first sync actually uses. Pre-existing from #229.
 *  - Renaming a provider's container (a supported PATCH) ORPHANS its cursor and floor
 *    rows rather than re-keying them, so the renamed provider reads as never-synced here
 *    while its old activity is still stored. Pre-existing #228-era: the next forward sync
 *    already re-imports its window as a "first" sync.
 */
export function getEarliestSyncedWatermark(
    db: Database.Database,
    providerType: GitProviderType,
    identifier: string,
    now: string,
): EarliestSyncedWatermark {
    const stored = getProviderEarliestSyncTime(db, providerType, identifier);
    if (stored) return {kind: 'exact', watermark: stored};
    // Legacy: cursor exists but the floor it reached was never recorded (#233).
    if (isEarliestFloorUnknown(db, providerType, identifier)) return {kind: 'unknown'};
    // Never-synced provider: nothing imported yet, so the window its first sync will
    // use is the honest floor. firstSyncSince returns '' only when `now` is
    // unparseable; fall back to `now` (a zero-width window the caller's overlap guard
    // rejects) rather than '', which downstream would read as "walk all history".
    return {
        kind: 'exact',
        watermark: firstSyncSince(now, FIRST_SYNC_WINDOW_DEFAULT_MONTHS) || now,
    };
}

/**
 * Declare a LEGACY provider's true earliest-synced floor (#233) — the admin-supplied
 * recovery path for a floor {@link getEarliestSyncedWatermark} refuses to guess. Writes
 * the exact watermark, restoring the provider's ability to back-extend its window.
 *
 * Only ever call this with a floor the admin actually knows (when the provider first
 * synced, minus the window that run used). Declaring a floor NEWER than the truth makes
 * the next backfill re-cover already-imported activity and double-count it; declaring
 * one OLDER silently strands the span in between. Hence: no default and no inference —
 * an explicit human assertion.
 *
 * By default this refuses a provider whose floor is already recorded, because clobbering
 * a floor EARNED by a real sync is exactly the corruption the feature guards. But a
 * hand-typed floor is fallible, and refusing every overwrite would make the admin's own
 * typo permanent — the mistake would only surface as inflated counts after the backfill
 * ran. `force` is the escape hatch: it says "I know a floor is recorded and I am
 * replacing it", which is correctable-by-design for a declared floor and a loaded gun for
 * an earned one. That is why it is opt-in per call and never the default.
 *
 * `force` overrides ONLY that refusal. It never waives the existence requirement: a
 * provider with neither a cursor nor a floor has synced nothing, so there is no floor to
 * describe and the identifier is far more likely a typo than a real target. Writing one
 * anyway would invent an `exact` floor out of thin air — and a first sync will not
 * correct it (it only records a floor when none is stored), so the span between the
 * invented floor and the window that sync actually reached would be permanently
 * un-importable: the backfill only ever walks BELOW the floor. Hence `never_synced` is
 * unconditional.
 */
export function declareEarliestSyncedFloor(
    db: Database.Database,
    providerType: GitProviderType,
    identifier: string,
    floor: string,
    now: string,
    options?: {force?: boolean},
): {
    ok: true;
} | {
    ok: false;
    reason: 'not_legacy' | 'never_synced' | 'invalid_floor' | 'future_floor';
} {
    // Must be a real UTC ISO instant: this value is compared as an ISO string by the
    // overlap guard, so a loosely-parsed date would corrupt every later comparison.
    if (!isUtcIsoInstant(floor)) return {ok: false, reason: 'invalid_floor'};
    // Bound the upper edge: a floor at/after `now` claims the provider imported nothing
    // (or imported the future). Both make every later backfill target look "older than
    // the floor" and pass the overlap guard onto already-synced spans. Compared as
    // INSTANTS so the guard is total for anything isUtcIsoInstant admits; `now` is
    // rejected outright if unparseable rather than letting NaN compare false and pass.
    if (Number.isNaN(Date.parse(now))) return {ok: false, reason: 'future_floor'};
    if (Date.parse(floor) >= Date.parse(now)) return {ok: false, reason: 'future_floor'};
    // Check-then-act: read the state and write the floor in ONE transaction so a
    // concurrent declare/first-sync can't land between them and clobber a real floor.
    return db.transaction(
        (): {ok: true} | {ok: false; reason: 'not_legacy' | 'never_synced'} => {
            // Falsy, matching isEarliestFloorUnknown: a blank row is not a floor.
            const hasFloor = Boolean(getProviderEarliestSyncTime(db, providerType, identifier));
            const hasCursor =
                getSyncStateValue(db, syncStateKey(providerType, identifier)) !== null;
            // Nothing synced under this key — refuse even under force (see above).
            if (!hasFloor && !hasCursor) return {ok: false, reason: 'never_synced'};
            // A floor is recorded: only an explicit force may replace it.
            if (hasFloor && !options?.force) return {ok: false, reason: 'not_legacy'};
            setProviderEarliestSyncTime(db, providerType, identifier, floor);
            return {ok: true};
        },
    )();
}

/**
 * True iff `value` is a canonical UTC ISO instant (what every stored timestamp is).
 * Both checks earn their place, and each catches what the other cannot:
 *  - the REGEX pins the shape to exactly 4 digits + millis + 'Z', excluding ISO 8601
 *    expanded/negative years ('+010000-01-01T00:00:00.000Z'), which parse and round-trip
 *    cleanly yet break the ISO-string ordering every watermark comparison relies on;
 *  - the ROUND-TRIP rejects values that match the shape but are not the instant they
 *    spell — '2025-02-30T00:00:00.000Z' parses and normalizes to 2025-03-02;
 *  - the NaN check guards `toISOString()`, which throws RangeError on an Invalid Date.
 */
function isUtcIsoInstant(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
    const parsed = new Date(value);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/**
 * Derive the immutable raw-author key a day's metrics are RETAINED under (#253).
 *
 * `aggregateDailyMetrics` groups by `AnalysisCommit.authorLogin`, which
 * `toAnalysisCommit` fills as `username || email` — so a "login" that is byte-equal to
 * the author's email means the commit carried NO provider username. Passing it through
 * as a login would key an email-only author as `${provider}:login:alice@example.com`,
 * an identity shape nothing else in the system produces. Detect that case and let
 * {@link rawAuthorKeyFor} take its email branch, so the stored key matches the identity
 * the resolver actually looks the author up by.
 *
 * Returns null only for a truly anonymous author (no login, no email), whose day is
 * skipped: there is no stable key to retain it under, and bucketing every such commit
 * together would attribute unrelated people to one identity.
 */
function retentionKeyFor(
    providerType: GitProviderType,
    analysisLogin: string,
    email: string | null,
): string | null {
    const isEmailFallback = email !== null && analysisLogin.toLowerCase() === email.toLowerCase();
    return rawAuthorKeyFor(providerType, isEmailFallback ? null : analysisLogin, email);
}

// Raw container identifier (org/workspace/group) for a provider — the canonical
// helper, shared with the resolver so the mapping lives in one place.
const providerIdentifier = providerContainer;

function applyRepoFilter(
    repos: string[],
    include: string[] | undefined,
    exclude: string[] | undefined,
): string[] {
    let filtered = repos;
    if (include && include.length > 0) {
        filtered = filtered.filter((r) => include.includes(r));
    }
    if (exclude && exclude.length > 0) {
        filtered = filtered.filter((r) => !exclude.includes(r));
    }
    return filtered;
}

function parseRepoFilters(rawRepos: string[] | undefined): {include: string[]; exclude: string[]} {
    const include: string[] = [];
    const exclude: string[] = [];
    for (const entry of rawRepos ?? []) {
        if (entry.startsWith('exclude:')) {
            exclude.push(entry.slice('exclude:'.length));
        } else if (entry.startsWith('include:')) {
            include.push(entry.slice('include:'.length));
        } else {
            include.push(entry);
        }
    }
    return {include, exclude};
}

// Per-PR normalized facts for pr_records (Task 5.2). Built in fetchProviderData
// where the raw GitPR + its review comments/verdicts are in hand, then resolved
// to a developer and upserted in sync().
interface PRRecordInput {
    provider: GitProviderType;
    repo: string;
    prId: string;
    authorLogin: string | null;
    authorEmail: string | null;
    state: string;
    createdAt: string;
    mergedAt: string | null;
    closedAt: string | null;
    reviewCommentCount: number;
    changesRequestedCount: number;
    /** Normalized review verdict events (approved / changes_requested). */
    reviewEventCount: number;
    // Whether the comment / verdict fetches succeeded. On failure the counts
    // above are zero BY ABSENCE, not by observation — the upsert must not let
    // them clobber previously-observed values (a transient API failure would
    // otherwise rewrite real review history as "clean reviews").
    commentsOk: boolean;
    reviewsOk: boolean;
}

interface ProviderFetchResult {
    commits: AnalysisCommit[];
    prs: AnalysisPR[];
    reviewComments: AnalysisReviewComment[];
    prRecords: PRRecordInput[];
    errors: string[];
    stateKey: string;
    /** The provider's container id — the second half of its sync-state keys, so
     *  runSync can lower the earliest watermark (#229) without re-deriving it. */
    identifier: string;
    /**
     * The floor a FIRST forward sync actually reached (#229) — the clamped window
     * start (`since`), or {@link EARLIEST_SYNC_EPOCH} for a walk-all sync — so
     * runSync can record the true earliest-synced watermark and the "sync older
     * history" backfill's default is exact rather than guessed. `null` on every
     * non-first-sync path (a backfill, an incremental run, or a first sync that
     * failed before any repo was processed), where the watermark must not be
     * (re)written from the forward path.
     */
    firstSyncFloor: string | null;
    /**
     * The instant this provider's forward cursor advances to on a COMPLETE run —
     * the effective `until` the fetch actually covered.
     *
     * `now` on every normal run (first sync, or a cursor within
     * {@link GIT_CATCHUP_WINDOW_MAX_DAYS} of now), and an EARLIER, capped instant
     * when a held cursor left a wider span to re-cover (#235). Threaded out rather
     * than re-deriving `now` at the advance: a capped run covered `[since, until]`
     * only, so advancing to `now` would skip `[until, now]` entirely — the silent
     * permanent snapshot gap #231 exists to prevent, reintroduced by the very cap
     * meant to bound the stall.
     *
     * Ignored on the backfill path, which never advances the forward cursor.
     */
    forwardCursorTarget: string;
    /**
     * True iff every fetch feeding the ADDITIVE commit-derived snapshot succeeded
     * for this provider — `listRepos` AND every repo's `getCommits`. When false the
     * run must NOT advance this provider's cursor/watermark AND must NOT write its
     * snapshots (#231): commit counts are ADDED across runs (see
     * {@link remergeStoredSnapshot}), so persisting the partially-fetched window now
     * and re-fetching it next run would double-count. The only gap-free option is to
     * discard this provider's partial data and re-cover the whole window next run —
     * loud (errors surface every run) rather than a silent, permanent snapshot gap.
     *
     * Best-effort fetches that are idempotent under re-delivery (PRs/review comments
     * are max()-merged; commit diffs fall back to empty) do NOT clear this flag:
     * holding the cursor for them would force an additive commit re-fetch, which is
     * strictly worse than the bounded, self-healing undercount they already accept.
     */
    complete: boolean;
}

async function fetchProviderData(
    providerConfig: GitProviderConfig,
    now: string,
    db: Database.Database,
    report?: ProgressReporter,
    firstSyncWindowMonths?: number,
    backfill?: {since: string; until: string},
): Promise<ProviderFetchResult> {
    const errors: string[] = [];
    const allCommits: AnalysisCommit[] = [];
    const allPRs: AnalysisPR[] = [];
    const allReviewComments: AnalysisReviewComment[] = [];
    const allPRRecords: PRRecordInput[] = [];

    const provider = createGitProvider(providerConfig);
    const providerType = provider.name;
    const identifier = providerIdentifier(providerConfig);
    const stateKey = syncStateKey(providerType, identifier);
    // Window selection:
    //   - Backfill (#229): a fixed, strictly-older slice [since, until] the caller
    //     already validated as disjoint from stored activity. It ignores the forward
    //     cursor entirely (it walks BELOW the earliest watermark, not above `now`).
    //   - Otherwise: first sync (no stored cursor) optionally clamps the window to
    //     the last N months so run #1 doesn't walk the whole history; once a cursor
    //     exists it is the source of truth and firstSyncWindowMonths is IGNORED —
    //     re-widening `since` against additive snapshots would double-count (see
    //     SyncRunOptions).
    const storedCursor = getSyncStateValue(db, stateKey);
    const since = backfill ? backfill.since : (storedCursor ?? firstSyncSince(now, firstSyncWindowMonths));
    // This run is a FIRST forward sync when it is not a backfill and no cursor exists
    // yet. Only then does runSync record the earliest-synced watermark (#229): the
    // real floor `since` reached, mapped to the epoch sentinel for a walk-all ('').
    const isFirstSync = !backfill && storedCursor === null;
    const firstSyncFloor = isFirstSync ? (since === '' ? EARLIEST_SYNC_EPOCH : since) : null;
    // Commit fetch upper bound:
    //   - Backfill (#229): the caller's watermark.
    //   - Resuming a stored cursor: `now`, CAPPED to GIT_CATCHUP_WINDOW_MAX_DAYS past
    //     the cursor (#235) so a long-held cursor re-fetches a bounded span per run
    //     instead of an ever-widening one. Chunked, never skipped — the run advances
    //     the cursor to this `until` (see forwardCursorTarget), so the next run
    //     resumes exactly here and no span is lost.
    //   - First sync (no cursor): `now`. The cap deliberately does NOT apply — the
    //     window is already bounded by firstSyncWindowMonths, and capping it would
    //     silently turn a requested 6-month import into a 30-day one.
    // `until` bounds BOTH the commit walk (with its per-commit getCommitDiff fan-out)
    // and — since #247 — the per-PR review fan-out below, which is filtered to
    // `updatedAt <= until` (prWithinFetchWindow). See GIT_CATCHUP_WINDOW_MAX_DAYS for the
    // full scope of what is and is not bounded.
    const until = backfill
        ? backfill.until
        : storedCursor !== null
          ? catchUpUntil(storedCursor, now)
          : now;

    const rawRepos = 'repos' in providerConfig ? providerConfig.repos : undefined;
    const excludeRepos =
        providerConfig.type === 'github' || providerConfig.type === 'bitbucket'
            ? providerConfig.exclude_repos
            : undefined;
    const {include: includeRepos, exclude: excludeFromList} = parseRepoFilters(rawRepos);
    const allExclude = [...excludeFromList, ...(excludeRepos ?? [])];

    report?.((p) => {
        p.stage = 'listing_repos';
        p.current_repo = null;
    });
    let repoNames: string[] = [];
    try {
        const repos = await provider.listRepos();
        repoNames = repos.filter((r) => !r.isArchived).map((r) => r.name);
    } catch (err) {
        errors.push(
            `[${providerType}] Failed to list repos: ${err instanceof Error ? err.message : String(err)}`,
        );
        return {
            commits: allCommits,
            prs: allPRs,
            reviewComments: allReviewComments,
            prRecords: allPRRecords,
            errors,
            stateKey,
            identifier,
            // listRepos failed before any repo was processed — nothing was imported,
            // so don't claim a synced-back-to floor even on a first sync.
            firstSyncFloor: null,
            // Unused on this path (`complete: false` means no cursor advances), but the
            // window this run would have covered is still the honest value to report.
            forwardCursorTarget: until,
            // The window was not covered at all — hold the cursor so it retries (#231).
            complete: false,
        };
    }

    const reposToSync = applyRepoFilter(
        repoNames,
        includeRepos.length > 0 ? includeRepos : undefined,
        allExclude.length > 0 ? allExclude : undefined,
    );

    // Accumulate (+=) rather than assign, matching the other counters' cumulative
    // semantics. Today the only listener-bearing caller is the single-provider
    // sync-now trigger (so this reads as that provider's repo count); a future
    // multi-provider listener would also see the stage revisit 'listing_repos'
    // per provider — design that presentation when such a caller exists.
    report?.((p) => {
        p.stage = 'fetching';
        p.repos_total = (p.repos_total ?? 0) + reposToSync.length;
    });

    // Cleared the moment any repo's commit fetch throws: a single failed repo leaves
    // the provider's [since, until] window incompletely covered, so runSync must hold
    // the whole provider's cursor and drop its partial snapshots (#231).
    let commitsComplete = true;
    for (const repoName of reposToSync) {
        report?.((p) => {
            p.current_repo = repoName;
        });
        let rawCommits: GitCommit[] = [];
        try {
            rawCommits = await provider.getCommits(repoName, since, until);
        } catch (err) {
            errors.push(
                `[${providerType}/${repoName}] Failed to fetch commits: ${err instanceof Error ? err.message : String(err)}`,
            );
            // This repo's commit window is now un-covered — hold the provider's cursor
            // back so the whole window is re-fetched next run rather than skipped (#231).
            commitsComplete = false;
            // A failed repo still counts as processed so the N/M counter reaches M.
            report?.((p) => {
                p.repos_processed += 1;
                p.current_repo = null;
            });
            continue;
        }
        report?.((p) => {
            p.commits_fetched += rawCommits.length;
        });

        for (const rawCommit of rawCommits) {
            let diffs: GitFileDiff[] = [];
            try {
                diffs = await provider.getCommitDiff(repoName, rawCommit.sha);
            } catch {
                // Diff fetch failed — use empty diffs; commit still counts
            }
            // Namespace file paths by repo to prevent false churn collisions
            const namespacedDiffs = diffs.map((d) => ({...d, path: `${repoName}/${d.path}`}));
            allCommits.push(toAnalysisCommit(rawCommit, namespacedDiffs));
        }

        let rawPRs: GitPR[] = [];
        try {
            rawPRs = await provider.getPullRequests(repoName, 'all', since);
        } catch (err) {
            errors.push(
                `[${providerType}/${repoName}] Failed to fetch PRs: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
        report?.((p) => {
            p.prs_fetched += rawPRs.length;
        });

        let commentFetchFailures = 0;
        let reviewFetchFailures = 0;
        for (const pr of rawPRs) {
            // EVERY listed PR feeds allPRs / prRecords unconditionally — the list row is
            // already in hand and cheap, and the per-day open/merge aggregate is combined
            // across runs with max() (remergeStoredSnapshot), which is only idempotent if
            // each run delivers the FULL per-day set. Dropping list rows here would
            // partition a single day's PRs across catch-up chunks and make max(partial,
            // partial) silently undercount prs_opened/prs_merged (#247 review SO-1; the
            // additive/idempotent-merge rule from #205/#192).
            allPRs.push(toAnalysisPR(pr));

            // Bound ONLY the expensive per-PR review fan-out (getReviewComments +
            // getPRReviews, 2 API calls each) to the run's [since, until] window (#247).
            // getPullRequests takes no upper bound, so a held cursor would otherwise
            // re-fan an ever-widening span; gating the fan-out on `updatedAt <= until`
            // fans each PR out in exactly one chunk (its updatedAt lands in exactly one
            // contiguous [since, until]) — collapsing the recovery amplification to ~1x.
            // Lossless: a deferred PR re-lists next chunk (since' === until) and is fanned
            // out then. On a normal uncapped run (until === now) nothing is deferred.
            const fanOut = prWithinFetchWindow(pr.updatedAt, until);

            // A deferred fan-out is "not observed this run" — exactly like a failed fetch,
            // so commentsOk/reviewsOk are false and upsertPRRecord carries forward the
            // previously-observed review counts instead of clobbering them with zeros. It
            // is NOT a fetch FAILURE, so it is not counted toward the error advisories.
            let prCommentCount = 0;
            let commentsOk = fanOut;
            if (fanOut) {
                try {
                    const comments = await provider.getReviewComments(repoName, pr.id);
                    prCommentCount = comments.length;
                    for (const c of comments) {
                        allReviewComments.push(toAnalysisReviewComment(c));
                    }
                } catch {
                    // Review comment fetch failed — counted and surfaced below
                    commentsOk = false;
                    commentFetchFailures++;
                }
            }

            // Review verdict events (Task 5.2). Best-effort like comments: a
            // failed (or deferred) fetch still records the PR, flagged so the upsert
            // preserves previously-observed verdict data.
            let changesRequestedCount = 0;
            let reviewEventCount = 0;
            let reviewsOk = fanOut;
            if (fanOut) {
                try {
                    const reviews = await provider.getPRReviews(repoName, pr.id);
                    reviewEventCount = reviews.length;
                    changesRequestedCount = reviews.filter(
                        (r) => r.state === 'changes_requested',
                    ).length;
                } catch {
                    reviewsOk = false;
                    reviewFetchFailures++;
                }
            }

            allPRRecords.push({
                provider: providerType,
                repo: repoName,
                prId: pr.id,
                authorLogin: pr.author.username || null,
                authorEmail: pr.author.email || null,
                state: pr.state,
                createdAt: pr.createdAt,
                mergedAt: pr.mergedAt,
                closedAt: pr.closedAt,
                reviewCommentCount: prCommentCount,
                changesRequestedCount,
                reviewEventCount,
                commentsOk,
                reviewsOk,
            });
        }

        // Surface fetch failures (aggregated per repo so a rate-limited run
        // doesn't produce one error per PR). A silent failure here would be
        // indistinguishable from a clean review history downstream.
        if (commentFetchFailures > 0) {
            errors.push(
                `[${providerType}/${repoName}] Failed to fetch review comments for ${commentFetchFailures} PR(s)`,
            );
        }
        if (reviewFetchFailures > 0) {
            errors.push(
                `[${providerType}/${repoName}] Failed to fetch review verdicts for ${reviewFetchFailures} PR(s)`,
            );
        }

        report?.((p) => {
            p.repos_processed += 1;
            p.current_repo = null;
        });
    }

    return {
        commits: allCommits,
        prs: allPRs,
        reviewComments: allReviewComments,
        prRecords: allPRRecords,
        errors,
        stateKey,
        identifier,
        firstSyncFloor,
        forwardCursorTarget: until,
        complete: commitsComplete,
    };
}

/**
 * Review cycles for a PR: 0 when it never saw any review activity; otherwise
 * one initial review round plus one more per "changes requested" send-back.
 */
function computeReviewRounds(
    reviewEventCount: number,
    reviewCommentCount: number,
    changesRequestedCount: number,
): number {
    if (reviewEventCount === 0 && reviewCommentCount === 0) return 0;
    return 1 + changesRequestedCount;
}

function timeToMergeHours(record: PRRecordInput): number | null {
    if (!record.mergedAt) return null;
    const ms = Date.parse(record.mergedAt) - Date.parse(record.createdAt);
    if (Number.isNaN(ms) || ms < 0) return null;
    return ms / 3_600_000;
}

/**
 * Project constraint: all timestamps in UTC ISO. Bitbucket/GitLab can emit
 * offset timestamps (+02:00-style); normalize so the day-attribution in the
 * coaching engine (substr of the date part) is a UTC day, not a local one.
 * Unparseable input passes through untouched rather than becoming garbage.
 */
function toUtcIso(timestamp: string): string;
function toUtcIso(timestamp: string | null): string | null;
function toUtcIso(timestamp: string | null): string | null {
    if (timestamp === null) return null;
    const ms = Date.parse(timestamp);
    return Number.isNaN(ms) ? timestamp : new Date(ms).toISOString();
}

interface PRRecordExistingRow {
    review_comment_count: number;
    review_rounds: number;
    changes_requested_count: number;
}

function upsertPRRecord(
    db: Database.Database,
    record: PRRecordInput,
    developerId: string,
    syncedAt: string,
): void {
    // A failed comment/verdict fetch yields zeros by absence, not observation.
    // Carry forward the previously-observed values for the failed dimension so
    // one bad sync can't rewrite real review history as "clean reviews".
    let commentCount = record.reviewCommentCount;
    let crCount = record.changesRequestedCount;
    let rounds = computeReviewRounds(record.reviewEventCount, commentCount, crCount);
    if (!record.commentsOk || !record.reviewsOk) {
        const existing = db
            .prepare(
                `SELECT review_comment_count, review_rounds, changes_requested_count
                 FROM pr_records WHERE provider = ? AND repo = ? AND pr_id = ?`,
            )
            .get(record.provider, record.repo, record.prId) as PRRecordExistingRow | undefined;
        if (existing) {
            if (!record.commentsOk) commentCount = existing.review_comment_count;
            if (!record.reviewsOk) {
                // Verdict events weren't observed this sync — restore the last
                // verdict-derived round count and changes-requested count as a
                // unit. Recomputing rounds from a fresh comment count alone
                // (which can't raise rounds past 1) would blend stale and fresh
                // state into a row that never matched any single observation.
                crCount = existing.changes_requested_count;
                rounds = existing.review_rounds;
            } else {
                // Verdicts observed; only comments are stale — recompute from
                // the authoritative fresh verdict data.
                rounds = computeReviewRounds(record.reviewEventCount, commentCount, crCount);
            }
        }
    }

    db.prepare(
        `INSERT INTO pr_records
         (id, developer_id, provider, repo, pr_id, state, created_at, merged_at, closed_at,
          review_comment_count, review_rounds, changes_requested_count, time_to_merge_hours, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, repo, pr_id) DO UPDATE SET
           developer_id = excluded.developer_id,
           state = excluded.state,
           created_at = excluded.created_at,
           -- Freeze the merge timestamp once observed: a PR merges exactly once,
           -- and Bitbucket approximates it with updated_on, which post-merge
           -- activity inflates on every re-sync. COALESCE keeps the first
           -- non-null value so merged_at and time_to_merge_hours stay consistent.
           merged_at = COALESCE(pr_records.merged_at, excluded.merged_at),
           closed_at = excluded.closed_at,
           review_comment_count = excluded.review_comment_count,
           review_rounds = excluded.review_rounds,
           changes_requested_count = excluded.changes_requested_count,
           -- Keep the FIRST observed time-to-merge: it never legitimately
           -- changes after merge, and Bitbucket's merge timestamp is
           -- approximated by updated_on, which post-merge activity inflates.
           time_to_merge_hours = COALESCE(pr_records.time_to_merge_hours, excluded.time_to_merge_hours),
           synced_at = excluded.synced_at`,
    ).run(
        randomUUID(),
        developerId,
        record.provider,
        record.repo,
        record.prId,
        record.state,
        toUtcIso(record.createdAt),
        toUtcIso(record.mergedAt),
        toUtcIso(record.closedAt),
        commentCount,
        rounds,
        crCount,
        timeToMergeHours(record),
        syncedAt,
    );
}

/**
 * The newest forward CURSOR across an already-resolved provider set — the instant git
 * data has been synced UP TO. Factored out of {@link GitSync.getLastSyncTime} so a
 * caller that has already resolved its providers once (e.g. `toprope status`, #246) can
 * reuse the identical scan without resolving them a second time, keeping the read and
 * the writer of `git_last_sync:<type>:<container>` cursors from drifting apart.
 * Returns null when no resolved provider has a cursor yet.
 */
export function latestProviderCursor(
    db: Database.Database,
    providerConfigs: GitProviderConfig[],
): string | null {
    let latest: string | null = null;
    let latestMs = -Infinity;
    for (const pc of providerConfigs) {
        const key = syncStateKey(pc.type, providerIdentifier(pc));
        const row = db
            .prepare('SELECT value FROM sync_state WHERE key = ?')
            .get(key) as SyncStateRow | undefined;
        const t = row?.value ?? null;
        if (!t) continue;
        // Compare by parsed instant, not lexically, and drop an unparseable value —
        // matching loadGitSyncHealth's totality. A garbage row must not sort high,
        // win the max, and render as "connected (just now)" via formatTimeAgo(NaN).
        const ms = Date.parse(t);
        if (Number.isNaN(ms)) continue;
        if (ms > latestMs) {
            latestMs = ms;
            latest = t;
        }
    }
    return latest;
}

export class GitSync implements ConnectorInterface {
    private readonly config: GitConnectorConfig;

    constructor(config: GitConnectorConfig) {
        this.config = config;
    }

    getName(): string {
        return CONNECTOR_NAME;
    }

    /**
     * The newest forward CURSOR across this connector's providers — the instant git
     * data has been synced UP TO, not the instant a run last happened.
     *
     * Those were the same thing until #235: a complete run always advanced the cursor
     * to `now`. With the catch-up cap they diverge — a provider recovering from a long
     * stall syncs successfully every night while this still reports an instant weeks
     * back, because that is genuinely how far the data reaches. That is the honest
     * answer for a freshness/staleness question and the wrong one for "did the sync
     * run?"; a caller wanting the latter must not use this. This method has no direct
     * caller in `src/` (it satisfies ConnectorInterface); the shared scan it delegates
     * to, {@link latestProviderCursor}, is what `toprope status` calls to render the
     * Git connector's "last sync" line (#246).
     */
    getLastSyncTime(db: Database.Database): string | null {
        return latestProviderCursor(db, this.getProviderConfigs(db));
    }

    async sync(db: Database.Database, providerFilter?: string): Promise<SyncResult> {
        const providerConfigs = this.getProviderConfigs(db).filter(
            (pc) => !providerFilter || pc.type === providerFilter,
        );

        if (providerConfigs.length === 0) {
            return {
                connector: CONNECTOR_NAME,
                snapshotsWritten: 0,
                snapshotsSkipped: 0,
                errors: providerFilter
                    ? [`No provider of type '${providerFilter}' configured`]
                    : ['No git providers configured'],
                lastSyncTime: new Date().toISOString(),
            };
        }

        return this.runSync(db, providerConfigs);
    }

    /**
     * Run the sync pipeline over an EXPLICIT provider set — the seam the
     * per-provider "sync now" API (GC1.7 / #199) triggers with a single provider.
     * It reuses the exact fetch → merge → upsert path {@link sync} runs (no cloned
     * sync logic): the ONLY difference is the caller supplies the provider configs
     * instead of them being resolved from DB + config here. An empty list yields
     * the same "nothing configured" shape rather than throwing.
     *
     * `onProgress` (optional, GC#209) receives a {@link GitSyncProgress} snapshot
     * as the run advances — the sync-now API stores the latest one so the admin
     * UI can poll live progress. Omitted on the scheduled path (no observer).
     */
    async syncProviders(
        db: Database.Database,
        providerConfigs: GitProviderConfig[],
        onProgress?: GitSyncProgressListener,
        options?: SyncRunOptions,
    ): Promise<SyncResult> {
        if (providerConfigs.length === 0) {
            return {
                connector: CONNECTOR_NAME,
                snapshotsWritten: 0,
                snapshotsSkipped: 0,
                errors: ['No git providers configured'],
                lastSyncTime: new Date().toISOString(),
            };
        }
        return this.runSync(db, providerConfigs, onProgress, options);
    }

    // The shared pipeline body for both entry points above. Assumes a non-empty,
    // already-resolved provider set (callers own resolution + the empty case) so
    // the fetch/merge/upsert logic lives in exactly one place.
    private async runSync(
        db: Database.Database,
        providerConfigs: GitProviderConfig[],
        onProgress?: GitSyncProgressListener,
        options?: SyncRunOptions,
    ): Promise<SyncResult> {
        const errors: string[] = [];
        let snapshotsWritten = 0;
        let snapshotsSkipped = 0;
        const now = new Date().toISOString();
        const allUnmatched = new Set<string>();

        // Narrow + validate the auto-create config BEFORE any network work (#256). This is
        // the second of the feature's two trust boundaries — `loadConfig` is the first, but
        // a `GitConnectorConfig` also reaches here assembled programmatically (tests, the
        // admin sync-now path, an embedder), and the boundary that must never be bypassed
        // is the one next to the write. An invalid config aborts the run rather than
        // syncing with the feature silently off: the operator asked for hands-off
        // onboarding, and "ran fine, created nobody" is the failure mode this rejects.
        let autoCreate: AutoCreateSettings;
        try {
            autoCreate = resolveAutoCreateSettings(this.config);
        } catch (err) {
            return {
                connector: CONNECTOR_NAME,
                snapshotsWritten: 0,
                snapshotsSkipped: 0,
                errors: [`Invalid auto-create config: ${err instanceof Error ? err.message : String(err)}`],
                lastSyncTime: now,
            };
        }

        // One mutable progress state for the whole run; every report merges into
        // it and emits a copy, so the listener always sees cumulative counters.
        const progressState: GitSyncProgress = {
            stage: 'listing_repos',
            repos_total: null,
            repos_processed: 0,
            current_repo: null,
            commits_fetched: 0,
            prs_fetched: 0,
            developers_matched: 0,
        };
        const report: ProgressReporter | undefined = onProgress
            ? (mutate): void => {
                  mutate(progressState);
                  onProgress({...progressState});
              }
            : undefined;
        // Distinct developers resolved anywhere in the run (snapshots or PR
        // records) — the developers_matched counter's source.
        const matchedDevelopers = new Set<string>();

        const devLookup = buildDevLookupMap(db);
        const churnWindowHours = this.config.analysis?.churn_window_hours ?? 48;

        // Fetch data from all providers separately (for per-provider sync state),
        // then merge before analysis so multi-provider contributions to the same
        // (developer_id, date) are accumulated rather than overwritten.
        const fetchResults: Array<{result: ProviderFetchResult; providerType: GitProviderType}> = [];

        for (const pc of providerConfigs) {
            const result = await fetchProviderData(
                pc,
                now,
                db,
                report,
                options?.firstSyncWindowMonths,
                options?.backfill,
            );
            errors.push(...result.errors);
            fetchResults.push({result, providerType: pc.type});
        }

        report?.((p) => {
            p.stage = 'analyzing';
            p.current_repo = null;
        });

        // Every author's daily facts this run observed, matched AND unmatched, ready to
        // be RETAINED under their immutable raw identity (#253). This — not
        // git_snapshots — is now the run's primary write: git_snapshots is derived from
        // it by projection below, so an author with no developer record is no longer
        // dropped but simply not yet projected.
        // Keyed by `${raw_author_key} ${date}` so two provider INSTANCES of the same family
        // contributing to one author-day are summed here rather than colliding in the store
        // (see the accumulation below). Insertion-ordered, so the write pass stays
        // deterministic.
        const rawWrites = new Map<string, RawAuthorDailyInput>();
        // The raw author keys THIS run retained — the scope auto-create (#256) acts on.
        // Deliberately not "every current candidate": a hands-off run onboards the
        // authorship it just observed, and must not silently sweep up candidates an
        // operator left unpromoted in the review queue on purpose.
        const retainedKeys = new Set<string>();
        // The (developer_id, date) cells this run's raw writes resolve to — exactly the
        // cells the projection must rebuild. Deduped by composite key so a developer
        // reached under two identities (a github login and a bitbucket login) yields one
        // cell, not two rebuilds of the same one.
        const touchedCells = new Map<string, SnapshotCell>();
        // Per-PR records (Task 5.2), written after the snapshot pass. Keyed naturally by
        // (provider, repo, pr_id), so no cross-provider merging is needed.
        //
        // Collected UNRESOLVED and resolved inside the write transaction against the same
        // post-auto-create lookup the snapshot projection uses. Resolving here would use
        // the pre-fetch map, so a developer created during the run — by auto-create (#256),
        // or by an admin during the minutes of network fetch — would have their PRs
        // silently dropped. That loss is PERMANENT: providers re-fetch PRs by `updated_at`,
        // so a PR that is already merged and never touched again is never re-delivered.
        const fetchedPRRecords: Array<{record: PRRecordInput; providerType: GitProviderType}> = [];
        // Deferred sync-state advances (#231). Each entry is applied INSIDE the write
        // transaction below, so a provider's cursor/watermark commits atomically with
        // — and only if — its data is persisted. Populated only for providers whose
        // fetch was complete; an incomplete provider contributes nothing this run.
        const cursorAdvances: Array<() => void> = [];
        // Auto-create's summary/failure lines (#256). Staged rather than pushed straight
        // into `errors` because they are produced INSIDE the write transaction: on a
        // rollback no developer was created, so reporting that any were would be a lie.
        // Appended only after the transaction commits, and discarded on failure.
        const autoCreateAdvisories: string[] = [];
        // Deferred stall-counter updates (#235), applied in the SAME transaction as
        // the cursor advances so the counter and the cursor can never disagree about
        // whether this run moved the provider forward. Unlike `cursorAdvances` this
        // covers EVERY provider in the run — a complete one clears its streak, an
        // incomplete one extends it.
        const stallUpdates: Array<() => void> = [];

        for (const {result, providerType} of fetchResults) {
            const {commits, prs, reviewComments, prRecords, stateKey, identifier} = result;

            // Stall accounting (#235) — FORWARD runs only. A backfill deliberately
            // leaves the forward cursor untouched (it walks older history), so its
            // outcome says nothing about whether the cursor is stuck; counting a failed
            // backfill would raise a stall alert for a provider syncing perfectly, and
            // a successful one would clear a real stall that is still stuck.
            if (!options?.backfill) {
                if (result.complete) {
                    stallUpdates.push(() => clearProviderStall(db, providerType, identifier));
                } else {
                    stallUpdates.push(() => recordProviderStallRun(db, providerType, identifier, now));
                }
            }

            // A provider whose commit fetch was incomplete (listRepos or any repo's
            // getCommits threw) must not advance its cursor OR write its additive
            // snapshots (#231). Commit counts are ADDED across runs, so writing this
            // run's partial data and re-fetching the same window next run would
            // double-count; discarding the partial data and re-covering the whole
            // window next run is the only gap-free option. Skip the provider entirely
            // — its errors are already surfaced, so the failure is loud, not silent.
            // (Trade-off: a permanently-failing repo stalls the provider until it is
            // fixed or excluded via config — a visible stall, preferred over a silent,
            // permanent snapshot gap.)
            if (!result.complete) {
                continue;
            }

            // Defer this provider's sync-state advance into the write transaction.
            // Backfill (#229) LOWERS the earliest watermark to the (older) slice it
            // just imported and leaves the forward cursor untouched, so normal "Sync
            // now" keeps resuming from now; every other run advances the forward cursor
            // to `now`. Written per-provider even on an empty fetch (a complete run
            // that found nothing legitimately covered its window), so a backfill can
            // only ever widen backward and never re-covers a slice.
            cursorAdvances.push(() => {
                if (options?.backfill) {
                    setProviderEarliestSyncTime(db, providerType, identifier, options.backfill.since);
                } else {
                    // On the FIRST forward sync, ALSO record the true earliest-synced
                    // floor (#229) so the "sync older history" backfill's default is
                    // exact, not the too-recent lazy guess. Guard on an unset
                    // watermark: a first sync should never clobber a lower value a
                    // prior direct-API backfill may have written (the UI can't reach
                    // that ordering, but the route doesn't forbid it). The read runs
                    // inside the write transaction, so this check-then-set is atomic.
                    if (
                        result.firstSyncFloor !== null &&
                        getProviderEarliestSyncTime(db, providerType, identifier) === null
                    ) {
                        setProviderEarliestSyncTime(db, providerType, identifier, result.firstSyncFloor);
                    }
                    // The instant actually COVERED, not `now`: a catch-up run capped by
                    // GIT_CATCHUP_WINDOW_MAX_DAYS (#235) fetched only [since, until], so
                    // advancing to `now` would silently skip the rest. Equal to `now` on
                    // every uncapped run, which is all of them for a healthy provider.
                    setSyncStateValue(db, stateKey, result.forwardCursorTarget);
                }
            });

            for (const record of prRecords) {
                fetchedPRRecords.push({record, providerType});
                // Progress counter only — the authoritative resolution happens in the
                // write transaction (see `fetchedPRRecords`).
                const developerId = resolveDeveloperId(
                    devLookup,
                    providerType,
                    record.authorLogin,
                    record.authorEmail,
                );
                if (developerId) matchedDevelopers.add(developerId);
            }

            if (commits.length === 0 && prs.length === 0 && reviewComments.length === 0) {
                // Cursor advance was already queued above for this complete provider.
                continue;
            }

            const metricsMap = aggregateDailyMetrics(commits, prs, churnWindowHours, reviewComments);

            for (const [login, byDate] of metricsMap) {
                // The first commit under this analysis login carries the identity fields
                // the raw row is keyed and pre-filled by. A PR-only author has no commit,
                // so both stay null and the row is keyed by the login alone — the same
                // identity the resolver would have used for them before #253.
                const sampleCommit = commits.find((c) => c.authorLogin === login);
                const emailForLogin = sampleCommit?.authorEmail ?? null;
                const rawAuthorKey = retentionKeyFor(providerType, login, emailForLogin);
                // No stable identity (no login, no email) — nothing to retain it under.
                if (!rawAuthorKey) continue;
                retainedKeys.add(rawAuthorKey);

                for (const [, metrics] of byDate) {
                    const row: RawAuthorDailyInput = {
                        provider: providerType,
                        raw_author_key: rawAuthorKey,
                        author_login: login,
                        author_email: emailForLogin,
                        author_display_name: sampleCommit?.authorName ?? null,
                        date: metrics.date,
                        commits: metrics.commits,
                        lines_added: metrics.lines_added,
                        lines_removed: metrics.lines_removed,
                        files_changed: metrics.files_changed,
                        prs_opened: metrics.prs_opened,
                        prs_merged: metrics.prs_merged,
                        review_comments_given: metrics.review_comments_given,
                        avg_time_to_merge_hours: metrics.avg_time_to_merge_hours,
                        code_churn_rate: metrics.code_churn_rate,
                        ai_signature_score: metrics.ai_signature_score,
                        avg_commit_size: metrics.avg_commit_size,
                        commit_burst_count: metrics.commit_burst_count,
                    };
                    // Accumulate WITHIN the run before the store ever sees it. `providerType`
                    // is the provider FAMILY, not the instance, so two configured GitHub orgs
                    // (or two Bitbucket workspaces) sharing an author produce the same
                    // (key, date) here. Pushing both would hand them to the across-runs rule,
                    // which max()es the re-delivered PR fields — correct for one PR delivered
                    // twice, badly wrong for two orgs' genuinely different PRs on one day: the
                    // smaller org's count would vanish, permanently, since the cursor advances
                    // past the window. These sides ARE disjoint, so they sum.
                    const dedupeKey = `${rawAuthorKey}\u0000${metrics.date}`;
                    const prior = rawWrites.get(dedupeKey);
                    rawWrites.set(
                        dedupeKey,
                        prior ? {...prior, ...mergeDailyDisjoint(prior, row)} : row,
                    );
                }

                // Progress counter only — a live estimate for the UI, resolved against the
                // pre-fetch map. The AUTHORITATIVE resolution (which cells to project, and
                // who goes in the unmatched advisory) happens inside the write transaction
                // below against a freshly-read map, because minutes of network fetch sit
                // between the two and a developer created in that gap must not be missed.
                const developerId = resolveRawAuthor(
                    devLookup,
                    providerType,
                    rawAuthorKey,
                    login,
                    emailForLogin,
                );
                if (developerId) matchedDevelopers.add(developerId);
            }
        }

        report?.((p) => {
            p.stage = 'writing';
            p.developers_matched = matchedDevelopers.size;
        });

        // Retain every author's daily facts, PROJECT the touched cells of git_snapshots
        // from them, write the per-PR records AND advance every complete provider's
        // cursor/watermark in a SINGLE transaction (#231/#253). The cursor advances live
        // inside the same tx as the data write, so on any write failure the whole
        // transaction rolls back — no cursor moves past a window whose data was never
        // persisted, no raw row is retained for it either, and the next run re-covers it.
        // `snapshotsWritten` / `snapshotsSkipped` are staged locally and only committed to
        // the run counters after the tx succeeds, so a rolled-back run never reports
        // phantom writes.
        const insertMany = db.transaction(() => {
            // RETAIN FIRST, in a pass of its own. Auto-create below derives its candidates
            // from `raw_author_daily`, and the replay it performs re-projects every date a
            // new developer's retained rows touch — so every row of this run must already
            // be in the store before either happens, or a freshly-created developer's
            // current-window activity would be invisible to their own replay. Splitting the
            // former single loop is exactly what buys "no second pass, no re-fetch".
            for (const row of rawWrites.values()) {
                upsertRawAuthorDaily(db, row, now);
            }

            // Opt-in hands-off onboarding (#256), between retention and projection.
            if (autoCreate.enabled && autoCreate.team !== null) {
                autoCreateAdvisories.push(...this.runAutoCreate(db, autoCreate.team, autoCreate, retainedKeys));
            }

            // Read the identity map INSIDE the transaction, and AFTER auto-create: it must
            // see the developers this run just minted, or their rows would be retained but
            // their cells never projected while the cursor advanced past the window that
            // produced them. (The same reason it is re-read at all: `devLookup` was built
            // before minutes of network fetch, during which a developer may have been added.)
            const writeLookup = buildDevLookupMap(db);
            for (const row of rawWrites.values()) {
                const developerId = resolveRawAuthor(
                    writeLookup,
                    row.provider,
                    row.raw_author_key,
                    row.author_login,
                    row.author_email,
                );
                if (developerId) {
                    touchedCells.set(`${developerId}:${row.date}`, {developer_id: developerId, date: row.date});
                } else {
                    // The advisory is sourced from the RETAINED rows: exactly the authors
                    // whose day was kept but could not be attributed — precisely the set the
                    // onboarding review queue (DO1.4/DO1.5) will offer to promote.
                    allUnmatched.add(`${row.provider}:${row.author_login ?? row.author_email ?? 'unknown'}`);
                }
            }
            // Rebuild EXACTLY the cells this run touched. Each is recomputed from every
            // retained raw row on that day — including identities this run never fetched —
            // so a scoped single-provider run still yields the full multi-provider total
            // rather than dropping the other provider's same-day contribution (#192/#205).
            const projection = projectSnapshots(db, {cells: [...touchedCells.values()]});
            const written = projection.cellsWritten;
            // A touched cell is skipped ONLY when its stored row is legacy (`is_projected
            // = 0`, pre-#253) and the projection refuses to overwrite an accumulated total
            // it cannot reconstruct. That is real, operator-visible data: on an upgraded
            // deployment the day straddling the upgrade is legacy, so this run's newly
            // retained commits for that day are NOT written while the cursor advances past
            // them. Reporting 0 here would make an incomplete run read as a clean one —
            // exactly the "completion signal is not a currency claim" failure. Surfaced as
            // an advisory below as well, since `records_skipped` alone doesn't say why.
            const skipped = projection.cellsSkippedLegacy;
            // Resolved HERE, against the post-auto-create map — see `fetchedPRRecords`.
            for (const {record, providerType} of fetchedPRRecords) {
                const developerId = resolveDeveloperId(
                    writeLookup,
                    providerType,
                    record.authorLogin,
                    record.authorEmail,
                );
                if (developerId) upsertPRRecord(db, record, developerId, now);
            }
            // Advance cursors LAST, still inside the tx: they persist iff every write
            // above committed. Collected only for complete providers (see the loop).
            for (const advance of cursorAdvances) {
                advance();
            }
            // Stall counters move with the cursors, in the same tx and on the same
            // all-or-nothing terms (#235). A rolled-back run therefore records no stall
            // either — correct, because nothing about it persisted: no cursor moved, and
            // the next run re-covers the window and accounts for itself. Its failure is
            // still loud via the rollback error pushed below.
            for (const update of stallUpdates) {
                update();
            }
            snapshotsWritten = written;
            snapshotsSkipped = skipped;
        });

        try {
            insertMany();
            // Committed — only now is the auto-create summary true.
            errors.push(...autoCreateAdvisories);
        } catch (err) {
            // Hard failure: the tx rolled back, so NO snapshots were written, NO developer
            // was auto-created and NO cursor advanced — the window is intact and will be
            // re-fetched next run. Surface it clearly rather than swallowing it into a
            // "successful" result.
            snapshotsWritten = 0;
            snapshotsSkipped = 0;
            autoCreateAdvisories.length = 0;
            // Derived from writes that were discarded, so reporting it would describe a
            // state that does not exist — same reason the auto-create advisories are
            // cleared. The rollback error below is the honest signal.
            allUnmatched.clear();
            errors.push(
                `Failed to write sync data (transaction rolled back — no cursor advanced, window will be re-fetched next run): ${err instanceof Error ? err.message : String(err)}`,
            );
        }

        if (allUnmatched.size > 0) {
            errors.push(`${UNMATCHED_AUTHORS_PREFIX} ${[...allUnmatched].join(', ')}`);
        }

        // Say WHY cells were skipped, not just how many. `records_skipped` is a bare
        // number on the sync log; without this an operator sees a "complete" run whose
        // count silently disagrees with the data, and has nothing to search for.
        if (snapshotsSkipped > 0) {
            errors.push(
                `${LEGACY_CELLS_SKIPPED_PREFIX} ${snapshotsSkipped} cell(s) were left untouched because they hold pre-upgrade totals the projection cannot reconstruct. Their raw authorship IS retained; re-run "sync older history" for the affected window if those days matter.`,
            );
        }

        return {connector: CONNECTOR_NAME, snapshotsWritten, snapshotsSkipped, errors, lastSyncTime: now};
    }

    /**
     * Opt-in auto-create (#256): turn this run's unmatched HUMAN authors into developers,
     * attributed in the same run. Returns the lines to surface on the SyncResult.
     *
     * MUST be called from inside the sync write transaction, between retention and
     * projection. That placement is what makes the epic's atomicity criterion hold —
     * creation, projection and the cursor advance commit together, so a rolled-back run
     * creates nobody — and what makes "no second pass, no re-fetch" true: the new
     * developer's own replay sees this run's rows because they are already retained.
     *
     * Everything below the team check is DELEGATED, not re-implemented. `promoteAllCandidates`
     * already derives candidates from the raw store, hard-skips bots via the shared
     * classifier, and creates each developer through `createDeveloperWithReplay` — which
     * carries the identity-uniqueness guard and the replay. Re-deriving any of that here
     * would be a second definition of who a bot is, or of what a duplicate is, and the two
     * would drift. Auto-create's only additions are the run scope, the operator denylist,
     * and `unreviewed` — the flag that keeps a self-asserted commit email from becoming an
     * attribution claim when nobody is vouching for the row — all passed as options.
     *
     * Cost note: the creations are batched into ONE whole-day rebuild, not one replay each
     * (`promoteAllCandidates` defers the per-create replay and issues a single
     * `replayDevelopers` over the union of their dates). That matters because this runs
     * inside the run's write transaction: a `dates`-mode projection rebuilds every cell on
     * the days it covers regardless of whose replay asked for it, so the per-creation shape
     * re-did almost the same rebuild once per author and held the SQLite write lock for the
     * duration. Batching is exact rather than approximate — the projection is idempotent
     * and order-independent, so one pass over the union writes what N passes converge to.
     * It also does NOT fork the create path: `createDeveloperWithReplay` is still the single
     * write boundary; only the projection call is hoisted out of the loop.
     */
    private runAutoCreate(
        db: Database.Database,
        team: string,
        settings: AutoCreateSettings,
        retainedKeys: ReadonlySet<string>,
    ): string[] {
        // FAIL CLOSED on an unusable team: create it when absent (parity with GitHub-org
        // discovery's default team), but refuse an ARCHIVED one. A developer created into
        // an archived team is absent from every team aggregate — the write "succeeds" and
        // the person never appears, which is the silent hole this epic exists to close.
        // Reported as a genuine error (no advisory prefix) so it turns the provider red
        // rather than reading as a run that simply had nobody to onboard.
        if (!ensureTeam(db, team)) {
            return [
                `Auto-create is enabled but team '${team}' is archived — no developers were created. Un-archive it or change connectors.git.auto_create_team.`,
            ];
        }
        if (retainedKeys.size === 0) return [];

        const result = promoteAllCandidates(db, team, {
            onlyKeys: retainedKeys,
            exclusions: settings.exclude,
            // No human is reviewing these rows, so only provider-verified logins are
            // onboarded and the created developers claim no self-asserted commit email.
            unreviewed: true,
        });
        // Nothing observed and nothing skipped — stay silent rather than emit a line every
        // run reporting that a steady-state sync onboarded nobody.
        if (result.promoted === 0 && result.skippedBots === 0 && result.failed === 0) return [];

        const lines = [
            `${AUTO_CREATE_SUMMARY_PREFIX} ${result.promoted} developers (${result.skippedBots} bot authors skipped) into team '${team}'`,
        ];
        if (result.failed > 0) {
            // Deliberately NOT advisory-prefixed. A candidate that could not be promoted is
            // authorship that stays unattributed, and the operator has to see it. The most
            // common cause is benign-but-worth-knowing: two raw keys for one person, the
            // second colliding with the developer the first just created.
            const detail = result.entries
                .filter((e): e is Extract<typeof e, {status: 'failed'}> => e.status === 'failed')
                .map((e) => `${e.candidate.raw_author_key} (${e.reason}: ${e.message})`)
                .join('; ');
            lines.push(autoCreateFailureLine(result.failed, detail));
        }
        return lines;
    }

    // Resolve the providers this sync run should cover: DB-connected providers
    // (via the store) merged with config-file providers, DB winning on overlap.
    // Loads the server key here (fail-closed) so a UI-connected provider's token
    // can be decrypted; a config-only setup with no key is unaffected.
    private getProviderConfigs(db: Database.Database): GitProviderConfig[] {
        return resolveAllGitProviders(db, loadServerKey(), this.config);
    }
}
