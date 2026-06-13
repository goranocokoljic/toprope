/**
 * Unified manager coaching panel routes (Task 5.11 / #132).
 *
 * The single most privacy-sensitive manager surface: it returns TEAM-LEVEL
 * coaching aggregates ONLY — PR/review trends, churn/effectiveness trends,
 * anonymized loop/nudge patterns (opted-in developers only), and synthesized team
 * coaching opportunities. There is deliberately NO route here that takes a
 * developer id, and the panel builder only ever calls aggregate read functions,
 * so a manager can never drill into, or reconstruct, an individual's coaching.
 *
 * Defense in depth mirrors the sibling coaching routes: the session middleware
 * confines the developer role to /api/me, and `isAdmin` is the explicit backstop
 * here. The min-group-size floor and the opted-in-only filter live inside the
 * aggregates themselves, so this layer only resolves scope and authorizes.
 */

import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {
    getOrgManagerCoachingPanel,
    getTeamManagerCoachingPanel,
} from '../../coaching/manager-aggregate/panel';
import {parsePeriodUnit, type PeriodUnitInput} from './coaching-params';
import {forbidden, isAdmin} from './guards';

export function registerManagerCoachingRoutes(app: FastifyInstance, db: Database.Database): void {
    /**
     * Org-wide manager coaching panel — every developer pooled. Admin/manager
     * only. Each pillar gates on its GLOBAL enable flag; every aggregate inside is
     * floored (and the loop/nudge section opted-in only), so nothing about any
     * individual can surface.
     */
    app.get<{Querystring: PeriodUnitInput}>('/api/coaching/manager/org', async (request, reply) => {
        if (!isAdmin(request)) {
            return forbidden(reply);
        }
        const unit = parsePeriodUnit(request.query.unit);
        return {data: getOrgManagerCoachingPanel(db, unit)};
    });

    /**
     * One team's manager coaching panel. 404 when the team doesn't exist so a typo
     * can't be mistaken for a real-but-empty team. Each pillar gates on the value
     * resolved FOR THAT TEAM (team overrides honored). The aggregates never expose
     * an individual's figures.
     */
    app.get<{Params: {team: string}; Querystring: PeriodUnitInput}>(
        '/api/coaching/manager/team/:team',
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
            return {data: getTeamManagerCoachingPanel(db, team, unit)};
        },
    );
}
