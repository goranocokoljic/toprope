import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {parsePagination, buildPaginatedResponse} from './types';

interface WasteAlert {
    id: string;
    developer_id: string | null;
    developer_name: string | null;
    team: string;
    alert_type: string;
    tool: string | null;
    details: Record<string, unknown>;
    monthly_waste: number | null;
    detected_at: string;
}

interface WasteTeamSummary {
    team: string;
    alert_count: number;
    total_monthly_waste: number;
    alert_types: string[];
}

export function registerWasteRoutes(app: FastifyInstance, db: Database.Database): void {
    app.get<{Querystring: {page?: string; limit?: string; team?: string}}>('/api/waste', async (request) => {
        const pagination = parsePagination(request.query as Record<string, unknown>);
        const {team} = request.query;

        let countSql = `SELECT COUNT(*) as cnt FROM waste_alerts wa WHERE wa.resolved_at IS NULL`;
        let dataSql = `
            SELECT wa.id, wa.developer_id, d.name as developer_name, wa.team,
                   wa.alert_type, wa.tool, wa.details, wa.monthly_waste, wa.detected_at
            FROM waste_alerts wa
            LEFT JOIN developers d ON d.id = wa.developer_id
            WHERE wa.resolved_at IS NULL`;

        const params: unknown[] = [];
        if (team) {
            countSql += ' AND wa.team = ?';
            dataSql += ' AND wa.team = ?';
            params.push(team);
        }

        dataSql += ' ORDER BY wa.detected_at DESC LIMIT ? OFFSET ?';

        const offset = (pagination.page - 1) * pagination.limit;
        const total = (db.prepare(countSql).get(...params) as {cnt: number}).cnt;
        const rows = db
            .prepare(dataSql)
            .all(...params, pagination.limit, offset) as {
            id: string;
            developer_id: string | null;
            developer_name: string | null;
            team: string;
            alert_type: string;
            tool: string | null;
            details: string;
            monthly_waste: number | null;
            detected_at: string;
        }[];

        const alerts: WasteAlert[] = rows.map((row) => ({
            id: row.id,
            developer_id: row.developer_id,
            developer_name: row.developer_name,
            team: row.team,
            alert_type: row.alert_type,
            tool: row.tool,
            details: parseJsonSafe(row.details),
            monthly_waste: row.monthly_waste,
            detected_at: row.detected_at,
        }));

        return buildPaginatedResponse(alerts, total, pagination);
    });

    app.get('/api/waste/summary', async () => {
        const rows = db
            .prepare(
                `SELECT team,
                        COUNT(*) as alert_count,
                        COALESCE(SUM(monthly_waste), 0) as total_monthly_waste,
                        GROUP_CONCAT(DISTINCT alert_type) as alert_types_str
                 FROM waste_alerts
                 WHERE resolved_at IS NULL
                 GROUP BY team
                 ORDER BY total_monthly_waste DESC`,
            )
            .all() as {
            team: string;
            alert_count: number;
            total_monthly_waste: number;
            alert_types_str: string | null;
        }[];

        const summaries: WasteTeamSummary[] = rows.map((row) => ({
            team: row.team,
            alert_count: row.alert_count,
            total_monthly_waste: row.total_monthly_waste,
            alert_types: row.alert_types_str ? row.alert_types_str.split(',') : [],
        }));

        return {data: summaries};
    });
}

function parseJsonSafe(value: string): Record<string, unknown> {
    try {
        return JSON.parse(value) as Record<string, unknown>;
    } catch {
        return {raw: value};
    }
}
