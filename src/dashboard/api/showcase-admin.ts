/**
 * Showcase GOVERNANCE routes (Task 5.9 / #130) — the manager-facing surface used
 * to MODERATE a team's showcase.
 *
 * The one invariant this file exists to make structural: moderation can REMOVE,
 * but can NEVER publish or edit on a developer's behalf. That holds because this
 * surface offers exactly two verbs — list and remove — and NEITHER can create or
 * alter an example's content. Publishing lives solely under /api/me, keyed off
 * the developer's OWN session + retrospective; there is deliberately no admin
 * route here (or anywhere) that writes a showcase example's content. The session
 * middleware confines developers to /api/me, so these /api/admin routes are
 * reachable only by the manager/admin role — and even then only to remove.
 *
 * On AUTHORITY: Toprope's role model is binary (admin | developer) with no
 * per-team-lead role, and every /api/admin route is the full-org admin/manager
 * surface. So the `team` a remove names is NOT a verified "I lead this team"
 * claim — it is the team whose showcase the action is scoped to. It bounds WHICH
 * examples a removal may touch (the example must belong to that team's showcase),
 * not WHO may moderate (any admin may). The recorded `showcase_removals.team` is
 * therefore that scope label, not an authorization fact; a future scoped
 * team-lead role would add the membership check here. The removal is logged and
 * notifies the author either way. Nothing here reads prompt_captures: moderation
 * sees only the already-published, owner-redacted content, never a private capture.
 */

import type {FastifyInstance, FastifyReply} from 'fastify';
import type Database from 'better-sqlite3';
import {forbidden, isAdmin} from './guards';
import {asObject, badRequest, rejectUnknownKeys} from './body-validation';
import {listPublishedExamples} from '../../showcase/store';
import {
    removeExampleAsTeamLead,
    ShowcaseGovernanceError,
    type ShowcaseGovernanceErrorCode,
} from '../../showcase/governance';
import {
    removeShowcaseAsLead,
    UnitGovernanceError,
    type UnitGovernanceErrorCode,
} from '../../showcase/unitGovernance';
import {parseShowcaseFilters, type ShowcaseFilterQuery} from './showcase-filters';

const MAX_REASON_LEN = 1000;
const REMOVE_KEYS = ['team', 'reason'] as const;

/** Map a governance error code to its HTTP status. */
const ERROR_STATUS: Record<ShowcaseGovernanceErrorCode, number> = {
    example_not_found: 404,
    not_team_showcase: 403,
    not_published: 409,
};

function sendGovernanceError(err: unknown, reply: FastifyReply): FastifyReply {
    if (err instanceof ShowcaseGovernanceError) {
        return reply.status(ERROR_STATUS[err.code]).send({error: 'Governance error', code: err.code, message: err.message});
    }
    throw err;
}

/**
 * Map a 6.3.x unit-governance error code to its HTTP status. `not_found` /
 * `not_a_showcase` are 404 (no such moderatable showcase), `not_team_showcase` is 403
 * (outside this team's gallery), `not_removable` is 409 (wrong lifecycle state). The
 * owner-only codes never reach this admin route, but are mapped for completeness.
 */
const UNIT_ERROR_STATUS: Record<UnitGovernanceErrorCode, number> = {
    not_found: 404,
    not_a_showcase: 404,
    not_author: 403,
    not_published: 409,
    not_removable: 409,
    not_team_showcase: 403,
};

function sendUnitGovernanceError(err: unknown, reply: FastifyReply): FastifyReply {
    if (err instanceof UnitGovernanceError) {
        return reply
            .status(UNIT_ERROR_STATUS[err.code])
            .send({error: 'Governance error', code: err.code, message: err.message});
    }
    throw err;
}

export function registerShowcaseAdminRoutes(app: FastifyInstance, db: Database.Database): void {
    /**
     * Moderation list of PUBLISHED examples. With ?team=T it shows only examples in
     * team T's showcase — scoped in SQL by the same rule a removal enforces, so a
     * moderator sees exactly what they could act on for that team; without it,
     * every published example across the org. Optional content filters: task_type,
     * tool, scope. Admin/manager only.
     */
    app.get<{Querystring: ShowcaseFilterQuery}>('/api/admin/showcase', async (request, reply) => {
        if (!isAdmin(request)) {
            return forbidden(reply);
        }
        // Same validated shape as the /api/me browse filters; the moderation list
        // consumes task_type/tool/scope/team identically (team scopes to that
        // team's showcase in SQL).
        const filters = parseShowcaseFilters(request.query, reply);
        if (!filters) {
            return reply;
        }
        return {data: listPublishedExamples(db, filters)};
    });

    /**
     * Remove an example from a team's showcase. Body: { team, reason? }. `team` is
     * REQUIRED — it names the team whose showcase the action is scoped to and
     * bounds WHICH examples may be touched: the service refuses (403) an example
     * outside that team's showcase. On success the example flips to `removed`, the
     * action is logged, and the author is notified — atomically. There is no body
     * field that could create or alter content: removal is the only verb.
     */
    app.post<{Params: {id: string}; Body: unknown}>('/api/admin/showcase/:id/remove', async (request, reply) => {
        if (!isAdmin(request)) {
            return forbidden(reply);
        }

        const obj = asObject(request.body);
        if (!obj) {
            badRequest(reply, 'Request body must be an object');
            return reply;
        }
        if (!rejectUnknownKeys(obj, REMOVE_KEYS, reply)) {
            return reply;
        }

        const team = typeof obj.team === 'string' ? obj.team.trim() : '';
        if (!team) {
            badRequest(reply, 'team is required (the team whose showcase you are moderating)');
            return reply;
        }

        let reason: string | null = null;
        if (obj.reason !== undefined && obj.reason !== null) {
            if (typeof obj.reason !== 'string') {
                badRequest(reply, 'reason must be a string');
                return reply;
            }
            const trimmed = obj.reason.trim();
            if (trimmed.length > MAX_REASON_LEN) {
                badRequest(reply, `reason exceeds the ${MAX_REASON_LEN}-character limit`);
                return reply;
            }
            reason = trimmed.length === 0 ? null : trimmed;
        }

        try {
            const result = removeExampleAsTeamLead(db, {
                exampleId: request.params.id,
                team,
                removedByUserId: request.authUser!.userId,
                removedByEmail: request.authUser!.email,
                reason,
            });
            return {data: {removalId: result.removalId, example: result.example}};
        } catch (err) {
            return sendGovernanceError(err, reply);
        }
    });

    /**
     * Remove a 6.3.x showcase UNIT from a team's gallery (the contribution-spine
     * model). Body: { team, reason? }. `team` is REQUIRED — it scopes the action to
     * that team's gallery and bounds which showcases may be touched (the service
     * refuses, 403, a showcase outside it). On success the showcase flips to `removed`,
     * the action is logged in the audit trail, and the author is notified via their
     * removal feed — atomically. As with the Phase 5 route there is NO body field that
     * could create or alter content: removal is the only verb. A lead can never publish
     * on a developer's behalf — that path lives solely in the consent-gated 6.3.2 flow.
     */
    app.post<{Params: {id: string}; Body: unknown}>('/api/admin/showcase-units/:id/remove', async (request, reply) => {
        if (!isAdmin(request)) {
            return forbidden(reply);
        }

        const obj = asObject(request.body);
        if (!obj) {
            badRequest(reply, 'Request body must be an object');
            return reply;
        }
        if (!rejectUnknownKeys(obj, REMOVE_KEYS, reply)) {
            return reply;
        }

        const team = typeof obj.team === 'string' ? obj.team.trim() : '';
        if (!team) {
            badRequest(reply, 'team is required (the team whose gallery you are moderating)');
            return reply;
        }

        let reason: string | null = null;
        if (obj.reason !== undefined && obj.reason !== null) {
            if (typeof obj.reason !== 'string') {
                badRequest(reply, 'reason must be a string');
                return reply;
            }
            const trimmed = obj.reason.trim();
            if (trimmed.length > MAX_REASON_LEN) {
                badRequest(reply, `reason exceeds the ${MAX_REASON_LEN}-character limit`);
                return reply;
            }
            reason = trimmed.length === 0 ? null : trimmed;
        }

        try {
            const removed = removeShowcaseAsLead(db, {
                showcaseId: request.params.id,
                team,
                removedByUserId: request.authUser!.userId,
                reason,
            });
            return {data: {showcase: removed}};
        } catch (err) {
            return sendUnitGovernanceError(err, reply);
        }
    });
}
