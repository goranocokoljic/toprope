import {describe, it, expect} from 'vitest';
import {
    MIN_TEAM_COHORT,
    aggregateTeamPeriod,
    computeReworkTrend,
    countSufficientPeriods,
    latestSufficientSignal,
    type DevPeriodMetric,
} from '../../../src/coaching/pr-review/guidance';
import {DEFAULT_PR_REVIEW_THRESHOLDS} from '../../../src/coaching/pr-review/config';
import type {CombinedSignal} from '../../../src/coaching/pr-review/types';

const THRESHOLDS = DEFAULT_PR_REVIEW_THRESHOLDS; // minPrs 3, churn 0.2, reject 0.3

interface PointSeed {
    period: string;
    prs_total: number | null;
    rework_rate: number | null;
    combined_signal?: CombinedSignal;
}
function pt(seed: PointSeed): {
    period: string;
    prs_total: number | null;
    rework_rate: number | null;
    combined_signal: CombinedSignal;
} {
    return {
        period: seed.period,
        prs_total: seed.prs_total,
        rework_rate: seed.rework_rate,
        combined_signal: seed.combined_signal ?? 'insufficient_data',
    };
}

describe('computeReworkTrend (Task 5.3)', () => {
    it('reports a rising trajectory with the from→to endpoints', () => {
        const trend = computeReworkTrend(
            [
                pt({period: '2026-01', prs_total: 5, rework_rate: 0.15}),
                pt({period: '2026-02', prs_total: 4, rework_rate: 0.22}),
                pt({period: '2026-03', prs_total: 6, rework_rate: 0.3}),
            ],
            THRESHOLDS.minPrs,
        );
        expect(trend.direction).toBe('rising');
        expect(trend.from_period).toBe('2026-01');
        expect(trend.to_period).toBe('2026-03');
        expect(trend.from_value).toBe(0.15);
        expect(trend.to_value).toBe(0.3);
    });

    it('reports falling when the rate drops beyond the dead-band', () => {
        const trend = computeReworkTrend(
            [
                pt({period: '2026-01', prs_total: 5, rework_rate: 0.4}),
                pt({period: '2026-02', prs_total: 5, rework_rate: 0.1}),
            ],
            THRESHOLDS.minPrs,
        );
        expect(trend.direction).toBe('falling');
    });

    it('reads a sub-dead-band move as steady', () => {
        const trend = computeReworkTrend(
            [
                pt({period: '2026-01', prs_total: 5, rework_rate: 0.2}),
                pt({period: '2026-02', prs_total: 5, rework_rate: 0.21}),
            ],
            THRESHOLDS.minPrs,
        );
        expect(trend.direction).toBe('steady');
    });

    it('ignores periods below the min-PR bar', () => {
        const trend = computeReworkTrend(
            [
                pt({period: '2026-01', prs_total: 2, rework_rate: 0.9}), // too few PRs
                pt({period: '2026-02', prs_total: 5, rework_rate: 0.2}),
            ],
            THRESHOLDS.minPrs,
        );
        // Only one sufficient period → cannot claim a trend.
        expect(trend.direction).toBe('insufficient_data');
        expect(trend.to_period).toBe('2026-02');
        expect(trend.from_value).toBe(0.2);
    });

    it('returns insufficient_data with null endpoints when nothing clears the bar', () => {
        const trend = computeReworkTrend(
            [pt({period: '2026-01', prs_total: 1, rework_rate: 0.5})],
            THRESHOLDS.minPrs,
        );
        expect(trend.direction).toBe('insufficient_data');
        expect(trend.from_value).toBeNull();
        expect(trend.to_value).toBeNull();
    });
});

describe('latestSufficientSignal / countSufficientPeriods', () => {
    it('takes the signal from the latest period that cleared the bar', () => {
        const points = [
            pt({period: '2026-01', prs_total: 5, rework_rate: 0.1, combined_signal: 'effective'}),
            pt({period: '2026-02', prs_total: 6, rework_rate: 0.4, combined_signal: 'struggling'}),
            pt({period: '2026-03', prs_total: 1, rework_rate: 0.0, combined_signal: 'effective'}), // too thin
        ];
        expect(latestSufficientSignal(points, THRESHOLDS.minPrs)).toBe('struggling');
        expect(countSufficientPeriods(points, THRESHOLDS.minPrs)).toBe(2);
    });

    it('is insufficient_data when no period qualifies', () => {
        const points = [pt({period: '2026-01', prs_total: 2, rework_rate: 0.5})];
        expect(latestSufficientSignal(points, THRESHOLDS.minPrs)).toBe('insufficient_data');
        expect(countSufficientPeriods(points, THRESHOLDS.minPrs)).toBe(0);
    });
});

describe('aggregateTeamPeriod — k-anonymity + pooling (Task 5.3)', () => {
    const dev = (over: Partial<DevPeriodMetric>): DevPeriodMetric => ({
        prsTotal: 4,
        prsMerged: 4,
        reworkRate: 0.25,
        reviewRejectionRate: 0.25,
        avgReviewRounds: 1.5,
        avgCommentDensity: 3,
        avgTimeToMergeHours: 10,
        avgChurn: 0.1,
        ...over,
    });

    it(`suppresses a period with fewer than ${MIN_TEAM_COHORT} contributors, exposing NO numbers`, () => {
        const point = aggregateTeamPeriod(
            '2026-03',
            [dev({}), dev({})], // only 2 contributors
            THRESHOLDS,
        );
        expect(point.suppressed).toBe(true);
        expect(point.developers).toBeNull();
        expect(point.prs_total).toBeNull();
        expect(point.rework_rate).toBeNull();
        expect(point.review_rejection_rate).toBeNull();
        expect(point.avg_comment_density).toBeNull();
        expect(point.combined_signal).toBe('insufficient_data');
    });

    it('does not count zero-PR developers toward the cohort', () => {
        // 3 rows but one has no PRs → only 2 real contributors → suppressed.
        const point = aggregateTeamPeriod(
            '2026-03',
            [dev({}), dev({}), dev({prsTotal: 0, prsMerged: 0})],
            THRESHOLDS,
        );
        expect(point.suppressed).toBe(true);
    });

    it('pools rates by PR volume once the cohort clears the floor', () => {
        // Dev A: 10 PRs, rework 0.10 → 1 reworked. Dev B: 10 PRs, rework 0.50 → 5.
        // Dev C: 20 PRs, rework 0.25 → 5. Pooled = 11 / 40 = 0.275.
        const point = aggregateTeamPeriod(
            '2026-03',
            [
                dev({prsTotal: 10, prsMerged: 10, reworkRate: 0.1, reviewRejectionRate: 0.1}),
                dev({prsTotal: 10, prsMerged: 10, reworkRate: 0.5, reviewRejectionRate: 0.5}),
                dev({prsTotal: 20, prsMerged: 20, reworkRate: 0.25, reviewRejectionRate: 0.25}),
            ],
            THRESHOLDS,
        );
        expect(point.suppressed).toBe(false);
        expect(point.developers).toBe(3);
        expect(point.prs_total).toBe(40);
        expect(point.rework_rate).toBeCloseTo(0.275, 4);
        expect(point.review_rejection_rate).toBeCloseTo(0.275, 4);
    });

    it('recomputes the team combined signal from pooled churn + rejection', () => {
        // High churn (>=0.2) + high pooled rejection (>=0.3) → struggling.
        const point = aggregateTeamPeriod(
            '2026-03',
            [
                dev({prsTotal: 5, reworkRate: 0.4, reviewRejectionRate: 0.4, avgChurn: 0.3}),
                dev({prsTotal: 5, reworkRate: 0.4, reviewRejectionRate: 0.4, avgChurn: 0.3}),
                dev({prsTotal: 5, reworkRate: 0.4, reviewRejectionRate: 0.4, avgChurn: 0.3}),
            ],
            THRESHOLDS,
        );
        expect(point.combined_signal).toBe('struggling');
    });
});
