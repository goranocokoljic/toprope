import Database from 'better-sqlite3';
import {randomUUID} from 'crypto';

export interface WasteDetectorConfig {
    inactivity_threshold_days?: number;
    underutilized_threshold_pct?: number;
    cost_outlier_multiplier?: number;
    lookback_days?: number;
}

export interface WasteAlert {
    id: string;
    developer_id: string | null;
    developer_name: string | null;
    team: string;
    alert_type: string;
    tool: string | null;
    details: Record<string, unknown>;
    monthly_waste: number | null;
    detected_at: string;
    resolved_at: string | null;
    resolution: string | null;
}

export interface WasteTeamSummary {
    team: string;
    alert_count: number;
    total_monthly_waste: number;
    alerts_by_type: Record<string, number>;
}

export interface WasteRunResult {
    created: number;
    skipped: number;
}

interface WasteCondition {
    developer_id: string | null;
    team: string;
    alert_type: string;
    tool: string | null;
    details: Record<string, unknown>;
    monthly_waste: number | null;
}

const TOOL_CATEGORIES: Record<string, string> = {
    copilot: 'ide_assistant',
    cursor: 'ide_assistant',
    windsurf: 'ide_assistant',
    codeium: 'ide_assistant',
    tabnine: 'ide_assistant',
    claude_code: 'ai_agent',
    codex: 'ai_agent',
    aider: 'ai_agent',
};

export function runWasteDetection(
    db: Database.Database,
    config?: WasteDetectorConfig,
): WasteRunResult {
    const inactivityThreshold = config?.inactivity_threshold_days ?? 14;
    const underutilizedThreshold = config?.underutilized_threshold_pct ?? 20;
    const costOutlierMultiplier = config?.cost_outlier_multiplier ?? 3;
    const lookbackDays = config?.lookback_days ?? 30;

    const conditions: WasteCondition[] = [
        ...findUnusedSeats(db, inactivityThreshold),
        ...findUnderutilized(db, underutilizedThreshold, lookbackDays),
        ...findDuplicateTools(db),
        ...findCostOutliers(db, costOutlierMultiplier, lookbackDays),
    ];

    let created = 0;
    let skipped = 0;
    const now = new Date().toISOString();

    const checkExisting = db.prepare(
        `SELECT 1 FROM waste_alerts
         WHERE developer_id IS ? AND alert_type = ? AND tool IS ?
         LIMIT 1`,
    );

    const insert = db.prepare(
        `INSERT INTO waste_alerts (id, developer_id, team, alert_type, tool, details, monthly_waste, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const condition of conditions) {
        const existing = checkExisting.get(
            condition.developer_id,
            condition.alert_type,
            condition.tool,
        );

        if (existing) {
            skipped++;
            continue;
        }

        insert.run(
            randomUUID(),
            condition.developer_id,
            condition.team,
            condition.alert_type,
            condition.tool,
            JSON.stringify(condition.details),
            condition.monthly_waste,
            now,
        );
        created++;
    }

    return {created, skipped};
}

function findUnusedSeats(db: Database.Database, thresholdDays: number): WasteCondition[] {
    const rows = db
        .prepare(
            `SELECT s.developer_id, d.name as developer_name, d.team, s.tool, s.monthly_cost
             FROM subscriptions s
             JOIN developers d ON d.id = s.developer_id
             WHERE s.seat_revoked_at IS NULL
               AND NOT EXISTS (
                   SELECT 1 FROM tool_snapshots ts
                   WHERE ts.developer_id = s.developer_id
                     AND ts.tool = s.tool
                     AND ts.is_active = 1
                     AND ts.date >= date('now', '-' || ? || ' days')
               )`,
        )
        .all(thresholdDays) as {
        developer_id: string;
        developer_name: string;
        team: string;
        tool: string;
        monthly_cost: number | null;
    }[];

    return rows.map((row) => ({
        developer_id: row.developer_id,
        team: row.team,
        alert_type: 'unused_seat',
        tool: row.tool,
        details: {
            developer_name: row.developer_name,
            inactivity_days: thresholdDays,
            tool: row.tool,
        },
        monthly_waste: row.monthly_cost,
    }));
}

function findUnderutilized(
    db: Database.Database,
    thresholdPct: number,
    lookbackDays: number,
): WasteCondition[] {
    const devStats = db
        .prepare(
            `SELECT ts.developer_id, d.name as developer_name, d.team, ts.tool,
                    AVG(ts.interaction_count) as avg_interactions
             FROM tool_snapshots ts
             JOIN developers d ON d.id = ts.developer_id
             WHERE ts.date >= date('now', '-' || ? || ' days')
               AND ts.is_active = 1
             GROUP BY ts.developer_id, ts.tool`,
        )
        .all(lookbackDays) as {
        developer_id: string;
        developer_name: string;
        team: string;
        tool: string;
        avg_interactions: number;
    }[];

    const teamStats = db
        .prepare(
            `SELECT d.team, ts.tool,
                    AVG(ts.interaction_count) as team_avg_interactions
             FROM tool_snapshots ts
             JOIN developers d ON d.id = ts.developer_id
             WHERE ts.date >= date('now', '-' || ? || ' days')
               AND ts.is_active = 1
             GROUP BY d.team, ts.tool`,
        )
        .all(lookbackDays) as {
        team: string;
        tool: string;
        team_avg_interactions: number;
    }[];

    const teamAvgMap = new Map<string, number>();
    for (const row of teamStats) {
        teamAvgMap.set(`${row.team}:${row.tool}`, row.team_avg_interactions);
    }

    const subCosts = db
        .prepare(
            `SELECT developer_id, tool, monthly_cost
             FROM subscriptions
             WHERE seat_revoked_at IS NULL AND monthly_cost IS NOT NULL`,
        )
        .all() as {developer_id: string; tool: string; monthly_cost: number}[];

    const subCostMap = new Map<string, number>();
    for (const sub of subCosts) {
        subCostMap.set(`${sub.developer_id}:${sub.tool}`, sub.monthly_cost);
    }

    const conditions: WasteCondition[] = [];

    for (const dev of devStats) {
        const teamAvg = teamAvgMap.get(`${dev.team}:${dev.tool}`);
        if (!teamAvg || teamAvg === 0) continue;

        const monthlyCost = subCostMap.get(`${dev.developer_id}:${dev.tool}`);
        if (monthlyCost == null) continue;

        const usagePct = (dev.avg_interactions / teamAvg) * 100;
        if (usagePct < thresholdPct) {
            conditions.push({
                developer_id: dev.developer_id,
                team: dev.team,
                alert_type: 'underutilized',
                tool: dev.tool,
                details: {
                    developer_name: dev.developer_name,
                    avg_interactions: Math.round(dev.avg_interactions * 10) / 10,
                    team_avg_interactions: Math.round(teamAvg * 10) / 10,
                    usage_pct: Math.round(usagePct * 10) / 10,
                    threshold_pct: thresholdPct,
                    lookback_days: lookbackDays,
                },
                monthly_waste: monthlyCost,
            });
        }
    }

    return conditions;
}

function findDuplicateTools(db: Database.Database): WasteCondition[] {
    const subscriptions = db
        .prepare(
            `SELECT s.developer_id, d.name as developer_name, d.team, s.tool, s.monthly_cost
             FROM subscriptions s
             JOIN developers d ON d.id = s.developer_id
             WHERE s.seat_revoked_at IS NULL`,
        )
        .all() as {
        developer_id: string;
        developer_name: string;
        team: string;
        tool: string;
        monthly_cost: number | null;
    }[];

    const byDeveloper = new Map<string, typeof subscriptions>();
    for (const sub of subscriptions) {
        const list = byDeveloper.get(sub.developer_id) ?? [];
        list.push(sub);
        byDeveloper.set(sub.developer_id, list);
    }

    const conditions: WasteCondition[] = [];

    for (const subs of byDeveloper.values()) {
        if (subs.length < 2) continue;

        const byCategory = new Map<string, typeof subs>();
        for (const sub of subs) {
            const category = TOOL_CATEGORIES[sub.tool.toLowerCase()];
            if (!category) continue;
            const list = byCategory.get(category) ?? [];
            list.push(sub);
            byCategory.set(category, list);
        }

        for (const [category, catSubs] of byCategory) {
            if (catSubs.length < 2) continue;

            const first = catSubs[0];
            const costs = catSubs.map((s) => s.monthly_cost ?? 0).sort((a, b) => b - a);
            const wastedCost = costs.slice(1).reduce((sum, c) => sum + c, 0);

            conditions.push({
                developer_id: first.developer_id,
                team: first.team,
                alert_type: 'duplicate_tool',
                tool: category,
                details: {
                    developer_name: first.developer_name,
                    category,
                    tools: catSubs.map((s) => ({tool: s.tool, monthly_cost: s.monthly_cost})),
                    note: 'Review needed — developer may have reasons for multiple tools',
                },
                monthly_waste: wastedCost > 0 ? wastedCost : null,
            });
        }
    }

    return conditions;
}

function findCostOutliers(
    db: Database.Database,
    multiplier: number,
    lookbackDays: number,
): WasteCondition[] {
    const devPrs = db
        .prepare(
            `SELECT gs.developer_id, d.name as developer_name, d.team,
                    SUM(gs.prs_merged) as total_prs
             FROM git_snapshots gs
             JOIN developers d ON d.id = gs.developer_id
             WHERE gs.date >= date('now', '-' || ? || ' days')
             GROUP BY gs.developer_id`,
        )
        .all(lookbackDays) as {
        developer_id: string;
        developer_name: string;
        team: string;
        total_prs: number;
    }[];

    const devCosts = db
        .prepare(
            `SELECT developer_id, SUM(monthly_cost) as total_monthly_cost
             FROM subscriptions
             WHERE seat_revoked_at IS NULL AND monthly_cost IS NOT NULL
             GROUP BY developer_id`,
        )
        .all() as {developer_id: string; total_monthly_cost: number}[];

    const costMap = new Map<string, number>();
    for (const c of devCosts) {
        costMap.set(c.developer_id, c.total_monthly_cost);
    }

    interface DevMetric {
        developer_id: string;
        developer_name: string;
        team: string;
        cost_per_pr: number;
        monthly_cost: number;
        prs_per_month: number;
    }

    const metrics: DevMetric[] = [];
    for (const dev of devPrs) {
        const monthlyCost = costMap.get(dev.developer_id);
        if (!monthlyCost || monthlyCost === 0) continue;
        const prsPerMonth = dev.total_prs / (lookbackDays / 30);
        if (prsPerMonth === 0) continue;
        metrics.push({
            developer_id: dev.developer_id,
            developer_name: dev.developer_name,
            team: dev.team,
            cost_per_pr: monthlyCost / prsPerMonth,
            monthly_cost: monthlyCost,
            prs_per_month: prsPerMonth,
        });
    }

    const teamMap = new Map<string, DevMetric[]>();
    for (const m of metrics) {
        const list = teamMap.get(m.team) ?? [];
        list.push(m);
        teamMap.set(m.team, list);
    }

    const conditions: WasteCondition[] = [];

    for (const teamDevs of teamMap.values()) {
        if (teamDevs.length < 2) continue;

        const teamAvg = teamDevs.reduce((sum, d) => sum + d.cost_per_pr, 0) / teamDevs.length;

        for (const dev of teamDevs) {
            if (dev.cost_per_pr > multiplier * teamAvg) {
                conditions.push({
                    developer_id: dev.developer_id,
                    team: dev.team,
                    alert_type: 'cost_outlier',
                    tool: null,
                    details: {
                        developer_name: dev.developer_name,
                        cost_per_pr: Math.round(dev.cost_per_pr * 100) / 100,
                        team_avg_cost_per_pr: Math.round(teamAvg * 100) / 100,
                        multiplier_detected: Math.round((dev.cost_per_pr / teamAvg) * 10) / 10,
                        monthly_cost: dev.monthly_cost,
                        prs_per_month: Math.round(dev.prs_per_month * 10) / 10,
                        lookback_days: lookbackDays,
                    },
                    monthly_waste: null,
                });
            }
        }
    }

    return conditions;
}

export function listActiveAlerts(db: Database.Database): WasteAlert[] {
    const rows = db
        .prepare(
            `SELECT wa.id, wa.developer_id, d.name as developer_name, wa.team,
                    wa.alert_type, wa.tool, wa.details, wa.monthly_waste,
                    wa.detected_at, wa.resolved_at, wa.resolution
             FROM waste_alerts wa
             LEFT JOIN developers d ON d.id = wa.developer_id
             WHERE wa.resolved_at IS NULL
             ORDER BY wa.detected_at DESC`,
        )
        .all() as {
        id: string;
        developer_id: string | null;
        developer_name: string | null;
        team: string;
        alert_type: string;
        tool: string | null;
        details: string;
        monthly_waste: number | null;
        detected_at: string;
        resolved_at: string | null;
        resolution: string | null;
    }[];

    return rows.map((row) => ({
        id: row.id,
        developer_id: row.developer_id,
        developer_name: row.developer_name,
        team: row.team,
        alert_type: row.alert_type,
        tool: row.tool,
        details: parseJsonSafe(row.details),
        monthly_waste: row.monthly_waste,
        detected_at: row.detected_at,
        resolved_at: row.resolved_at,
        resolution: row.resolution,
    }));
}

export function getWasteSummaryByTeam(db: Database.Database): WasteTeamSummary[] {
    const rows = db
        .prepare(
            `SELECT team, COUNT(*) as alert_count,
                    COALESCE(SUM(monthly_waste), 0) as total_monthly_waste,
                    GROUP_CONCAT(alert_type) as alert_types_raw
             FROM waste_alerts
             WHERE resolved_at IS NULL
             GROUP BY team
             ORDER BY total_monthly_waste DESC`,
        )
        .all() as {
        team: string;
        alert_count: number;
        total_monthly_waste: number;
        alert_types_raw: string | null;
    }[];

    return rows.map((row) => {
        const alertsByType: Record<string, number> = {};
        if (row.alert_types_raw) {
            for (const type of row.alert_types_raw.split(',')) {
                alertsByType[type] = (alertsByType[type] ?? 0) + 1;
            }
        }
        return {
            team: row.team,
            alert_count: row.alert_count,
            total_monthly_waste: row.total_monthly_waste,
            alerts_by_type: alertsByType,
        };
    });
}

export function resolveAlert(
    db: Database.Database,
    alertId: string,
    reason: string,
): boolean {
    const now = new Date().toISOString();
    const result = db
        .prepare(
            `UPDATE waste_alerts SET resolved_at = ?, resolution = ?
             WHERE id = ? AND resolved_at IS NULL`,
        )
        .run(now, reason, alertId);
    return result.changes > 0;
}

function parseJsonSafe(value: string): Record<string, unknown> {
    try {
        return JSON.parse(value) as Record<string, unknown>;
    } catch {
        return {raw: value};
    }
}
