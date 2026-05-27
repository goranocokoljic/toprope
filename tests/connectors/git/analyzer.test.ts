import {describe, it, expect} from 'vitest';
import {aggregateDailyMetrics} from '../../../src/connectors/git/analyzer';
import type {AnalysisCommit, AnalysisPR, AnalysisReviewComment} from '../../../src/connectors/git/analysis-types';

function makeCommit(overrides: Partial<AnalysisCommit> = {}): AnalysisCommit {
    return {
        sha: 'abc123',
        authorLogin: 'alice',
        authorEmail: 'alice@example.com',
        date: '2024-01-15T10:00:00Z',
        message: 'feat: add feature',
        additions: 50,
        deletions: 10,
        fileDiffs: [
            {path: 'src/foo.ts', additions: 30, deletions: 5, status: 'modified'},
            {path: 'src/bar.ts', additions: 20, deletions: 5, status: 'modified'},
        ],
        ...overrides,
    };
}

function makePR(overrides: Partial<AnalysisPR> = {}): AnalysisPR {
    return {
        id: '1',
        authorLogin: 'alice',
        createdAt: '2024-01-15T08:00:00Z',
        mergedAt: '2024-01-16T10:00:00Z',
        ...overrides,
    };
}

describe('aggregateDailyMetrics - commits', () => {
    it('aggregates commit counts per developer per day', () => {
        const commits = [
            makeCommit({sha: 'c1', date: '2024-01-15T10:00:00Z'}),
            makeCommit({sha: 'c2', date: '2024-01-15T14:00:00Z'}),
            makeCommit({sha: 'c3', date: '2024-01-16T10:00:00Z'}),
        ];
        const result = aggregateDailyMetrics(commits, []);
        const aliceMetrics = result.get('alice')!;

        expect(aliceMetrics.get('2024-01-15')!.commits).toBe(2);
        expect(aliceMetrics.get('2024-01-16')!.commits).toBe(1);
    });

    it('sums lines_added and lines_removed correctly', () => {
        const commits = [
            makeCommit({sha: 'c1', additions: 100, deletions: 20}),
            makeCommit({sha: 'c2', additions: 50, deletions: 10, date: '2024-01-15T14:00:00Z'}),
        ];
        const result = aggregateDailyMetrics(commits, []);
        const day = result.get('alice')!.get('2024-01-15')!;

        expect(day.lines_added).toBe(150);
        expect(day.lines_removed).toBe(30);
    });

    it('skips commits with null authorLogin', () => {
        const commits = [
            makeCommit({sha: 'c1', authorLogin: null}),
        ];
        const result = aggregateDailyMetrics(commits, []);
        expect(result.size).toBe(0);
    });

    it('handles multiple developers separately', () => {
        const commits = [
            makeCommit({sha: 'c1', authorLogin: 'alice'}),
            makeCommit({sha: 'c2', authorLogin: 'bob', date: '2024-01-15T11:00:00Z'}),
        ];
        const result = aggregateDailyMetrics(commits, []);
        expect(result.has('alice')).toBe(true);
        expect(result.has('bob')).toBe(true);
        expect(result.get('alice')!.get('2024-01-15')!.commits).toBe(1);
        expect(result.get('bob')!.get('2024-01-15')!.commits).toBe(1);
    });

    it('returns empty map for empty commits and PRs', () => {
        const result = aggregateDailyMetrics([], []);
        expect(result.size).toBe(0);
    });
});

describe('aggregateDailyMetrics - burst detection', () => {
    it('detects commit burst (3+ commits within 30 minutes)', () => {
        const commits = [
            makeCommit({sha: 'c1', date: '2024-01-15T10:00:00Z'}),
            makeCommit({sha: 'c2', date: '2024-01-15T10:10:00Z'}),
            makeCommit({sha: 'c3', date: '2024-01-15T10:20:00Z'}),
        ];
        const result = aggregateDailyMetrics(commits, []);
        const day = result.get('alice')!.get('2024-01-15')!;
        expect(day.commit_burst_count).toBeGreaterThan(0);
    });

    it('does not flag 3 commits spread over 2 hours', () => {
        const commits = [
            makeCommit({sha: 'c1', date: '2024-01-15T08:00:00Z'}),
            makeCommit({sha: 'c2', date: '2024-01-15T10:00:00Z'}),
            makeCommit({sha: 'c3', date: '2024-01-15T12:00:00Z'}),
        ];
        const result = aggregateDailyMetrics(commits, []);
        const day = result.get('alice')!.get('2024-01-15')!;
        expect(day.commit_burst_count).toBe(0);
    });

    it('does not flag 2 commits within 30 minutes (below threshold)', () => {
        const commits = [
            makeCommit({sha: 'c1', date: '2024-01-15T10:00:00Z'}),
            makeCommit({sha: 'c2', date: '2024-01-15T10:10:00Z'}),
        ];
        const result = aggregateDailyMetrics(commits, []);
        const day = result.get('alice')!.get('2024-01-15')!;
        expect(day.commit_burst_count).toBe(0);
    });
});

describe('aggregateDailyMetrics - PR metrics', () => {
    it('attributes prs_opened to createdAt date', () => {
        const result = aggregateDailyMetrics([], [makePR()]);
        const alice = result.get('alice')!;
        expect(alice.get('2024-01-15')!.prs_opened).toBe(1);
    });

    it('attributes prs_merged to mergedAt date', () => {
        const result = aggregateDailyMetrics([], [makePR()]);
        const alice = result.get('alice')!;
        expect(alice.get('2024-01-16')!.prs_merged).toBe(1);
    });

    it('calculates time_to_merge_hours correctly', () => {
        const pr = makePR({
            createdAt: '2024-01-15T08:00:00Z',
            mergedAt: '2024-01-15T18:00:00Z', // 10 hours later
        });
        const result = aggregateDailyMetrics([], [pr]);
        const mergedDay = result.get('alice')!.get('2024-01-15')!;
        expect(mergedDay.avg_time_to_merge_hours).toBeCloseTo(10, 1);
    });

    it('does not attribute merged metrics for unmerged PR', () => {
        const pr = makePR({mergedAt: null});
        const result = aggregateDailyMetrics([], [pr]);
        const alice = result.get('alice')!;
        const openDay = alice.get('2024-01-15');
        expect(openDay?.prs_opened).toBe(1);
        for (const [, metrics] of alice) {
            expect(metrics.prs_merged).toBe(0);
        }
    });

    it('averages time_to_merge across multiple PRs on same day', () => {
        const prs = [
            makePR({id: '1', createdAt: '2024-01-15T08:00:00Z', mergedAt: '2024-01-15T18:00:00Z'}), // 10h
            makePR({id: '2', createdAt: '2024-01-15T06:00:00Z', mergedAt: '2024-01-15T10:00:00Z'}), // 4h
        ];
        const result = aggregateDailyMetrics([], prs);
        const alice = result.get('alice')!;
        const mergedDay = alice.get('2024-01-15')!;
        expect(mergedDay.avg_time_to_merge_hours).toBeCloseTo(7, 1); // (10 + 4) / 2
    });

    it('skips PRs with null authorLogin', () => {
        const pr = makePR({authorLogin: null});
        const result = aggregateDailyMetrics([], [pr]);
        expect(result.size).toBe(0);
    });
});

describe('aggregateDailyMetrics - cross-day churn', () => {
    function fooCommit(sha: string, date: string, additions: number): AnalysisCommit {
        return makeCommit({
            sha,
            date,
            additions,
            deletions: 0,
            fileDiffs: [
                {path: 'src/foo.ts', additions, deletions: 0, status: 'modified'},
            ],
        });
    }

    it('detects churn when a file is re-touched on the next day within the window', () => {
        const commits = [
            fooCommit('c1', '2024-01-15T10:00:00Z', 100),
            fooCommit('c2', '2024-01-16T06:00:00Z', 50), // 20h later — within 48h, next day
        ];
        const result = aggregateDailyMetrics(commits, [], 48);
        const day2 = result.get('alice')!.get('2024-01-16')!;
        expect(day2.code_churn_rate).toBeGreaterThan(0);
    });

    it('does not flag cross-day churn outside the window', () => {
        const commits = [
            fooCommit('c1', '2024-01-15T10:00:00Z', 100),
            fooCommit('c2', '2024-01-18T10:00:00Z', 50), // 72h later — outside 48h
        ];
        const result = aggregateDailyMetrics(commits, [], 48);
        const day2 = result.get('alice')!.get('2024-01-18')!;
        expect(day2.code_churn_rate).toBe(0);
    });
});

describe('aggregateDailyMetrics - cross-midnight burst', () => {
    it('detects a burst that spans midnight, attributed to the first commit day', () => {
        const commits = [
            makeCommit({sha: 'c1', date: '2024-01-15T23:52:00Z'}),
            makeCommit({sha: 'c2', date: '2024-01-15T23:57:00Z'}),
            makeCommit({sha: 'c3', date: '2024-01-16T00:03:00Z'}),
        ];
        const result = aggregateDailyMetrics(commits, []);
        const alice = result.get('alice')!;
        expect(alice.get('2024-01-15')!.commit_burst_count).toBeGreaterThan(0);
        expect(alice.get('2024-01-16')!.commit_burst_count).toBe(0);
    });
});

describe('aggregateDailyMetrics - review comments given', () => {
    function makeReviewComment(overrides: Partial<AnalysisReviewComment> = {}): AnalysisReviewComment {
        return {
            authorLogin: 'bob',
            createdAt: '2024-01-15T10:00:00Z',
            ...overrides,
        };
    }

    it('attributes review comments to the commenter on the comment day', () => {
        const comments = [
            makeReviewComment(),
            makeReviewComment({createdAt: '2024-01-15T14:00:00Z'}),
        ];
        const result = aggregateDailyMetrics([], [], 48, comments);
        expect(result.get('bob')!.get('2024-01-15')!.review_comments_given).toBe(2);
    });

    it('skips review comments with null authorLogin', () => {
        const result = aggregateDailyMetrics([], [], 48, [makeReviewComment({authorLogin: null})]);
        expect(result.size).toBe(0);
    });

    it('counts the reviewer, not the PR author', () => {
        const pr = makePR({authorLogin: 'alice'});
        const comment = makeReviewComment({authorLogin: 'bob', createdAt: '2024-01-15T12:00:00Z'});
        const result = aggregateDailyMetrics([], [pr], 48, [comment]);
        expect(result.get('bob')!.get('2024-01-15')!.review_comments_given).toBe(1);
        expect(result.get('alice')!.get('2024-01-15')?.review_comments_given ?? 0).toBe(0);
    });
});
