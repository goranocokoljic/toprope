import type {BadgeTone} from './Badge';

/**
 * Utilization + activity tiering for the manager Teams screens (Task 2.6),
 * kept in one module so the teams list and team detail classify against the
 * SAME documented thresholds rather than re-inventing them — the acceptance
 * criterion is explicitly "utilization indicators use consistent thresholds".
 *
 * Framing note: these are deliberately "utilization health" tiers, not a
 * performance ranking. They describe how much of what an org is paying for is
 * actually being used, never who is "best".
 */

export type UtilizationLevel = 'healthy' | 'watch' | 'low';

export interface UtilizationTier {
    level: UtilizationLevel;
    /** Maps to the green / amber / red indicator the task calls for. */
    tone: BadgeTone;
    label: string;
}

/**
 * Team utilization = active developers / team size, as a 0..1 ratio.
 *
 * Thresholds (documented, shared):
 *   - healthy (green):  rate >= 0.70  — most of the team is actively using AI tooling
 *   - watch   (amber):  0.40 <= rate < 0.70 — meaningful but partial adoption
 *   - low     (red):    rate < 0.40  — most paid-for capacity sits idle
 */
export const UTILIZATION_HEALTHY_MIN = 0.7;
export const UTILIZATION_WATCH_MIN = 0.4;

export function utilizationTier(rate: number): UtilizationTier {
    const r = Number.isFinite(rate) ? rate : 0;
    if (r >= UTILIZATION_HEALTHY_MIN) return {level: 'healthy', tone: 'success', label: 'Healthy'};
    if (r >= UTILIZATION_WATCH_MIN) return {level: 'watch', tone: 'warning', label: 'Watch'};
    return {level: 'low', tone: 'danger', label: 'Low'};
}

export type ActivityLevel = 'active' | 'low' | 'inactive';

export interface ActivityTier {
    level: ActivityLevel;
    tone: BadgeTone;
    label: string;
}

/**
 * Per-developer activity health from active days in the last 30, shown as a
 * calm indicator — NOT a ranked leaderboard (see Task 2.6 / 2.17 principle).
 *
 * Thresholds (documented, shared):
 *   - active   (green):  >= 8 active days in the last 30 (roughly twice a week)
 *   - low      (amber):  1..7 active days — some usage, but sporadic
 *   - inactive (neutral): 0 active days — no recorded activity in the window
 *
 * Inactive is a neutral (not red) tone on purpose: an individual with no
 * activity is a coaching/enablement signal, not an alarm to point at a person.
 */
export const ACTIVITY_ACTIVE_MIN_DAYS = 8;

export function activityTier(activeDays30d: number): ActivityTier {
    const days = Number.isFinite(activeDays30d) ? Math.max(0, Math.floor(activeDays30d)) : 0;
    if (days >= ACTIVITY_ACTIVE_MIN_DAYS) return {level: 'active', tone: 'success', label: 'Active'};
    if (days >= 1) return {level: 'low', tone: 'warning', label: 'Low'};
    return {level: 'inactive', tone: 'neutral', label: 'Inactive'};
}

/** Human labels for the backend waste alert_type strings, for inline display. */
const WASTE_TYPE_LABELS: Record<string, string> = {
    unused_seat: 'Unused seat',
    underutilized: 'Underutilized',
    duplicate_tool: 'Duplicate tool',
    cost_outlier: 'Cost outlier',
    plan_roi: 'Plan ROI',
};

export function wasteTypeLabel(alertType: string): string {
    return (
        WASTE_TYPE_LABELS[alertType] ??
        alertType
            .split(/[_\s-]+/)
            .filter(Boolean)
            .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
            .join(' ')
    );
}
