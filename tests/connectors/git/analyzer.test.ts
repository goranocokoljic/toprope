import {describe, it, expect} from 'vitest';
import {aggregateDailyMetrics} from '../../../src/connectors/git/analyzer';
import type {GitCommit, GitPullRequest} from '../../../src/connectors/git/client';

function makeCommit(overrides: Partial<GitCommit> = {}): GitCommit {
    return {
        sha: 'abc123',
        author_login: 'alice',
        author_email: 'alice@example.com',
        author_date: '2024-01-15T10:00:00Z',
        message: 'feat: add feature',
        additions: 50,
        deletions: 10,
        files_changed: 2,
        files: [
            {filename: 'src/foo.ts', additions: 30, deletions: 5, changes: 35, status: 'modified'},
            {filename: 'src/bar.ts', additions: 20, deletions: 5, changes: 25, status: 'modified'},
        ],
        ...overrides,
    };
}

function makePR(overrides: Partial<GitPullRequest> = {}): GitPullRequest {
    return {
        number: 1,
        title: 'feat: add feature',
        state: 'merged',
        author_login: 'alice',
        created_at: '2024-01-15T08:00:00Z',
        merged_at: '2024-01-16T10:00:00Z',
        closed_at: '2024-01-16T10:00:00Z',
        additions: 50,
        deletions: 10,
        changed_files: 2,
        review_comments: 3,
        ...overrides,
    };
}

describe('aggregateDailyMetrics - commits', () => {
    it('aggregates commit counts per developer per day', () => {
        const commits = [
            makeCommit({sha: 'c1', author_date: '2024-01-15T10:00:00Z'}),
            makeCommit({sha: 'c2', author_date: '2024-01-15T14:00:00Z'}),
            makeCommit({sha: 'c3', author_date: '2024-01-16T10:00:00Z'}),
        ];
        const result = aggregateDailyMetrics(commits, []);
        const aliceMetrics = result.get('alice')!;

        expect(aliceMetrics.get('2024-01-15')!.commits).toBe(2);
        expect(aliceMetrics.get('2024-01-16')!.commits).toBe(1);
    });

    it('sums lines_added and lines_removed correctly', () => {
        const commits = [
            makeCommit({sha: 'c1', additions: 100, deletions: 20}),
            makeCommit({sha: 'c2', additions: 50, deletions: 10, author_date: '2024-01-15T14:00:00Z'}),
        ];
        const result = aggregateDailyMetrics(commits, []);
        const day = result.get('alice')!.get('2024-01-15')!;

        expect(day.lines_added).toBe(150);
        expect(day.lines_removed).toBe(30);
    });

    it('skips commits with null author_login', () => {
        const commits = [
            makeCommit({sha: 'c1', author_login: null}),
        ];
        const result = aggregateDailyMetrics(commits, []);
        expect(result.size).toBe(0);
    });

    it('handles multiple developers separately', () => {
        const commits = [
            makeCommit({sha: 'c1', author_login: 'alice'}),
            makeCommit({sha: 'c2', author_login: 'bob', author_date: '2024-01-15T11:00:00Z'}),
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
            makeCommit({sha: 'c1', author_date: '2024-01-15T10:00:00Z'}),
            makeCommit({sha: 'c2', author_date: '2024-01-15T10:10:00Z'}),
            makeCommit({sha: 'c3', author_date: '2024-01-15T10:20:00Z'}),
        ];
        const result = aggregateDailyMetrics(commits, []);
        const day = result.get('alice')!.get('2024-01-15')!;
        expect(day.commit_burst_count).toBeGreaterThan(0);
    });

    it('does not flag 3 commits spread over 2 hours', () => {
        const commits = [
            makeCommit({sha: 'c1', author_date: '2024-01-15T08:00:00Z'}),
            makeCommit({sha: 'c2', author_date: '2024-01-15T10:00:00Z'}),
            makeCommit({sha: 'c3', author_date: '2024-01-15T12:00:00Z'}),
        ];
        const result = aggregateDailyMetrics(commits, []);
        const day = result.get('alice')!.get('2024-01-15')!;
        expect(day.commit_burst_count).toBe(0);
    });

    it('does not flag 2 commits within 30 minutes (below threshold)', () => {
        const commits = [
            makeCommit({sha: 'c1', author_date: '2024-01-15T10:00:00Z'}),
            makeCommit({sha: 'c2', author_date: '2024-01-15T10:10:00Z'}),
        ];
        const result = aggregateDailyMetrics(commits, []);
        const day = result.get('alice')!.get('2024-01-15')!;
        expect(day.commit_burst_count).toBe(0);
    });
});

describe('aggregateDailyMetrics - PR metrics', () => {
    it('attributes prs_opened to created_at date', () => {
        const result = aggregateDailyMetrics([], [makePR()]);
        const alice = result.get('alice')!;
        expect(alice.get('2024-01-15')!.prs_opened).toBe(1);
    });

    it('attributes prs_merged to merged_at date', () => {
        const result = aggregateDailyMetrics([], [makePR()]);
        const alice = result.get('alice')!;
        expect(alice.get('2024-01-16')!.prs_merged).toBe(1);
    });

    it('calculates time_to_merge_hours correctly', () => {
        const pr = makePR({
            created_at: '2024-01-15T08:00:00Z',
            merged_at: '2024-01-15T18:00:00Z', // 10 hours later
        });
        const result = aggregateDailyMetrics([], [pr]);
        const mergedDay = result.get('alice')!.get('2024-01-15')!;
        expect(mergedDay.avg_time_to_merge_hours).toBeCloseTo(10, 1);
    });

    it('does not attribute merged metrics for unmerged PR', () => {
        const pr = makePR({merged_at: null, state: 'open', closed_at: null});
        const result = aggregateDailyMetrics([], [pr]);
        const alice = result.get('alice')!;
        // Should have prs_opened but no day with prs_merged
        const openDay = alice.get('2024-01-15');
        expect(openDay?.prs_opened).toBe(1);
        for (const [, metrics] of alice) {
            expect(metrics.prs_merged).toBe(0);
        }
    });

    it('averages time_to_merge across multiple PRs on same day', () => {
        const prs = [
            makePR({number: 1, created_at: '2024-01-15T08:00:00Z', merged_at: '2024-01-15T18:00:00Z'}), // 10h
            makePR({number: 2, created_at: '2024-01-15T06:00:00Z', merged_at: '2024-01-15T10:00:00Z'}), // 4h
        ];
        const result = aggregateDailyMetrics([], prs);
        const alice = result.get('alice')!;
        const mergedDay = alice.get('2024-01-15')!;
        expect(mergedDay.avg_time_to_merge_hours).toBeCloseTo(7, 1); // (10 + 4) / 2
    });

    it('skips PRs with null author_login', () => {
        const pr = makePR({author_login: null});
        const result = aggregateDailyMetrics([], [pr]);
        expect(result.size).toBe(0);
    });
});
