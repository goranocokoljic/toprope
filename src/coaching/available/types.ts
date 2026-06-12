/**
 * Available-Data Coaching — shared types (Task 5.1 / #122).
 *
 * Coaching grounded in data the platform already has: the developer's own churn
 * trajectory (git), suggestion-acceptance trend (tool data, where it exists),
 * the Phase 4 adoption journey, and tier-aware personal insights. Every signal
 * is within-developer-over-time (never a cross-developer comparison) and private
 * to the developer — managers see only aggregate trends derived from these.
 */

import type {PeriodUnit} from '../period-window';

/** The four signal kinds, exactly as the schema's signal_type column documents. */
export type CoachingSignalType =
    | 'churn_reflection'
    | 'acceptance_trend'
    | 'journey_coaching'
    | 'personal_insight';

/**
 * Confidence/provenance of a signal. `git_estimate` = derived from git activity
 * (an inference); `measured` = derived from tool-API data (a measurement). The
 * issue's launch expectation: git-only signals carry `git_estimate`.
 */
export type CoachingBasis = 'git_estimate' | 'measured';

/**
 * Period unit the generator runs on (period TEXT: YYYY-Www or YYYY-MM). Aliases
 * the shared {@link PeriodUnit} so it cannot drift from the pr-review coaching
 * unit (both surfaces share the period-window helpers).
 */
export type CoachingPeriodUnit = PeriodUnit;

/**
 * One produced signal before persistence — the pure engine's output. The
 * generator stamps id/developer/period/created_at around this and serializes
 * `metricContext` to the JSON column.
 *
 * `metricContext.category` is the single categorical the manager aggregate
 * buckets on (e.g. churn direction, journey annotation type) so no observation
 * text is ever needed on the team path; the remaining fields are the numbers
 * behind the observation, surfaced only on the developer's private view.
 */
export interface CoachingSignalDraft {
    signalType: CoachingSignalType;
    basis: CoachingBasis;
    observation: string;
    /** Always carries a `category` key; null only when there's nothing to record. */
    metricContext: CoachingMetricContext;
}

/** The JSON shape stored in metric_context. `category` is always present. */
export interface CoachingMetricContext {
    /** The categorical the team aggregate buckets on (direction / annotation / tier). */
    category: string;
    [key: string]: unknown;
}

/** Direction of a within-developer metric move across the baseline comparison. */
export type SignalDirection = 'elevated' | 'lower' | 'steady';

/** Direction of the acceptance-rate trend (its own vocabulary — higher is better). */
export type AcceptanceDirection = 'rising' | 'falling' | 'steady';

// ───────────────────────────────────────────────────────────────────────────
// Read-side wire shapes (snake_case, matching every sibling API payload).
// ───────────────────────────────────────────────────────────────────────────

/** One stored signal as returned on the developer's PRIVATE view. */
export interface DeveloperCoachingSignal {
    period: string;
    signal_type: CoachingSignalType;
    basis: CoachingBasis;
    /** The coaching text — only ever returned to the developer themselves. */
    observation: string;
    /** Parsed metric_context (the numbers behind the observation), or null. */
    metric_context: CoachingMetricContext | null;
    created_at: string;
}

/** The developer-private available-data coaching payload (their own data only). */
export interface DeveloperCoaching {
    period_unit: CoachingPeriodUnit;
    /** Newest period first, then a stable signal-type order within a period. */
    signals: DeveloperCoachingSignal[];
}

/**
 * One period's team aggregate for a single signal type. Either suppressed (too
 * few contributing developers — k-anonymity) or a count + category breakdown.
 * NEVER carries any observation text and never names a developer.
 */
export interface TeamCoachingPoint {
    period: string;
    /** True when fewer than the cohort floor of developers had this signal. */
    suppressed: boolean;
    /** Developers with this signal this period — present only when not suppressed. */
    developers: number | null;
    /** category → count (e.g. {elevated: 2, lower: 1}); null when suppressed. */
    categories: Record<string, number> | null;
}

/** One signal type's team-level trajectory for the manager view. */
export interface TeamCoachingSeries {
    signal_type: CoachingSignalType;
    points: TeamCoachingPoint[];
}

/** The manager-facing aggregate payload — trends only, NO individual text. */
export interface TeamCoaching {
    /** Team name, or the literal 'org' for the org-wide roll-up. */
    scope: string;
    period_unit: CoachingPeriodUnit;
    series: TeamCoachingSeries[];
}

/** Tunable thresholds for the within-developer trend classifications. */
export interface AvailableCoachingThresholds {
    /** Relative change in mean churn vs baseline to call it elevated/lower. */
    churnChangeThreshold: number;
    /** Absolute change (percentage points) in acceptance rate to call a trend. */
    acceptanceChangeThreshold: number;
    /** Prior periods forming the developer's own within-developer baseline. */
    baselinePeriods: number;
    /** Minimum active days in the period before churn/personal coaching fires. */
    minActiveDays: number;
}
