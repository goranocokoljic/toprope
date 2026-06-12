import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import type Database from 'better-sqlite3';
import {getDeveloperDetail, getDeveloperTimelineWindow} from './developer-detail';
import {
    earliestDeveloperDate,
    getMeActivity,
    getMeOverview,
    getMeTools,
} from './developer-views';
import {getDeveloperJourney} from './journey';
import {parseTimeRange, TimeRangeError, type TimeRangeInput} from './range';
import {requireDeveloperId} from './guards';
import {getDeveloperPRReviewCoaching} from '../../coaching/pr-review/coaching';
import {getDeveloperCoaching} from '../../coaching/available/coaching';
import {parsePeriodUnit, type PeriodUnitInput} from './coaching-params';
import {isCoachingPillar1Enabled, isCoachingPillar2Enabled} from '../../settings/store';
import {getDeveloperById} from '../../registry/developers';

/**
 * Self-service endpoints for the logged-in developer (Task 2.4 / #39).
 *
 * The developer id is taken STRICTLY from the authenticated session
 * (request.authUser.developerId) and NEVER from a request parameter or body, so
 * a developer can only ever see their own data — passing someone else's id is
 * not even possible here. The session middleware (src/auth/middleware.ts) already
 * confines developer-role sessions to /api/me/* and rejects unauthenticated
 * requests with 401 before they reach these handlers.
 *
 * A developer-role account whose developer link is null (the linked developer
 * was removed → FK SET NULL) gets a 404 rather than a leak of anyone's data.
 */
function notFound(reply: FastifyReply): void {
    reply
        .status(404)
        .send({error: 'Not Found', message: 'No developer profile linked to this account'});
}

export function registerMeRoutes(app: FastifyInstance, db: Database.Database): void {
    app.get('/api/me/profile', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const detail = getDeveloperDetail(db, developerId);
        if (!detail) {
            return notFound(reply);
        }
        return {data: detail};
    });

    app.get<{Querystring: TimeRangeInput}>('/api/me/overview', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const range = resolveRange(request, reply, db, developerId);
        if (!range) {
            return reply;
        }
        return {
            data: {
                range: range.range,
                from: range.from,
                to: range.to,
                ...getMeOverview(db, developerId, range.from, range.to),
            },
        };
    });

    app.get<{Querystring: TimeRangeInput}>('/api/me/tools', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const range = resolveRange(request, reply, db, developerId);
        if (!range) {
            return reply;
        }
        return {
            data: {
                range: range.range,
                from: range.from,
                to: range.to,
                tools: getMeTools(db, developerId, range.from, range.to),
            },
        };
    });

    app.get<{Querystring: TimeRangeInput}>('/api/me/timeline', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const range = resolveRange(request, reply, db, developerId);
        if (!range) {
            return reply;
        }
        return {
            data: {
                range: range.range,
                from: range.from,
                to: range.to,
                points: getDeveloperTimelineWindow(db, developerId, range.from, range.to),
            },
        };
    });

    app.get('/api/me/journey', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        return {data: getDeveloperJourney(db, developerId)};
    });

    /**
     * The developer's PRIVATE PR/review coaching: their own rework/review
     * trajectory over time, both scope variants kept separate (all_pr factual /
     * ai_assisted_pr inferred). Session-scoped like every /api/me route — the id
     * comes only from the session, so a developer can never reach anyone else's
     * coaching. `unit` selects weekly or monthly periods (default monthly).
     */
    app.get<{Querystring: PeriodUnitInput}>('/api/me/pr-coaching', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        // Pillar 2 (PR/review coaching) can be switched off org-wide or per team
        // (Task 5.10): when it is, this surface returns only {enabled:false} so the
        // feature is hidden everywhere rather than serving coaching the org disabled.
        const team = getDeveloperById(db, developerId)?.team ?? null;
        if (!isCoachingPillar2Enabled(db, team)) {
            return {data: {enabled: false as const}};
        }
        const unit = parsePeriodUnit(request.query.unit);
        return {data: {enabled: true as const, ...getDeveloperPRReviewCoaching(db, developerId, unit)}};
    });

    /**
     * The developer's PRIVATE available-data coaching: their own churn
     * reflection, acceptance trend (only when tool data exists), journey
     * coaching, and tier-aware personal insight — each within-developer-over-time
     * and including the observation text. Session-scoped like every /api/me
     * route, so a developer can never reach anyone else's coaching. `unit` selects
     * weekly or monthly periods (default monthly).
     */
    app.get<{Querystring: PeriodUnitInput}>('/api/me/coaching', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        // Pillar 1 (available-data coaching) gating, mirroring pr-coaching above.
        const team = getDeveloperById(db, developerId)?.team ?? null;
        if (!isCoachingPillar1Enabled(db, team)) {
            return {data: {enabled: false as const}};
        }
        const unit = parsePeriodUnit(request.query.unit);
        return {data: {enabled: true as const, ...getDeveloperCoaching(db, developerId, unit)}};
    });

    app.get<{Querystring: TimeRangeInput}>('/api/me/activity', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const range = resolveRange(request, reply, db, developerId);
        if (!range) {
            return reply;
        }
        return {
            data: {
                range: range.range,
                from: range.from,
                to: range.to,
                ...getMeActivity(db, developerId, range.from, range.to),
            },
        };
    });
}

/**
 * Parse the range query exactly as the manager endpoints do (same kinds, same
 * 400 on bad input), resolving "lifetime" from the developer's own earliest
 * record so the window can never reach beyond their data. Returns null after
 * sending a 400 when the range is invalid.
 */
function resolveRange(
    request: FastifyRequest<{Querystring: TimeRangeInput}>,
    reply: FastifyReply,
    db: Database.Database,
    developerId: string,
): {range: string; from: string; to: string} | null {
    try {
        return parseTimeRange(request.query, {
            earliest: () => earliestDeveloperDate(db, developerId),
        });
    } catch (err) {
        if (err instanceof TimeRangeError) {
            reply.status(400).send({error: 'Bad Request', message: err.message});
            return null;
        }
        throw err;
    }
}
