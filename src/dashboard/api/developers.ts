import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {getDeveloperDetail, getDeveloperTimeline} from './developer-detail';

export function registerDeveloperRoutes(app: FastifyInstance, db: Database.Database): void {
    app.get<{Params: {id: string}}>('/api/developers/:id', async (request, reply) => {
        const {id} = request.params;
        const detail = getDeveloperDetail(db, id);
        if (!detail) {
            return reply.status(404).send({error: 'Not Found', message: `Developer '${id}' not found`});
        }
        return {data: detail};
    });

    app.get<{Params: {id: string}}>('/api/developers/:id/timeline', async (request, reply) => {
        const {id} = request.params;
        const timeline = getDeveloperTimeline(db, id);
        if (timeline === null) {
            return reply.status(404).send({error: 'Not Found', message: `Developer '${id}' not found`});
        }
        return {data: timeline};
    });
}
