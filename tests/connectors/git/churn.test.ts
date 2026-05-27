import {describe, it, expect} from 'vitest';
import {calculateChurnRate, calculateDailyChurnRates} from '../../../src/connectors/git/churn';
import type {AnalysisCommit} from '../../../src/connectors/git/analysis-types';

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

describe('calculateChurnRate', () => {
    it('returns zero churn for non-overlapping files', () => {
        const commits = [
            makeCommit({
                sha: 'c1',
                date: '2024-01-15T10:00:00Z',
                fileDiffs: [{path: 'src/foo.ts', additions: 10, deletions: 5, status: 'modified'}],
            }),
            makeCommit({
                sha: 'c2',
                date: '2024-01-16T10:00:00Z',
                fileDiffs: [{path: 'src/bar.ts', additions: 20, deletions: 5, status: 'modified'}],
            }),
        ];

        const result = calculateChurnRate(commits, 48);
        expect(result.churn_rate).toBe(0);
    });

    it('detects churn when same file modified twice within window', () => {
        const commits = [
            makeCommit({
                sha: 'c1',
                date: '2024-01-15T10:00:00Z',
                fileDiffs: [{path: 'src/foo.ts', additions: 10, deletions: 0, status: 'modified'}],
            }),
            makeCommit({
                sha: 'c2',
                date: '2024-01-15T20:00:00Z', // 10 hours later — within 48h window
                fileDiffs: [{path: 'src/foo.ts', additions: 5, deletions: 5, status: 'modified'}],
            }),
        ];

        const result = calculateChurnRate(commits, 48);
        expect(result.churn_rate).toBeGreaterThan(0);
        expect(result.lines_rechurned).toBe(10); // second commit's lines on same file
    });

    it('does NOT flag re-touch outside the window', () => {
        const commits = [
            makeCommit({
                sha: 'c1',
                date: '2024-01-01T00:00:00Z',
                fileDiffs: [{path: 'src/foo.ts', additions: 10, deletions: 0, status: 'modified'}],
            }),
            makeCommit({
                sha: 'c2',
                date: '2024-01-05T00:00:00Z', // 4 days later — outside 48h window
                fileDiffs: [{path: 'src/foo.ts', additions: 10, deletions: 0, status: 'modified'}],
            }),
        ];

        const result = calculateChurnRate(commits, 48);
        expect(result.churn_rate).toBe(0);
        expect(result.lines_rechurned).toBe(0);
    });

    it('respects configurable window', () => {
        const commits = [
            makeCommit({
                sha: 'c1',
                date: '2024-01-15T00:00:00Z',
                fileDiffs: [{path: 'src/foo.ts', additions: 10, deletions: 0, status: 'modified'}],
            }),
            makeCommit({
                sha: 'c2',
                date: '2024-01-15T12:00:00Z', // 12 hours later
                fileDiffs: [{path: 'src/foo.ts', additions: 5, deletions: 5, status: 'modified'}],
            }),
        ];

        // With 6-hour window, 12h gap should NOT flag churn
        const result6h = calculateChurnRate(commits, 6);
        expect(result6h.churn_rate).toBe(0);

        // With 24-hour window, 12h gap SHOULD flag churn
        const result24h = calculateChurnRate(commits, 24);
        expect(result24h.churn_rate).toBeGreaterThan(0);
    });

    it('returns zero for empty commits array', () => {
        const result = calculateChurnRate([], 48);
        expect(result.churn_rate).toBe(0);
        expect(result.total_lines_changed).toBe(0);
        expect(result.lines_rechurned).toBe(0);
    });

    it('returns zero for single commit', () => {
        const result = calculateChurnRate([makeCommit()], 48);
        expect(result.churn_rate).toBe(0);
    });

    it('computes churn_rate = lines_rechurned / total_lines_changed', () => {
        const commits = [
            makeCommit({
                sha: 'c1',
                date: '2024-01-15T10:00:00Z',
                fileDiffs: [{path: 'src/foo.ts', additions: 100, deletions: 0, status: 'modified'}],
            }),
            makeCommit({
                sha: 'c2',
                date: '2024-01-15T12:00:00Z',
                fileDiffs: [{path: 'src/foo.ts', additions: 50, deletions: 50, status: 'modified'}],
            }),
        ];

        const result = calculateChurnRate(commits, 48);
        // total = 200, rechurned = 100 (second commit on same file)
        expect(result.total_lines_changed).toBe(200);
        expect(result.lines_rechurned).toBe(100);
        expect(result.churn_rate).toBeCloseTo(0.5, 5);
    });
});

describe('calculateDailyChurnRates', () => {
    it('attributes cross-day re-churn to the later commit day', () => {
        const commits = [
            makeCommit({
                sha: 'c1',
                date: '2024-01-15T10:00:00Z',
                fileDiffs: [{path: 'src/foo.ts', additions: 100, deletions: 0, status: 'modified'}],
            }),
            makeCommit({
                sha: 'c2',
                date: '2024-01-16T06:00:00Z', // 20h later — within 48h, next day
                fileDiffs: [{path: 'src/foo.ts', additions: 50, deletions: 0, status: 'modified'}],
            }),
        ];

        const rates = calculateDailyChurnRates(commits, 48);
        expect(rates.get('2024-01-15')).toBe(0); // first touch, nothing prior
        expect(rates.get('2024-01-16')).toBe(1); // 50 of 50 lines re-touch foo.ts within window
    });

    it('does not flag re-touch outside the window', () => {
        const commits = [
            makeCommit({
                sha: 'c1',
                date: '2024-01-15T10:00:00Z',
                fileDiffs: [{path: 'src/foo.ts', additions: 100, deletions: 0, status: 'modified'}],
            }),
            makeCommit({
                sha: 'c2',
                date: '2024-01-18T10:00:00Z', // 72h later — outside 48h
                fileDiffs: [{path: 'src/foo.ts', additions: 50, deletions: 0, status: 'modified'}],
            }),
        ];

        const rates = calculateDailyChurnRates(commits, 48);
        expect(rates.get('2024-01-18')).toBe(0);
    });
});
