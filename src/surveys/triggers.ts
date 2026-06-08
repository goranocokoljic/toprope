/**
 * Trigger detection for data-prompted surveys (Task 4.3 / #98).
 *
 * Each detector inspects the data already in the warehouse and emits candidate
 * surveys — it does NOT create or send anything (dispatch.ts owns that, applying
 * the auto/manual setting and dedup). Keeping detection pure makes every trigger
 * independently testable by seeding the source table and asserting candidates.
 *
 * Sources:
 *   usage_drop      ← monthly_aggregates.interaction_delta_pct (per developer)
 *   unused_new_seat ← a recently-assigned subscription with no activity since
 *   plan_change     ← plan_change_events (recent transitions)
 *   anomaly         ← Area E / Task 4.7 (soft dep, not built): convert an
 *                     externally-detected anomaly via `anomalyCandidate`
 */
import type Database from 'better-sqlite3';
import type {SurveyTriggerType} from './types';

// A detected condition that warrants asking the developer for context. The
// trigger_context is persisted on the survey and feeds the question template.
export interface SurveyTriggerCandidate {
    developerId: string;
    team: string;
    triggerType: SurveyTriggerType;
    triggerContext: Record<string, unknown>;
}

export interface TriggerDetectionOptions {
    // usage_drop: flag a period-over-period interaction drop at or beyond this
    // magnitude (percent, positive number). Default 40 → a ≥40% drop.
    usageDropThresholdPct?: number;
    // unused_new_seat: a seat must have existed at least this many days with no
    // activity to count as "unused" (mirrors the waste inactivity window).
    unusedInactivityDays?: number;
    // unused_new_seat: only seats assigned within this many days are "new" — an
    // ancient idle seat is ordinary waste (Task 2.x), not a survey-worthy event.
    newSeatWindowDays?: number;
    // plan_change: only transitions within this many days are recent enough to
    // ask about.
    planChangeWindowDays?: number;
}

const DEFAULT_USAGE_DROP_PCT = 40;
const DEFAULT_UNUSED_INACTIVITY_DAYS = 14;
const DEFAULT_NEW_SEAT_WINDOW_DAYS = 90;
const DEFAULT_PLAN_CHANGE_WINDOW_DAYS = 45;

/**
 * Detect significant usage drops from each developer's most recent monthly
 * aggregate. A drop is flagged when interaction_delta_pct ≤ -threshold (the
 * delta is null for a developer's first month, which is correctly skipped — no
 * fabricated baseline).
 */
export function detectUsageDrops(
    db: Database.Database,
    options: TriggerDetectionOptions = {},
): SurveyTriggerCandidate[] {
    const threshold = options.usageDropThresholdPct ?? DEFAULT_USAGE_DROP_PCT;
    const rows = db
        .prepare(
            `SELECT m.developer_id, m.team, m.month, m.interaction_delta_pct
             FROM monthly_aggregates m
             JOIN (
                 SELECT developer_id, MAX(month) AS latest
                 FROM monthly_aggregates
                 GROUP BY developer_id
             ) latest_m
               ON latest_m.developer_id = m.developer_id AND latest_m.latest = m.month
             WHERE m.interaction_delta_pct IS NOT NULL
               AND m.interaction_delta_pct <= ?`,
        )
        .all(-Math.abs(threshold)) as {
        developer_id: string;
        team: string;
        month: string;
        interaction_delta_pct: number;
    }[];

    return rows.map((row) => ({
        developerId: row.developer_id,
        team: row.team,
        triggerType: 'usage_drop',
        triggerContext: {
            metric: 'interactions',
            drop_pct: row.interaction_delta_pct,
            period: row.month,
        },
    }));
}

/**
 * Detect new seats that have sat unused. A candidate is a non-revoked
 * subscription assigned recently (within newSeatWindowDays) but old enough to be
 * "unused for N days" (≥ unusedInactivityDays), with no active tool_snapshot
 * since it was assigned.
 */
export function detectUnusedNewSeats(
    db: Database.Database,
    options: TriggerDetectionOptions = {},
): SurveyTriggerCandidate[] {
    const inactivityDays = options.unusedInactivityDays ?? DEFAULT_UNUSED_INACTIVITY_DAYS;
    const newWindowDays = options.newSeatWindowDays ?? DEFAULT_NEW_SEAT_WINDOW_DAYS;
    const rows = db
        .prepare(
            `SELECT s.developer_id, d.team, s.tool, s.seat_assigned_at,
                    CAST(julianday('now') - julianday(s.seat_assigned_at) AS INTEGER) AS days_old
             FROM subscriptions s
             JOIN developers d ON d.id = s.developer_id
             WHERE s.seat_revoked_at IS NULL
               AND s.seat_assigned_at IS NOT NULL
               AND date(s.seat_assigned_at) <= date('now', '-' || ? || ' days')
               AND date(s.seat_assigned_at) >= date('now', '-' || ? || ' days')
               AND NOT EXISTS (
                   SELECT 1 FROM tool_snapshots ts
                   WHERE ts.developer_id = s.developer_id
                     AND ts.tool = s.tool
                     AND ts.is_active = 1
                     AND ts.date >= date(s.seat_assigned_at)
               )`,
        )
        .all(inactivityDays, newWindowDays) as {
        developer_id: string;
        team: string;
        tool: string;
        seat_assigned_at: string;
        days_old: number;
    }[];

    return rows.map((row) => ({
        developerId: row.developer_id,
        team: row.team,
        triggerType: 'unused_new_seat',
        triggerContext: {
            tool: row.tool,
            seat_assigned_at: row.seat_assigned_at,
            days_unused: row.days_old,
        },
    }));
}

/**
 * Detect recent plan changes / tool switches worth asking about, from the
 * plan_change_events log written by subscription lifecycle handling (Task 2.14).
 */
export function detectPlanChanges(
    db: Database.Database,
    options: TriggerDetectionOptions = {},
): SurveyTriggerCandidate[] {
    const windowDays = options.planChangeWindowDays ?? DEFAULT_PLAN_CHANGE_WINDOW_DAYS;
    const rows = db
        .prepare(
            `SELECT p.developer_id, d.team, p.tool, p.old_tool, p.old_plan, p.new_plan, p.changed_at
             FROM plan_change_events p
             JOIN developers d ON d.id = p.developer_id
             WHERE date(p.changed_at) >= date('now', '-' || ? || ' days')`,
        )
        .all(windowDays) as {
        developer_id: string;
        team: string;
        tool: string;
        old_tool: string | null;
        old_plan: string | null;
        new_plan: string | null;
        changed_at: string;
    }[];

    return rows.map((row) => ({
        developerId: row.developer_id,
        team: row.team,
        triggerType: 'plan_change',
        triggerContext: {
            tool: row.tool,
            old_tool: row.old_tool,
            old_plan: row.old_plan,
            new_plan: row.new_plan,
            changed_at: row.changed_at,
        },
    }));
}

/**
 * Build an anomaly survey candidate from an externally-detected anomaly. Anomaly
 * detection itself lives in Area E (Task 4.7), which is a soft dependency and not
 * yet built — so there is no anomaly table to scan here. When 4.7 lands it can
 * feed each anomaly through this helper to raise a survey, with no change to
 * dispatch.
 */
export function anomalyCandidate(input: {
    developerId: string;
    team: string;
    metric: string;
    context?: Record<string, unknown>;
}): SurveyTriggerCandidate {
    return {
        developerId: input.developerId,
        team: input.team,
        triggerType: 'anomaly',
        triggerContext: {metric: input.metric, ...(input.context ?? {})},
    };
}

/**
 * Run every data-backed detector and return the combined candidate list. The
 * anomaly trigger is intentionally absent (its source, Task 4.7, isn't built);
 * use `anomalyCandidate` to fold anomalies in once it exists.
 */
export function detectAllTriggers(
    db: Database.Database,
    options: TriggerDetectionOptions = {},
): SurveyTriggerCandidate[] {
    return [
        ...detectUsageDrops(db, options),
        ...detectUnusedNewSeats(db, options),
        ...detectPlanChanges(db, options),
    ];
}
