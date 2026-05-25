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

        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 30);
        const cutoffDate = cutoff.toISOString().slice(0, 10);

        const total = (db.prepare('SELECT COUNT(*) as cnt FROM teams').get() as {cnt: number}).cnt;

        const offset = (pagination.page - 1) * pagination.limit;
        const pageTeams = db
            .prepare('SELECT name, department, manager FROM teams ORDER BY name LIMIT ? OFFSET ?')
            .all(pagination.limit, offset) as {name: string; department: string | null; manager: string | null}[];

        if (pageTeams.length === 0) {
            return buildPaginatedResponse([], total, pagination);
        }

        const devCountRows = db
            .prepare(
                `SELECT team, COUNT(*) as cnt FROM developers
                 WHERE team IN (${pageTeams.map(() => '?').join(',')})
                 GROUP BY team`,
            )
            .all(...pageTeams.map((t) => t.name)) as {team: string; cnt: number}[];

        const activeCountRows = db
            .prepare(
                `SELECT d.team, COUNT(DISTINCT ts.developer_id) as cnt
                 FROM tool_snapshots ts
                 JOIN developers d ON d.id = ts.developer_id
                 WHERE d.team IN (${pageTeams.map(() => '?').join(',')}) AND ts.is_active = 1 AND ts.date >= ?
                 GROUP BY d.team`,
            )
            .all(...pageTeams.map((t) => t.name), cutoffDate) as {team: string; cnt: number}[];

        const toolMixRows = db
            .prepare(
                `SELECT d.team, GROUP_CONCAT(DISTINCT ts.tool) as tools
                 FROM tool_snapshots ts
                 JOIN developers d ON d.id = ts.developer_id
                 WHERE d.team IN (${pageTeams.map(() => '?').join(',')}) AND ts.is_active = 1 AND ts.date >= ?
                 GROUP BY d.team`,
            )
            .all(...pageTeams.map((t) => t.name), cutoffDate) as {team: string; tools: string | null}[];

        const costRows = db
            .prepare(
                `SELECT d.team, COALESCE(SUM(s.monthly_cost), 0) as total_cost
                 FROM subscriptions s
                 JOIN developers d ON d.id = s.developer_id
                 WHERE d.team IN (${pageTeams.map(() => '?').join(',')}) AND s.seat_revoked_at IS NULL
                 GROUP BY d.team`,
            )
            .all(...pageTeams.map((t) => t.name)) as {team: string; total_cost: number}[];

        const devCountMap = new Map(devCountRows.map((r) => [r.team, r.cnt]));
        const activeCountMap = new Map(activeCountRows.map((r) => [r.team, r.cnt]));
        const toolMixMap = new Map(toolMixRows.map((r) => [r.team, r.tools ? r.tools.split(',').filter(Boolean) : []]));
        const costMap = new Map(costRows.map((r) => [r.team, r.total_cost]));

        const summaries: TeamSummary[] = pageTeams.map((team) => {
            const devCount = devCountMap.get(team.name) ?? 0;
            const activeCount = activeCountMap.get(team.name) ?? 0;
            return {
                name: team.name,
                department: team.department,
                manager: team.manager,
                developer_count: devCount,
                active_count: activeCount,
                tool_mix: toolMixMap.get(team.name) ?? [],
                total_monthly_cost: costMap.get(team.name) ?? 0,
                utilization_rate: devCount > 0 ? activeCount / devCount : 0,
            };
        });

        return buildPaginatedResponse(summaries, total, pagination);
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
