/**
 * Anomaly detection engine — the pure math (Task 4.7 / #102).
 *
 * Two detection methods, one minimum-baseline guard, and the severity banding,
 * all expressed as side-effect-free functions over a numeric baseline window.
 * No database, no config loading, no period arithmetic — those live in
 * config.ts / scan.ts. Keeping the math pure is what makes every acceptance
 * criterion (method behaviour, threshold edges, the baseline guard, severity
 * bands, the divide-by-zero guards) directly unit-testable.
 *
 * STATISTICAL (mean + std-dev) — for noisy-but-stationary metrics (commits,
 * interactions, churn):
 *     mean = average of the baseline window
 *     std  = population standard deviation of the window
 *     z    = (observed - mean) / max(std, EPSILON)
 *     flag if |z| >= threshold ; deviation = z ; expected = mean
 *
 * PERCENTAGE_CHANGE vs baseline — for metrics where a directional shift matters
 * regardless of variance (usage level, cost):
 *     baseline = prior period value (default) or the trailing window average
 *     pct = (observed - baseline) / max(|baseline|, EPSILON) * 100
 *     flag if |pct| >= threshold ; deviation = pct ; expected = baseline
 *
 * MINIMUM-BASELINE GUARD (critical): a metric must have >= minBaselinePeriods of
 * history before detection runs. Below that the result is `building_baseline`
 * and NO anomaly is produced — this is the early-weeks false-positive protection.
 */

import type {AnomalyMethod, AnomalySeverity} from './types';

/**
 * Floor for every denominator, so neither method can divide by zero: a
 * zero-variance baseline (statistical) or a zero prior value (percentage_change)
 * yields a large-but-finite deviation rather than Infinity/NaN. Small enough not
 * to distort real deviations.
 */
export const EPSILON = 1e-9;

/** Resolved per-metric detection config (see config.ts for how it's resolved). */
export interface MetricConfig {
    method: AnomalyMethod;
    /** z-multiplier (statistical) or percent (percentage_change) to flag at. */
    threshold: number;
    /** Number of prior periods that form the baseline window. */
    baselineWindow: number;
    /**
     * For percentage_change: compare against the immediately prior period
     * (`prior`, the default) or the trailing window average (`average`).
     * Ignored by the statistical method.
     */
    percentageBaseline?: 'prior' | 'average';
}

/** Global knobs shared across metrics (resolved from settings, with defaults). */
export interface EngineParams {
    /** Minimum baseline periods required before detection runs (the guard). */
    minBaselinePeriods: number;
    /**
     * Statistical |z| above which severity is `high` rather than `notable`
     * (the issue's "> 2.5 = high", config-tunable). Below the metric threshold
     * nothing flags; between threshold and this cutoff is `notable`.
     */
    statisticalHighZ: number;
}

/**
 * Outcome of evaluating one metric for one period. A discriminated union so the
 * caller (and tests) can tell the three states apart:
 *   - building_baseline : guard not satisfied — deliberately no anomaly
 *   - normal            : enough history, value within tolerance
 *   - anomaly           : flagged, with the fields a row needs
 */
export type EvaluationResult =
    | {kind: 'building_baseline'; baselineCount: number; required: number}
    | {kind: 'normal'; method: AnomalyMethod; observed: number; expected: number; deviation: number}
    | {
          kind: 'anomaly';
          method: AnomalyMethod;
          observed: number;
          expected: number;
          deviation: number;
          severity: AnomalySeverity;
      };

/** Arithmetic mean of a non-empty array. */
function mean(values: number[]): number {
    let sum = 0;
    for (const v of values) sum += v;
    return sum / values.length;
}

/** Population standard deviation (divides by N, not N-1). */
function populationStdDev(values: number[], avg: number): number {
    let sumSq = 0;
    for (const v of values) {
        const d = v - avg;
        sumSq += d * d;
    }
    return Math.sqrt(sumSq / values.length);
}

/** Round to a sensible precision so stored deviations are not noisy floats. */
function round4(value: number): number {
    return Math.round(value * 1e4) / 1e4;
}

/**
 * Severity for a flagged statistical anomaly. `high` once |z| exceeds the
 * configured high cutoff; otherwise `notable`. The cutoff is floored at the
 * metric threshold so a threshold set ABOVE the global high-Z (e.g. threshold 3,
 * highZ 2.5) doesn't leave an empty notable band that mislabels everything.
 */
export function statisticalSeverity(
    absZ: number,
    threshold: number,
    statisticalHighZ: number,
): AnomalySeverity {
    return absZ > Math.max(statisticalHighZ, threshold) ? 'high' : 'notable';
}

/**
 * Severity for a flagged percentage-change anomaly. `high` once |pct| exceeds
 * twice the threshold (the issue's "> 2x = high"); otherwise `notable`.
 */
export function percentageSeverity(absPct: number, threshold: number): AnomalySeverity {
    return absPct > 2 * threshold ? 'high' : 'notable';
}

/**
 * Statistical detection. `baseline` is the chronological window of prior values
 * (it must already satisfy the minimum-baseline guard — `evaluateMetric` checks
 * that before calling here). Returns `normal` or `anomaly`; never throws and
 * never returns NaN thanks to the EPSILON-floored denominator.
 */
export function detectStatistical(
    observed: number,
    baseline: number[],
    config: MetricConfig,
    params: EngineParams,
): Extract<EvaluationResult, {kind: 'normal' | 'anomaly'}> {
    const avg = mean(baseline);
    const std = populationStdDev(baseline, avg);
    const z = round4((observed - avg) / Math.max(std, EPSILON));
    const expected = round4(avg);
    if (Math.abs(z) >= config.threshold) {
        return {
            kind: 'anomaly',
            method: 'statistical',
            observed,
            expected,
            deviation: z,
            severity: statisticalSeverity(Math.abs(z), config.threshold, params.statisticalHighZ),
        };
    }
    return {kind: 'normal', method: 'statistical', observed, expected, deviation: z};
}

/**
 * Percentage-change detection against the prior period (default) or the trailing
 * window average. `baseline` is the chronological prior window; the comparison
 * value is its last element (`prior`) or its mean (`average`). EPSILON floors the
 * denominator so a zero baseline yields a large finite percentage, not Infinity.
 */
export function detectPercentageChange(
    observed: number,
    baseline: number[],
    config: MetricConfig,
): Extract<EvaluationResult, {kind: 'normal' | 'anomaly'}> {
    const compareTo =
        config.percentageBaseline === 'average' ? mean(baseline) : baseline[baseline.length - 1];
    const pct = round4(((observed - compareTo) / Math.max(Math.abs(compareTo), EPSILON)) * 100);
    const expected = round4(compareTo);
    if (Math.abs(pct) >= config.threshold) {
        return {
            kind: 'anomaly',
            method: 'percentage_change',
            observed,
            expected,
            deviation: pct,
            severity: percentageSeverity(Math.abs(pct), config.threshold),
        };
    }
    return {kind: 'normal', method: 'percentage_change', observed, expected, deviation: pct};
}

/**
 * Evaluate one metric for one period: enforce the minimum-baseline guard, then
 * dispatch to the configured method. `baseline` is the chronological window of
 * the metric's prior-period values (oldest → newest), EXCLUDING the observed
 * period. The single entry point the scan layer calls per (scope, metric).
 */
export function evaluateMetric(
    observed: number,
    baseline: number[],
    config: MetricConfig,
    params: EngineParams,
): EvaluationResult {
    // The guard is the early-weeks protection: until a metric has accumulated
    // enough history, it is "building baseline" and fires nothing — regardless of
    // method. minBaselinePeriods is floored at 1 so an empty baseline can never
    // slip through to a method that would read baseline[length-1] of an empty
    // array or average an empty window.
    const required = Math.max(1, params.minBaselinePeriods);
    if (baseline.length < required) {
        return {kind: 'building_baseline', baselineCount: baseline.length, required};
    }
    return config.method === 'percentage_change'
        ? detectPercentageChange(observed, baseline, config)
        : detectStatistical(observed, baseline, config, params);
}
