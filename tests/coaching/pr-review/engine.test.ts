import {describe, it, expect} from 'vitest';
import {
    commentDensity,
    computeCombinedSignal,
    computeVariantMetrics,
    selectAiAssistedPRs,
} from '../../../src/coaching/pr-review/engine';
import {DEFAULT_PR_REVIEW_THRESHOLDS} from '../../../src/coaching/pr-review/config';
import type {PRData, PRReviewThresholds} from '../../../src/coaching/pr-review/types';

const T: PRReviewThresholds = {...DEFAULT_PR_REVIEW_THRESHOLDS};

function makePR(overrides: Partial<PRData> = {}): PRData {
    return {
        prId: '1',
        state: 'merged',
        createdAt: '2026-05-04T08:00:00Z',
        mergedAt: '2026-05-05T08:00:00Z',
        closedAt: '2026-05-05T08:00:00Z',
        reviewCommentCount: 0,
        reviewRounds: 1,
        changesRequestedCount: 0,
        timeToMergeHours: 24,
        aiSignatureScore: null,
        ...overrides,
    };
}

describe('computeVariantMetrics — formulas', () => {
    it('computes rework_rate and review_rejection_rate as sent-back PRs / total', () => {
        const prs = [
            makePR({prId: '1', changesRequestedCount: 1}),
            makePR({prId: '2', changesRequestedCount: 2}),
            makePR({prId: '3'}),
            makePR({prId: '4'}),
        ];
        const m = computeVariantMetrics('all_pr', prs, null, null, T);
        expect(m.reworkRate).toBe(0.5);
        expect(m.reviewRejectionRate).toBe(0.5);
    });

    it('computes avg_review_rounds as the mean of review cycles per PR', () => {
        const prs = [
            makePR({prId: '1', reviewRounds: 1}),
            makePR({prId: '2', reviewRounds: 3}),
            makePR({prId: '3', reviewRounds: 2}),
        ];
        const m = computeVariantMetrics('all_pr', prs, null, null, T);
        expect(m.avgReviewRounds).toBe(2);
    });

    it('computes avg_comment_density as total review comments / PR count', () => {
        const prs = [
            makePR({prId: '1', reviewCommentCount: 5}),
            makePR({prId: '2', reviewCommentCount: 1}),
        ];
        const m = computeVariantMetrics('all_pr', prs, null, null, T);
        expect(m.avgCommentDensity).toBe(3);
    });

    it('computes comment_density_vs_baseline as this period / own baseline', () => {
        const prs = [makePR({prId: '1', reviewCommentCount: 4})];
        const m = computeVariantMetrics('all_pr', prs, null, 2, T);
        expect(m.commentDensityVsBaseline).toBe(2);
    });

    it('guards comment_density_vs_baseline against a zero baseline (eps, no Infinity)', () => {
        const prs = [makePR({prId: '1', reviewCommentCount: 4})];
        const m = computeVariantMetrics('all_pr', prs, null, 0, T);
        expect(m.commentDensityVsBaseline).not.toBeNull();
        expect(Number.isFinite(m.commentDensityVsBaseline!)).toBe(true);
        expect(m.commentDensityVsBaseline!).toBeGreaterThan(0);
    });

    it('leaves comment_density_vs_baseline null when no baseline exists yet', () => {
        const prs = [makePR({prId: '1', reviewCommentCount: 4})];
        const m = computeVariantMetrics('all_pr', prs, null, null, T);
        expect(m.commentDensityVsBaseline).toBeNull();
    });

    it('computes avg_time_to_merge_hours over merged PRs only', () => {
        const prs = [
            makePR({prId: '1', timeToMergeHours: 10}),
            makePR({prId: '2', timeToMergeHours: 30}),
            makePR({prId: '3', state: 'open', mergedAt: null, timeToMergeHours: null}),
        ];
        const m = computeVariantMetrics('all_pr', prs, null, null, T);
        expect(m.avgTimeToMergeHours).toBe(20);
    });

    it('counts prs_total and prs_merged', () => {
        const prs = [
            makePR({prId: '1', state: 'merged'}),
            makePR({prId: '2', state: 'open', mergedAt: null, timeToMergeHours: null}),
            makePR({prId: '3', state: 'closed', mergedAt: null, timeToMergeHours: null}),
        ];
        const m = computeVariantMetrics('all_pr', prs, null, null, T);
        expect(m.prsTotal).toBe(3);
        expect(m.prsMerged).toBe(1);
    });

    it('returns null rates and insufficient_data for an empty PR set', () => {
        const m = computeVariantMetrics('all_pr', [], null, null, T);
        expect(m.prsTotal).toBe(0);
        expect(m.prsMerged).toBe(0);
        expect(m.reworkRate).toBeNull();
        expect(m.reviewRejectionRate).toBeNull();
        expect(m.avgReviewRounds).toBeNull();
        expect(m.avgCommentDensity).toBeNull();
        expect(m.commentDensityVsBaseline).toBeNull();
        expect(m.avgTimeToMergeHours).toBeNull();
        expect(m.combinedSignal).toBe('insufficient_data');
    });

    it('labels the variants: all_pr is factual, ai_assisted_pr is inferred', () => {
        expect(computeVariantMetrics('all_pr', [], null, null, T).basis).toBe('factual');
        expect(computeVariantMetrics('ai_assisted_pr', [], null, null, T).basis).toBe('inferred');
    });
});

describe('selectAiAssistedPRs', () => {
    it('includes only PRs at or above the AI-signature threshold', () => {
        const prs = [
            makePR({prId: 'high', aiSignatureScore: 0.8}),
            makePR({prId: 'edge', aiSignatureScore: 0.5}),
            makePR({prId: 'low', aiSignatureScore: 0.2}),
        ];
        const selected = selectAiAssistedPRs(prs, 0.5);
        expect(selected.map((p) => p.prId)).toEqual(['high', 'edge']);
    });

    it('excludes PRs with no AI-signature estimate', () => {
        const prs = [makePR({prId: 'unknown', aiSignatureScore: null})];
        expect(selectAiAssistedPRs(prs, 0.5)).toHaveLength(0);
    });
});

describe('commentDensity', () => {
    it('is null for an empty set (no PRs is not a zero density)', () => {
        expect(commentDensity([])).toBeNull();
    });

    it('is comments per PR otherwise', () => {
        expect(
            commentDensity([
                makePR({reviewCommentCount: 3}),
                makePR({reviewCommentCount: 1}),
            ]),
        ).toBe(2);
    });
});

describe('computeCombinedSignal — the churn + review disambiguator', () => {
    const thresholds = {...T, minPrs: 3, churnHighThreshold: 0.2, rejectThreshold: 0.3};

    it('returns insufficient_data below the minimum PR count', () => {
        expect(computeCombinedSignal(2, 0.5, 0.9, thresholds)).toBe('insufficient_data');
        expect(computeCombinedSignal(0, null, null, thresholds)).toBe('insufficient_data');
    });

    it('high churn + high rejection → struggling', () => {
        expect(computeCombinedSignal(5, 0.25, 0.4, thresholds)).toBe('struggling');
    });

    it('high churn + clean reviews → healthy_iteration', () => {
        expect(computeCombinedSignal(5, 0.25, 0.1, thresholds)).toBe('healthy_iteration');
    });

    it('low churn + clean reviews → effective', () => {
        expect(computeCombinedSignal(5, 0.05, 0.1, thresholds)).toBe('effective');
    });

    it('low churn + some rejection → effective (the issue logic table)', () => {
        expect(computeCombinedSignal(5, 0.05, 0.9, thresholds)).toBe('effective');
    });

    it('treats thresholds as inclusive (>=) on both axes', () => {
        expect(computeCombinedSignal(5, 0.2, 0.3, thresholds)).toBe('struggling');
    });

    it('treats unknown churn as not-high (degrades to effective, never guesses struggling)', () => {
        expect(computeCombinedSignal(5, null, 0.9, thresholds)).toBe('effective');
    });

    it('exactly minPrs PRs is enough to compute a signal', () => {
        expect(computeCombinedSignal(3, 0.05, 0, thresholds)).toBe('effective');
    });
});

