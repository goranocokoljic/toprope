import type {WasteAlert, WasteResolutionReason} from '../api/types';
import {toolLabel} from './toolLabels';

/**
 * Presentation helpers for the manager Waste Detection screen (Task 2.7). Kept
 * separate from the shared utilization tiers so the screen-specific framing —
 * resolution reasons, the plain-language detail line per alert type, and the
 * Plan-ROI detail shape — lives in one place.
 *
 * Framing rule for everything here: waste alerts are spend-optimization review
 * prompts, never developer blame. Copy says "review", "consider", "worth
 * confirming" — never "lazy", "wasting", or anything accusatory about a person.
 */

// --- Resolution reasons (mirror WASTE_RESOLUTION_REASONS on the backend) ----

export interface ResolutionOption {
    value: WasteResolutionReason;
    /** Label for the select / audit display. */
    label: string;
}

export const RESOLUTION_OPTIONS: ResolutionOption[] = [
    {value: 'reallocated', label: 'Seat reallocated'},
    {value: 'upgraded', label: 'Plan upgraded'},
    {value: 'justified', label: 'Justified — keep as is'},
    {value: 'downgrade_recommended', label: 'Downgrade recommended'},
    {value: 'monitor_longer', label: 'Monitor longer'},
    {value: 'dismissed', label: 'Dismissed'},
];

const RESOLUTION_LABELS: Record<string, string> = Object.fromEntries(
    RESOLUTION_OPTIONS.map((o) => [o.value, o.label]),
);

/** Human label for a stored resolution reason (audit trail display). */
export function resolutionLabel(reason: string | null | undefined): string {
    if (!reason) return '—';
    return RESOLUTION_LABELS[reason] ?? reason;
}

// --- Safe detail readers ----------------------------------------------------

function num(details: Record<string, unknown>, key: string): number | null {
    const v = details[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(details: Record<string, unknown>, key: string): string | null {
    const v = details[key];
    return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Plain-language, review-framed summary line for the non-Plan-ROI alert types.
 * Plan ROI gets its own dedicated card (planRoiDetails below), so it is not
 * described here. Returns null when there's nothing meaningful to add.
 */
export function describeWasteAlert(alert: WasteAlert): string | null {
    const d = alert.details ?? {};
    switch (alert.alert_type) {
        case 'unused_seat': {
            const days = num(d, 'inactivity_days');
            return days
                ? `No activity recorded in the last ${days}+ days — the seat may be reassignable, or the developer may prefer another tool.`
                : 'No recent activity recorded on this seat.';
        }
        case 'underutilized': {
            const usage = num(d, 'usage_pct');
            const threshold = num(d, 'threshold_pct');
            if (usage != null && threshold != null) {
                return `Using about ${usage}% of the team average for this tool, below the ${threshold}% review threshold. Worth checking whether a different plan fits better.`;
            }
            return 'Usage is below the team review threshold for this tool.';
        }
        case 'duplicate_tool': {
            const tools = Array.isArray(d.tools)
                ? (d.tools as {tool?: unknown}[])
                      .map((t) => (typeof t.tool === 'string' ? toolLabel(t.tool) : null))
                      .filter((t): t is string => t !== null)
                : [];
            const category = str(d, 'category');
            const list = tools.length > 0 ? tools.join(' + ') : 'multiple tools';
            return `Overlapping ${category ?? 'tool'} coverage (${list}). Worth confirming both are needed.`;
        }
        case 'cost_outlier': {
            const mult = num(d, 'multiplier_detected');
            return mult
                ? `Cost per merged PR is about ${mult}× the team average — worth a look at whether the tooling fits this developer's work.`
                : 'Cost per output is well above the team average — worth reviewing.';
        }
        default: {
            // Unknown types fall back to a stored note if present.
            return str(d, 'note');
        }
    }
}

// --- Plan ROI detail shape --------------------------------------------------

/** The change-driven fields a Plan-ROI alert carries (see plan-roi.ts). */
export interface PlanRoiDetails {
    developerName: string | null;
    tool: string | null;
    oldPlan: string | null;
    newPlan: string | null;
    oldMonthlyCost: number | null;
    newMonthlyCost: number | null;
    costDelta: number | null;
    usageDelta: number | null;
    baselineUsage: number | null;
    postChangeUsage: number | null;
    daysSinceChange: number | null;
    note: string | null;
}

/** Extract the typed Plan-ROI fields from an alert's loosely-typed details. */
export function planRoiDetails(alert: WasteAlert): PlanRoiDetails {
    const d = alert.details ?? {};
    return {
        developerName: str(d, 'developer_name') ?? alert.developer_name,
        tool: str(d, 'tool') ?? alert.tool,
        oldPlan: str(d, 'old_plan'),
        newPlan: str(d, 'new_plan'),
        oldMonthlyCost: num(d, 'old_monthly_cost'),
        newMonthlyCost: num(d, 'new_monthly_cost'),
        costDelta: num(d, 'cost_delta'),
        usageDelta: num(d, 'usage_delta'),
        baselineUsage: num(d, 'baseline_usage'),
        postChangeUsage: num(d, 'post_change_usage'),
        daysSinceChange: num(d, 'days_since_change'),
        note: str(d, 'note'),
    };
}
