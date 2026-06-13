import {describe, it, expect} from 'vitest';
import {deriveTeamOpportunities} from '../../../src/coaching/manager-aggregate/opportunities';
import {aggregateLoopNudge} from '../../../src/coaching/manager-aggregate/loop-nudge';
import type {
    TeamPRReviewCoaching,
    TeamVariantTrajectory,
    TrendDirection,
    ScopeVariant,
} from '../../../src/coaching/pr-review/types';
import type {TeamCoaching, TeamCoachingPoint} from '../../../src/coaching/available/types';
import type {LoopContribution, NudgeContribution} from '../../../src/coaching/manager-aggregate/loop-nudge';
import type {NudgeType} from '../../../src/coaching/realtime/types';

function variant(
    scopeVariant: ScopeVariant,
    direction: TrendDirection,
    sufficientPeriods: number,
): TeamVariantTrajectory {
    return {
        scope_variant: scopeVariant,
        basis: scopeVariant === 'all_pr' ? 'factual' : 'inferred',
        points: [],
        rework_trend: {
            metric: 'rework_rate',
            direction,
            from_period: '2026-05',
            to_period: '2026-06',
            from_value: 0.1,
            to_value: 0.3,
        },
        latest_signal: 'struggling',
        sufficient_periods: sufficientPeriods,
    };
}

function prReview(allPr: TeamVariantTrajectory, aiAssisted: TeamVariantTrajectory): TeamPRReviewCoaching {
    return {scope: 'eng', period_unit: 'monthly', all_pr: allPr, ai_assisted: aiAssisted};
}

function churnPoint(categories: Record<string, number> | null): TeamCoachingPoint {
    return categories
        ? {period: '2026-06', suppressed: false, developers: 5, categories}
        : {period: '2026-06', suppressed: true, developers: null, categories: null};
}

function available(churnPoints: TeamCoachingPoint[]): TeamCoaching {
    return {
        scope: 'eng',
        period_unit: 'monthly',
        series: [{signal_type: 'churn_reflection', points: churnPoints}],
    };
}

const loops = (...ids: string[]): LoopContribution[] => ids.map((developerId) => ({developerId}));
const nudges = (pairs: Array<[string, NudgeType]>): NudgeContribution[] =>
    pairs.map(([developerId, nudgeType]) => ({developerId, nudgeType}));

describe('deriveTeamOpportunities', () => {
    it('produces no opportunities when all pillars are null (disabled)', () => {
        expect(deriveTeamOpportunities(null, null, null)).toEqual([]);
    });

    it('surfaces rising rework on both PR variants', () => {
        const ops = deriveTeamOpportunities(
            prReview(variant('all_pr', 'rising', 3), variant('ai_assisted_pr', 'rising', 3)),
            null,
            null,
        );
        const ids = ops.map((o) => o.id);
        expect(ids).toContain('rework_rising_all_pr');
        expect(ids).toContain('rework_rising_ai_assisted');
        expect(ops.every((o) => o.pillar === 'pr_review')).toBe(true);
    });

    it('does NOT surface a rework opportunity when the trend is steady or has no data', () => {
        const steady = deriveTeamOpportunities(
            prReview(variant('all_pr', 'steady', 3), variant('ai_assisted_pr', 'falling', 3)),
            null,
            null,
        );
        expect(steady).toEqual([]);

        // Rising direction but zero sufficient periods → not enough floored data to claim it.
        const thin = deriveTeamOpportunities(
            prReview(variant('all_pr', 'rising', 0), variant('ai_assisted_pr', 'insufficient_data', 0)),
            null,
            null,
        );
        expect(thin).toEqual([]);
    });

    it('surfaces elevated churn only when elevated is the dominant category of the latest sufficient point', () => {
        const elevated = deriveTeamOpportunities(null, available([churnPoint({elevated: 4, lower: 1})]), null);
        expect(elevated.map((o) => o.id)).toContain('churn_elevated');

        const lowerDominant = deriveTeamOpportunities(null, available([churnPoint({elevated: 1, lower: 4})]), null);
        expect(lowerDominant.map((o) => o.id)).not.toContain('churn_elevated');
    });

    it('ignores suppressed churn points and reads the latest SUFFICIENT one', () => {
        // Latest point suppressed; the prior sufficient one is elevated-dominant.
        const ops = deriveTeamOpportunities(
            null,
            available([churnPoint({elevated: 4, lower: 1}), churnPoint(null)]),
            null,
        );
        expect(ops.map((o) => o.id)).toContain('churn_elevated');
    });

    it('derives loop + nudge opportunities only from non-suppressed (floored) cells', () => {
        // Loops: 3 distinct devs → shown. missing_context: 3 → shown. missing_error: 1 → suppressed.
        const agg = aggregateLoopNudge(
            'eng',
            'monthly',
            3,
            loops('a', 'b', 'c'),
            nudges([
                ['a', 'missing_context'],
                ['b', 'missing_context'],
                ['c', 'missing_context'],
                ['a', 'missing_error'],
            ]),
        );
        const ops = deriveTeamOpportunities(null, null, agg);
        const ids = ops.map((o) => o.id);
        expect(ids).toContain('loops_common');
        expect(ids).toContain('nudge_missing_context');
        // The suppressed (single-developer) nudge type yields NO opportunity.
        expect(ids).not.toContain('nudge_missing_error');
        expect(ops.every((o) => o.pillar === 'loop_nudge')).toBe(true);
    });

    it('produces NO loop/nudge opportunity when every cell is suppressed', () => {
        const agg = aggregateLoopNudge('eng', 'monthly', 1, loops('a'), nudges([['a', 'short_prompt']]));
        expect(deriveTeamOpportunities(null, null, agg)).toEqual([]);
    });

    it('frames every suggestion as an opportunity, never naming an individual', () => {
        const agg = aggregateLoopNudge('eng', 'monthly', 3, loops('a', 'b', 'c'), []);
        const ops = deriveTeamOpportunities(
            prReview(variant('all_pr', 'rising', 3), variant('ai_assisted_pr', 'steady', 3)),
            available([churnPoint({elevated: 4})]),
            agg,
        );
        expect(ops.length).toBeGreaterThan(0);
        for (const op of ops) {
            expect(op.title.length).toBeGreaterThan(0);
            expect(op.suggestion).toMatch(/may help|can help|helps|help/i);
            // No developer id token leaks into the copy.
            expect(op.suggestion).not.toMatch(/\bdev-\d|developer-\d/);
        }
    });
});
