/**
 * Shared parser for the showcase browse/moderation query filters (Task 5.9).
 *
 * The access-scoped browse (/api/me) and the moderation list (/api/admin) accept
 * the SAME optional querystring filters — task_type, tool, team, scope — and must
 * reject a bad `scope` identically. This is the one home for turning that
 * querystring into a validated `ShowcaseBrowseFilters`, so the two routes can't
 * drift in how they parse it (mirroring how the store-side clause builders are
 * single-homed in appendContentFilters/selectShowcase). The `team` key is the
 * common scope_target/team filter; `ShowcaseModerationFilters` is structurally a
 * superset-compatible shape, so the moderation route consumes the same result.
 */

import type {FastifyReply} from 'fastify';
import {badRequest, optionalQueryString} from './body-validation';
import {isShowcaseScope, type ShowcaseBrowseFilters} from '../../showcase/types';

/** The raw querystring shape both showcase filter surfaces accept. */
export interface ShowcaseFilterQuery {
    task_type?: string;
    tool?: string;
    team?: string;
    scope?: string;
}

/**
 * Parse the showcase filter querystring into a validated filter object. Returns
 * the filters (possibly empty) on success, or null after sending a 400 when
 * `scope` is present but not one of the known scopes. Absent/blank params are
 * simply omitted, so a contradictory combination (e.g. scope=org with team=T) is
 * accepted and resolves to the intersection in SQL — no param overrides another.
 */
export function parseShowcaseFilters(query: ShowcaseFilterQuery, reply: FastifyReply): ShowcaseBrowseFilters | null {
    const filters: ShowcaseBrowseFilters = {};
    const taskType = optionalQueryString(query.task_type);
    if (taskType !== undefined) {
        filters.taskType = taskType;
    }
    const tool = optionalQueryString(query.tool);
    if (tool !== undefined) {
        filters.tool = tool;
    }
    const team = optionalQueryString(query.team);
    if (team !== undefined) {
        filters.team = team;
    }
    const scope = optionalQueryString(query.scope);
    if (scope !== undefined) {
        if (!isShowcaseScope(scope)) {
            badRequest(reply, 'scope filter must be one of: team, org');
            return null;
        }
        filters.scope = scope;
    }
    return filters;
}
