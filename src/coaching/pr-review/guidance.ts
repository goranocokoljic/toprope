/**
 * PR/Review coaching — pure trajectory + aggregation math (Task 5.3 / #124).
 *
 * Side-effect-free functions that turn the per-period metric points (read from
 * pr_review_metrics by coaching.ts) into the two coaching surfaces:
 *   - the developer's private TRAJECTORY framing (trend over time, never a bare
 *     snapshot verdict — design §5.3), and
 *   - the manager's TEAM AGGREGATE, with a k-anonymity floor so a thin team can
 *     never surface an individual's numbers (design §5.4).
 *
 * Keeping this pure makes every privacy-critical rule (the cohort floor, the
 * "no numbers when suppressed" guarantee, the trajectory dead-band) directly
 * unit-testable without a database.
 */

import {computeCombinedSignal} from './engine';
import type {
    CombinedSignal,
    MetricTrend,
    PRReviewThresholds,
    TeamAggregatePoint,
    TrendDirection,
} from './types';

/**
 * k-anonymity floor for every manager-facing aggregate. A period with fewer than
 * this many CONTRIBUTING developers (developers who actually had PRs in scope) is
 * suppressed entirely — its numbers would, at the limit of one contributor, be a
 * single developer's figures wearing a team's clothes. Three is the smallest
 * cohort where no single developer dominates the average; below it the manager
 * sees only "not enough data", never a number.
 */
export const MIN_TEAM_COHORT = 3;

/**
 * Dead-band for the trajectory direction: a rework-rate move smaller than 2
 * percentage points reads as 'steady' so ordinary period-to-period noise is not
 * narrated as a real rise or fall (the same 0.5–2pp dead-band idea the developer
 * overview trend uses).
 */
const REWORK_TREND_DEADBAND = 0.02;

/** The minimal point shape the trajectory helpers read (snake_case = the wire shape). */
export interface TrajectoryLike {
    period: string;
    prs_total: number | null;
    rework_rate: number | null;
    combined_signal: CombinedSignal;
}

/** A trajectory point that cleared the min-PR bar — enough PRs to coach on. */
function isSufficient(point: {prs_total: number | null; rework_rate: number | null}, minPrs: number): boolean {
    return point.prs_total !== null && point.prs_total >= minPrs && point.rework_rate !== null;
}

/**
 * The rework-rate trend across an ordered (oldest→newest) series. Only periods
 * that cleared the min-PR bar count — coaching on a one-PR period would be noise.
 * Needs at least two such periods to claim a direction; otherwise the direction
 * is 'insufficient_data' and the endpoints describe whatever single period (if
 * any) we do have, so the UI can still show "here's your latest" without
 * inventing a trend.
 */
export function computeReworkTrend(points: TrajectoryLike[], minPrs: number): MetricTrend {
    const sufficient = points.filter((p) => isSufficient(p, minPrs));
    if (sufficient.length < 2) {
        const only = sufficient[0];
        return {
            metric: 'rework_rate',
            direction: 'insufficient_data',
            from_period: only?.period ?? null,
            to_period: only?.period ?? null,
            from_value: only?.rework_rate ?? null,
            to_value: only?.rework_rate ?? null,
        };
    }
    const first = sufficient[0];
    const last = sufficient[sufficient.length - 1];
    const delta = (last.rework_rate as number) - (first.rework_rate as number);
    let direction: TrendDirection = 'steady';
    if (delta > REWORK_TREND_DEADBAND) direction = 'rising';
    else if (delta < -REWORK_TREND_DEADBAND) direction = 'falling';
    return {
        metric: 'rework_rate',
        direction,
        from_period: first.period,
        to_period: last.period,
        from_value: first.rework_rate,
        to_value: last.rework_rate,
    };
}

/**
 * The combined signal of the latest period that cleared the min-PR bar — the
 * "where you are now" anchor for the guidance copy. 'insufficient_data' when no
 * period in the window had enough PRs, so the UI coaches gently rather than
 * rendering a verdict on thin data.
 */
export function latestSufficientSignal(points: TrajectoryLike[], minPrs: number): CombinedSignal {
    for (let i = points.length - 1; i >= 0; i--) {
        const p = points[i];
        if (isSufficient(p, minPrs)) return p.combined_signal;
    }
    return 'insufficient_data';
}

/** Count of window periods that cleared the min-PR bar. */
export function countSufficientPeriods(points: TrajectoryLike[], minPrs: number): number {
    return points.filter((p) => isSufficient(p, minPrs)).length;
}

/**
 * One developer's per-period metrics for a single variant, as the aggregator
 * consumes them. Rates are the stored per-developer values; the aggregator
 * reconstructs counts from rate × volume so the team rate is the true pooled
 * rate, not a mean-of-means.
 */
export interface DevPeriodMetric {
    prsTotal: number;
    prsMerged: number;
    reworkRate: number | null;
    reviewRejectionRate: number | null;
    avgReviewRounds: number | null;
    avgCommentDensity: number | null;
    avgTimeToMergeHours: number | null;
    avgChurn: number | null;
}

function round4(value: number): number {
    return Math.round(value * 1e4) / 1e4;
}

/** A fully suppressed point — carries the marker and nothing else. */
function suppressedPoint(period: string): TeamAggregatePoint {
    return {
        period,
        suppressed: true,
        developers: null,
        prs_total: null,
        rework_rate: null,
        review_rejection_rate: null,
        avg_review_rounds: null,
        avg_comment_density: null,
        avg_time_to_merge_hours: null,
        avg_churn: null,
        combined_signal: 'insufficient_data',
    };
}

/**
 * Aggregate one period's per-developer metrics into a single team-level point.
 *
 * Privacy first: only developers who actually had PRs in scope this period count
 * toward the cohort, and if fewer than `minCohort` did, the point is suppressed —
 * it returns the marker with EVERY number null, so nothing about any individual
 * leaks. This is the core anti-leak guarantee of the manager view.
 *
 * When the cohort clears the floor, rates are pooled honestly: a per-developer
 * rate times that developer's PR volume reconstructs the underlying count, so the
 * team rework rate is total_sent_back / total_prs (not an average of averages
 * that would over-weight a low-volume developer). Time-to-merge pools over merged
 * PRs; churn — which is not PR-scoped — is an unweighted mean across contributing
 * developers and is a rough team indicator only. The team combined signal is
 * recomputed from the pooled churn + rejection so it reflects the team, not any
 * one person.
 */
export function aggregateTeamPeriod(
    period: string,
    devMetrics: DevPeriodMetric[],
    thresholds: PRReviewThresholds,
    minCohort: number = MIN_TEAM_COHORT,
): TeamAggregatePoint {
    const contributors = devMetrics.filter((d) => d.prsTotal > 0);
    if (contributors.length < minCohort) {
        return suppressedPoint(period);
    }

    let prsTotal = 0;
    let sentBack = 0; // Σ rejectionRate × prsTotal
    let reworkCount = 0; // Σ reworkRate × prsTotal
    let roundsWeighted = 0;
    let roundsWeight = 0;
    let commentsTotal = 0; // Σ commentDensity × prsTotal
    let ttmWeighted = 0;
    let ttmWeight = 0;
    const churns: number[] = [];

    for (const d of contributors) {
        prsTotal += d.prsTotal;
        if (d.reviewRejectionRate !== null) sentBack += d.reviewRejectionRate * d.prsTotal;
        if (d.reworkRate !== null) reworkCount += d.reworkRate * d.prsTotal;
        if (d.avgReviewRounds !== null) {
            roundsWeighted += d.avgReviewRounds * d.prsTotal;
            roundsWeight += d.prsTotal;
        }
        if (d.avgCommentDensity !== null) commentsTotal += d.avgCommentDensity * d.prsTotal;
        if (d.avgTimeToMergeHours !== null && d.prsMerged > 0) {
            ttmWeighted += d.avgTimeToMergeHours * d.prsMerged;
            ttmWeight += d.prsMerged;
        }
        if (d.avgChurn !== null) churns.push(d.avgChurn);
    }

    const reworkRate = prsTotal > 0 ? round4(reworkCount / prsTotal) : null;
    const reviewRejectionRate = prsTotal > 0 ? round4(sentBack / prsTotal) : null;
    const avgReviewRounds = roundsWeight > 0 ? round4(roundsWeighted / roundsWeight) : null;
    const avgCommentDensity = prsTotal > 0 ? round4(commentsTotal / prsTotal) : null;
    const avgTimeToMergeHours = ttmWeight > 0 ? round4(ttmWeighted / ttmWeight) : null;
    const avgChurn =
        churns.length > 0 ? round4(churns.reduce((s, c) => s + c, 0) / churns.length) : null;

    return {
        period,
        suppressed: false,
        developers: contributors.length,
        prs_total: prsTotal,
        rework_rate: reworkRate,
        review_rejection_rate: reviewRejectionRate,
        avg_review_rounds: avgReviewRounds,
        avg_comment_density: avgCommentDensity,
        avg_time_to_merge_hours: avgTimeToMergeHours,
        avg_churn: avgChurn,
        combined_signal: computeCombinedSignal(prsTotal, avgChurn, reviewRejectionRate, thresholds),
    };
}
