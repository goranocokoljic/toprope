import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {isAdmin, forbidden} from './guards';

interface DistributionRow {
    tool: string;
    seats: number;
    developers: number;
    monthly_cost: number;
}

export function registerToolsRoutes(app: FastifyInstance, db: Database.Database): void {
    // Seats and cost per tool across the org. An active seat is a subscription
    // that has not been revoked (seat_revoked_at IS NULL).
    app.get('/api/tools/distribution', async (request, reply) => {
        if (!isAdmin(request)) {
            return forbidden(reply);
        }

        const tools = db
            .prepare(
                `SELECT tool,
                        COUNT(*) AS seats,
                        COUNT(DISTINCT developer_id) AS developers,
                        COALESCE(SUM(monthly_cost), 0) AS monthly_cost
                 FROM subscriptions
                 WHERE seat_revoked_at IS NULL
                 GROUP BY tool
                 ORDER BY tool`,
            )
            .all() as DistributionRow[];

        return {
            data: {
                tools,
                total_seats: tools.reduce((sum, t) => sum + t.seats, 0),
                total_monthly_cost: tools.reduce((sum, t) => sum + t.monthly_cost, 0),
            },
        };
    });
}
