import {describe, it, expect} from 'vitest';
import {
    EPSILON,
    detectPercentageChange,
    detectStatistical,
    evaluateMetric,
    percentageSeverity,
    statisticalSeverity,
    type EngineParams,
    type MetricConfig,
} from '../../src/anomaly/engine';

const PARAMS: EngineParams = {minBaselinePeriods: 4, statisticalHighZ: 2.5};

const statConfig = (overrides: Partial<MetricConfig> = {}): MetricConfig => ({
    method: 'statistical',
    threshold: 2.0,
    baselineWindow: 8,
    ...overrides,
});

const pctConfig = (overrides: Partial<MetricConfig> = {}): MetricConfig => ({
    method: 'percentage_change',
    threshold: 40,
    baselineWindow: 8,
    percentageBaseline: 'prior',
    ...overrides,
});

describe('detectStatistical', () => {
    it('flags a value beyond the threshold std-devs from the mean', () => {
        // baseline [-1,1,-1,1]: mean 0, population std 1. observed 3 → z = 3.
        const r = detectStatistical(3, [-1, 1, -1, 1], statConfig(), PARAMS);
        expect(r.kind).toBe('anomaly');
        expect(r.expected).toBe(0);
        expect(r.deviation).toBe(3);
    });

    it('does not flag a value within tolerance', () => {
        const r = detectStatistical(1.5, [-1, 1, -1, 1], statConfig(), PARAMS);
        expect(r.kind).toBe('normal');
        expect(r.deviation).toBe(1.5);
    });

    it('flags exactly at the threshold (>= is inclusive)', () => {
        // mean 0, std 1, observed 2 → z = 2.0 == threshold.
        const r = detectStatistical(2, [-1, 1, -1, 1], statConfig({threshold: 2.0}), PARAMS);
        expect(r.kind).toBe('anomaly');
        expect(r.deviation).toBe(2);
    });

    it('stays just below the threshold', () => {
        const r = detectStatistical(1.999, [-1, 1, -1, 1], statConfig({threshold: 2.0}), PARAMS);
        expect(r.kind).toBe('normal');
    });

    it('guards zero-variance baselines (no NaN/Infinity)', () => {
        // All-equal baseline → std 0; EPSILON floor keeps z finite.
        const r = detectStatistical(20, [10, 10, 10, 10], statConfig(), PARAMS);
        expect(r.kind).toBe('anomaly');
        expect(Number.isFinite(r.deviation)).toBe(true);
        expect(r.severity).toBe('high'); // a huge finite z lands in the high band
    });

    it('a flat value on a flat baseline is normal, not an anomaly', () => {
        const r = detectStatistical(10, [10, 10, 10, 10], statConfig(), PARAMS);
        expect(r.kind).toBe('normal');
        expect(r.deviation).toBe(0);
    });

    it('handles negative deviations (drops) symmetrically', () => {
        const r = detectStatistical(-3, [-1, 1, -1, 1], statConfig(), PARAMS);
        expect(r.kind).toBe('anomaly');
        expect(r.deviation).toBe(-3);
    });
});

describe('detectPercentageChange', () => {
    it('flags a shift at/above the threshold percent (prior baseline)', () => {
        const r = detectPercentageChange(140, [80, 90, 100], pctConfig());
        expect(r.kind).toBe('anomaly');
        expect(r.expected).toBe(100); // prior = last element
        expect(r.deviation).toBe(40);
    });

    it('does not flag a sub-threshold shift', () => {
        const r = detectPercentageChange(139, [80, 90, 100], pctConfig());
        expect(r.kind).toBe('normal');
        expect(r.deviation).toBe(39);
    });

    it('can compare against the trailing average when configured', () => {
        // average of [100,200,300] = 200; observed 300 → +50%.
        const r = detectPercentageChange(300, [100, 200, 300], pctConfig({percentageBaseline: 'average'}));
        expect(r.expected).toBe(200);
        expect(r.deviation).toBe(50);
    });

    it('guards a zero baseline against divide-by-zero', () => {
        const r = detectPercentageChange(5, [0], pctConfig());
        expect(r.kind).toBe('anomaly');
        expect(Number.isFinite(r.deviation)).toBe(true);
        expect(r.deviation).toBeGreaterThan(0);
    });

    it('zero observed on a zero baseline is a 0% change (normal)', () => {
        const r = detectPercentageChange(0, [0], pctConfig());
        expect(r.kind).toBe('normal');
        expect(r.deviation).toBe(0);
    });

    it('detects a drop (negative percent)', () => {
        const r = detectPercentageChange(40, [100], pctConfig());
        expect(r.kind).toBe('anomaly');
        expect(r.deviation).toBe(-60);
    });
});

describe('severity bands', () => {
    it('statistical: notable between threshold and high-Z, high beyond', () => {
        expect(statisticalSeverity(2.0, 2.0, 2.5)).toBe('notable');
        expect(statisticalSeverity(2.5, 2.0, 2.5)).toBe('notable');
        expect(statisticalSeverity(2.51, 2.0, 2.5)).toBe('high');
    });

    it('statistical: high cutoff is floored at the threshold (no empty notable band)', () => {
        // threshold 3 > highZ 2.5: anything flagged (|z|>=3) is high.
        expect(statisticalSeverity(3.0, 3.0, 2.5)).toBe('notable'); // == cutoff stays notable
        expect(statisticalSeverity(3.1, 3.0, 2.5)).toBe('high');
    });

    it('percentage_change: notable up to 2x threshold, high beyond', () => {
        expect(percentageSeverity(40, 40)).toBe('notable');
        expect(percentageSeverity(80, 40)).toBe('notable');
        expect(percentageSeverity(80.1, 40)).toBe('high');
    });
});

describe('evaluateMetric — minimum-baseline guard', () => {
    it('reports building_baseline below the minimum periods (fires nothing)', () => {
        const r = evaluateMetric(100, [1, 2, 3], statConfig(), PARAMS);
        expect(r.kind).toBe('building_baseline');
        if (r.kind === 'building_baseline') {
            expect(r.baselineCount).toBe(3);
            expect(r.required).toBe(4);
        }
    });

    it('evaluates once the minimum periods are present', () => {
        const r = evaluateMetric(3, [-1, 1, -1, 1], statConfig(), PARAMS);
        expect(r.kind).toBe('anomaly');
    });

    it('an extreme value below the guard is STILL suppressed (early-weeks protection)', () => {
        // Only 2 periods of history but a wild observed value: must not fire.
        const r = evaluateMetric(9999, [1, 1], statConfig(), PARAMS);
        expect(r.kind).toBe('building_baseline');
    });

    it('floors the required periods at 1 so an empty baseline never reaches a method', () => {
        const r = evaluateMetric(5, [], statConfig(), {minBaselinePeriods: 0, statisticalHighZ: 2.5});
        expect(r.kind).toBe('building_baseline');
        if (r.kind === 'building_baseline') {
            expect(r.required).toBe(1);
        }
    });

    it('dispatches to the configured method', () => {
        const stat = evaluateMetric(140, [80, 90, 100, 110], statConfig(), PARAMS);
        expect(stat.kind !== 'building_baseline' && stat.method).toBe('statistical');
        const pct = evaluateMetric(140, [80, 90, 100, 110], pctConfig(), PARAMS);
        expect(pct.kind !== 'building_baseline' && pct.method).toBe('percentage_change');
    });
});

describe('EPSILON', () => {
    it('is small and positive', () => {
        expect(EPSILON).toBeGreaterThan(0);
        expect(EPSILON).toBeLessThan(1e-6);
    });
});
