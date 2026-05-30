import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import {getRoiConfigForTeam} from '../settings/store';

/**
 * Plan-Change ROI Detection (Task 2.15 / #50).
 *
 * When a developer moves to a more expensive plan, this module watches whether
 * usage rose enough to justify the extra spend. Vendor dashboards never surface
 * this — they benefit from upsell — so it is exactly the incentive-aligned
 * insight that justifies the platform to a budget-conscious manager. The framing
 * in every output is "review", never "the developer did something wrong".
 *
 * The flow has two distinct phases, mapped to the two deliverables:
 *
 *   1. Baseline capture (`captureBaselines`) — as soon as a cost-increase upgrade
 *      appears in plan_change_events, record the average daily usage in the N days
 *      BEFORE the change. The window is anchored to `changed_at`, and tool_snapshots
 *      are append-only, so this is deterministic regardless of when it runs — but it
 *      is persisted on the event row so it is an auditable fact, not a recomputation.
 *
 *   2. Post-change evaluation (`evaluatePlanRoi`) — only AFTER the per-team settling
 *      period has elapsed, compute the average daily usage in the N days after the
 *      change, compare the cost-increase ratio against the usage-increase ratio, and
 *      raise a `plan_roi` waste alert when cost rose disproportionately.
 *
 * `evaluatePlanRoi` performs both phases (it captures any missing baselines first)
 * so a single scheduled call is self-contained; tests can also drive
 * `captureBaselines` on its own to assert the baseline phase in isolation.
 *
 * SCOPE BOUNDARY — only genuine cost increases off a *positive* prior cost are
 * candidates (`new_monthly_cost > old_monthly_cost > 0`). This excludes, by design:
 *   - downgrades and lateral moves (no cost increase) — never flagged;
 *   - free→paid transitions (old cost 0) — the cost ratio is undefined (÷0), and a
 *     brand-new paid seat with no usage is already the unused-seat detector's job.
 */

/** Default window, in days, over which baseline (pre-change) usage is averaged. */
export const DEFAULT_BASELINE_WINDOW_DAYS = 30;

const MS_PER_DAY = 86_400_000;

export interface PlanRoiOptions {
    /** Evaluation "now"; injectable so tests can simulate elapsed settling. */
    now?: Date;
    /** Days before the change over which baseline usage is averaged (default 30). */
    baselineWindowDays?: number;
}

export interface PlanRoiResult {
    /** Upgrade events that had their pre-change baseline usage recorded this run. */
    baselinesCaptured: number;
    /** Settled upgrade events whose post-change usage was evaluated this run. */
    evaluated: number;
    /** Of those evaluated, how many were flagged as disproportionate (alert raised). */
    flagged: number;
}

/** A cost-increase upgrade event, joined with the developer's team. */
interface UpgradeEvent {
    id: string;
    developer_id: string;
    team: string;
    developer_name: string;
    tool: string;
    old_tool: string | null;
    old_plan: string | null;
    new_plan: string | null;
    old_monthly_cost: number;
    new_monthly_cost: number;
    changed_at: string;
    baseline_usage: number | null;
    baseline_window_days: number | null;
}

/**
 * The candidacy predicate shared by both phases: an event is a Plan-ROI candidate
 * only when it records a real cost increase off a positive prior cost. This single
 * WHERE clause is the one place downgrades, lateral moves, and free→paid jumps are
 * filtered out (see the SCOPE BOUNDARY note above).
 */
const UPGRADE_CANDIDATE_WHERE = `
    old_monthly_cost IS NOT NULL
    AND new_monthly_cost IS NOT NULL
    AND new_monthly_cost > old_monthly_cost
    AND old_monthly_cost > 0
`;

/** Add `days` (may be negative) to a YYYY-MM-DD date, returning YYYY-MM-DD (UTC). */
function addDays(date: string, days: number): string {
    const ms = Date.parse(`${date}T00:00:00.000Z`) + days * MS_PER_DAY;
    return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Average daily usage (interaction_count) for a developer+tool over the half-open
 * date window [start, end). The total interactions are divided by the full window
 * length in days, so days with no snapshot count as zero usage — this is the honest
 * "average daily usage" rather than an average over only the active days, and keeps
 * the baseline and post-change figures directly comparable as per-day rates.
 */
function avgDailyUsage(
    db: Database.Database,
    developerId: string,
    tool: string,
    startDate: string,
    endDate: string,
    windowDays: number,
): number {
    if (windowDays <= 0) {
        return 0;
    }
    const row = db
        .prepare(
            `SELECT COALESCE(SUM(interaction_count), 0) AS total
             FROM tool_snapshots
             WHERE developer_id = ? AND tool = ? AND date >= ? AND date < ?`,
        )
        .get(developerId, tool, startDate, endDate) as {total: number};
    return row.total / windowDays;
}

/** Before a switch the relevant usage is the OLD tool's; for a same-tool plan upgrade old_tool is null. */
function baselineTool(event: {tool: string; old_tool: string | null}): string {
    return event.old_tool ?? event.tool;
}

/**
 * Phase 1 — record the pre-change baseline usage for every cost-increase upgrade
 * that does not yet have one. Idempotent: events already carrying a baseline are
 * skipped, so re-running never churns the figure. Returns the number captured.
 */
export function captureBaselines(
    db: Database.Database,
    baselineWindowDays: number = DEFAULT_BASELINE_WINDOW_DAYS,
): number {
    const events = db
        .prepare(
            `SELECT id, developer_id, tool, old_tool, changed_at
             FROM plan_change_events
             WHERE baseline_usage IS NULL AND ${UPGRADE_CANDIDATE_WHERE}`,
        )
        .all() as Pick<
        UpgradeEvent,
        'id' | 'developer_id' | 'tool' | 'old_tool' | 'changed_at'
    >[];

    const update = db.prepare(
        'UPDATE plan_change_events SET baseline_usage = ?, baseline_window_days = ? WHERE id = ?',
    );

    let captured = 0;
    for (const event of events) {
        const changedDate = event.changed_at.slice(0, 10);
        const start = addDays(changedDate, -baselineWindowDays);
        const usage = avgDailyUsage(
            db,
            event.developer_id,
            baselineTool(event),
            start,
            changedDate,
            baselineWindowDays,
        );
        update.run(usage, baselineWindowDays, event.id);
        captured++;
    }
    return captured;
}

/** Has the settling period elapsed for an event as of `now`? */
function settlingElapsed(changedAt: string, settlingDays: number, now: Date): boolean {
    return now.getTime() - Date.parse(changedAt) >= settlingDays * MS_PER_DAY;
}

/**
 * The usage-increase ratio (post / baseline). When baseline usage is zero the ratio
 * is undefined: if post usage is also zero, usage genuinely did not move so we treat
 * the ratio as 1 (no increase to offset the cost); if post usage is positive, usage
 * grew from nothing — an unbounded increase — so we treat it as Infinity, which can
 * never be flagged.
 */
function usageRatioOf(baseline: number, post: number): number {
    if (baseline > 0) {
        return post / baseline;
    }
    return post > 0 ? Infinity : 1;
}

function round(value: number, dp = 2): number {
    const f = 10 ** dp;
    return Math.round(value * f) / f;
}

/**
 * Phase 2 — the scheduled entrypoint. Captures any missing baselines, then for each
 * cost-increase upgrade whose per-team settling period has elapsed, computes the
 * post-change usage, compares cost-increase vs usage-increase ratios, marks the
 * event evaluated, and raises a review-oriented `plan_roi` alert when cost rose
 * disproportionately (cost ratio >= threshold × usage ratio).
 *
 * Re-evaluation is gated by `evaluated_at`, so each event yields at most one alert
 * no matter how often the job runs. Thresholds and the settling period are resolved
 * per developer-team via the settings system (Task 2.16), honoring team overrides
 * only when the governing flag permits.
 */
export function evaluatePlanRoi(db: Database.Database, options: PlanRoiOptions = {}): PlanRoiResult {
    const now = options.now ?? new Date();
    const baselineWindowDays = options.baselineWindowDays ?? DEFAULT_BASELINE_WINDOW_DAYS;

    const baselinesCaptured = captureBaselines(db, baselineWindowDays);

    const events = db
        .prepare(
            `SELECT pce.id, pce.developer_id, d.team, d.name AS developer_name,
                    pce.tool, pce.old_tool, pce.old_plan, pce.new_plan,
                    pce.old_monthly_cost, pce.new_monthly_cost, pce.changed_at,
                    pce.baseline_usage, pce.baseline_window_days
             FROM plan_change_events pce
             JOIN developers d ON d.id = pce.developer_id
             WHERE pce.evaluated_at IS NULL AND ${UPGRADE_CANDIDATE_WHERE}`,
        )
        .all() as UpgradeEvent[];

    const markEvaluated = db.prepare(
        'UPDATE plan_change_events SET post_change_usage = ?, evaluated_at = ?, roi_flagged = ? WHERE id = ?',
    );
    const insertAlert = db.prepare(
        `INSERT INTO waste_alerts (id, developer_id, team, alert_type, tool, details, monthly_waste, detected_at)
         VALUES (?, ?, ?, 'plan_roi', ?, ?, ?, ?)`,
    );

    let evaluated = 0;
    let flagged = 0;
    const nowIso = now.toISOString();

    for (const event of events) {
        const {threshold, settlingDays} = getRoiConfigForTeam(db, event.team);
        if (!settlingElapsed(event.changed_at, settlingDays, now)) {
            continue;
        }

        const changedDate = event.changed_at.slice(0, 10);
        const postEnd = addDays(changedDate, settlingDays);
        const postUsage = avgDailyUsage(
            db,
            event.developer_id,
            event.tool,
            changedDate,
            postEnd,
            settlingDays,
        );
        const baselineUsage = event.baseline_usage ?? 0;

        const costRatio = event.new_monthly_cost / event.old_monthly_cost;
        const usageRatio = usageRatioOf(baselineUsage, postUsage);
        const isFlagged = costRatio >= threshold * usageRatio;

        const costDelta = event.new_monthly_cost - event.old_monthly_cost;
        const daysSinceChange = Math.floor(
            (now.getTime() - Date.parse(event.changed_at)) / MS_PER_DAY,
        );

        db.transaction(() => {
            markEvaluated.run(postUsage, nowIso, isFlagged ? 1 : 0, event.id);
            if (isFlagged) {
                const details = {
                    developer_name: event.developer_name,
                    tool: event.tool,
                    old_plan: event.old_plan,
                    new_plan: event.new_plan,
                    old_monthly_cost: event.old_monthly_cost,
                    new_monthly_cost: event.new_monthly_cost,
                    cost_delta: round(costDelta),
                    cost_ratio: round(costRatio),
                    baseline_usage: round(baselineUsage),
                    post_change_usage: round(postUsage),
                    usage_delta: round(postUsage - baselineUsage),
                    usage_ratio: Number.isFinite(usageRatio) ? round(usageRatio) : null,
                    threshold,
                    baseline_window_days: event.baseline_window_days ?? baselineWindowDays,
                    settling_days: settlingDays,
                    days_since_change: daysSinceChange,
                    note:
                        `Review suggested — ${event.developer_name}'s ${event.tool} moved from ` +
                        `${event.old_plan ?? 'previous plan'} to ${event.new_plan ?? 'new plan'} ` +
                        `(+$${round(costDelta)}/mo, ${round(costRatio)}× cost) but daily usage changed ` +
                        `${Number.isFinite(usageRatio) ? `${round(usageRatio)}×` : 'from no prior usage'} ` +
                        `over the ${settlingDays}-day settling period. Worth confirming the upgrade is ` +
                        `delivering value for this developer.`,
                };
                insertAlert.run(
                    randomUUID(),
                    event.developer_id,
                    event.team,
                    event.tool,
                    JSON.stringify(details),
                    round(costDelta),
                    nowIso,
                );
            }
        })();

        evaluated++;
        if (isFlagged) {
            flagged++;
        }
    }

    return {baselinesCaptured, evaluated, flagged};
}
