/**
 * Best-practice browse UI — the non-contextual discovery surface (Task 6.2.8 / #163).
 *
 * The HTTP edge of the browsable/searchable best-practices library. Where the
 * authoring routes (6.2.3) are owner-scoped (a developer editing their OWN drafts) and
 * the contextual surface (6.2.7) shows practices next to a metric, these routes are the
 * library a developer browses: list/search published practices, read one in full, see
 * its history, and leave feedback on it.
 *
 * Everything lives under /api/me, so the session middleware confines it to the
 * authenticated developer and the viewer identity (id + team) comes STRICTLY from the
 * session, never request input. Two invariants hold the surface honest:
 *
 *  1. VIEWER-SCOPED. Every read and the feedback write go through the browse service,
 *     whose candidate set is the PUBLISHED practices the viewer may see (6.1.5 search +
 *     6.1.4 scope). A practice outside the viewer's scope (or not published, or not a
 *     practice) is a uniform 404 — there is structurally no path to read or rate a
 *     practice the viewer could not otherwise see.
 *  2. FEEDBACK IS THE VIEWER'S OWN. The toggle records the session developer's signal
 *     (never request input), gated on the practice being visible to them — so the
 *     feedback log can never be poisoned with votes on practices that were never shown.
 *
 * The handlers only validate the request shape, resolve the viewer's team, and map the
 * service result to a status; all browse logic lives in src/practices/browse.ts.
 */

import type {FastifyInstance, FastifyReply} from 'fastify';
import type Database from 'better-sqlite3';
import {requireDeveloperId} from './guards';
import {asObject, badRequest, optionalQueryString, rejectUnknownKeys} from './body-validation';
import {getDeveloperById} from '../../registry/developers';
import {isContributionScope, type ContributionScope} from '../../contributions/types';
import {isFeedbackSignal} from '../../practices/types';
import {helpfulRatio, toggleFeedback} from '../../practices/feedback';
import {getFeedbackCounts} from '../../practices/store';
import {resolveContributionModel} from '../../practices/contributionModel';
import {
    browsePractices,
    getBrowsePracticeDetail,
    getBrowsePracticeHistory,
    isPracticeVisibleToViewer,
    type PracticeBrowseFilters,
} from '../../practices/browse';

const FEEDBACK_KEYS = ['signal'] as const;

/** Default page size for the browse list — bounds the discovery surface so it never ships the whole library. */
export const DEFAULT_BROWSE_LIMIT = 50;

/** Hard ceiling on the browse page size, so a caller can't request an unbounded list. */
export const MAX_BROWSE_LIMIT = 200;

/** The viewer's team, resolved server-side from their developer record. Null when teamless. */
function viewerTeamOf(db: Database.Database, developerId: string): string | null {
    return getDeveloperById(db, developerId)?.team ?? null;
}

/**
 * Validate the optional `scope` query filter: absent → undefined (no filter); a known
 * scope → itself; anything else → 400 (returns false). The browse list only knows the
 * fixed scope vocabulary, so a typo fails loudly rather than silently matching nothing.
 */
export function parseScopeFilter(value: unknown, reply: FastifyReply): ContributionScope | undefined | false {
    const raw = optionalQueryString(value);
    if (raw === undefined) {
        return undefined;
    }
    if (!isContributionScope(raw)) {
        badRequest(reply, 'scope must be one of: team, org');
        return false;
    }
    return raw;
}

/**
 * Parse the optional `limit` query param: absent → the default; a positive integer
 * within the ceiling → itself; anything else → 400 (returns false). Keeps the browse
 * page bounded so a caller can't request an unbounded or nonsensical size.
 */
export function parseLimit(value: unknown, reply: FastifyReply): number | false {
    if (value === undefined) {
        return DEFAULT_BROWSE_LIMIT;
    }
    const raw = Array.isArray(value) ? value[value.length - 1] : value;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_BROWSE_LIMIT) {
        badRequest(reply, `limit must be an integer between 1 and ${MAX_BROWSE_LIMIT}`);
        return false;
    }
    return n;
}

export function registerPracticeBrowseRoutes(app: FastifyInstance, db: Database.Database): void {
    /**
     * Browse / search the published best practices the viewer may see. Query:
     * { q?, tag?, team?, scope? }. Returns the viewer-scoped, ranked list plus the
     * viewer-team's active contribution model (so the contribute entry point can
     * explain what publishing means for the team). An empty list is a normal result.
     */
    app.get<{Querystring: {q?: string; tag?: string; team?: string; scope?: string; limit?: string}}>(
        '/api/me/practices/browse',
        async (request, reply) => {
            const developerId = requireDeveloperId(request, reply);
            if (!developerId) {
                return reply;
            }
            const scope = parseScopeFilter(request.query.scope, reply);
            if (scope === false) {
                return reply;
            }
            const limit = parseLimit(request.query.limit, reply);
            if (limit === false) {
                return reply;
            }
            const viewerTeam = viewerTeamOf(db, developerId);
            const filters: PracticeBrowseFilters = {
                text: optionalQueryString(request.query.q),
                tag: optionalQueryString(request.query.tag),
                team: optionalQueryString(request.query.team),
                scope,
                limit,
            };
            return {
                data: {
                    model: resolveContributionModel(db, viewerTeam),
                    // Any authenticated developer may author a draft practice; the model
                    // governs only what happens on publish (enforced by the authoring routes).
                    canContribute: true,
                    practices: browsePractices(db, viewerTeam, filters),
                },
            };
        },
    );

    /**
     * Read one published practice in full: rendered content, feedback (with the
     * viewer's own signal), endorsement, the active contribution model, the edit
     * affordance gate, and any showcase cross-links. 404 when the practice is not
     * visible to the viewer (missing / not published / out of scope).
     */
    app.get<{Params: {id: string}}>('/api/me/practices/browse/:id', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const viewerTeam = viewerTeamOf(db, developerId);
        const detail = getBrowsePracticeDetail(db, viewerTeam, developerId, request.params.id);
        if (!detail) {
            return reply.status(404).send({error: 'Not Found', message: 'Best practice not found'});
        }
        return {data: detail};
    });

    /** Version history of a practice the viewer may see, oldest-first. 404 when not visible. */
    app.get<{Params: {id: string}}>('/api/me/practices/browse/:id/history', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const viewerTeam = viewerTeamOf(db, developerId);
        const history = getBrowsePracticeHistory(db, viewerTeam, request.params.id);
        if (!history) {
            return reply.status(404).send({error: 'Not Found', message: 'Best practice not found'});
        }
        return {data: history};
    });

    /**
     * Toggle the viewer's helpful / not-helpful feedback on a practice (6.2.4 togglable
     * semantics). Body: { signal }. The developer id is the session's. Gated on the
     * practice being visible to the viewer (404 otherwise), so feedback can only be left
     * on a practice they can actually read. Returns the resulting signal and the fresh
     * aggregate counts so the affordance can update without a refetch.
     */
    app.post<{Params: {id: string}; Body: unknown}>(
        '/api/me/practices/browse/:id/feedback',
        async (request, reply) => {
            const developerId = requireDeveloperId(request, reply);
            if (!developerId) {
                return reply;
            }
            const obj = asObject(request.body);
            if (!obj) {
                badRequest(reply, 'Request body must be an object');
                return reply;
            }
            if (!rejectUnknownKeys(obj, FEEDBACK_KEYS, reply)) {
                return reply;
            }
            if (!isFeedbackSignal(obj.signal)) {
                badRequest(reply, 'signal must be one of: helpful, not_helpful');
                return reply;
            }

            const viewerTeam = viewerTeamOf(db, developerId);
            // Visibility gate FIRST: never record feedback on a practice the viewer
            // cannot see (out of scope / unpublished / missing).
            if (!isPracticeVisibleToViewer(db, viewerTeam, request.params.id)) {
                return reply
                    .status(404)
                    .send({error: 'Not Found', message: 'Best practice not found'});
            }

            const result = toggleFeedback(db, {
                contributionId: request.params.id,
                developerId,
                signal: obj.signal,
            });
            const counts = getFeedbackCounts(db, request.params.id);
            return {
                data: {
                    signal: result.signal,
                    removed: result.removed,
                    feedback: {
                        helpful: counts.helpful,
                        notHelpful: counts.notHelpful,
                        helpfulRatio: helpfulRatio(counts),
                    },
                },
            };
        },
    );
}
