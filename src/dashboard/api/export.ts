import type {FastifyInstance, FastifyReply} from 'fastify';
import type Database from 'better-sqlite3';

interface ExportRow {
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
    subscription_monthly_cost: number | null;
}

export function registerExportRoutes(app: FastifyInstance, db: Database.Database): void {
    app.get<{Querystring: {format?: string; from?: string; to?: string; team?: string}}>(
        '/api/export',
        async (request, reply) => {
            const {format = 'json', from, to, team} = request.query;

            let sql = `
                SELECT ts.developer_id, d.name as developer_name, d.team,
                       ts.tool, ts.date, ts.data_quality, ts.is_active,
                       ts.interaction_count, ts.acceptance_count, ts.acceptance_rate,
                       ts.estimated_cost,
                       s.monthly_cost as subscription_monthly_cost
                FROM tool_snapshots ts
                JOIN developers d ON d.id = ts.developer_id
                LEFT JOIN (
                    SELECT developer_id, tool, MAX(monthly_cost) as monthly_cost
                    FROM subscriptions
                    WHERE seat_revoked_at IS NULL
                    GROUP BY developer_id, tool
                ) s ON s.developer_id = ts.developer_id AND s.tool = ts.tool
                WHERE 1=1`;

            const params: unknown[] = [];

            if (from) {
                sql += ' AND ts.date >= ?';
                params.push(from);
            }

            if (to) {
                sql += ' AND ts.date <= ?';
                params.push(to);
            }

            if (team) {
                sql += ' AND d.team = ?';
                params.push(team);
            }

            const EXPORT_LIMIT = 50000;
            sql += ` ORDER BY ts.date, d.name, ts.tool LIMIT ${EXPORT_LIMIT + 1}`;

            const allRows = db.prepare(sql).all(...params) as ExportRow[];
            const truncated = allRows.length > EXPORT_LIMIT;
            const rows = truncated ? allRows.slice(0, EXPORT_LIMIT) : allRows;

            if (format === 'csv') {
                return sendCsv(reply, rows, truncated);
            }

            return reply.send({data: rows, total: rows.length, truncated});
        },
    );
}

function sendCsv(reply: FastifyReply, rows: ExportRow[], truncated: boolean): FastifyReply {
    const headers = [
        'developer_id',
        'developer_name',
        'team',
        'tool',
        'date',
        'data_quality',
        'is_active',
        'interaction_count',
        'acceptance_count',
        'acceptance_rate',
        'estimated_cost',
        'subscription_monthly_cost',
    ];

    const lines = [headers.join(',')];
    for (const row of rows) {
        lines.push(
            [
                csvEscape(row.developer_id),
                csvEscape(row.developer_name),
                csvEscape(row.team),
                csvEscape(row.tool),
                csvEscape(row.date),
                csvEscape(row.data_quality),
                String(row.is_active),
                row.interaction_count ?? '',
                row.acceptance_count ?? '',
                row.acceptance_rate ?? '',
                row.estimated_cost ?? '',
                row.subscription_monthly_cost ?? '',
            ].join(','),
        );
    }

    void reply.header('Content-Type', 'text/csv; charset=utf-8');
    void reply.header('Content-Disposition', 'attachment; filename="govproxy-export.csv"');
    if (truncated) {
        void reply.header('X-Truncated', 'true');
    }
    return reply.send(lines.join('\r\n'));
}

function csvEscape(value: string | null | undefined): string {
    if (value == null) return '';
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}
