/**
 * Shared types for the Best-Practice companion tables (Task 6.2.1 / #156).
 *
 * These shapes describe the four tables Best Practices adds on top of the 6.1
 * contribution spine — practice_details, practice_metric_pins, practice_feedback,
 * practice_usage_events. A best practice itself is a `contributions` row
 * (content_type = 'best_practice') with its prose body in `contribution_versions`;
 * these companions carry only what the feature-agnostic spine cannot.
 */

/** A manual surfacing override: `pin` forces a practice to appear next to a metric, `suppress` hides it. */
export type MetricPinAction = 'pin' | 'suppress';

export const METRIC_PIN_ACTIONS = ['pin', 'suppress'] as const;

export function isMetricPinAction(value: unknown): value is MetricPinAction {
    return value === 'pin' || value === 'suppress';
}

/** A per-developer feedback signal on a practice. Closed, binary set. */
export type FeedbackSignal = 'helpful' | 'not_helpful';

export const FEEDBACK_SIGNALS = ['helpful', 'not_helpful'] as const;

export function isFeedbackSignal(value: unknown): value is FeedbackSignal {
    return value === 'helpful' || value === 'not_helpful';
}

/**
 * A self-marked usage event. OPEN enum (typed `string`, no DB CHECK) so the
 * interaction vocabulary can grow without a migration — the values in use today
 * are listed in `KNOWN_USAGE_EVENTS` for reference.
 */
export type UsageEventType = string;

/** The usage-event kinds in use today. Informational — the column is not constrained to them. */
export const KNOWN_USAGE_EVENTS = ['viewed', 'applied'] as const;

/** Practice-specific fields for a contribution (1:1 companion to the spine row). */
export interface PracticeDetails {
    contributionId: string;
    /** The AI model used if AI-assisted authoring; null otherwise. */
    modelUsed: string | null;
    /** Hybrid-model lead-endorsement flag (6.2.2). */
    endorsed: boolean;
}

/** The fields to set on a practice's details. Both optional; an omitted field keeps/defaults. */
export interface PracticeDetailsInput {
    modelUsed?: string | null;
    endorsed?: boolean;
}

/** A stored manual pin/suppress override. */
export interface MetricPin {
    id: string;
    contributionId: string;
    metric: string;
    action: MetricPinAction;
    actorId: string;
    createdAt: string;
}

/** The fields needed to record a pin/suppress override. */
export interface NewMetricPin {
    contributionId: string;
    metric: string;
    action: MetricPinAction;
    actorId: string;
    /** UTC ISO timestamp; defaults to now. */
    createdAt?: string;
}

/** Optional filters for listing metric pins. All are ANDed; omitted fields don't filter. */
export interface MetricPinFilters {
    contributionId?: string;
    metric?: string;
    action?: MetricPinAction;
}

/** A stored per-developer feedback signal. */
export interface PracticeFeedback {
    id: string;
    contributionId: string;
    developerId: string;
    signal: FeedbackSignal;
    createdAt: string;
}

/** The fields needed to record (or flip) a developer's feedback on a practice. */
export interface NewFeedback {
    contributionId: string;
    developerId: string;
    signal: FeedbackSignal;
    /** UTC ISO timestamp; defaults to now. Restamped when an existing signal is flipped. */
    createdAt?: string;
}

/** Aggregate feedback tallies for a contribution. */
export interface FeedbackCounts {
    helpful: number;
    notHelpful: number;
}

/** A stored usage event. */
export interface UsageEvent {
    id: string;
    contributionId: string;
    developerId: string;
    event: UsageEventType;
    /** The metric the practice was surfaced against, or null. */
    metricContext: string | null;
    occurredAt: string;
}

/** The fields needed to record a usage event. */
export interface NewUsageEvent {
    contributionId: string;
    developerId: string;
    event: UsageEventType;
    metricContext?: string | null;
    /** UTC ISO timestamp; defaults to now. */
    occurredAt?: string;
}
