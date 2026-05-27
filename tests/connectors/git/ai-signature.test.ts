import {describe, it, expect} from 'vitest';
import {scoreAiSignature} from '../../../src/connectors/git/ai-signature';
import type {AnalysisCommit} from '../../../src/connectors/git/analysis-types';

function makeCommit(overrides: Partial<AnalysisCommit> = {}): AnalysisCommit {
    return {
        sha: 'abc123',
        authorLogin: 'alice',
        authorEmail: 'alice@example.com',
        date: '2024-01-15T10:00:00Z',
        message: 'feat: add feature',
        additions: 20,
        deletions: 5,
        fileDiffs: [
            {path: 'src/foo.ts', additions: 10, deletions: 5, status: 'modified'},
            {path: 'src/bar.ts', additions: 10, deletions: 0, status: 'modified'},
        ],
        ...overrides,
    };
}

function makeAiPatternedCommit(): AnalysisCommit {
    // Simulate a large AI-generated commit: many new files, high additions, zero deletions
    const fileDiffs = Array.from({length: 8}, (_, i) => ({
        path: `src/module${i}.ts`,
        additions: 80,
        deletions: 0,
        status: 'added',
    }));
    return makeCommit({
        additions: 640,
        deletions: 0,
        fileDiffs,
        message: 'feat: generate comprehensive service layer with full error handling',
    });
}

function makeNormalCommit(): AnalysisCommit {
    return makeCommit({
        additions: 15,
        deletions: 8,
        fileDiffs: [
            {path: 'src/foo.ts', additions: 10, deletions: 5, status: 'modified'},
            {path: 'src/bar.ts', additions: 5, deletions: 3, status: 'modified'},
        ],
        message: 'fix: correct null check in auth middleware',
    });
}

describe('scoreAiSignature', () => {
    it('returns estimated_score > 0 for obviously AI-patterned commit', () => {
        const result = scoreAiSignature(makeAiPatternedCommit());
        expect(result.estimated_score).toBeGreaterThan(0);
    });

    it('returns estimated_score = 0 for normal human-looking commit', () => {
        const result = scoreAiSignature(makeNormalCommit());
        expect(result.estimated_score).toBe(0);
    });

    it('caps score at 100', () => {
        const commit = makeAiPatternedCommit();
        const result = scoreAiSignature(commit);
        expect(result.estimated_score).toBeLessThanOrEqual(100);
    });

    it('includes signals array when score > 0', () => {
        const result = scoreAiSignature(makeAiPatternedCommit());
        expect(result.signals.length).toBeGreaterThan(0);
    });

    it('returns empty signals for normal commit', () => {
        const result = scoreAiSignature(makeNormalCommit());
        expect(result.signals).toHaveLength(0);
    });

    it('detects large commit signal', () => {
        const commit = makeCommit({
            additions: 400,
            deletions: 10,
            fileDiffs: Array.from({length: 5}, (_, i) => ({
                path: `src/x${i}.ts`,
                additions: 80,
                deletions: 2,
                status: 'modified',
            })),
        });
        const result = scoreAiSignature(commit);
        expect(result.signals.some((s) => s.startsWith('large_commit'))).toBe(true);
    });

    it('detects bulk new files signal', () => {
        const fileDiffs = Array.from({length: 6}, (_, i) => ({
            path: `src/new${i}.ts`,
            additions: 50,
            deletions: 0,
            status: 'added',
        }));
        const commit = makeCommit({fileDiffs, additions: 300, deletions: 0});
        const result = scoreAiSignature(commit);
        expect(result.signals.some((s) => s.startsWith('bulk_new_files'))).toBe(true);
    });

    it('does not flag a single-file small commit', () => {
        const commit = makeCommit({
            additions: 5,
            deletions: 2,
            fileDiffs: [{path: 'src/foo.ts', additions: 5, deletions: 2, status: 'modified'}],
        });
        const result = scoreAiSignature(commit);
        expect(result.estimated_score).toBe(0);
    });
});
