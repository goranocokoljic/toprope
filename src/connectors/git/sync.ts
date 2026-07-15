import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import {aggregateDailyMetrics} from './analyzer.js';
import {toAnalysisCommit, toAnalysisPR, toAnalysisReviewComment} from './analysis-types.js';
import type {AnalysisCommit, AnalysisPR, AnalysisReviewComment} from './analysis-types.js';
import {createGitProvider} from './providers/factory.js';
import {providerContainer} from './providers/config.js';
import {resolveAllGitProviders} from './providers/resolve.js';
import {loadServerKey} from './providers/secret.js';
import type {GitProviderConfig, GitProviderType, GitCommit, GitFileDiff, GitPR} from './providers/types.js';
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

interface SyncStateRow {
    value: string;
}

interface DeveloperRow {
    id: string;
    email: string | null;
    external_ids: string | null;
}

interface GitSnapshotRow {
    developer_id: string;
    date: string;
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
    data_source: string;
}

function getProviderLastSyncTime(db: Database.Database, key: string): string | null {
    const row = db
        .prepare('SELECT value FROM sync_state WHERE key = ?')
        .get(key) as SyncStateRow | undefined;
    return row?.value ?? null;
}

function setProviderLastSyncTime(db: Database.Database, key: string, time: string): void {
    db.prepare(
        'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, time);
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
    return getProviderLastSyncTime(db, earliestSyncStateKey(providerType, identifier));
}

function setProviderEarliestSyncTime(
    db: Database.Database,
    providerType: GitProviderType,
    identifier: string,
    time: string,
): void {
    setProviderLastSyncTime(db, earliestSyncStateKey(providerType, identifier), time);
}

/**
 * The current earliest-synced watermark for a provider — the oldest instant whose
 * activity has already been imported — as UTC ISO. The "sync older history"
 * backfill (#229) extends BELOW this edge: it fetches the strictly-older slice
 * [new_target, watermark], disjoint from everything already stored, so the
 * additive snapshot merge stays correct. The backfill route calls this to both
 * enforce the overlap guard (`new_target < watermark`) and set the fetch's upper
 * bound.
 *
 * The watermark is now recorded at FIRST-SYNC time (runSync writes the real floor
 * the first forward sync reached — the clamped window start, or {@link
 * EARLIEST_SYNC_EPOCH} for a walk-all sync) and lowered by every backfill, so for
 * any provider synced by this build it is EXACT — the overlap guard never overlaps
 * an already-imported span.
 *
 * LEGACY LAZY DEFAULT: a provider whose first sync predates this change has no
 * stored watermark. Only there do we fall back to `now` − the #228 default window.
 * This is best-effort and PERMANENT for that provider: the forward path only records
 * the floor on a genuine first sync (`storedCursor === null`), and a legacy provider
 * already has a cursor, so its watermark is never back-recorded — the fallback does
 * NOT self-heal on later forward syncs. It is also systematically too-recent: the
 * true floor is `first_sync_time − window`, older than `now − window` by however
 * long ago the provider first synced, so a legacy provider's FIRST backfill can
 * re-cover and additively double-count that overlap (bounded by elapsed time since
 * first sync). Correcting it needs a data migration (or a cursor reset that forces a
 * true first sync). New providers — synced by this build — are never exposed to it.
 */
export function getEarliestSyncedWatermark(
    db: Database.Database,
    providerType: GitProviderType,
    identifier: string,
    now: string,
): string {
    const stored = getProviderEarliestSyncTime(db, providerType, identifier);
    if (stored) return stored;
    // firstSyncSince returns '' only when `now` is unparseable; fall back to `now`
    // (a zero-width window the caller's overlap guard rejects) rather than '',
    // which downstream would read as "walk all history".
    return firstSyncSince(now, FIRST_SYNC_WINDOW_DEFAULT_MONTHS) || now;
}

// Build a map from identifier → developer_id, covering:
//   - email (from developers.email)
//   - github:<login>, bitbucket:<login>, gitlab:<login> (from external_ids JSON)
function buildDevLookupMap(db: Database.Database): Map<string, string> {
    const rows = db.prepare('SELECT id, email, external_ids FROM developers').all() as DeveloperRow[];
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
                map.set(`${key}:${value}`, row.id);
            }
        } catch {
            // malformed external_ids — skip
        }
    }

    return map;
}

function resolveDeveloperId(
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

// Commit-count-weighted mean of a rate/score field. When two snapshots' commit
// counts add, a straight average would ignore that one side may represent far more
// commits than the other. total===0 (no commits on either side) yields 0 — the
// neutral value for these per-commit metrics.
function commitWeightedAvg(aVal: number, aCommits: number, bVal: number, bCommits: number): number {
    const total = aCommits + bCommits;
    return total > 0 ? (aVal * aCommits + bVal * bCommits) / total : 0;
}

// Merge two snapshots for the same (developer_id, date) from DIFFERENT providers
// WITHIN a single sync run. Every field is additive/combinable because the two sides
// are genuinely disjoint (distinct providers, distinct PRs). This is NOT the right
// rule for combining against a previously-stored row across runs — see
// remergeStoredSnapshot for why PR/review fields must not be summed there.
function mergeSnapshots(a: GitSnapshotRow, b: GitSnapshotRow): GitSnapshotRow {
    const totalCommits = a.commits + b.commits;
    const totalPrs = a.prs_merged + b.prs_merged;

    let avgTTM: number | null = null;
    if (a.avg_time_to_merge_hours !== null && b.avg_time_to_merge_hours !== null && totalPrs > 0) {
        avgTTM = (a.avg_time_to_merge_hours * a.prs_merged + b.avg_time_to_merge_hours * b.prs_merged) / totalPrs;
    } else {
        avgTTM = a.avg_time_to_merge_hours ?? b.avg_time_to_merge_hours;
    }

    // Cross-provider churn cannot be recomputed without the full commit set; simple average is an approximation.
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

// Re-merge an incoming per-run snapshot against the STORED (developer_id, date) row.
// Deliberately different from mergeSnapshots (which combines DISTINCT providers within
// one run and so may add every field): across runs the two sides are NOT disjoint.
//   - Commit windows ARE disjoint (each run fetches commits on a [since, now] committer-
//     date window that advances), so commit-derived counts are ADDED — this is the
//     accumulation the issue asks for.
//   - PR / review activity is RE-DELIVERED: providers fetch PRs by updated_at/updated_on
//     (github/bitbucket getPullRequests), so a PR merely touched since the last cursor is
//     re-fetched and re-aggregated on the next run, and its review comments are re-fetched
//     unconditionally. Additively summing prs_opened/prs_merged/review_comments_given
//     against the stored row would inflate them on essentially every scheduled sync of an
//     active PR. So they are combined with max(): idempotent under re-delivery (re-seeing
//     the same PRs never inflates) and never below the stored value (a scoped single-
//     provider run cannot drop another provider's already-recorded PRs). The known cost is
//     an undercount when genuinely-distinct PRs accrue across runs/providers on the same
//     day — a bounded, conservative error rooted in git_snapshots having no provider
//     dimension (tracked by the #192 SEC-2 follow-up), and far preferable to the unbounded
//     per-sync inflation additive summing would produce.
//   - Rate/score fields are commit-count-weighted so a small delta can't drag a large
//     accumulated row halfway (the exponential-recency skew a straight mean would cause).
function remergeStoredSnapshot(stored: GitSnapshotRow, incoming: GitSnapshotRow): GitSnapshotRow {
    return {
        developer_id: stored.developer_id,
        date: stored.date,
        commits: stored.commits + incoming.commits,
        lines_added: stored.lines_added + incoming.lines_added,
        lines_removed: stored.lines_removed + incoming.lines_removed,
        files_changed: stored.files_changed + incoming.files_changed,
        prs_opened: Math.max(stored.prs_opened, incoming.prs_opened),
        prs_merged: Math.max(stored.prs_merged, incoming.prs_merged),
        review_comments_given: Math.max(stored.review_comments_given, incoming.review_comments_given),
        // avg_time_to_merge pairs with prs_merged (which we take via max). Source it from
        // the SAME side that owns the larger merge count so the (count, TTM) pair always
        // matches a real observation — never a maxed count paired with a stale first-
        // observed average from a different run. On a tie (the common same-PR re-delivery
        // case) keep the first-observed value.
        avg_time_to_merge_hours:
            incoming.prs_merged > stored.prs_merged
                ? incoming.avg_time_to_merge_hours ?? stored.avg_time_to_merge_hours
                : stored.avg_time_to_merge_hours ?? incoming.avg_time_to_merge_hours,
        code_churn_rate: commitWeightedAvg(stored.code_churn_rate, stored.commits, incoming.code_churn_rate, incoming.commits),
        ai_signature_score: commitWeightedAvg(stored.ai_signature_score, stored.commits, incoming.ai_signature_score, incoming.commits),
        avg_commit_size: commitWeightedAvg(stored.avg_commit_size, stored.commits, incoming.avg_commit_size, incoming.commits),
        commit_burst_count: stored.commit_burst_count + incoming.commit_burst_count,
        data_source: stored.data_source === incoming.data_source ? stored.data_source : 'multi',
    };
}

// Re-merge the incoming snapshot against the stored (developer_id, date) row rather
// than REPLACE-ing it, so a scoped/per-provider sync (CLI --provider, UI "Sync now")
// no longer overwrites the merged row with just its own metrics and permanently drops
// another provider's same-day commits (the incremental cursor never re-fetches them),
// and a second incremental run of the same provider on the same day accumulates rather
// than replaces. remergeStoredSnapshot ADDS the disjoint commit delta while keeping the
// re-delivered PR/review fields idempotent (see its doc). Runs inside runSync's outer
// db.transaction (the upsert loop), so this SELECT → merge → write is atomic — no other
// writer can slip a row in between the read and the write.
//
// Known trade-off of the issue's additive-incremental design: because commit counts are
// added, re-fetching the same commits (a manual cursor reset or a full re-sync with an
// empty `since`) double-counts them — the rows are no longer reconstructible by re-running
// sync from scratch. Normal incremental operation never re-fetches a committed window, so
// this is the accepted cost; a provider-dimension snapshot (the #192 SEC-2 follow-up) is
// the durable fix.
function upsertSnapshot(db: Database.Database, snap: GitSnapshotRow): 'written' | 'skipped' {
    const existing = db
        .prepare(
            `SELECT developer_id, date, commits, lines_added, lines_removed, files_changed,
                    prs_opened, prs_merged, review_comments_given, avg_time_to_merge_hours,
                    code_churn_rate, ai_signature_score, avg_commit_size, commit_burst_count, data_source
             FROM git_snapshots WHERE developer_id = ? AND date = ?`,
        )
        .get(snap.developer_id, snap.date) as GitSnapshotRow | undefined;

    // On conflict the stored row already contributed to `merged`, so writing the
    // merged values is the accumulated result — not a clobber.
    const merged = existing ? remergeStoredSnapshot(existing, snap) : snap;

    const result = db
        .prepare(
            `INSERT INTO git_snapshots
             (id, developer_id, date, commits, lines_added, lines_removed, files_changed,
              prs_opened, prs_merged, review_comments_given, avg_time_to_merge_hours,
              code_churn_rate, ai_signature_score, avg_commit_size, commit_burst_count, data_source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
               data_source = excluded.data_source`,
        )
        .run(
            randomUUID(),
            merged.developer_id,
            merged.date,
            merged.commits,
            merged.lines_added,
            merged.lines_removed,
            merged.files_changed,
            merged.prs_opened,
            merged.prs_merged,
            merged.review_comments_given,
            merged.avg_time_to_merge_hours,
            merged.code_churn_rate,
            merged.ai_signature_score,
            merged.avg_commit_size,
            merged.commit_burst_count,
            merged.data_source,
        );

    return result.changes > 0 ? 'written' : 'skipped';
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
    const storedCursor = getProviderLastSyncTime(db, stateKey);
    const since = backfill ? backfill.since : (storedCursor ?? firstSyncSince(now, firstSyncWindowMonths));
    // This run is a FIRST forward sync when it is not a backfill and no cursor exists
    // yet. Only then does runSync record the earliest-synced watermark (#229): the
    // real floor `since` reached, mapped to the epoch sentinel for a walk-all ('').
    const isFirstSync = !backfill && storedCursor === null;
    const firstSyncFloor = isFirstSync ? (since === '' ? EARLIEST_SYNC_EPOCH : since) : null;
    // Commit fetch upper bound: the backfill's watermark, else `now`. PRs are fetched
    // by `since` only (the provider interface has no PR `until`); in backfill that
    // re-delivers recent PRs, which the max()-based cross-run merge folds in
    // idempotently (see remergeStoredSnapshot) — no inflation, just extra fetch.
    const until = backfill ? backfill.until : now;

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
            allPRs.push(toAnalysisPR(pr));
            let prCommentCount = 0;
            let commentsOk = true;
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

            // Review verdict events (Task 5.2). Best-effort like comments: a
            // failed fetch still records the PR, flagged so the upsert
            // preserves previously-observed verdict data.
            let changesRequestedCount = 0;
            let reviewEventCount = 0;
            let reviewsOk = true;
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

export class GitSync implements ConnectorInterface {
    private readonly config: GitConnectorConfig;

    constructor(config: GitConnectorConfig) {
        this.config = config;
    }

    getName(): string {
        return CONNECTOR_NAME;
    }

    getLastSyncTime(db: Database.Database): string | null {
        const providers = this.getProviderConfigs(db);
        let latest: string | null = null;
        for (const pc of providers) {
            const key = syncStateKey(pc.type, providerIdentifier(pc));
            const row = db
                .prepare('SELECT value FROM sync_state WHERE key = ?')
                .get(key) as SyncStateRow | undefined;
            const t = row?.value ?? null;
            if (t && (!latest || t > latest)) latest = t;
        }
        return latest;
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

        // Accumulate snapshots from all providers into a single map keyed by
        // "developer_id:date" so same-day multi-provider data is merged.
        const globalSnapshots = new Map<string, GitSnapshotRow>();
        // Per-PR records (Task 5.2) resolved to developers, written after the
        // snapshot pass. Keyed naturally by (provider, repo, pr_id), so no
        // cross-provider merging is needed.
        const resolvedPRRecords: Array<{record: PRRecordInput; developerId: string}> = [];

        for (const {result, providerType} of fetchResults) {
            const {commits, prs, reviewComments, prRecords, stateKey, identifier} = result;

            // Record this provider's sync progress. Backfill (#229) LOWERS the
            // earliest watermark to the (older) slice it just imported and leaves
            // the forward cursor untouched, so normal "Sync now" keeps resuming from
            // now; every other run advances the forward cursor to `now`. Mirrors the
            // forward cursor's existing semantics: written per-provider even on an
            // empty/partial fetch (a failed repo is skipped, same accepted trade-off),
            // so a backfill can only ever widen backward and never re-covers a slice.
            const recordProgress = (): void => {
                if (options?.backfill) {
                    setProviderEarliestSyncTime(db, providerType, identifier, options.backfill.since);
                } else {
                    // On the FIRST forward sync, ALSO record the true earliest-synced
                    // floor (#229) so the "sync older history" backfill's default is
                    // exact, not the too-recent lazy guess. Guard on an unset
                    // watermark: a first sync should never clobber a lower value a
                    // prior direct-API backfill may have written (the UI can't reach
                    // that ordering, but the route doesn't forbid it).
                    if (
                        result.firstSyncFloor !== null &&
                        getProviderEarliestSyncTime(db, providerType, identifier) === null
                    ) {
                        setProviderEarliestSyncTime(db, providerType, identifier, result.firstSyncFloor);
                    }
                    setProviderLastSyncTime(db, stateKey, now);
                }
            };

            for (const record of prRecords) {
                const developerId = resolveDeveloperId(
                    devLookup,
                    providerType,
                    record.authorLogin,
                    record.authorEmail,
                );
                if (developerId) {
                    resolvedPRRecords.push({record, developerId});
                    matchedDevelopers.add(developerId);
                }
            }

            if (commits.length === 0 && prs.length === 0 && reviewComments.length === 0) {
                recordProgress();
                continue;
            }

            const metricsMap = aggregateDailyMetrics(commits, prs, churnWindowHours, reviewComments);

            // Check for unmatched authors
            for (const commit of commits) {
                const devId = resolveDeveloperId(devLookup, providerType, commit.authorLogin, commit.authorEmail);
                if (!devId) {
                    const label = commit.authorLogin ?? commit.authorEmail ?? 'unknown';
                    allUnmatched.add(`${providerType}:${label}`);
                }
            }

            for (const [login, byDate] of metricsMap) {
                const emailForLogin = commits.find((c) => c.authorLogin === login)?.authorEmail ?? null;
                const developerId = resolveDeveloperId(devLookup, providerType, login, emailForLogin);
                if (!developerId) continue;
                matchedDevelopers.add(developerId);

                for (const [, metrics] of byDate) {
                    const snap: GitSnapshotRow = {
                        developer_id: developerId,
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
                        data_source: providerType,
                    };

                    const key = `${developerId}:${metrics.date}`;
                    const existing = globalSnapshots.get(key);
                    globalSnapshots.set(key, existing ? mergeSnapshots(existing, snap) : snap);
                }
            }

            recordProgress();
        }

        report?.((p) => {
            p.stage = 'writing';
            p.developers_matched = matchedDevelopers.size;
        });

        // Upsert all merged snapshots + per-PR records in a single transaction
        const insertMany = db.transaction(() => {
            for (const snap of globalSnapshots.values()) {
                const outcome = upsertSnapshot(db, snap);
                if (outcome === 'written') snapshotsWritten++;
                else snapshotsSkipped++;
            }
            for (const {record, developerId} of resolvedPRRecords) {
                upsertPRRecord(db, record, developerId, now);
            }
        });

        try {
            insertMany();
        } catch (err) {
            errors.push(
                `Failed to write snapshots: ${err instanceof Error ? err.message : String(err)}`,
            );
        }

        if (allUnmatched.size > 0) {
            errors.push(`${UNMATCHED_AUTHORS_PREFIX} ${[...allUnmatched].join(', ')}`);
        }

        return {connector: CONNECTOR_NAME, snapshotsWritten, snapshotsSkipped, errors, lastSyncTime: now};
    }

    // Resolve the providers this sync run should cover: DB-connected providers
    // (via the store) merged with config-file providers, DB winning on overlap.
    // Loads the server key here (fail-closed) so a UI-connected provider's token
    // can be decrypted; a config-only setup with no key is unaffected.
    private getProviderConfigs(db: Database.Database): GitProviderConfig[] {
        return resolveAllGitProviders(db, loadServerKey(), this.config);
    }
}
