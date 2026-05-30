import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {isAdmin, forbidden} from './guards';

interface ProviderRow {
    provider: string;
    developer_count: number;
    snapshot_count: number;
}

export function registerProviderRoutes(app: FastifyInstance, db: Database.Database): void {
    // Git provider(s) hosting a team's repositories. The Phase-1 schema does not
    // track repositories directly, so providers are derived from the team's
    // developers' git activity (git_snapshots.data_source = provider tag).
    app.get<{Params: {team: string}}>('/api/teams/:team/providers', async (request, reply) => {
        if (!isAdmin(request)) {
            return forbidden(reply);
        }

        const {team} = request.params;
        const exists = db.prepare('SELECT 1 FROM teams WHERE name = ?').get(team);
        if (!exists) {
            return reply.status(404).send({error: 'Not Found', message: `Team '${team}' not found`});
        }

        const providers = db
            .prepare(
                `SELECT gs.data_source AS provider,
                        COUNT(DISTINCT gs.developer_id) AS developer_count,
                        COUNT(*) AS snapshot_count
                 FROM git_snapshots gs
                 JOIN developers d ON d.id = gs.developer_id
                 WHERE d.team = ?
                 GROUP BY gs.data_source
                 ORDER BY gs.data_source`,
            )
            .all(team) as ProviderRow[];

        return {data: {team, providers}};
    });
}
