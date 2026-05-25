import type {GitCommit, GitPullRequest} from './client';
import {calculateChurnRate} from './churn';
import {scoreAiSignature} from './ai-signature';

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

function toDateString(isoDate: string): string {
    return isoDate.slice(0, 10);
}

function detectBursts(commits: GitCommit[]): number {
    if (commits.length < COMMIT_BURST_MIN_COUNT) return 0;

    const times = commits
        .map((c) => new Date(c.author_date).getTime())
        .sort((a, b) => a - b);

    const windowMs = COMMIT_BURST_WINDOW_MINUTES * 60 * 1_000;
    let burstCount = 0;

    for (let i = 0; i <= times.length - COMMIT_BURST_MIN_COUNT; i++) {
        if (times[i + COMMIT_BURST_MIN_COUNT - 1] - times[i] <= windowMs) {
            burstCount++;
            // Skip past all commits in this burst to avoid double-counting overlapping windows
            const burstEnd = times[i] + windowMs;
            while (i < times.length && times[i] <= burstEnd) i++;
            i--;
        }
    }

    return burstCount;
}

export function aggregateDailyMetrics(
    commits: GitCommit[],
    pullRequests: GitPullRequest[],
    churnWindowHours = 48,
): Map<string, Map<string, DailyGitMetrics>> {
    // Map: login -> date -> metrics
    const result = new Map<string, Map<string, DailyGitMetrics>>();

    // Group commits by login and date
    const commitsByLoginDate = new Map<string, Map<string, GitCommit[]>>();
    for (const commit of commits) {
        const login = commit.author_login;
        if (!login) continue;
        const date = toDateString(commit.author_date);

        if (!commitsByLoginDate.has(login)) commitsByLoginDate.set(login, new Map());
        const byDate = commitsByLoginDate.get(login)!;
        if (!byDate.has(date)) byDate.set(date, []);
        byDate.get(date)!.push(commit);
    }

    // Group all commits per login for burst detection (across all dates)
    const allCommitsByLogin = new Map<string, GitCommit[]>();
    for (const commit of commits) {
        const login = commit.author_login;
        if (!login) continue;
        if (!allCommitsByLogin.has(login)) allCommitsByLogin.set(login, []);
        allCommitsByLogin.get(login)!.push(commit);
    }

    // Process commit metrics per login and date
    for (const [login, byDate] of commitsByLoginDate) {
        if (!result.has(login)) result.set(login, new Map());
        const devMetrics = result.get(login)!;

        for (const [date, dayCommits] of byDate) {
            const totalAdded = dayCommits.reduce((s, c) => s + c.additions, 0);
            const totalRemoved = dayCommits.reduce((s, c) => s + c.deletions, 0);
            const totalFiles = dayCommits.reduce((s, c) => s + c.files_changed, 0);
            const avgCommitSize = dayCommits.length > 0 ? (totalAdded + totalRemoved) / dayCommits.length : 0;

            const {churn_rate} = calculateChurnRate(dayCommits, churnWindowHours);
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
                code_churn_rate: churn_rate,
                ai_signature_score: avgAiScore,
                avg_commit_size: avgCommitSize,
                commit_burst_count: 0, // filled below
            });
        }
    }

    // Compute burst counts per login per day using all-login commits
    for (const [login, allCommits] of allCommitsByLogin) {
        const commitsByDate = new Map<string, GitCommit[]>();
        for (const commit of allCommits) {
            const date = toDateString(commit.author_date);
            if (!commitsByDate.has(date)) commitsByDate.set(date, []);
            commitsByDate.get(date)!.push(commit);
        }

        const devMetrics = result.get(login);
        if (!devMetrics) continue;

        for (const [date, dayCommits] of commitsByDate) {
            const metrics = devMetrics.get(date);
            if (metrics) {
                metrics.commit_burst_count = detectBursts(dayCommits);
            }
        }
    }

    // Process PR metrics
    for (const pr of pullRequests) {
        const login = pr.author_login;
        if (!login) continue;

        const openedDate = toDateString(pr.created_at);
        if (!result.has(login)) result.set(login, new Map());
        const devMetrics = result.get(login)!;

        // prs_opened on created date
        const openedMetrics = devMetrics.get(openedDate);
        if (openedMetrics) {
            openedMetrics.prs_opened++;
        } else {
            devMetrics.set(openedDate, {
                developer_login: login,
                date: openedDate,
                commits: 0,
                lines_added: 0,
                lines_removed: 0,
                files_changed: 0,
                prs_opened: 1,
                prs_merged: 0,
                review_comments_given: 0,
                avg_time_to_merge_hours: null,
                code_churn_rate: 0,
                ai_signature_score: 0,
                avg_commit_size: 0,
                commit_burst_count: 0,
            });
        }

        // prs_merged and time-to-merge on merged date
        if (pr.merged_at) {
            const mergedDate = toDateString(pr.merged_at);
            const timeToMergeHours =
                (new Date(pr.merged_at).getTime() - new Date(pr.created_at).getTime()) /
                (1000 * 3600);

            if (!devMetrics.has(mergedDate)) {
                devMetrics.set(mergedDate, {
                    developer_login: login,
                    date: mergedDate,
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
                });
            }

            const mergedMetrics = devMetrics.get(mergedDate)!;
            mergedMetrics.prs_merged++;

            // Rolling average of time-to-merge
            if (mergedMetrics.avg_time_to_merge_hours === null) {
                mergedMetrics.avg_time_to_merge_hours = timeToMergeHours;
            } else {
                mergedMetrics.avg_time_to_merge_hours =
                    (mergedMetrics.avg_time_to_merge_hours * (mergedMetrics.prs_merged - 1) +
                        timeToMergeHours) /
                    mergedMetrics.prs_merged;
            }
        }
    }

    return result;
}
