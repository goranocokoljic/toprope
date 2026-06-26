/**
 * Showcase browse/consumption routes (Task 6.3.9 / #172) — the developer-facing
 * gallery, unit detail, owner-unpublish, and removal-notification feed.
 *
 * The HTTP edge of Epic 6.3's consumption surface, the showcase analogue of the
 * best-practice browse routes (6.2.8). Everything lives under /api/me, so the session
 * middleware confines it to the authenticated developer and the viewer identity
 * (id + team) comes STRICTLY from the session, never request input. Two invariants
 * hold the surface honest:
 *
 *  1. VIEWER-SCOPED, NO LEAK TO PRIVATE CAPTURES. Every read goes through the browse
 *     service, whose candidate set is the PUBLISHED showcases the viewer may see
 *     (6.1.5 search + 6.1.4 scope) and which reads only the published, redacted unit —
 *     never `prompt_captures`. A showcase outside the viewer's scope (or not published,
 *     or not a showcase) is a uniform 404.
 *  2. OWNER-ONLY UNPUBLISH; NO PUBLISH PATH. The only mutation here is the author
 *     unpublishing their OWN showcase (the governance service re-checks authorship).
 *     There is deliberately no route that publishes or edits content — publishing
 *     lives solely in the consent-gated dual-path flow (6.3.2). A lead's removal is a
 *     separate /api/admin route; this self-service surface cannot remove others' work.
 *
 * The handlers only validate the request shape, resolve the viewer's team, and map the
 * service result to a status; all browse/governance logic lives in src/showcase/.
 */

import type {FastifyInstance, FastifyReply} from 'fastify';
import type Database from 'better-sqlite3';
import {requireDeveloperId} from './guards';
import {optionalQueryString} from './body-validation';
import {DEFAULT_BROWSE_LIMIT, parseLimit, parseScopeFilter} from './practices-browse';
import {getDeveloperById} from '../../registry/developers';
import {
    browseShowcases,
    getShowcaseDetail,
    type ShowcaseBrowseFilters,
} from '../../showcase/browse';
import {UnitGovernanceError, unpublishOwnShowcase, listShowcaseRemovalsForAuthor} from '../../showcase/unitGovernance';

/** The viewer's team, resolved server-side from their developer record. Null when teamless. */
function viewerTeamOf(db: Database.Database, developerId: string): string | null {
    return getDeveloperById(db, developerId)?.team ?? null;
}

export function registerShowcaseBrowseRoutes(app: FastifyInstance, db: Database.Database): void {
    /**
     * Browse / search the published showcases the viewer may see. Query:
     * { q?, tag?, team?, scope?, limit? }. Returns the viewer-scoped, ranked gallery.
     * An empty list is a normal result. Filters only narrow within the viewer's scope,
     * so a `team` filter can never reveal another team's team-scoped showcases.
     */
    app.get<{Querystring: {q?: string; tag?: string; team?: string; scope?: string; limit?: string}}>(
        '/api/me/showcase-units/browse',
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
            const filters: ShowcaseBrowseFilters = {
                text: optionalQueryString(request.query.q),
                tag: optionalQueryString(request.query.tag),
                team: optionalQueryString(request.query.team),
                scope,
                limit,
            };
            return {data: {showcases: browseShowcases(db, viewerTeam, filters)}};
        },
    );

    /**
     * The author's removal-notification feed: every lead removal of one of THEIR
     * showcases, newest first. This is how "the author is notified" is delivered — the
     * same logged audit row read back by its author, so a removal can never be silent.
     * Author-scoped; never another developer's. Declared before `:id` so the static
     * segment wins the match.
     */
    app.get('/api/me/showcase-units/removals', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        return {data: listShowcaseRemovalsForAuthor(db, developerId)};
    });

    /**
     * Read one showcase the viewer may see in full: the curators' note + outcome, the
     * inline-annotated conversation, the clearly-AI secondary annotation, and the
     * cross-linked practices — every unit component. 404 when not visible to the viewer
     * (missing / not a showcase / not published / out of scope).
     */
    app.get<{Params: {id: string}}>('/api/me/showcase-units/:id', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const viewerTeam = viewerTeamOf(db, developerId);
        const detail = getShowcaseDetail(db, viewerTeam, developerId, request.params.id);
        if (!detail) {
            return reply.status(404).send({error: 'Not Found', message: 'Showcase not found'});
        }
        return {data: detail};
    });

    /**
     * Owner unpublish: the author removes their OWN showcase from the gallery (status →
     * unpublished; gone from browse). Author-scoped and guarded on the showcase being
     * currently published. Any failure (not the author, missing, not a showcase, already
     * gone) is a uniform 404, so a non-owner can never distinguish "exists but not yours"
     * from "doesn't exist", nor resurrect a removed showcase by unpublishing it.
     */
    app.post<{Params: {id: string}}>('/api/me/showcase-units/:id/unpublish', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        try {
            const updated = unpublishOwnShowcase(db, {showcaseId: request.params.id, developerId});
            return {data: updated};
        } catch (err) {
            if (err instanceof UnitGovernanceError) {
                // Uniform 404 across every governance code: never reveal a showcase's
                // existence or state to a non-owner via a distinguishable status.
                return reply
                    .status(404)
                    .send({error: 'Not Found', message: 'No published showcase of yours with that id'});
            }
            throw err;
        }
    });
}
