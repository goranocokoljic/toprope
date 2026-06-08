/**
 * Shared vocabulary and record shapes for data-prompted surveys (Task 4.3 / #98).
 *
 * A survey is created from a trigger condition observed in the data, then either
 * auto-sent or queued for a manager to send. Responses are captured and shown to
 * the manager as context next to the triggering data point — voluntary, never
 * punitive.
 */

// The conditions that can prompt a survey. The first four are detected from the
// data (see triggers.ts); `manual` is created on demand by a manager.
export const SURVEY_TRIGGER_TYPES = [
    'usage_drop',
    'unused_new_seat',
    'plan_change',
    'anomaly',
    'manual',
] as const;
export type SurveyTriggerType = (typeof SURVEY_TRIGGER_TYPES)[number];

// The four trigger types whose auto-vs-manual behaviour is settings-driven.
// `manual` is excluded: a manager-initiated survey is, by definition, manual.
export const AUTOMATED_TRIGGER_TYPES = [
    'usage_drop',
    'unused_new_seat',
    'plan_change',
    'anomaly',
] as const;
export type AutomatedTriggerType = (typeof AUTOMATED_TRIGGER_TYPES)[number];

// Lifecycle:
//   queued    — created, not yet delivered (auto-send pending, or awaiting a
//               manager's approval for a manual-dispatch trigger)
//   sent      — delivered to the developer (Slack or email)
//   answered  — the developer responded
//   declined  — the developer chose not to answer (recorded, never punitive)
//   dismissed — a manager discarded a queued survey without sending it
export const SURVEY_STATUSES = ['queued', 'sent', 'answered', 'declined', 'dismissed'] as const;
export type SurveyStatus = (typeof SURVEY_STATUSES)[number];

export const SURVEY_DELIVERIES = ['slack', 'email'] as const;
export type SurveyDelivery = (typeof SURVEY_DELIVERIES)[number];

// A single tap-to-answer option presented with a survey.
export interface SurveyChoice {
    value: string;
    label: string;
}

// The full question as asked: prompt text plus optional tap-to-answer choices.
export interface SurveyQuestion {
    questionText: string;
    choices: SurveyChoice[];
}

export interface SurveyRecord {
    id: string;
    developer_id: string;
    trigger_type: string;
    trigger_context: Record<string, unknown> | null;
    question_text: string;
    choices: SurveyChoice[];
    status: string;
    delivery: string | null;
    created_at: string;
    sent_at: string | null;
}

export interface SurveyResponseRecord {
    id: string;
    survey_id: string;
    response_text: string | null;
    response_choice: string | null;
    answered_at: string;
}

export function isSurveyTriggerType(value: unknown): value is SurveyTriggerType {
    return typeof value === 'string' && (SURVEY_TRIGGER_TYPES as readonly string[]).includes(value);
}
