import {describe, it, expect} from 'vitest';
import {aggregateDailyMetrics, prMergeDurationHours} from '../../../src/connectors/git/analyzer';
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

/**
 * #302 — the analyzer must not manufacture a value the write boundary will refuse.
 *
 * Every date here reaches `raw_author_daily`: the day key verbatim, and
 * `avg_time_to_merge_hours` as `new Date(mergedAt) - new Date(createdAt)`. The store refuses a
 * malformed day and a NaN metric by THROWING, inside the sync's single all-providers write
 * transaction — so the sync now skips such a row instead. These tests pin the two places where
 * the analyzer can keep that skip from costing more than the malformed value itself.
 */
describe('aggregateDailyMetrics - unusable PR timestamps (#302)', () => {
    it('leaves avg_time_to_merge null rather than NaN when createdAt is unparseable', () => {
        // The merged day is WELL FORMED and carries the day's commits. Poisoning it with a NaN
        // would make the write boundary refuse the whole row — losing real commit data over a
        // metric that is nullable precisely to mean "not known".
        const result = aggregateDailyMetrics(
            [makeCommit({date: '2024-01-16T09:00:00Z'})],
            [makePR({createdAt: 'not-a-date', mergedAt: '2024-01-16T10:00:00Z'})],
        );
        const mergedDay = result.get('alice')!.get('2024-01-16')!;

        expect(mergedDay.commits).toBe(1);
        expect(mergedDay.prs_merged).toBe(1);
        expect(mergedDay.avg_time_to_merge_hours).toBeNull();
        expect(Number.isNaN(mergedDay.avg_time_to_merge_hours as number)).toBe(false);
    });

    it('reports UNKNOWN, not a 54-year duration, when createdAt is null', () => {
        // The input class only the `typeof` guard inside `prMergeDurationHours` handles.
        // `new Date(null).getTime()` is 0 — the Unix EPOCH, not an Invalid Date — so a
        // finiteness check passes it and a ~473,706-hour duration lands on the merged-day row,
        // whose own date is perfectly well formed. Every downstream check accepts it, it is
        // projected into git_snapshots, and nothing recomputes it. `Date.parse(null)` is NaN.
        const result = aggregateDailyMetrics(
            [],
            [makePR({createdAt: null as unknown as string, mergedAt: '2024-01-16T10:00:00Z'})],
        );
        const mergedDay = result.get('alice')!.get('2024-01-16')!;
        expect(mergedDay.prs_merged).toBe(1);
        expect(mergedDay.avg_time_to_merge_hours).toBeNull();
    });

    it('reports UNKNOWN for an expanded-year createdAt instead of a negative duration', () => {
        // `Date.parse('+033658-…')` is finite, so this survives every finiteness check and
        // stores ≈ -31,600 years. It is refused because a PR cannot merge before it opened.
        const result = aggregateDailyMetrics(
            [],
            [makePR({createdAt: '+033658-09-27T00:00:00.000Z', mergedAt: '2024-01-16T10:00:00Z'})],
        );
        expect(result.get('alice')!.get('2024-01-16')!.avg_time_to_merge_hours).toBeNull();
    });

    it('reports UNKNOWN for an array createdAt, which toString would make parseable', () => {
        const result = aggregateDailyMetrics(
            [],
            [
                makePR({
                    createdAt: ['2024-01-16T00:00:00Z'] as unknown as string,
                    mergedAt: '2024-01-16T10:00:00Z',
                }),
            ],
        );
        expect(result.get('alice')!.get('2024-01-16')!.avg_time_to_merge_hours).toBeNull();
    });

    it('averages only the MEASURABLE merge times even when the unmeasurable one is listed FIRST', () => {
        // The ordering the sample counter exists for — and the COMMON one, since every provider
        // lists PRs newest-first. Divide by `prs_merged` instead and this single 10h observation
        // is reported as 5h; with the measurable PR first, that bug is invisible.
        const result = aggregateDailyMetrics(
            [],
            [
                makePR({id: '1', createdAt: 'not-a-date', mergedAt: '2024-01-16T12:00:00Z'}),
                makePR({id: '2', createdAt: '2024-01-16T00:00:00Z', mergedAt: '2024-01-16T10:00:00Z'}),
            ],
        );
        const mergedDay = result.get('alice')!.get('2024-01-16')!;
        expect(mergedDay.prs_merged).toBe(2);
        expect(mergedDay.avg_time_to_merge_hours).toBeCloseTo(10, 6);
    });

    it('averages only the MEASURABLE merge times, not one per merged PR', () => {
        // Two PRs merge on the same day; one has an unusable createdAt. Dividing by prs_merged
        // (= 2) would report 5h for a single 10h observation. The divisor must be the number of
        // samples actually added.
        const result = aggregateDailyMetrics(
            [],
            [
                makePR({id: '1', createdAt: '2024-01-16T00:00:00Z', mergedAt: '2024-01-16T10:00:00Z'}),
                makePR({id: '2', createdAt: 'not-a-date', mergedAt: '2024-01-16T12:00:00Z'}),
            ],
        );
        const mergedDay = result.get('alice')!.get('2024-01-16')!;

        expect(mergedDay.prs_merged).toBe(2);
        expect(mergedDay.avg_time_to_merge_hours).toBeCloseTo(10, 6);
    });

    it('still averages every merge time when all of them are measurable', () => {
        const result = aggregateDailyMetrics(
            [],
            [
                makePR({id: '1', createdAt: '2024-01-16T00:00:00Z', mergedAt: '2024-01-16T10:00:00Z'}),
                makePR({id: '2', createdAt: '2024-01-16T08:00:00Z', mergedAt: '2024-01-16T12:00:00Z'}),
            ],
        );
        expect(result.get('alice')!.get('2024-01-16')!.avg_time_to_merge_hours).toBeCloseTo(7, 6);
    });

    it('keys a NON-STRING date to an empty day instead of throwing out of the whole run', () => {
        // The input class ONLY the totality of `toDateString` handles. `AnalysisPR.createdAt` is
        // typed `string`, but it is a field of a response body the providers cast rather than
        // validate — `created_at: null` is a real shape. A bare `.slice` throws a TypeError from
        // here, which is outside the sync's try: the whole run dies before any provider's cursor
        // advances, and does it again next run. Revert the `typeof` guard and this test throws.
        const result = aggregateDailyMetrics(
            [],
            [makePR({createdAt: null as unknown as string, mergedAt: null})],
        );
        expect([...result.get('alice')!.keys()]).toEqual(['']);
        expect(result.get('alice')!.get('')!.prs_opened).toBe(1);
    });

    it('does NOT coerce an array date into a well-formed-looking day', () => {
        // `String(['2024-01-15T00:00:00Z'])` is a perfectly valid day, so a coercing
        // `String(x).slice(0, 10)` would let an odd JSON body manufacture a key nobody can
        // attribute — and the write boundary would accept it. It must stay unattributable.
        const result = aggregateDailyMetrics(
            [],
            [makePR({createdAt: ['2024-01-15T00:00:00Z'] as unknown as string, mergedAt: null})],
        );
        expect([...result.get('alice')!.keys()]).toEqual(['']);
    });

    it('keys a review comment with a non-string date to an empty day too', () => {
        const comments: AnalysisReviewComment[] = [
            {authorLogin: 'bob', createdAt: undefined as unknown as string},
        ];
        const result = aggregateDailyMetrics([], [], 48, comments);
        expect([...result.get('bob')!.keys()]).toEqual(['']);
    });
});

/**
 * #302 — the ONE time-to-merge rule, shared with `pr_records` in `sync.ts`.
 *
 * Two independent copies is how they came to disagree: for one `created_at: '+033658-…'` PR the
 * store wrote `pr_records.time_to_merge_hours = NULL` and
 * `raw_author_daily.avg_time_to_merge_hours = -277304070` from the same pair of timestamps.
 */
describe('prMergeDurationHours (#302)', () => {
    it('measures a well-formed pair in hours', () => {
        expect(prMergeDurationHours('2024-01-16T00:00:00Z', '2024-01-16T10:00:00Z')).toBe(10);
    });

    it('is null for an unparseable operand', () => {
        expect(prMergeDurationHours('not-a-date', '2024-01-16T10:00:00Z')).toBeNull();
        expect(prMergeDurationHours('2024-01-16T00:00:00Z', 'not-a-date')).toBeNull();
    });

    it('is null for a NON-STRING operand, which `new Date()` would resolve to the epoch', () => {
        // `new Date(null).getTime() === 0`, so the old `new Date(x).getTime()` form returned a
        // finite ~54-year duration here and stored it.
        expect(prMergeDurationHours(null, '2024-01-16T10:00:00Z')).toBeNull();
        expect(prMergeDurationHours(undefined, '2024-01-16T10:00:00Z')).toBeNull();
        expect(prMergeDurationHours(0, '2024-01-16T10:00:00Z')).toBeNull();
    });

    it('is null for an ARRAY operand, whose toString would otherwise parse cleanly', () => {
        expect(prMergeDurationHours(['2024-01-16T00:00:00Z'], '2024-01-16T10:00:00Z')).toBeNull();
    });

    it('is null when the PR merged before it was opened', () => {
        // Finite, so every finiteness check passes it all the way into git_snapshots.
        expect(prMergeDurationHours('2024-01-16T10:00:00Z', '2024-01-16T00:00:00Z')).toBeNull();
        expect(prMergeDurationHours('+033658-09-27T00:00:00.000Z', '2024-01-16T10:00:00Z')).toBeNull();
    });

    it('admits a zero-length merge (opened and merged at the same instant)', () => {
        expect(prMergeDurationHours('2024-01-16T10:00:00Z', '2024-01-16T10:00:00Z')).toBe(0);
    });
});
