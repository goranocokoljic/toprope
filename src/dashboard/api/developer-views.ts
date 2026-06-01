import type Database from 'better-sqlite3';
import {getDeveloperPlanChanges} from '../../expenses/subscription-tracker';

/**
 * Data layer for the self-service developer view (Task 2.4 / #39).
 *
 * Every function here takes an already-resolved developer id (the caller pulls
 * it STRICTLY from the authenticated session) plus a resolved [from, to] date
 * window, and returns only that developer's data. Nothing here reads a request
 * parameter — scoping is the route layer's job and is done from the session, so
 * a developer can never widen the query to someone else.
 *
 * The [from, to] window is the same inclusive YYYY-MM-DD pair the manager
 * endpoints feed into `date >= ? AND date <= ?`, produced by the shared
 * `parseTimeRange` helper — so range behaviour is identical to the manager side.
 */

export type TrendDirection = 'up' | 'down' | 'flat';

export interface MeOverview {
    active_days: number;
    primary_tools: string[];
    acceptance_rate: {
        current: number | null;
        previous: number | null;
        trend: TrendDirection;
    };
    estimated_monthly_cost: number;
}

export interface MeToolBreakdown {
    tool: string;
    active_days: number;
    interactions: number;
    acceptances: number;
    acceptance_rate: number | null;
    features_used: string[];
    estimated_monthly_cost: number;
}

export interface MeProviderActivity {
    provider: string;
    commits: number;
    lines_added: number;
    lines_removed: number;
    files_changed: number;
    prs_opened: number;
    prs_merged: number;
}

export interface MeActivity {
    totals: {
        commits: number;
        lines_added: number;
        lines_removed: number;
        files_changed: number;
        prs_opened: number;
        prs_merged: number;
        avg_churn_rate: number | null;
    };
    providers: MeProviderActivity[];
}

/**
 * Earliest date with any activity (tool or git) for a developer, used to resolve
 * the "lifetime" range exactly as the manager endpoints resolve theirs.
 */
export function earliestDeveloperDate(db: Database.Database, developerId: string): string | null {
    const row = db
        .prepare(
            `SELECT MIN(d) AS earliest FROM (
               SELECT MIN(date) AS d FROM tool_snapshots WHERE developer_id = ?
               UNION ALL
               SELECT MIN(date) AS d FROM git_snapshots WHERE developer_id = ?
             ) WHERE d IS NOT NULL`,
        )
        .get(developerId, developerId) as {earliest: string | null};
    return row.earliest;
}

/** Midpoint date (YYYY-MM-DD) of the inclusive [from, to] window. */
function midpoint(from: string, to: string): string {
    const fromMs = Date.parse(`${from}T00:00:00.000Z`);
    const toMs = Date.parse(`${to}T00:00:00.000Z`);
    const midMs = fromMs + Math.floor((toMs - fromMs) / 2);
    return new Date(midMs).toISOString().slice(0, 10);
}

/** Add `days` to a YYYY-MM-DD date, returning YYYY-MM-DD. */
function addDays(date: string, days: number): string {
    const ms = Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000;
    return new Date(ms).toISOString().slice(0, 10);
}

function aggregateAcceptanceRate(
    db: Database.Database,
    developerId: string,
    from: string,
    to: string,
): number | null {
    const row = db
        .prepare(
            `SELECT COALESCE(SUM(interaction_count), 0) AS interactions,
                    COALESCE(SUM(acceptance_count), 0) AS acceptances
             FROM tool_snapshots
             WHERE developer_id = ? AND date >= ? AND date <= ?`,
        )
        .get(developerId, from, to) as {interactions: number; acceptances: number};
    if (row.interactions <= 0) {
        return null;
    }
    return row.acceptances / row.interactions;
}

/**
 * Personal stat summary: active days, the tools used most, the direction the
 * acceptance rate is trending (first half of the range vs second half), and the
 * developer's estimated monthly cost from their active subscriptions.
 */
export function getMeOverview(
    db: Database.Database,
    developerId: string,
    from: string,
    to: string,
): MeOverview {
    // A day counts as active if there was tool activity or git activity on it.
    const activeDays = (
        db
            .prepare(
                `SELECT COUNT(*) AS cnt FROM (
                   SELECT date FROM tool_snapshots
                     WHERE developer_id = ? AND is_active = 1 AND date >= ? AND date <= ?
                   UNION
                   SELECT date FROM git_snapshots
                     WHERE developer_id = ? AND commits > 0 AND date >= ? AND date <= ?
                 )`,
            )
            .get(developerId, from, to, developerId, from, to) as {cnt: number}
    ).cnt;

    const primaryTools = (
        db
            .prepare(
                `SELECT tool, COALESCE(SUM(interaction_count), 0) AS interactions
                 FROM tool_snapshots
                 WHERE developer_id = ? AND is_active = 1 AND date >= ? AND date <= ?
                 GROUP BY tool
                 HAVING interactions > 0
                 ORDER BY interactions DESC, tool`,
            )
            .all(developerId, from, to) as {tool: string; interactions: number}[]
    ).map((r) => r.tool);

    // Split the window into two DISJOINT halves so the midpoint day is never
    // counted in both: the first half is [from, mid], the second is the day
    // after mid through to. When the window is too short to have a distinct
    // second half (a single day), there is no trend to compute, so both halves
    // resolve to the same value and the direction reads 'flat'.
    const mid = midpoint(from, to);
    const secondHalfStart = addDays(mid, 1);
    const previous = aggregateAcceptanceRate(db, developerId, from, mid);
    const current =
        secondHalfStart > to ? previous : aggregateAcceptanceRate(db, developerId, secondHalfStart, to);

    let trend: TrendDirection = 'flat';
    if (current !== null && previous !== null) {
        const delta = current - previous;
        // 0.5pp dead-band so floating-point noise doesn't read as a real move.
        if (delta > 0.005) trend = 'up';
        else if (delta < -0.005) trend = 'down';
    } else if (current !== null && previous === null) {
        trend = 'up';
    } else if (current === null && previous !== null) {
        trend = 'down';
    }

    const estimatedCost = (
        db
            .prepare(
                `SELECT COALESCE(SUM(monthly_cost), 0) AS cost
                 FROM subscriptions
                 WHERE developer_id = ? AND seat_revoked_at IS NULL`,
            )
            .get(developerId) as {cost: number}
    ).cost;

    return {
        active_days: activeDays,
        primary_tools: primaryTools,
        acceptance_rate: {current, previous, trend},
        estimated_monthly_cost: estimatedCost,
    };
}

/**
 * Stored features_used is a JSON array string (written by the connectors as
 * JSON.stringify(string[])). Parse it back to a string array; any row that is
 * absent, unparseable, or not an array of strings contributes no features
 * rather than throwing.
 */
function parseFeatures(raw: string | null): string[] {
    if (!raw) {
        return [];
    }
    try {
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
        return [];
    }
}

/**
 * Per-tool breakdown for the developer: activity, acceptance rate, the union of
 * features touched, and the monthly cost of the matching active subscription.
 */
export function getMeTools(
    db: Database.Database,
    developerId: string,
    from: string,
    to: string,
): MeToolBreakdown[] {
    const rows = db
        .prepare(
            `SELECT tool,
                    COUNT(DISTINCT CASE WHEN is_active = 1 THEN date END) AS active_days,
                    COALESCE(SUM(interaction_count), 0) AS interactions,
                    COALESCE(SUM(acceptance_count), 0) AS acceptances
             FROM tool_snapshots
             WHERE developer_id = ? AND date >= ? AND date <= ?
             GROUP BY tool
             ORDER BY interactions DESC, tool`,
        )
        .all(developerId, from, to) as {
        tool: string;
        active_days: number;
        interactions: number;
        acceptances: number;
    }[];

    // Per-tool active subscription cost, summed so multiple seats on one tool
    // are reflected. Revoked seats are excluded.
    const costRows = db
        .prepare(
            `SELECT tool, COALESCE(SUM(monthly_cost), 0) AS cost
             FROM subscriptions
             WHERE developer_id = ? AND seat_revoked_at IS NULL
             GROUP BY tool`,
        )
        .all(developerId) as {tool: string; cost: number}[];
    const costByTool = new Map(costRows.map((r) => [r.tool, r.cost]));

    // Feature union per tool over the window.
    const featureRows = db
        .prepare(
            `SELECT tool, features_used
             FROM tool_snapshots
             WHERE developer_id = ? AND date >= ? AND date <= ? AND features_used IS NOT NULL`,
        )
        .all(developerId, from, to) as {tool: string; features_used: string | null}[];
    const featuresByTool = new Map<string, Set<string>>();
    for (const r of featureRows) {
        const set = featuresByTool.get(r.tool) ?? new Set<string>();
        for (const f of parseFeatures(r.features_used)) {
            set.add(f);
        }
        featuresByTool.set(r.tool, set);
    }

    return rows.map((r) => ({
        tool: r.tool,
        active_days: r.active_days,
        interactions: r.interactions,
        acceptances: r.acceptances,
        acceptance_rate: r.interactions > 0 ? r.acceptances / r.interactions : null,
        features_used: Array.from(featuresByTool.get(r.tool) ?? []).sort(),
        estimated_monthly_cost: costByTool.get(r.tool) ?? 0,
    }));
}

/**
 * Personal git activity over the window. `totals` are summed across every git
 * provider and are the authoritative unified numbers the developer view shows.
 *
 * The `providers` breakdown groups by the snapshot's `data_source`. Because git
 * snapshots are merged per developer per day at sync time (one row per dev/day,
 * UNIQUE(developer_id, date)), a day on which the developer was active on more
 * than one provider is stored as a single row tagged `data_source = 'multi'` —
 * so that day appears under a `'multi'` bucket here rather than split back into
 * its constituent providers (the per-provider split is not recoverable from the
 * merged row). The breakdown therefore reflects how the data is stored, while
 * `totals` always reflect the true cross-provider sum.
 *
 * Note `totals.avg_churn_rate` is a rough indicator only: it is an unweighted
 * mean of the per-day churn ratios (a 2-line day counts the same as a 2000-line
 * day), days with no churn value are excluded, and a cross-provider day's churn
 * is itself an approximation from the sync-time merge. Use it as a trend hint,
 * not an exact figure — the count fields above are the authoritative numbers.
 */
export function getMeActivity(
    db: Database.Database,
    developerId: string,
    from: string,
    to: string,
): MeActivity {
    const totalsRow = db
        .prepare(
            `SELECT COALESCE(SUM(commits), 0) AS commits,
                    COALESCE(SUM(lines_added), 0) AS lines_added,
                    COALESCE(SUM(lines_removed), 0) AS lines_removed,
                    COALESCE(SUM(files_changed), 0) AS files_changed,
                    COALESCE(SUM(prs_opened), 0) AS prs_opened,
                    COALESCE(SUM(prs_merged), 0) AS prs_merged,
                    AVG(code_churn_rate) AS avg_churn_rate
             FROM git_snapshots
             WHERE developer_id = ? AND date >= ? AND date <= ?`,
        )
        .get(developerId, from, to) as {
        commits: number;
        lines_added: number;
        lines_removed: number;
        files_changed: number;
        prs_opened: number;
        prs_merged: number;
        avg_churn_rate: number | null;
    };

    const providers = db
        .prepare(
            `SELECT COALESCE(data_source, 'git') AS provider,
                    COALESCE(SUM(commits), 0) AS commits,
                    COALESCE(SUM(lines_added), 0) AS lines_added,
                    COALESCE(SUM(lines_removed), 0) AS lines_removed,
                    COALESCE(SUM(files_changed), 0) AS files_changed,
                    COALESCE(SUM(prs_opened), 0) AS prs_opened,
                    COALESCE(SUM(prs_merged), 0) AS prs_merged
             FROM git_snapshots
             WHERE developer_id = ? AND date >= ? AND date <= ?
             GROUP BY COALESCE(data_source, 'git')
             ORDER BY provider`,
        )
        .all(developerId, from, to) as MeProviderActivity[];

    return {
        totals: {
            commits: totalsRow.commits,
            lines_added: totalsRow.lines_added,
            lines_removed: totalsRow.lines_removed,
            files_changed: totalsRow.files_changed,
            prs_opened: totalsRow.prs_opened,
            prs_merged: totalsRow.prs_merged,
            avg_churn_rate: totalsRow.avg_churn_rate,
        },
        providers,
    };
}

// The personal activity timeline is the manager timeline scoped to a session-
// resolved id and bounded by the shared range parser, so /api/me/timeline calls
// getDeveloperTimelineWindow directly rather than wrapping it here.

/** A milestone on the developer's adoption journey. */
export type MeJourneyEventType = 'started' | 'plan_change' | 'tool_switch';

export interface MeJourneyTool {
    tool: string;
    /** When the developer first used this tool (earliest activity or seat) — YYYY-MM-DD. */
    started_on: string | null;
    /** Most recent day the developer was active on this tool — YYYY-MM-DD. */
    last_active_on: string | null;
    /** Plan of the current (non-revoked) subscription, if any. */
    current_plan: string | null;
    /** Monthly cost of the current (non-revoked) subscription, if any. */
    current_monthly_cost: number | null;
    /** Whether the developer holds a live (non-revoked) seat for this tool. */
    active: boolean;
}

export interface MeJourneyEvent {
    /** Day the milestone happened — YYYY-MM-DD. */
    date: string;
    type: MeJourneyEventType;
    /** The tool the event concerns (the new tool, for a switch). */
    tool: string;
    /** The tool moved away from, on a tool switch; null otherwise. */
    from_tool: string | null;
    from_plan: string | null;
    to_plan: string | null;
    old_monthly_cost: number | null;
    new_monthly_cost: number | null;
}

/**
 * Per-tool current status plus the chronological list of "started"/plan-change/
 * tool-switch milestones. From `developer.id`.
 */
export interface MeJourney {
    tools: MeJourneyTool[];
    events: MeJourneyEvent[];
}

/** Date portion (YYYY-MM-DD) of a stored timestamp, or null. */
function dateOf(value: string | null): string | null {
    return value ? value.slice(0, 10) : null;
}

/** The earlier of two YYYY-MM-DD dates, ignoring nulls (lexical = chronological). */
function earliestDate(a: string | null, b: string | null): string | null {
    if (a === null) return b;
    if (b === null) return a;
    return a <= b ? a : b;
}

/**
 * The developer's adoption journey: when they started each tool, the current
 * plan/cost per tool, and a chronological list of lifecycle milestones (first
 * use, plan upgrades/downgrades, tool switches). This is the growth-story data
 * behind the "My adoption journey" view — never a comparison to anyone else.
 *
 * Start dates are taken from the full activity history (no recency cutoff) and
 * the earliest seat assignment, so "when I started" reflects the true first
 * touch even for a tool whose snapshots predate the detail view's one-year
 * window. Plan/tool transitions come from `plan_change_events`, the same
 * lifecycle record the manager ROI feature reads.
 */
export function getMeJourney(db: Database.Database, developerId: string): MeJourney {
    // first_active/last_active are gated on is_active = 1 so "started using" means
    // the first day of real engagement, not the first snapshot row — connectors
    // also write is_active = 0 rows for seat-but-no-usage days, and counting those
    // would contradict the is_active semantics getMeOverview uses for active_days.
    const activityRows = db
        .prepare(
            `SELECT tool,
                    MIN(CASE WHEN is_active = 1 THEN date END) AS first_active,
                    MAX(CASE WHEN is_active = 1 THEN date END) AS last_active
             FROM tool_snapshots
             WHERE developer_id = ?
             GROUP BY tool`,
        )
        .all(developerId) as {tool: string; first_active: string | null; last_active: string | null}[];

    const subscriptionRows = db
        .prepare(
            `SELECT tool, plan, monthly_cost, seat_assigned_at, seat_revoked_at
             FROM subscriptions
             WHERE developer_id = ?
             ORDER BY seat_assigned_at`,
        )
        .all(developerId) as {
        tool: string;
        plan: string | null;
        monthly_cost: number | null;
        seat_assigned_at: string | null;
        seat_revoked_at: string | null;
    }[];

    const tools = new Map<string, MeJourneyTool>();
    const ensureTool = (tool: string): MeJourneyTool => {
        let entry = tools.get(tool);
        if (!entry) {
            entry = {
                tool,
                started_on: null,
                last_active_on: null,
                current_plan: null,
                current_monthly_cost: null,
                active: false,
            };
            tools.set(tool, entry);
        }
        return entry;
    };

    // One row per tool (GROUP BY tool), so a direct assign is exact; first_active
    // and last_active are null for a tool seen only on inactive days.
    for (const row of activityRows) {
        const entry = ensureTool(row.tool);
        entry.started_on = earliestDate(entry.started_on, row.first_active);
        entry.last_active_on = row.last_active;
    }

    // Subscriptions are ordered by seat_assigned_at, so the last non-revoked row
    // we see for a tool is its current seat (latest assignment wins).
    for (const sub of subscriptionRows) {
        const entry = ensureTool(sub.tool);
        entry.started_on = earliestDate(entry.started_on, dateOf(sub.seat_assigned_at));
        if (sub.seat_revoked_at === null) {
            entry.active = true;
            entry.current_plan = sub.plan;
            entry.current_monthly_cost = sub.monthly_cost;
        }
    }

    const planChanges = getDeveloperPlanChanges(db, developerId);

    const events: MeJourneyEvent[] = [];
    for (const entry of tools.values()) {
        if (entry.started_on) {
            events.push({
                date: entry.started_on,
                type: 'started',
                tool: entry.tool,
                from_tool: null,
                from_plan: null,
                to_plan: null,
                old_monthly_cost: null,
                new_monthly_cost: null,
            });
        }
    }
    for (const change of planChanges) {
        const isSwitch = change.old_tool !== null && change.old_tool !== change.tool;
        events.push({
            date: dateOf(change.changed_at) ?? change.changed_at,
            type: isSwitch ? 'tool_switch' : 'plan_change',
            tool: change.tool,
            from_tool: change.old_tool,
            from_plan: change.old_plan,
            to_plan: change.new_plan,
            old_monthly_cost: change.old_monthly_cost,
            new_monthly_cost: change.new_monthly_cost,
        });
    }

    // Chronological, with a stable tie-break so equal-dated milestones don't
    // reorder between requests (started before transitions on the same day).
    const typeRank: Record<MeJourneyEventType, number> = {started: 0, plan_change: 1, tool_switch: 1};
    events.sort(
        (a, b) =>
            a.date.localeCompare(b.date) || typeRank[a.type] - typeRank[b.type] || a.tool.localeCompare(b.tool),
    );

    const toolList = Array.from(tools.values()).sort((a, b) => {
        // Earliest-started first; tools without a start date sort last by name.
        if (a.started_on && b.started_on) return a.started_on.localeCompare(b.started_on) || a.tool.localeCompare(b.tool);
        if (a.started_on) return -1;
        if (b.started_on) return 1;
        return a.tool.localeCompare(b.tool);
    });

    return {tools: toolList, events};
}
