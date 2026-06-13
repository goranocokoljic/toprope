/**
 * Showcase GOVERNANCE routes (Task 5.9 / #130) — the manager-facing surface a
 * team lead uses to MODERATE their team's showcase.
 *
 * The one invariant this file exists to make structural: a team lead can REMOVE,
 * but can NEVER publish or edit on a developer's behalf. That holds because this
 * surface offers exactly two verbs — list and remove — and NEITHER can create or
 * alter an example's content. Publishing lives solely under /api/me, keyed off
 * the developer's OWN session + retrospective; there is deliberately no admin
 * route here (or anywhere) that writes a showcase example's content. The session
 * middleware confines developers to /api/me, so these /api/admin routes are
 * reachable only by the manager/admin role — and even then only to remove.
 *
 * Removal is team-bounded (a lead acts for one team, and can only remove examples
 * in that team's showcase), logged, and notifies the author — all enforced in the
 * governance service. Nothing here reads prompt_captures: moderation sees only the
 * already-published, owner-redacted content, never anyone's private capture.
 */

import type {FastifyInstance, FastifyReply} from 'fastify';
import type Database from 'better-sqlite3';
import {forbidden, isAdmin} from './guards';
import {asObject, badRequest} from './body-validation';
import {listPublishedExamples} from '../../showcase/store';
import {
    isExampleInTeamShowcase,
    removeExampleAsTeamLead,
    ShowcaseGovernanceError,
    type ShowcaseGovernanceErrorCode,
} from '../../showcase/governance';
import {isShowcaseScope, type ShowcaseExample} from '../../showcase/types';

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

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], reply: FastifyReply): boolean {
    for (const key of Object.keys(obj)) {
        if (!allowed.includes(key)) {
            badRequest(reply, `Field '${key}' is not accepted; this route accepts exactly ${allowed.join(', ')}`);
            return false;
        }
    }
    return true;
}

export function registerShowcaseAdminRoutes(app: FastifyInstance, db: Database.Database): void {
    /**
     * Moderation list of PUBLISHED examples for a team lead. With ?team=T it shows
     * only examples in team T's showcase (the rule the removal enforces, applied
     * here so a lead sees exactly what they could act on); without it, every
     * published example across the org. Optional content filters: task_type, tool,
     * scope. Admin/manager only.
     */
    app.get<{Querystring: {team?: string; task_type?: string; tool?: string; scope?: string}}>(
        '/api/admin/showcase',
        async (request, reply) => {
            if (!isAdmin(request)) {
                return forbidden(reply);
            }

            const filters: {taskType?: string; tool?: string; scope?: ShowcaseExample['scope']} = {};
            const taskType = optionalQueryString(request.query.task_type);
            if (taskType !== undefined) {
                filters.taskType = taskType;
            }
            const tool = optionalQueryString(request.query.tool);
            if (tool !== undefined) {
                filters.tool = tool;
            }
            const scope = optionalQueryString(request.query.scope);
            if (scope !== undefined) {
                if (!isShowcaseScope(scope)) {
                    badRequest(reply, 'scope filter must be one of: team, org');
                    return reply;
                }
                filters.scope = scope;
            }

            let examples = listPublishedExamples(db, filters);
            const team = optionalQueryString(request.query.team);
            if (team !== undefined) {
                examples = examples.filter((ex) => isExampleInTeamShowcase(db, ex, team));
            }
            return {data: examples};
        },
    );

    /**
     * Remove an example from a team's showcase as a team lead. Body: { team,
     * reason? }. `team` is REQUIRED — it both names the team the lead acts for and
     * bounds their authority: the service refuses (403) an example outside that
     * team's showcase. On success the example flips to `removed`, the action is
     * logged, and the author is notified — atomically. There is no body field that
     * could create or alter content: removal is the only verb.
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
}

/** Read an optional querystring filter: a non-empty trimmed string, or undefined when absent/blank. */
function optionalQueryString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
}
