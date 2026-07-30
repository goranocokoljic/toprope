/**
 * Cross-provider fixture tests — verifies that the analysis engine produces
 * identical git_snapshots from equivalent commit data regardless of which
 * provider (GitHub, Bitbucket, GitLab) supplied it.
 */
import {describe, it, expect} from 'vitest';
import {aggregateDailyMetrics} from '../../../src/connectors/git/analyzer';
import {toAnalysisCommit, toAnalysisPR, toAnalysisReviewComment} from '../../../src/connectors/git/analysis-types';
import type {GitCommit, GitPR, GitReviewComment, GitFileDiff} from '../../../src/connectors/git/providers/types';

// A canonical commit fixture that all three providers would return for the same
// underlying commit (same author, same code change, different provider types).
const CANONICAL_DIFFS: GitFileDiff[] = [
    {path: 'src/service.ts', additions: 120, deletions: 30, status: 'modified'},
    {path: 'src/utils.ts', additions: 45, deletions: 10, status: 'modified'},
    {path: 'tests/service.test.ts', additions: 80, deletions: 0, status: 'added'},
];

function makeEquivalentCommit(username: string, sha: string): GitCommit {
    return {
        sha,
        author: {name: 'Alice Dev', email: 'alice@example.com', username},
        date: '2024-03-10T09:30:00Z',
        message: 'feat: add service layer with comprehensive tests',
        additions: 245,
        deletions: 40,
    };
}

function makeEquivalentPR(username: string, id: string): GitPR {
    return {
        id,
        title: 'feat: add service layer',
        author: {name: 'Alice Dev', email: 'alice@example.com', username},
        state: 'merged',
        createdAt: '2024-03-10T08:00:00Z',
        mergedAt: '2024-03-11T14:00:00Z',
        closedAt: '2024-03-11T14:00:00Z',
        updatedAt: '2024-03-11T14:00:00Z',
        reviewers: [],
        additions: 245,
        deletions: 40,
    };
}

function makeEquivalentReviewComment(username: string, prId: string): GitReviewComment {
    return {
        author: {name: 'Bob Rev', email: 'bob@example.com', username},
        body: 'LGTM',
        createdAt: '2024-03-10T15:00:00Z',
        prId,
    };
}

// Provider-specific usernames for the same developer
const GITHUB_USERNAME = 'alice-gh';
const BITBUCKET_USERNAME = 'alice-bb';
const GITLAB_USERNAME = 'alice-gl';

const REVIEWER_GH = 'bob-gh';
const REVIEWER_BB = 'bob-bb';
const REVIEWER_GL = 'bob-gl';

describe('Cross-provider analysis: identical output for equivalent fixtures', () => {
    function runAnalysis(authorLogin: string, reviewerLogin: string) {
        const commit = makeEquivalentCommit(authorLogin, `sha-${authorLogin}`);
        const pr = makeEquivalentPR(authorLogin, `pr-${authorLogin}`);
        const review = makeEquivalentReviewComment(reviewerLogin, `pr-${authorLogin}`);

        const analysisCommit = toAnalysisCommit(commit, CANONICAL_DIFFS);
        const analysisPR = toAnalysisPR(pr);
        const analysisReview = toAnalysisReviewComment(review);

        return aggregateDailyMetrics([analysisCommit], [analysisPR], 48, [analysisReview]);
    }

    it('produces identical commit metrics from GitHub, Bitbucket, and GitLab data', () => {
        const ghResult = runAnalysis(GITHUB_USERNAME, REVIEWER_GH);
        const bbResult = runAnalysis(BITBUCKET_USERNAME, REVIEWER_BB);
        const glResult = runAnalysis(GITLAB_USERNAME, REVIEWER_GL);

        const ghDay = ghResult.get(GITHUB_USERNAME)!.get('2024-03-10')!;
        const bbDay = bbResult.get(BITBUCKET_USERNAME)!.get('2024-03-10')!;
        const glDay = glResult.get(GITLAB_USERNAME)!.get('2024-03-10')!;

        // Commit counts must match
        expect(ghDay.commits).toBe(1);
        expect(bbDay.commits).toBe(1);
        expect(glDay.commits).toBe(1);

        // Line counts must match
        expect(ghDay.lines_added).toBe(bbDay.lines_added);
        expect(ghDay.lines_added).toBe(glDay.lines_added);
        expect(ghDay.lines_removed).toBe(bbDay.lines_removed);
        expect(ghDay.lines_removed).toBe(glDay.lines_removed);

        // File counts must match
        expect(ghDay.files_changed).toBe(bbDay.files_changed);
        expect(ghDay.files_changed).toBe(glDay.files_changed);
    });

    it('produces identical AI signature scores across providers', () => {
        const ghResult = runAnalysis(GITHUB_USERNAME, REVIEWER_GH);
        const bbResult = runAnalysis(BITBUCKET_USERNAME, REVIEWER_BB);
        const glResult = runAnalysis(GITLAB_USERNAME, REVIEWER_GL);

        const ghScore = ghResult.get(GITHUB_USERNAME)!.get('2024-03-10')!.ai_signature_score;
        const bbScore = bbResult.get(BITBUCKET_USERNAME)!.get('2024-03-10')!.ai_signature_score;
        const glScore = glResult.get(GITLAB_USERNAME)!.get('2024-03-10')!.ai_signature_score;

        expect(ghScore).toBe(bbScore);
        expect(ghScore).toBe(glScore);
    });

    it('produces identical churn rates across providers', () => {
        // Two commits touching the same file within 48h — should produce same churn
        const makeChurnCommit = (username: string, sha: string, date: string): GitCommit => ({
            sha,
            author: {name: 'Alice Dev', email: 'alice@example.com', username},
            date,
            message: 'fix: re-churn',
            additions: 50,
            deletions: 10,
        });
        const churnDiff: GitFileDiff[] = [{path: 'src/service.ts', additions: 50, deletions: 10, status: 'modified'}];

        const runChurnAnalysis = (username: string) => {
            const c1 = toAnalysisCommit(makeChurnCommit(username, 'sha1', '2024-03-10T08:00:00Z'), churnDiff);
            const c2 = toAnalysisCommit(makeChurnCommit(username, 'sha2', '2024-03-10T16:00:00Z'), churnDiff);
            return aggregateDailyMetrics([c1, c2], [], 48);
        };

        const ghChurn = runChurnAnalysis(GITHUB_USERNAME).get(GITHUB_USERNAME)!.get('2024-03-10')!.code_churn_rate;
        const bbChurn = runChurnAnalysis(BITBUCKET_USERNAME).get(BITBUCKET_USERNAME)!.get('2024-03-10')!.code_churn_rate;
        const glChurn = runChurnAnalysis(GITLAB_USERNAME).get(GITLAB_USERNAME)!.get('2024-03-10')!.code_churn_rate;

        expect(ghChurn).toBe(bbChurn);
        expect(ghChurn).toBe(glChurn);
        expect(ghChurn).toBeGreaterThan(0); // should detect churn
    });

    it('detects commit bursts consistently across providers', () => {
        const makeBurstCommit = (username: string, sha: string, date: string): GitCommit => ({
            sha,
            author: {name: 'Alice Dev', email: 'alice@example.com', username},
            date,
            message: 'chore: quick commit',
            additions: 5,
            deletions: 2,
        });
        const diff: GitFileDiff[] = [{path: 'src/x.ts', additions: 5, deletions: 2, status: 'modified'}];

        const runBurstAnalysis = (username: string) => {
            const commits = [
                toAnalysisCommit(makeBurstCommit(username, 's1', '2024-03-10T10:00:00Z'), diff),
                toAnalysisCommit(makeBurstCommit(username, 's2', '2024-03-10T10:10:00Z'), diff),
                toAnalysisCommit(makeBurstCommit(username, 's3', '2024-03-10T10:20:00Z'), diff),
            ];
            return aggregateDailyMetrics(commits, [], 48);
        };

        const ghBurst = runBurstAnalysis(GITHUB_USERNAME).get(GITHUB_USERNAME)!.get('2024-03-10')!.commit_burst_count;
        const bbBurst = runBurstAnalysis(BITBUCKET_USERNAME).get(BITBUCKET_USERNAME)!.get('2024-03-10')!.commit_burst_count;
        const glBurst = runBurstAnalysis(GITLAB_USERNAME).get(GITLAB_USERNAME)!.get('2024-03-10')!.commit_burst_count;

        expect(ghBurst).toBeGreaterThan(0);
        expect(ghBurst).toBe(bbBurst);
        expect(ghBurst).toBe(glBurst);
    });

    it('produces identical PR metrics across providers', () => {
        const ghResult = runAnalysis(GITHUB_USERNAME, REVIEWER_GH);
        const bbResult = runAnalysis(BITBUCKET_USERNAME, REVIEWER_BB);
        const glResult = runAnalysis(GITLAB_USERNAME, REVIEWER_GL);

        // PR opened on 2024-03-10
        const ghOpen = ghResult.get(GITHUB_USERNAME)!.get('2024-03-10')!.prs_opened;
        const bbOpen = bbResult.get(BITBUCKET_USERNAME)!.get('2024-03-10')!.prs_opened;
        const glOpen = glResult.get(GITLAB_USERNAME)!.get('2024-03-10')!.prs_opened;
        expect(ghOpen).toBe(1);
        expect(bbOpen).toBe(1);
        expect(glOpen).toBe(1);

        // PR merged on 2024-03-11
        const ghMerged = ghResult.get(GITHUB_USERNAME)!.get('2024-03-11')!.prs_merged;
        const bbMerged = bbResult.get(BITBUCKET_USERNAME)!.get('2024-03-11')!.prs_merged;
        const glMerged = glResult.get(GITLAB_USERNAME)!.get('2024-03-11')!.prs_merged;
        expect(ghMerged).toBe(1);
        expect(bbMerged).toBe(1);
        expect(glMerged).toBe(1);

        // avg_time_to_merge identical
        const ghTTM = ghResult.get(GITHUB_USERNAME)!.get('2024-03-11')!.avg_time_to_merge_hours;
        const bbTTM = bbResult.get(BITBUCKET_USERNAME)!.get('2024-03-11')!.avg_time_to_merge_hours;
        const glTTM = glResult.get(GITLAB_USERNAME)!.get('2024-03-11')!.avg_time_to_merge_hours;
        expect(ghTTM).toBe(bbTTM);
        expect(ghTTM).toBe(glTTM);
    });

    it('review comments attributed consistently regardless of provider', () => {
        const ghResult = runAnalysis(GITHUB_USERNAME, REVIEWER_GH);
        const bbResult = runAnalysis(BITBUCKET_USERNAME, REVIEWER_BB);
        const glResult = runAnalysis(GITLAB_USERNAME, REVIEWER_GL);

        const ghComments = ghResult.get(REVIEWER_GH)!.get('2024-03-10')!.review_comments_given;
        const bbComments = bbResult.get(REVIEWER_BB)!.get('2024-03-10')!.review_comments_given;
        const glComments = glResult.get(REVIEWER_GL)!.get('2024-03-10')!.review_comments_given;

        expect(ghComments).toBe(1);
        expect(bbComments).toBe(1);
        expect(glComments).toBe(1);
    });
});
