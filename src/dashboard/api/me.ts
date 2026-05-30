import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {getDeveloperDetail, getDeveloperTimeline} from './developer-detail';

/**
 * Self-service endpoints for the logged-in developer. The developer id is taken
 * STRICTLY from the authenticated session (request.authUser.developerId) and
 * never from a request parameter, so a developer can only ever see their own
 * data — passing someone else's id is not even possible here.
 */
export function registerMeRoutes(app: FastifyInstance, db: Database.Database): void {
    app.get('/api/me/profile', async (request, reply) => {
        const developerId = request.authUser?.developerId;
        if (!developerId) {
            return reply
                .status(404)
                .send({error: 'Not Found', message: 'No developer profile linked to this account'});
        }
        const detail = getDeveloperDetail(db, developerId);
        if (!detail) {
            return reply
                .status(404)
                .send({error: 'Not Found', message: 'No developer profile linked to this account'});
        }
        return {data: detail};
    });

    app.get('/api/me/timeline', async (request, reply) => {
        const developerId = request.authUser?.developerId;
        if (!developerId) {
            return reply
                .status(404)
                .send({error: 'Not Found', message: 'No developer profile linked to this account'});
        }
        const timeline = getDeveloperTimeline(db, developerId);
        if (timeline === null) {
            return reply
                .status(404)
                .send({error: 'Not Found', message: 'No developer profile linked to this account'});
        }
        return {data: timeline};
    });
}
