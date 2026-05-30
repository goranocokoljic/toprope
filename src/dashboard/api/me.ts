import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import type Database from 'better-sqlite3';
import {getDeveloperDetail, getDeveloperTimelineWindow} from './developer-detail';
import {
    earliestDeveloperDate,
    getMeActivity,
    getMeOverview,
    getMeTools,
} from './developer-views';
import {parseTimeRange, TimeRangeError, type TimeRangeInput} from './range';

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

/**
 * Resolve the session's developer id, or send the appropriate error and return
 * null. 401 when unauthenticated (defence-in-depth behind the middleware), 404
 * when the account has no linked developer.
 */
function requireDeveloperId(request: FastifyRequest, reply: FastifyReply): string | null {
    if (!request.authUser) {
        reply.status(401).send({error: 'Unauthorized', message: 'Authentication required'});
        return null;
    }
    const developerId = request.authUser.developerId;
    if (!developerId) {
        notFound(reply);
        return null;
    }
    return developerId;
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
