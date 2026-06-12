/**
 * PR/Review Outcome Metrics — shared types (Task 5.2 / #123).
 *
 * Two clearly-separated metric sets per developer per period:
 *   - all_pr        : every PR — factual, no inference
 *   - ai_assisted_pr: only PRs whose estimated AI signature clears the
 *                     configured threshold — inferred, lower confidence
 * The variants are stored as separate rows (scope_variant) and never merged.
 */

export type ScopeVariant = 'all_pr' | 'ai_assisted_pr';

/** Confidence tier per variant: all_pr is factual, ai_assisted_pr inferred. */
export type MetricsBasis = 'factual' | 'inferred';

export const BASIS_FOR_VARIANT: Record<ScopeVariant, MetricsBasis> = {
    all_pr: 'factual',
    ai_assisted_pr: 'inferred',
};

/**
 * The churn + review disambiguator. Churn alone is ambiguous (sloppy
 * acceptance vs healthy iteration); combined with the review verdict it
 * separates the cases.
 */
export type CombinedSignal =
    | 'struggling'
    | 'healthy_iteration'
    | 'effective'
    | 'insufficient_data';

/** The two period units the engine computes (period TEXT: YYYY-Www or YYYY-MM). */
export type PRReviewPeriodUnit = 'weekly' | 'monthly';

/**
 * One PR's normalized facts, as read from pr_records and (for the AI variant)
 * annotated with the developer's estimated AI signature over the PR's window.
 */
export interface PRData {
    prId: string;
    state: string;
    createdAt: string;
    mergedAt: string | null;
    closedAt: string | null;
    reviewCommentCount: number;
    reviewRounds: number;
    changesRequestedCount: number;
    timeToMergeHours: number | null;
    /**
     * Estimated AI signature for this PR (mean of the developer's daily
     * ai_signature_score over the PR's active window) — null when no git
     * activity exists in the window to estimate from. An inference on an
     * inference; used only to select the ai_assisted_pr variant.
     */
    aiSignatureScore: number | null;
}

/** The computed metric set for one (developer, period, scope_variant). */
export interface VariantMetrics {
    scopeVariant: ScopeVariant;
    basis: MetricsBasis;
    prsTotal: number;
    prsMerged: number;
    reworkRate: number | null;
    avgReviewRounds: number | null;
    reviewRejectionRate: number | null;
    avgCommentDensity: number | null;
    commentDensityVsBaseline: number | null;
    avgTimeToMergeHours: number | null;
    avgChurn: number | null;
    combinedSignal: CombinedSignal;
}

/** Configurable thresholds (issue: churn_high, reject, ai_signature, min_prs). */
export interface PRReviewThresholds {
    /** avg_churn at or above this is "high churn". */
    churnHighThreshold: number;
    /** review_rejection_rate at or above this is "high rejection". */
    rejectThreshold: number;
    /** PR AI-signature estimate at or above this counts as AI-assisted. */
    aiSignatureThreshold: number;
    /** Below this many PRs in a period → insufficient_data (no false coaching). */
    minPrs: number;
    /** Trailing periods forming the developer's own comment-density baseline. */
    baselinePeriods: number;
}
