import type {AnalysisCommit, AnalysisPR, AnalysisReviewComment} from './analysis-types.js';
import {calculateDailyChurnRates} from './churn.js';
import {scoreAiSignature} from './ai-signature.js';

export interface DailyGitMetrics {
    developer_login: string;
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
}

const COMMIT_BURST_WINDOW_MINUTES = 30;
const COMMIT_BURST_MIN_COUNT = 3;

/**
 * The day key this pipeline attributes an ISO timestamp to.
 *
 * TOTAL over `unknown`, not over `string` (#302). Every timestamp reaching here is a field of a
 * response body the providers cast rather than validate, so `pr.createdAt` can be `null` or a
 * number at runtime however the interface types it — and a bare `.slice` on one of those throws
 * a `TypeError` out of `aggregateDailyMetrics`, which is not inside the run's `try`. That kills
 * the whole run before any provider's cursor advances and recurs identically next run: the same
 * permanent-stall geometry the write-boundary skip exists to close, reached one frame earlier.
 *
 * A non-string yields `''`, which is NOT a day the store will accept — so the row is skipped and
 * REPORTED by the write boundary rather than silently vanishing here. Deliberately not
 * `String(isoDate).slice(0, 10)`: `String(['2024-01-15T00:00:00Z'])` is a perfectly well-formed
 * day, so coercing would let an odd JSON body manufacture a valid-looking key out of a value
 * nobody can attribute — the same coercion hazard `isAttributableDate` puts its `typeof` first
 * for. `''` cannot be produced that way, and the one string that does produce it (`createdAt:
 * ''`) is unattributable for the same reason, so folding them together loses no distinction.
 *
 * SCOPED TO THE PR AND REVIEW-COMMENT DATES, which is the half nothing else gates. A COMMIT date
 * reaching this function has already passed `isAttributableDate` at its provider, and it had
 * better have: `calculateDailyChurnRates` (`churn.ts`) still slices `commit.date` bare, and it
 * runs BEFORE this function is ever asked about a commit — so totality here does not make
 * `aggregateDailyMetrics` total over a non-string commit date. The provider gate is what covers
 * that path; do not read this as covering it.
 */
function toDateString(isoDate: unknown): string {
    return typeof isoDate === 'string' ? isoDate.slice(0, 10) : '';
}

/**
 * How long a PR took to merge, in hours — or `null` when that is not KNOWN (#302).
 *
 * The ONE rule, shared with `pr_records`' `timeToMergeHours` in `sync.ts`, which delegates
 * here. Two copies is how they came to disagree: for `created_at: '+033658-…'` the store wrote
 * `pr_records.time_to_merge_hours = NULL` and `raw_author_daily.avg_time_to_merge_hours =
 * -277304070` from the SAME pair of timestamps, because one rejected `ms < 0` and the other
 * only asked `Number.isFinite`.
 *
 * `Date.parse`, gated by `typeof`, NOT `new Date(x).getTime()`. This is the same coercion
 * hazard {@link toDateString} refuses, and it is easier to miss here because the result LOOKS
 * fine: `new Date(null)` is the Unix EPOCH, not an Invalid Date, so a `null` `createdAt` and a
 * real `mergedAt` yield a perfectly finite ~54-year duration that every downstream check
 * accepts and stores. `Date.parse(null)` stringifies to `'null'` and is NaN, which is the
 * honest answer; the `typeof` guard then also covers an array, whose `toString` would
 * otherwise reproduce a parseable instant.
 *
 * `ms >= 0` because a PR cannot merge before it was opened, so a negative duration is a
 * statement about the response, not about the PR — and unlike NaN it survives every
 * finiteness check all the way into `git_snapshots`.
 */
export function prMergeDurationHours(createdAt: unknown, mergedAt: unknown): number | null {
    const ms = toInstantMs(mergedAt) - toInstantMs(createdAt);
    return Number.isFinite(ms) && ms >= 0 ? ms / 3_600_000 : null;
}

/** An instant as epoch ms, or NaN — total over `unknown`, for the reason above. */
function toInstantMs(iso: unknown): number {
    return typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
}

/**
 * One commit reduced to what burst detection needs: WHEN it happened and WHICH day key it is
 * attributed to. The two are separate on purpose — an offset-bearing author timestamp
 * (`…T10:00:00.000+02:00`, which GitLab really sends) keys to the day of its RAW string while
 * ordering by its instant, and folding them together would silently move commits a day.
 */
export interface BurstEvent {
    instantMs: number;
    day: string;
}

/**
 * Detect bursts across a developer's full commit stream (so bursts spanning midnight are not
 * split), attributing each burst to the day of its first commit. Returns burst counts keyed by
 * day.
 *
 * Exported (IG1.2 / #318) so the `raw_commits` cell recompute derives `commit_burst_count` with
 * THIS detector over the stored `committed_at` stream rather than re-implementing the
 * skip-past-the-window scan — a second copy would have to stay in step with a rule whose whole
 * point is not double-counting overlapping windows.
 */
export function detectBursts(events: BurstEvent[]): Map<string, number> {
    const burstsByDate = new Map<string, number>();
    if (events.length < COMMIT_BURST_MIN_COUNT) return burstsByDate;

    const sorted = [...events].sort((a, b) => a.instantMs - b.instantMs);
    const times = sorted.map((e) => e.instantMs);
    const windowMs = COMMIT_BURST_WINDOW_MINUTES * 60 * 1_000;

    for (let i = 0; i <= times.length - COMMIT_BURST_MIN_COUNT; i++) {
        if (times[i + COMMIT_BURST_MIN_COUNT - 1] - times[i] <= windowMs) {
            const day = sorted[i].day;
            burstsByDate.set(day, (burstsByDate.get(day) ?? 0) + 1);
            // Skip past all commits in this burst to avoid double-counting overlapping windows
            const burstEnd = times[i] + windowMs;
            while (i < times.length && times[i] <= burstEnd) i++;
            i--;
        }
    }

    return burstsByDate;
}

function detectBurstsByDate(commits: AnalysisCommit[]): Map<string, number> {
    return detectBursts(
        commits.map((c) => ({instantMs: new Date(c.date).getTime(), day: toDateString(c.date)})),
    );
}

function emptyMetrics(login: string, date: string): DailyGitMetrics {
    return {
        developer_login: login,
        date,
        commits: 0,
        lines_added: 0,
        lines_removed: 0,
        files_changed: 0,
        prs_opened: 0,
        prs_merged: 0,
        review_comments_given: 0,
        avg_time_to_merge_hours: null,
        code_churn_rate: 0,
        ai_signature_score: 0,
        avg_commit_size: 0,
        commit_burst_count: 0,
    };
}

export function aggregateDailyMetrics(
    commits: AnalysisCommit[],
    pullRequests: AnalysisPR[],
    churnWindowHours = 48,
    reviewComments: AnalysisReviewComment[] = [],
): Map<string, Map<string, DailyGitMetrics>> {
    // Map: login -> date -> metrics
    const result = new Map<string, Map<string, DailyGitMetrics>>();

    // Group commits by login and date
    const commitsByLoginDate = new Map<string, Map<string, AnalysisCommit[]>>();
    for (const commit of commits) {
        const login = commit.authorLogin;
        if (!login) continue;
        const date = toDateString(commit.date);

        if (!commitsByLoginDate.has(login)) commitsByLoginDate.set(login, new Map());
        const byDate = commitsByLoginDate.get(login)!;
        if (!byDate.has(date)) byDate.set(date, []);
        byDate.get(date)!.push(commit);
    }

    // Group all commits per login for burst detection and windowed churn
    // (both need the full cross-day commit stream, not just one day's commits)
    const allCommitsByLogin = new Map<string, AnalysisCommit[]>();
    for (const commit of commits) {
        const login = commit.authorLogin;
        if (!login) continue;
        if (!allCommitsByLogin.has(login)) allCommitsByLogin.set(login, []);
        allCommitsByLogin.get(login)!.push(commit);
    }

    // Churn must consider the window across days, so compute per-day rates from
    // each developer's full commit history up front.
    const churnByLogin = new Map<string, Map<string, number>>();
    for (const [login, all] of allCommitsByLogin) {
        churnByLogin.set(login, calculateDailyChurnRates(all, churnWindowHours));
    }

    // Process commit metrics per login and date
    for (const [login, byDate] of commitsByLoginDate) {
        if (!result.has(login)) result.set(login, new Map());
        const devMetrics = result.get(login)!;
        const churnByDate = churnByLogin.get(login);

        for (const [date, dayCommits] of byDate) {
            const totalAdded = dayCommits.reduce((s, c) => s + c.additions, 0);
            const totalRemoved = dayCommits.reduce((s, c) => s + c.deletions, 0);
            const totalFiles = dayCommits.reduce((s, c) => s + c.fileDiffs.length, 0);
            const avgCommitSize = dayCommits.length > 0 ? (totalAdded + totalRemoved) / dayCommits.length : 0;

            const churnRate = churnByDate?.get(date) ?? 0;
            const aiScores = dayCommits.map((c) => scoreAiSignature(c).estimated_score);
            const avgAiScore = aiScores.length > 0
                ? aiScores.reduce((s, v) => s + v, 0) / aiScores.length
                : 0;

            const existing = devMetrics.get(date);
            devMetrics.set(date, {
                developer_login: login,
                date,
                commits: (existing?.commits ?? 0) + dayCommits.length,
                lines_added: (existing?.lines_added ?? 0) + totalAdded,
                lines_removed: (existing?.lines_removed ?? 0) + totalRemoved,
                files_changed: (existing?.files_changed ?? 0) + totalFiles,
                prs_opened: existing?.prs_opened ?? 0,
                prs_merged: existing?.prs_merged ?? 0,
                review_comments_given: existing?.review_comments_given ?? 0,
                avg_time_to_merge_hours: existing?.avg_time_to_merge_hours ?? null,
                code_churn_rate: churnRate,
                ai_signature_score: avgAiScore,
                avg_commit_size: avgCommitSize,
                commit_burst_count: 0, // filled below
            });
        }
    }

    // Compute burst counts across each developer's full commit stream so a
    // burst spanning midnight is counted (attributed to its first commit's day).
    for (const [login, allCommits] of allCommitsByLogin) {
        const devMetrics = result.get(login);
        if (!devMetrics) continue;

        for (const [date, count] of detectBurstsByDate(allCommits)) {
            const metrics = devMetrics.get(date);
            if (metrics) metrics.commit_burst_count = count;
        }
    }

    // How many of a (login, day)'s merged PRs had a MEASURABLE time-to-merge (#302).
    //
    // Tracked separately from `prs_merged` because the two legitimately differ: a PR whose
    // `createdAt` or `mergedAt` the pipeline cannot use still merged (it counts), but its
    // duration is unknown and must not enter the mean. Reusing `prs_merged` as the divisor —
    // which the in-place rolling average used to do — weights the surviving samples by a count
    // that includes the ones never added: with an unmeasurable PR listed FIRST (the common
    // order, since every provider lists PRs newest-first) a single 10h observation is reported
    // as 5h.
    //
    // Keyed by the metrics OBJECT, not a synthesized `login + day` string. `mergedMetrics` is
    // the row stored in `devMetrics`, one per (login, day) — already exactly this counter's
    // grain — so an object key makes collision impossible by construction rather than by an
    // argument about separator characters in a free-form provider login.
    const measuredMergeTimes = new Map<DailyGitMetrics, number>();

    // Process PR metrics
    for (const pr of pullRequests) {
        const login = pr.authorLogin;
        if (!login) continue;

        const openedDate = toDateString(pr.createdAt);
        if (!result.has(login)) result.set(login, new Map());
        const devMetrics = result.get(login)!;

        // prs_opened on created date
        const openedMetrics = devMetrics.get(openedDate);
        if (openedMetrics) {
            openedMetrics.prs_opened++;
        } else {
            const m = emptyMetrics(login, openedDate);
            m.prs_opened = 1;
            devMetrics.set(openedDate, m);
        }

        // prs_merged and time-to-merge on merged date
        if (pr.mergedAt) {
            const mergedDate = toDateString(pr.mergedAt);
            const timeToMergeHours = prMergeDurationHours(pr.createdAt, pr.mergedAt);

            if (!devMetrics.has(mergedDate)) {
                devMetrics.set(mergedDate, emptyMetrics(login, mergedDate));
            }

            const mergedMetrics = devMetrics.get(mergedDate)!;
            mergedMetrics.prs_merged++;

            // Rolling average of time-to-merge, over the MEASURABLE samples only (#302).
            //
            // A `createdAt` or `mergedAt` this pipeline cannot use makes the duration UNKNOWN,
            // and the write boundary refuses a NaN metric — so before this guard ONE malformed
            // PR timestamp cost the whole merged-day row, including its commits, and could do so
            // on a day whose own date was perfectly fine (a bad `createdAt` poisons the row keyed
            // by `mergedAt`). `avg_time_to_merge_hours` is nullable precisely to mean "not
            // known", so leaving it alone is the honest answer and it costs nothing else. The
            // write boundary still refuses a NaN that reaches it by any other route — this
            // narrows what that skip has to swallow, it does not replace it.
            //
            // No `samples === 1` special case: at one sample the general expression below is
            // `((null ?? 0) * 0 + t) / 1`, which IS `t`.
            if (timeToMergeHours !== null) {
                const samples = (measuredMergeTimes.get(mergedMetrics) ?? 0) + 1;
                measuredMergeTimes.set(mergedMetrics, samples);
                mergedMetrics.avg_time_to_merge_hours =
                    ((mergedMetrics.avg_time_to_merge_hours ?? 0) * (samples - 1) +
                        timeToMergeHours) /
                    samples;
            }
        }
    }

    // Attribute review comments to the developer who wrote them, on the day
    // the comment was made (a reviewer's activity, not the PR author's).
    for (const comment of reviewComments) {
        const login = comment.authorLogin;
        if (!login) continue;

        const date = toDateString(comment.createdAt);
        if (!result.has(login)) result.set(login, new Map());
        const devMetrics = result.get(login)!;

        let metrics = devMetrics.get(date);
        if (!metrics) {
            metrics = emptyMetrics(login, date);
            devMetrics.set(date, metrics);
        }
        metrics.review_comments_given++;
    }

    return result;
}
