/**
 * Shared anomaly surfacing vocabulary (Task 4.8 / #103).
 *
 * One module the three surfaces — dashboard panel, Slack alert, and AI summary —
 * all read from, so they label and phrase an anomaly identically and, above all,
 * HONESTLY. The launch tier is git-derived, so the wording must never imply a
 * measured AI-tool interaction that the data doesn't contain: every metric label
 * here describes a git/cost signal as exactly what it is, and the two `measured`
 * tool metrics keep their measured names (they only ever carry real values once a
 * connector is online, so they cannot appear in a git-only period).
 *
 * Pure: depends only on the anomaly type vocabulary, no DB / config / I/O, so the
 * phrasing and the surfacing gate are directly unit-testable and reusable from the
 * numbers-only summary input builder without dragging persistence into it.
 */

import type {AnomalyBasis, AnomalyMetric, AnomalySeverity} from './types';

/**
 * Human, tier-honest label for each metric. Git-derived metrics are described as
 * the git signals they are ("commit activity," not "usage"); the cost metric is a
 * subscription-spend figure; `interactions` / `acceptance_rate` keep their
 * measured-tool names because they only carry real values with a connector online.
 */
export const METRIC_LABELS: Record<AnomalyMetric, string> = {
    commits: 'commit activity',
    prs_merged: 'merged PRs',
    churn: 'code churn',
    ai_signature: 'estimated AI-assistance signal',
    interactions: 'tool interactions',
    acceptance_rate: 'suggestion acceptance rate',
    cost: 'subscription cost',
};

export function metricLabel(metric: AnomalyMetric): string {
    return METRIC_LABELS[metric];
}

/**
 * Honest basis label for any surface. `git_estimate` is the launch tier — the
 * issue's "git-based estimate" wording — and `measured` is direct tool data.
 */
export function basisLabel(basis: AnomalyBasis): string {
    return basis === 'git_estimate' ? 'git-based estimate' : 'measured tool data';
}

/** Severity ordering, least → most severe. */
const SEVERITY_RANK: Record<AnomalySeverity, number> = {info: 1, notable: 2, high: 3};

export function severityRank(severity: AnomalySeverity): number {
    return SEVERITY_RANK[severity];
}

/** The severities that push out to Slack and into summaries. */
export type SurfaceableSeverity = 'notable' | 'high';

/**
 * The surfacing gate: only `notable` and `high` reach Slack and the AI summaries.
 * `info` is deliberately silent on those channels (it stays visible in the
 * dashboard panel) so borderline cases don't spam a manager's inbox or narrative.
 */
export function isSurfaceable(severity: AnomalySeverity): severity is SurfaceableSeverity {
    return severity === 'notable' || severity === 'high';
}

export type AnomalyDirection = 'increase' | 'decrease';

/** Direction of the deviation: observed at/above expected is an increase. */
export function anomalyDirection(observed: number, expected: number): AnomalyDirection {
    return observed >= expected ? 'increase' : 'decrease';
}

/**
 * Percentage change of observed vs expected, rounded to a whole percent — null
 * when expected is ~0 (no baseline to form a percentage against). For a
 * percentage_change anomaly this reproduces the stored deviation; for a
 * statistical one it re-expresses the z-score as a human-readable percentage.
 */
export function changePercent(observed: number, expected: number): number | null {
    if (!Number.isFinite(observed) || !Number.isFinite(expected)) return null;
    if (Math.abs(expected) < 1e-9) return null;
    return Math.round(((observed - expected) / Math.abs(expected)) * 100);
}

function capitalize(text: string): string {
    return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

/** The fields describeAnomaly needs — a subset of an AnomalyRecord. */
export interface AnomalyDescribable {
    metric: AnomalyMetric;
    observed_value: number;
    expected_value: number;
}

/**
 * One plain-language, tier-honest sentence describing what changed — the phrasing
 * both Slack and the summaries reuse. Uses the honest metric label and states
 * direction + magnitude, e.g. "Commit activity dropped 60%" / "Subscription cost
 * rose 45%". When there is no usable baseline percentage (expected ~0) it falls
 * back to the observed/expected values rather than inventing a percent.
 */
export function describeAnomaly(anomaly: AnomalyDescribable): string {
    const label = capitalize(metricLabel(anomaly.metric));
    const direction = anomalyDirection(anomaly.observed_value, anomaly.expected_value);
    const verb = direction === 'increase' ? 'rose' : 'dropped';
    const pct = changePercent(anomaly.observed_value, anomaly.expected_value);
    if (pct !== null && pct !== 0) {
        return `${label} ${verb} ${Math.abs(pct)}%`;
    }
    return `${label} ${verb} to ${round2(anomaly.observed_value)} from ${round2(anomaly.expected_value)}`;
}
