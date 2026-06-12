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

// ───────────────────────────────────────────────────────────────────────────
// Coaching surface (Task 5.3 / #124)
//
// Read-side shapes that turn the stored per-period metrics into a *trajectory*
// (the developer-private view) and a *team aggregate* (the manager view). The
// engine math stays in engine.ts / guidance.ts; these are the transport shapes
// the API returns. The two views never blur: an individual's numbers reach only
// the developer's own /api/me surface; the manager only ever sees an aggregate
// with a k-anonymity floor (see guidance.ts MIN_TEAM_COHORT).
// ───────────────────────────────────────────────────────────────────────────

// The shapes below cross the wire to the dashboard, so they follow the API's
// snake_case convention (matching every sibling endpoint and the stored
// columns), even though the pure engine internals above are camelCase.

/** Direction of a metric's movement across the trajectory window. */
export type TrendDirection = 'rising' | 'falling' | 'steady' | 'insufficient_data';

/**
 * A metric's movement over the window, as the from→to pair the UI needs to phrase
 * a trajectory ("rose from 15% to 30%") rather than a bare snapshot verdict. The
 * endpoints (period keys) and values are null when there isn't enough data to
 * establish a trend (fewer than two periods clearing the min-PR bar).
 */
export interface MetricTrend {
    /** Which stored metric this trend describes (rework_rate in V1). */
    metric: 'rework_rate';
    direction: TrendDirection;
    from_period: string | null;
    to_period: string | null;
    from_value: number | null;
    to_value: number | null;
}

/** One period's stored metrics, shaped for the trajectory series the UI plots. */
export interface PRReviewTrajectoryPoint {
    period: string;
    prs_total: number;
    prs_merged: number;
    rework_rate: number | null;
    review_rejection_rate: number | null;
    avg_review_rounds: number | null;
    avg_comment_density: number | null;
    comment_density_vs_baseline: number | null;
    avg_time_to_merge_hours: number | null;
    avg_churn: number | null;
    combined_signal: CombinedSignal;
}

/**
 * One scope variant's full trajectory plus the derived framing the UI turns into
 * coaching copy. `basis` carries the factual/inferred label so the AI-assisted
 * variant is always presentable as lower-confidence.
 */
export interface VariantTrajectory {
    scope_variant: ScopeVariant;
    basis: MetricsBasis;
    points: PRReviewTrajectoryPoint[];
    /** Movement of the headline rework signal across the window. */
    rework_trend: MetricTrend;
    /** Combined signal of the latest period that cleared the min-PR bar. */
    latest_signal: CombinedSignal;
    /** Periods in the window that had enough PRs to coach on (>= min_prs). */
    sufficient_periods: number;
}

/** The developer-private PR/review coaching payload (their own data only). */
export interface DeveloperPRReviewCoaching {
    period_unit: PRReviewPeriodUnit;
    all_pr: VariantTrajectory;
    ai_assisted: VariantTrajectory;
}

/**
 * One period's team aggregate for a variant. Either suppressed (too few
 * contributing developers to be safe to surface — k-anonymity) or the weighted
 * team-level numbers. Suppressed periods carry NO numbers at all, only the
 * marker, so a thin period can never leak an individual's figures.
 */
export interface TeamAggregatePoint {
    period: string;
    /** True when fewer than MIN_TEAM_COHORT developers contributed this period. */
    suppressed: boolean;
    /** Developers contributing PRs this period — present only when not suppressed. */
    developers: number | null;
    prs_total: number | null;
    rework_rate: number | null;
    review_rejection_rate: number | null;
    avg_review_rounds: number | null;
    avg_comment_density: number | null;
    avg_time_to_merge_hours: number | null;
    avg_churn: number | null;
    combined_signal: CombinedSignal;
}

/** One scope variant's team-level trajectory for the manager view. */
export interface TeamVariantTrajectory {
    scope_variant: ScopeVariant;
    basis: MetricsBasis;
    points: TeamAggregatePoint[];
    rework_trend: MetricTrend;
    latest_signal: CombinedSignal;
    /** Non-suppressed periods that also cleared the min-PR bar. */
    sufficient_periods: number;
}

/** The manager-facing team aggregate payload (NO individual numbers). */
export interface TeamPRReviewCoaching {
    /** Team name, or the literal 'org' for the org-wide roll-up. */
    scope: string;
    period_unit: PRReviewPeriodUnit;
    all_pr: TeamVariantTrajectory;
    ai_assisted: TeamVariantTrajectory;
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
