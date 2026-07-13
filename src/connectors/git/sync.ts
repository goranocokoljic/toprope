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

/** The stages a sync run passes through, in pipeline order (GC#209). */
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

// Mutate-then-emit reporter threaded through the pipeline: applies `mutate` to
// the run's single progress state, then emits a defensive copy so a listener
// can never mutate pipeline state. Undefined when no listener was passed, so
// the scheduled path pays nothing.
type ProgressReporter = (mutate: (progress: GitSyncProgress) => void) => void;

function syncStateKey(providerType: GitProviderType, identifier: string): string {
    return `git_last_sync:${providerType}:${identifier}`;
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
}

async function fetchProviderData(
    providerConfig: GitProviderConfig,
    now: string,
    db: Database.Database,
    report?: ProgressReporter,
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
    const since = getProviderLastSyncTime(db, stateKey) ?? '';

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
        };
    }

    const reposToSync = applyRepoFilter(
        repoNames,
        includeRepos.length > 0 ? includeRepos : undefined,
        allExclude.length > 0 ? allExclude : undefined,
    );

    // repos_total accumulates (+=) rather than assigns so a multi-provider run
    // keeps the counters cumulative across providers, matching the other counts.
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
            rawCommits = await provider.getCommits(repoName, since, now);
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
        return this.runSync(db, providerConfigs, onProgress);
    }

    // The shared pipeline body for both entry points above. Assumes a non-empty,
    // already-resolved provider set (callers own resolution + the empty case) so
    // the fetch/merge/upsert logic lives in exactly one place.
    private async runSync(
        db: Database.Database,
        providerConfigs: GitProviderConfig[],
        onProgress?: GitSyncProgressListener,
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
            const result = await fetchProviderData(pc, now, db, report);
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
            const {commits, prs, reviewComments, prRecords, stateKey} = result;

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
                setProviderLastSyncTime(db, stateKey, now);
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

            report?.((p) => {
                p.developers_matched = matchedDevelopers.size;
            });
            setProviderLastSyncTime(db, stateKey, now);
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
