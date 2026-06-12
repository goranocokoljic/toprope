import {describe, it, expect} from 'vitest';
import type {JourneyAnnotation} from '../../../src/dashboard/api/journey';
import {
    basisForTier,
    buildAcceptanceTrend,
    buildChurnReflection,
    buildJourneyCoaching,
    buildPersonalInsight,
    mostSalientAnnotation,
} from '../../../src/coaching/available/engine';
import {DEFAULT_AVAILABLE_COACHING_THRESHOLDS as T} from '../../../src/coaching/available/config';

describe('basisForTier', () => {
    it('maps high tier to measured and everything else to git_estimate', () => {
        expect(basisForTier('high')).toBe('measured');
        expect(basisForTier('medium')).toBe('git_estimate');
        expect(basisForTier('low')).toBe('git_estimate');
        expect(basisForTier('none')).toBe('git_estimate');
    });
});

describe('buildChurnReflection', () => {
    it('flags elevated churn vs the developer\'s own baseline, basis git_estimate', () => {
        const s = buildChurnReflection(0.5, 0.3, 3, T);
        expect(s).not.toBeNull();
        expect(s!.signalType).toBe('churn_reflection');
        expect(s!.basis).toBe('git_estimate');
        expect(s!.metricContext.category).toBe('elevated');
        expect(s!.metricContext.current).toBe(0.5);
        expect(s!.metricContext.baseline).toBe(0.3);
        expect(s!.observation.toLowerCase()).toContain('elevated');
    });

    it('recognizes lower and steady churn', () => {
        expect(buildChurnReflection(0.2, 0.4, 3, T)!.metricContext.category).toBe('lower');
        expect(buildChurnReflection(0.31, 0.3, 3, T)!.metricContext.category).toBe('steady');
    });

    it('returns null without a current value, a baseline, or enough activity', () => {
        expect(buildChurnReflection(null, 0.3, 3, T)).toBeNull();
        expect(buildChurnReflection(0.5, null, 3, T)).toBeNull();
        expect(buildChurnReflection(0.5, 0, 3, T)).toBeNull(); // zero baseline → no ratio
        expect(buildChurnReflection(0.5, 0.3, 1, T)).toBeNull(); // below minActiveDays
    });
});

describe('buildAcceptanceTrend', () => {
    it('is honestly ABSENT (null) for a git-only developer with no tool data', () => {
        // The privacy/honesty-critical rule: no current acceptance → no signal.
        expect(buildAcceptanceTrend(null, 0.6, T)).toBeNull();
    });

    it('returns null without a baseline to compare against', () => {
        expect(buildAcceptanceTrend(0.7, null, T)).toBeNull();
    });

    it('classifies rising / falling / steady, basis measured', () => {
        const rising = buildAcceptanceTrend(0.7, 0.6, T);
        expect(rising!.basis).toBe('measured');
        expect(rising!.signalType).toBe('acceptance_trend');
        expect(rising!.metricContext.category).toBe('rising');
        expect(buildAcceptanceTrend(0.5, 0.6, T)!.metricContext.category).toBe('falling');
        expect(buildAcceptanceTrend(0.61, 0.6, T)!.metricContext.category).toBe('steady');
    });
});

function ann(type: JourneyAnnotation['type'], week_start: string): JourneyAnnotation {
    return {type, week_start, label: type};
}

describe('mostSalientAnnotation', () => {
    it('picks the latest week, breaking a same-week tie by salience', () => {
        expect(mostSalientAnnotation([])).toBeNull();
        expect(
            mostSalientAnnotation([ann('first_active_week', '2026-01-05'), ann('plateau', '2026-03-02')])!
                .type,
        ).toBe('plateau');
        // Same week: plateau outranks sustained_ramp.
        expect(
            mostSalientAnnotation([
                ann('sustained_ramp', '2026-03-02'),
                ann('plateau', '2026-03-02'),
            ])!.type,
        ).toBe('plateau');
    });
});

describe('buildJourneyCoaching', () => {
    it('returns null when there is no journey moment to interpret', () => {
        expect(buildJourneyCoaching([], 'medium')).toBeNull();
    });

    it('interprets a plateau and labels basis by tier', () => {
        const git = buildJourneyCoaching([ann('plateau', '2026-05-04')], 'medium');
        expect(git!.signalType).toBe('journey_coaching');
        expect(git!.basis).toBe('git_estimate');
        expect(git!.metricContext.category).toBe('plateau');
        expect(git!.observation.toLowerCase()).toContain('agent');

        const measured = buildJourneyCoaching([ann('plateau', '2026-05-04')], 'high');
        expect(measured!.basis).toBe('measured');
    });

    it('interprets ramp and first-week moments', () => {
        expect(
            buildJourneyCoaching([ann('sustained_ramp', '2026-05-04')], 'medium')!.metricContext
                .category,
        ).toBe('sustained_ramp');
        expect(
            buildJourneyCoaching([ann('first_active_week', '2026-05-04')], 'medium')!.metricContext
                .category,
        ).toBe('first_active_week');
    });
});

describe('buildPersonalInsight', () => {
    const activity = {activeDays: 3, commits: 10, interactions: 40};

    it('returns null for a developer with no data (tier none)', () => {
        expect(buildPersonalInsight('none', activity, T)).toBeNull();
    });

    it('is measured for high tier and git_estimate for medium tier', () => {
        const high = buildPersonalInsight('high', activity, T);
        expect(high!.basis).toBe('measured');
        expect(high!.metricContext.category).toBe('high');
        const medium = buildPersonalInsight('medium', activity, T);
        expect(medium!.basis).toBe('git_estimate');
        expect(medium!.observation.toLowerCase()).toContain('estimated');
    });

    it('always speaks to the unused seat for an expense-only (low) tier', () => {
        const low = buildPersonalInsight('low', {activeDays: 0, commits: 0, interactions: 0}, T);
        expect(low!.basis).toBe('git_estimate');
        expect(low!.metricContext.category).toBe('low');
        expect(low!.observation.toLowerCase()).toContain('subscription');
    });

    it('requires enough activity for high/medium tiers', () => {
        expect(buildPersonalInsight('high', {activeDays: 1, commits: 1, interactions: 1}, T)).toBeNull();
    });
});
