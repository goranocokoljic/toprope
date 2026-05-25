import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {parsePagination, buildPaginatedResponse} from './types';

interface SnapshotRow {
    developer_id: string;
    developer_name: string;
    team: string;
    tool: string;
    date: string;
    data_quality: string;
    is_active: number;
    interaction_count: number | null;
    acceptance_count: number | null;
    acceptance_rate: number | null;
    estimated_cost: number | null;
    tokens_consumed: number | null;
}

export function registerSnapshotRoutes(app: FastifyInstance, db: Database.Database): void {
    app.get<{Querystring: {date?: string; team?: string; page?: string; limit?: string}}>(
        '/api/snapshots',
        async (request) => {
            const {date, team} = request.query;
            const pagination = parsePagination(request.query as Record<string, unknown>);

            let countSql = `
                SELECT COUNT(*) as cnt
                FROM tool_snapshots ts
                JOIN developers d ON d.id = ts.developer_id
                WHERE 1=1`;

            let dataSql = `
                SELECT ts.developer_id, d.name as developer_name, d.team,
                       ts.tool, ts.date, ts.data_quality, ts.is_active,
                       ts.interaction_count, ts.acceptance_count, ts.acceptance_rate,
                       ts.estimated_cost, ts.tokens_consumed
                FROM tool_snapshots ts
                JOIN developers d ON d.id = ts.developer_id
                WHERE 1=1`;

            const params: unknown[] = [];

            if (date) {
                countSql += ' AND ts.date = ?';
                dataSql += ' AND ts.date = ?';
                params.push(date);
            }

            if (team) {
                countSql += ' AND d.team = ?';
                dataSql += ' AND d.team = ?';
                params.push(team);
            }

            dataSql += ' ORDER BY ts.date DESC, d.name, ts.tool LIMIT ? OFFSET ?';

            const offset = (pagination.page - 1) * pagination.limit;
            const total = (db.prepare(countSql).get(...params) as {cnt: number}).cnt;
            const rows = db.prepare(dataSql).all(...params, pagination.limit, offset) as SnapshotRow[];

            return buildPaginatedResponse(rows, total, pagination);
        },
    );
}
