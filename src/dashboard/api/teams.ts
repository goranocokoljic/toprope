import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {parsePagination, buildPaginatedResponse} from './types';

interface TeamSummary {
    name: string;
    department: string | null;
    manager: string | null;
    developer_count: number;
    active_count: number;
    tool_mix: string[];
    total_monthly_cost: number;
    utilization_rate: number;
}

interface DeveloperInTeam {
    id: string;
    name: string;
    email: string | null;
    tools: string[];
    activity_summary: {
        active_days_30d: number;
        total_interactions_30d: number;
    };
    subscription_cost: number;
    has_waste: boolean;
}

interface TeamDetail {
    name: string;
    department: string | null;
    manager: string | null;
    developer_count: number;
    total_monthly_cost: number;
    total_monthly_waste: number;
    developers: DeveloperInTeam[];
}

export function registerTeamRoutes(app: FastifyInstance, db: Database.Database): void {
    app.get<{Querystring: {page?: string; limit?: string}}>('/api/teams', async (request) => {
        const pagination = parsePagination(request.query as Record<string, unknown>);

        const teams = db
            .prepare('SELECT name, department, manager FROM teams ORDER BY name')
            .all() as {name: string; department: string | null; manager: string | null}[];

        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 30);
        const cutoffDate = cutoff.toISOString().slice(0, 10);

        const summaries: TeamSummary[] = teams.map((team) => {
            const devCount = (
                db
                    .prepare('SELECT COUNT(*) as cnt FROM developers WHERE team = ?')
                    .get(team.name) as {cnt: number}
            ).cnt;

            const activeCount = (
                db
                    .prepare(
                        `SELECT COUNT(DISTINCT ts.developer_id) as cnt
                         FROM tool_snapshots ts
                         JOIN developers d ON d.id = ts.developer_id
                         WHERE d.team = ? AND ts.is_active = 1 AND ts.date >= ?`,
                    )
                    .get(team.name, cutoffDate) as {cnt: number}
            ).cnt;

            const toolRows = db
                .prepare(
                    `SELECT DISTINCT ts.tool
                     FROM tool_snapshots ts
                     JOIN developers d ON d.id = ts.developer_id
                     WHERE d.team = ? AND ts.is_active = 1 AND ts.date >= ?
                     ORDER BY ts.tool`,
                )
                .all(team.name, cutoffDate) as {tool: string}[];

            const costRow = db
                .prepare(
                    `SELECT COALESCE(SUM(s.monthly_cost), 0) as total_cost
                     FROM subscriptions s
                     JOIN developers d ON d.id = s.developer_id
                     WHERE d.team = ? AND s.seat_revoked_at IS NULL`,
                )
                .get(team.name) as {total_cost: number};

            return {
                name: team.name,
                department: team.department,
                manager: team.manager,
                developer_count: devCount,
                active_count: activeCount,
                tool_mix: toolRows.map((r) => r.tool),
                total_monthly_cost: costRow.total_cost,
                utilization_rate: devCount > 0 ? activeCount / devCount : 0,
            };
        });

        const total = summaries.length;
        const offset = (pagination.page - 1) * pagination.limit;
        const paginated = summaries.slice(offset, offset + pagination.limit);

        return buildPaginatedResponse(paginated, total, pagination);
    });

    app.get<{Params: {team: string}}>('/api/teams/:team', async (request, reply) => {
        const {team: teamName} = request.params;

        const team = db
            .prepare('SELECT name, department, manager FROM teams WHERE name = ?')
            .get(teamName) as {name: string; department: string | null; manager: string | null} | undefined;

        if (!team) {
            return reply.status(404).send({error: 'Not Found', message: `Team '${teamName}' not found`});
        }

        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 30);
        const cutoffDate = cutoff.toISOString().slice(0, 10);

        const developers = db
            .prepare('SELECT id, name, email FROM developers WHERE team = ? ORDER BY name')
            .all(teamName) as {id: string; name: string; email: string | null}[];

        const devDetails: DeveloperInTeam[] = developers.map((dev) => {
            const tools = db
                .prepare(
                    `SELECT DISTINCT tool FROM tool_snapshots
                     WHERE developer_id = ? AND is_active = 1 AND date >= ?
                     ORDER BY tool`,
                )
                .all(dev.id, cutoffDate) as {tool: string}[];

            const activityRow = db
                .prepare(
                    `SELECT
                       COUNT(DISTINCT date) as active_days,
                       COALESCE(SUM(interaction_count), 0) as total_interactions
                     FROM tool_snapshots
                     WHERE developer_id = ? AND is_active = 1 AND date >= ?`,
                )
                .get(dev.id, cutoffDate) as {active_days: number; total_interactions: number};

            const costRow = db
                .prepare(
                    `SELECT COALESCE(SUM(monthly_cost), 0) as cost
                     FROM subscriptions
                     WHERE developer_id = ? AND seat_revoked_at IS NULL`,
                )
                .get(dev.id) as {cost: number};

            const wasteRow = db
                .prepare(
                    `SELECT COUNT(*) as cnt FROM waste_alerts
                     WHERE developer_id = ? AND resolved_at IS NULL`,
                )
                .get(dev.id) as {cnt: number};

            return {
                id: dev.id,
                name: dev.name,
                email: dev.email,
                tools: tools.map((t) => t.tool),
                activity_summary: {
                    active_days_30d: activityRow.active_days,
                    total_interactions_30d: activityRow.total_interactions,
                },
                subscription_cost: costRow.cost,
                has_waste: wasteRow.cnt > 0,
            };
        });

        const costRow = db
            .prepare(
                `SELECT COALESCE(SUM(s.monthly_cost), 0) as total_cost
                 FROM subscriptions s
                 JOIN developers d ON d.id = s.developer_id
                 WHERE d.team = ? AND s.seat_revoked_at IS NULL`,
            )
            .get(teamName) as {total_cost: number};

        const wasteRow = db
            .prepare(
                `SELECT COALESCE(SUM(monthly_waste), 0) as total_waste
                 FROM waste_alerts
                 WHERE team = ? AND resolved_at IS NULL`,
            )
            .get(teamName) as {total_waste: number};

        const detail: TeamDetail = {
            name: team.name,
            department: team.department,
            manager: team.manager,
            developer_count: developers.length,
            total_monthly_cost: costRow.total_cost,
            total_monthly_waste: wasteRow.total_waste,
            developers: devDetails,
        };

        return {data: detail};
    });
}
