import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';

interface OverviewData {
    total_developers: number;
    active_developers: number;
    total_subscriptions: number;
    total_monthly_cost: number;
    active_tools: string[];
    data_quality_distribution: {
        high: number;
        medium: number;
        low: number;
        none: number;
    };
    active_waste_alert_count: number;
    total_monthly_waste: number;
}

export function registerOverviewRoutes(app: FastifyInstance, db: Database.Database): void {
    app.get('/api/overview', async () => {
        const totalDevs = (db.prepare('SELECT COUNT(*) as cnt FROM developers').get() as {cnt: number}).cnt;

        const activeCutoff = new Date();
        activeCutoff.setDate(activeCutoff.getDate() - 30);
        const cutoffDate = activeCutoff.toISOString().slice(0, 10);

        const activeDev = (
            db
                .prepare(
                    `SELECT COUNT(DISTINCT developer_id) as cnt FROM tool_snapshots
                     WHERE is_active = 1 AND date >= ?`,
                )
                .get(cutoffDate) as {cnt: number}
        ).cnt;

        const subRow = db
            .prepare(
                `SELECT COUNT(*) as cnt, COALESCE(SUM(monthly_cost), 0) as total_cost
                 FROM subscriptions WHERE seat_revoked_at IS NULL`,
            )
            .get() as {cnt: number; total_cost: number};

        const activeTools = db
            .prepare(
                `SELECT DISTINCT tool FROM tool_snapshots
                 WHERE is_active = 1 AND date >= ?
                 ORDER BY tool`,
            )
            .all(cutoffDate) as {tool: string}[];

        const qualityRows = db
            .prepare(
                `SELECT data_quality, COUNT(*) as cnt
                 FROM tool_snapshots
                 GROUP BY data_quality`,
            )
            .all() as {data_quality: string; cnt: number}[];

        const qualityDist: OverviewData['data_quality_distribution'] = {
            high: 0,
            medium: 0,
            low: 0,
            none: 0,
        };
        for (const row of qualityRows) {
            const key = row.data_quality as keyof typeof qualityDist;
            if (key in qualityDist) {
                qualityDist[key] = row.cnt;
            }
        }

        const wasteRow = db
            .prepare(
                `SELECT COUNT(*) as cnt, COALESCE(SUM(monthly_waste), 0) as total_waste
                 FROM waste_alerts WHERE resolved_at IS NULL`,
            )
            .get() as {cnt: number; total_waste: number};

        const data: OverviewData = {
            total_developers: totalDevs,
            active_developers: activeDev,
            total_subscriptions: subRow.cnt,
            total_monthly_cost: subRow.total_cost,
            active_tools: activeTools.map((r) => r.tool),
            data_quality_distribution: qualityDist,
            active_waste_alert_count: wasteRow.cnt,
            total_monthly_waste: wasteRow.total_waste,
        };

        return {data};
    });
}
