/**
 * Manager-facing PR/review coaching routes (Task 5.3 / #124).
 *
 * These serve ONLY team-level aggregates. There is deliberately no route here
 * that takes a developer id and returns their coaching — the sole individual
 * path is the developer's own /api/me/pr-coaching. Combined with the session
 * middleware (developers are confined to /api/me; managers/admins reach the rest)
 * and the k-anonymity floor inside the aggregate, a manager can see the team's
 * trajectory but never drill into, or reconstruct, an individual's numbers.
 */

import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {getOrgPRReviewCoaching, getTeamPRReviewCoaching} from '../../coaching/pr-review/coaching';
import {parsePeriodUnit, type PeriodUnitInput} from './coaching-params';
import {forbidden, isAdmin} from './guards';

export function registerCoachingRoutes(app: FastifyInstance, db: Database.Database): void {
    /**
     * Org-wide team aggregate — every developer pooled. Admin/manager only; each
     * period is suppressed unless enough developers contributed (k-anonymity).
     */
    app.get<{Querystring: PeriodUnitInput}>('/api/coaching/pr-review/org', async (request, reply) => {
        if (!isAdmin(request)) {
            return forbidden(reply);
        }
        const unit = parsePeriodUnit(request.query.unit);
        return {data: getOrgPRReviewCoaching(db, unit)};
    });

    /**
     * One team's aggregate. 404 when the team doesn't exist so a typo can't be
     * mistaken for a real-but-empty team. The aggregate itself never exposes an
     * individual's figures.
     */
    app.get<{Params: {team: string}; Querystring: PeriodUnitInput}>(
        '/api/coaching/pr-review/team/:team',
        async (request, reply) => {
            if (!isAdmin(request)) {
                return forbidden(reply);
            }
            const {team} = request.params;
            const exists = db.prepare('SELECT 1 FROM teams WHERE name = ?').get(team);
            if (!exists) {
                return reply.status(404).send({error: 'Not Found', message: `Team '${team}' not found`});
            }
            const unit = parsePeriodUnit(request.query.unit);
            return {data: getTeamPRReviewCoaching(db, team, unit)};
        },
    );
}
