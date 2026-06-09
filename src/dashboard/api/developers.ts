import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {getDeveloperDetail, getDeveloperTimeline} from './developer-detail';
import {getDeveloperJourney} from './journey';
import {forbidden, isAdmin} from './guards';

export function registerDeveloperRoutes(app: FastifyInstance, db: Database.Database): void {
    app.get<{Params: {id: string}}>('/api/developers/:id', async (request, reply) => {
        if (!isAdmin(request)) {
            return forbidden(reply);
        }
        const {id} = request.params;
        const detail = getDeveloperDetail(db, id);
        if (!detail) {
            return reply.status(404).send({error: 'Not Found', message: `Developer '${id}' not found`});
        }
        return {data: detail};
    });

    app.get<{Params: {id: string}}>('/api/developers/:id/timeline', async (request, reply) => {
        if (!isAdmin(request)) {
            return forbidden(reply);
        }
        const {id} = request.params;
        const timeline = getDeveloperTimeline(db, id);
        if (timeline === null) {
            return reply.status(404).send({error: 'Not Found', message: `Developer '${id}' not found`});
        }
        return {data: timeline};
    });

    // Manager's aggregate view of a developer's adoption journey (Task 4.11 /
    // #106). Same payload as the developer's own /api/me/journey — it carries no
    // prompt content and nothing rankable, only the developer's activity over
    // time — so the manager surface differs purely in framing. The session
    // middleware already confines developers to /api/me; the explicit isAdmin
    // backstop here is the deliberate defense-in-depth the sibling manager routes
    // use (see guards.ts), so a future allowlist change can't silently expose it.
    app.get<{Params: {id: string}}>('/api/developers/:id/journey', async (request, reply) => {
        if (!isAdmin(request)) {
            return forbidden(reply);
        }
        const {id} = request.params;
        // 404 on an unknown id rather than returning an empty journey, matching
        // the sibling detail/timeline routes.
        const exists = db.prepare('SELECT 1 FROM developers WHERE id = ?').get(id) !== undefined;
        if (!exists) {
            return reply.status(404).send({error: 'Not Found', message: `Developer '${id}' not found`});
        }
        return {data: getDeveloperJourney(db, id)};
    });
}
