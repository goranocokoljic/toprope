/**
 * PR/Review outcome metrics engine — the pure math (Task 5.2 / #123).
 *
 * Side-effect-free functions over normalized per-PR data. No database, no
 * config loading, no period arithmetic — those live in config.ts / compute.ts.
 * Keeping the math pure makes every acceptance criterion (each formula, both
 * variants, the combined-signal branches, the insufficient-data guard, the
 * divide-by-zero guards) directly unit-testable.
 *
 * Formulas (issue #123):
 *   rework_rate           = prs_requiring_changes / max(prs_total, 1)
 *   review_rejection_rate = prs_sent_back / max(prs_total, 1)
 *   avg_review_rounds     = mean(review_cycles_per_pr)
 *   comment_density       = total_review_comments / max(prs_total, 1)
 *   comment_density_vs_baseline = this_period_density / max(dev_baseline_density, eps)
 *
 * "Requiring changes" and "sent back" both derive from the providers' single
 * normalized changes-requested signal (a PR with >= 1 changes_requested review
 * event), so rework_rate and review_rejection_rate carry the same value in V1.
 * The schema keeps two columns (per issue #123) so a richer rework signal
 * (e.g. post-review commits) can split them later without a migration.
 *
 * Combined signal (churn + review) — the disambiguator:
 *   prs_total < min_prs                → insufficient_data
 *   high churn  + high rejection       → struggling
 *   high churn  + clean reviews        → healthy_iteration
 *   low churn   (either way)           → effective
 */

import type {
    CombinedSignal,
    PRData,
    PRReviewThresholds,
    ScopeVariant,
    VariantMetrics,
} from './types';
import {BASIS_FOR_VARIANT} from './types';

/**
 * Floor for every denominator, so a zero baseline density (or any other zero
 * denominator) yields a large-but-finite ratio rather than Infinity/NaN.
 */
export const EPSILON = 1e-9;

/** Round to a sensible precision so stored rates are not noisy floats. */
function round4(value: number): number {
    return Math.round(value * 1e4) / 1e4;
}

function mean(values: number[]): number | null {
    if (values.length === 0) return null;
    let sum = 0;
    for (const v of values) sum += v;
    return sum / values.length;
}

/** A PR was sent back for changes at least once. */
function wasSentBack(pr: PRData): boolean {
    return pr.changesRequestedCount >= 1;
}

/**
 * Select the PRs for the ai_assisted_pr variant: estimated AI signature
 * present and at or above the configured threshold. PRs with no estimate are
 * excluded — absence of evidence is not AI evidence.
 */
export function selectAiAssistedPRs(prs: PRData[], aiSignatureThreshold: number): PRData[] {
    return prs.filter(
        (pr) => pr.aiSignatureScore !== null && pr.aiSignatureScore >= aiSignatureThreshold,
    );
}

/**
 * Review comments per PR for a PR set — the building block both the period
 * density and the trailing baseline use, so the two cannot drift. Null when
 * the set is empty (no PRs → no density, not a zero density).
 */
export function commentDensity(prs: PRData[]): number | null {
    if (prs.length === 0) return null;
    const totalComments = prs.reduce((s, pr) => s + pr.reviewCommentCount, 0);
    return totalComments / prs.length;
}

/**
 * The churn + review combined signal. `avgChurn` may be null (no git activity
 * in the period to measure churn from) — treated as not-high churn, so the
 * signal degrades toward 'effective' rather than guessing 'struggling'.
 */
export function computeCombinedSignal(
    prsTotal: number,
    avgChurn: number | null,
    rejectionRate: number | null,
    thresholds: PRReviewThresholds,
): CombinedSignal {
    if (prsTotal < thresholds.minPrs) return 'insufficient_data';
    const highChurn = avgChurn !== null && avgChurn >= thresholds.churnHighThreshold;
    const highReject = rejectionRate !== null && rejectionRate >= thresholds.rejectThreshold;
    if (highChurn && highReject) return 'struggling';
    if (highChurn) return 'healthy_iteration';
    // Low churn — effective whether reviews are clean or not (issue's logic
    // table: low churn + some reject is still 'effective').
    return 'effective';
}

/**
 * Compute one variant's full metric set from its PR selection.
 *
 * @param prs              the PRs in scope for this variant and period
 * @param avgChurn         developer's mean churn for the period (git_snapshots)
 * @param baselineDensity  developer's OWN trailing comment density (within-dev
 *                         baseline), null when no history exists yet
 */
export function computeVariantMetrics(
    variant: ScopeVariant,
    prs: PRData[],
    avgChurn: number | null,
    baselineDensity: number | null,
    thresholds: PRReviewThresholds,
): VariantMetrics {
    const prsTotal = prs.length;
    const prsMerged = prs.filter((pr) => pr.state === 'merged').length;

    const sentBack = prs.filter(wasSentBack).length;
    const sentBackRate = prsTotal === 0 ? null : sentBack / prsTotal;
    // One value feeds both rates in V1 (see header) — kept as two fields so
    // they can diverge when a richer rework signal lands.
    const reworkRate = sentBackRate;
    const rejectionRate = sentBackRate;

    const avgReviewRounds = mean(prs.map((pr) => pr.reviewRounds));
    const density = commentDensity(prs);
    const densityVsBaseline =
        density !== null && baselineDensity !== null
            ? density / Math.max(baselineDensity, EPSILON)
            : null;

    const mergeTimes = prs
        .map((pr) => pr.timeToMergeHours)
        .filter((t): t is number => t !== null);
    const avgTimeToMergeHours = mean(mergeTimes);

    return {
        scopeVariant: variant,
        basis: BASIS_FOR_VARIANT[variant],
        prsTotal,
        prsMerged,
        reworkRate: reworkRate === null ? null : round4(reworkRate),
        avgReviewRounds: avgReviewRounds === null ? null : round4(avgReviewRounds),
        reviewRejectionRate: rejectionRate === null ? null : round4(rejectionRate),
        avgCommentDensity: density === null ? null : round4(density),
        commentDensityVsBaseline: densityVsBaseline === null ? null : round4(densityVsBaseline),
        avgTimeToMergeHours: avgTimeToMergeHours === null ? null : round4(avgTimeToMergeHours),
        avgChurn: avgChurn === null ? null : round4(avgChurn),
        combinedSignal: computeCombinedSignal(prsTotal, avgChurn, rejectionRate, thresholds),
    };
}
