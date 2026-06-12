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
import {getOrgCoaching, getTeamCoaching} from '../../coaching/available/coaching';
import {parsePeriodUnit, type PeriodUnitInput} from './coaching-params';
import {forbidden, isAdmin} from './guards';
import {isCoachingPillar1Enabled, isCoachingPillar2Enabled} from '../../settings/store';

export function registerCoachingRoutes(app: FastifyInstance, db: Database.Database): void {
    /**
     * Org-wide team aggregate — every developer pooled. Admin/manager only; each
     * period is suppressed unless enough developers contributed (k-anonymity).
     *
     * Pillar gating (Task 5.10): when the pillar is disabled the surface returns
     * only {enabled:false}, so a disabled pillar is hidden on the manager
     * aggregate too — not just the developer's /api/me view. The org aggregate
     * pools every team, so it gates on the GLOBAL pillar value (no team).
     */
    app.get<{Querystring: PeriodUnitInput}>('/api/coaching/pr-review/org', async (request, reply) => {
        if (!isAdmin(request)) {
            return forbidden(reply);
        }
        if (!isCoachingPillar2Enabled(db, null)) {
            return {data: {enabled: false as const}};
        }
        const unit = parsePeriodUnit(request.query.unit);
        return {data: {enabled: true as const, ...getOrgPRReviewCoaching(db, unit)}};
    });

    /**
     * One team's aggregate. 404 when the team doesn't exist so a typo can't be
     * mistaken for a real-but-empty team. The aggregate itself never exposes an
     * individual's figures. Gated by Pillar 2 resolved FOR THAT TEAM, so a team
     * override of the pillar is honored.
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
            if (!isCoachingPillar2Enabled(db, team)) {
                return {data: {enabled: false as const}};
            }
            const unit = parsePeriodUnit(request.query.unit);
            return {data: {enabled: true as const, ...getTeamPRReviewCoaching(db, team, unit)}};
        },
    );

    /**
     * Org-wide available-data coaching aggregate — every developer pooled. Admin/
     * manager only; per (period, signal type) the aggregate is suppressed unless
     * enough developers contributed (k-anonymity), and it carries only contributor
     * counts and category tallies — never an individual's observation text.
     * Gated by Pillar 1 (global) like the PR-review org aggregate above.
     */
    app.get<{Querystring: PeriodUnitInput}>('/api/coaching/available/org', async (request, reply) => {
        if (!isAdmin(request)) {
            return forbidden(reply);
        }
        if (!isCoachingPillar1Enabled(db, null)) {
            return {data: {enabled: false as const}};
        }
        const unit = parsePeriodUnit(request.query.unit);
        return {data: {enabled: true as const, ...getOrgCoaching(db, unit)}};
    });

    /**
     * One team's available-data coaching aggregate. 404 when the team doesn't
     * exist so a typo can't be mistaken for a real-but-empty team. The aggregate
     * never exposes an individual's text or numbers. Gated by Pillar 1 for the team.
     */
    app.get<{Params: {team: string}; Querystring: PeriodUnitInput}>(
        '/api/coaching/available/team/:team',
        async (request, reply) => {
            if (!isAdmin(request)) {
                return forbidden(reply);
            }
            const {team} = request.params;
            const exists = db.prepare('SELECT 1 FROM teams WHERE name = ?').get(team);
            if (!exists) {
                return reply.status(404).send({error: 'Not Found', message: `Team '${team}' not found`});
            }
            if (!isCoachingPillar1Enabled(db, team)) {
                return {data: {enabled: false as const}};
            }
            const unit = parsePeriodUnit(request.query.unit);
            return {data: {enabled: true as const, ...getTeamCoaching(db, team, unit)}};
        },
    );
}
