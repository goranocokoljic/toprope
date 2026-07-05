/**
 * Contextual best-practice display — the surfacing edge for the dashboard (Task
 * 6.2.7 / #162).
 *
 * The payoff of Epic 6.2: a developer looking at a metric (a churn figure, an
 * acceptance rate) sees the best practices that relate to it RIGHT THERE, not in a
 * separate docs graveyard. This module is the thin HTTP edge that lets the dashboard
 * ask "what practices should surface next to this metric for me?" and record that a
 * surfaced practice was actually viewed (the usage signal 6.2.4 feeds on).
 *
 * Everything lives under /api/me, so the session middleware confines it to the
 * authenticated developer and the viewer identity (id + team) comes STRICTLY from the
 * session — never from request input. Two invariants hold the surface honest:
 *
 *  1. VIEWER-SCOPED SURFACING. The candidate set is whatever {@link surfacePractices}
 *     (6.2.5 + 6.2.6) returns for the metric and the viewer's team — tag-matched,
 *     scope-resolved, suppression-respecting, pin-merged, model-ranked. This route adds
 *     no surfacing logic of its own; it only maps the result to a lean DTO and wraps it
 *     in encouraging copy. A developer can never be surfaced a practice they could not
 *     otherwise see.
 *  2. VIEW RECORDS ONLY WHAT IS SURFACED. Recording a "viewed" usage event is gated on
 *     the practice actually being in the viewer's current surfacing set for that metric
 *     — a practice the viewer cannot see (out of scope, unpublished, suppressed) is a
 *     404, so the usage log can never be poisoned with views of practices that were
 *     never shown. The event's developer id is the session's, so the later correlation
 *     (6.2.4) attributes engagement to the right person.
 *
 * Tone is a product requirement here (the surface is public-facing and sits next to a
 * developer's own number): the intro copy comes from {@link relatedPracticesIntro},
 * the single reviewed home for the encouraging framing.
 */

import type {FastifyInstance, FastifyReply} from 'fastify';
import type Database from 'better-sqlite3';
import {requireDeveloperId} from './guards';
import {asObject, badRequest, rejectUnknownKeys} from './body-validation';
import {getDeveloperById} from '../../registry/developers';
import {isPracticeMetric, type PracticeMetric} from '../../practices/metrics';
import {surfacePractices, type SurfacedPractice} from '../../practices/surfacing';
import {recordUsageEvent} from '../../practices/store';
import {relatedPracticesIntro} from '../../practices/tone';

/**
 * Default cap on how many practices surface next to a single metric — the affordance
 * is unobtrusive, so it shows a short list, not a wall. Overridable per request within
 * {@link MAX_RELATED_LIMIT}.
 */
const DEFAULT_RELATED_LIMIT = 3;

/** Hard ceiling on the surfacing limit, so a caller can't request an unbounded list. */
const MAX_RELATED_LIMIT = 20;

const VIEW_KEYS = ['metric'] as const;

/** The lean, viewer-safe shape of one surfaced practice the dashboard renders. */
interface RelatedPracticeDto {
    id: string;
    title: string;
    scope: string;
    /** True when a lead PINNED this practice to the metric (6.2.6) — the UI can mark it. */
    pinned: boolean;
    /** Lead-endorsement flag (hybrid model) — lets the UI show an "endorsed" marker. */
    endorsed: boolean;
    /** Raw helpful-ratio in [0,1] for an unobtrusive "found helpful" hint, or null when no feedback. */
    helpfulRatio: number | null;
}

function toDto(surfaced: SurfacedPractice): RelatedPracticeDto {
    return {
        id: surfaced.contribution.id,
        title: surfaced.contribution.title,
        scope: surfaced.contribution.scope,
        pinned: surfaced.pinned,
        endorsed: surfaced.ranking.endorsed,
        helpfulRatio: surfaced.ranking.helpfulRatio,
    };
}

/**
 * Validate the `metric` value against the known practice vocabulary, sending a 400
 * and returning null when it is missing or unrecognised. The contextual surface only
 * deals in the fixed metric set (the same one the authoring editor tags against), so a
 * typo fails loudly here rather than silently surfacing nothing.
 */
function requireMetric(value: unknown, reply: FastifyReply): PracticeMetric | null {
    if (typeof value !== 'string' || value.trim() === '') {
        badRequest(reply, 'metric is required');
        return null;
    }
    const metric = value.trim();
    if (!isPracticeMetric(metric)) {
        badRequest(reply, `metric must be one of the known practice metrics`);
        return null;
    }
    return metric;
}

/**
 * Parse the optional `limit` query param: absent → the default; a positive integer
 * within the ceiling → itself; anything else → 400 (returns null). Keeps the surfaced
 * list bounded without a caller being able to request an unbounded or nonsensical size.
 */
function parseLimit(value: unknown, reply: FastifyReply): number | null {
    if (value === undefined) {
        return DEFAULT_RELATED_LIMIT;
    }
    const raw = Array.isArray(value) ? value[value.length - 1] : value;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_RELATED_LIMIT) {
        badRequest(reply, `limit must be an integer between 1 and ${MAX_RELATED_LIMIT}`);
        return null;
    }
    return n;
}

export function registerPracticeSurfaceRoutes(app: FastifyInstance, db: Database.Database): void {
    /**
     * The practices to surface next to a metric for the logged-in developer. Query:
     * { metric, limit? }. Returns the viewer-scoped, ranked surfacing set (6.2.5 +
     * 6.2.6) mapped to a lean DTO, plus the encouraging intro copy. An empty set is a
     * normal, unobtrusive result (200 with an empty list), not an error — the affordance
     * simply renders nothing when there is nothing relevant.
     */
    app.get<{Querystring: {metric?: string; limit?: string}}>(
        '/api/me/practices/related',
        async (request, reply) => {
            const developerId = requireDeveloperId(request, reply);
            if (!developerId) {
                return reply;
            }
            const metric = requireMetric(request.query.metric, reply);
            if (!metric) {
                return reply;
            }
            const limit = parseLimit(request.query.limit, reply);
            if (limit === null) {
                return reply;
            }

            const viewerTeam = getDeveloperById(db, developerId)?.team ?? null;
            const surfaced = surfacePractices(db, {metric, viewerTeam, limit});
            return {
                data: {
                    metric,
                    intro: relatedPracticesIntro(metric),
                    practices: surfaced.map(toDto),
                },
            };
        },
    );

    /**
     * Record that the developer VIEWED a surfaced practice next to a metric — the
     * raw material the usage-signal correlation (6.2.4) joins against metric movement.
     * Body: { metric }. The developer id is the session's, never request input.
     *
     * Gated on the practice being SURFACING-ELIGIBLE for the viewer at this metric:
     * a practice the viewer cannot see (out of scope, unpublished, or suppressed) is a
     * 404 and records nothing. The gate runs against the UNCAPPED surfacing set (no
     * display `limit`), so it is deliberately "could-be-surfaced," not "was in the
     * top-N the GET rendered" — the display cap is an affordance, not a security
     * boundary, and a practice ranked below the cap is still a legitimate view target.
     */
    app.post<{Params: {id: string}; Body: unknown}>(
        '/api/me/practices/:id/view',
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
            if (!rejectUnknownKeys(obj, VIEW_KEYS, reply)) {
                return reply;
            }
            const metric = requireMetric(obj.metric, reply);
            if (!metric) {
                return reply;
            }

            const viewerTeam = getDeveloperById(db, developerId)?.team ?? null;
            const surfaced = surfacePractices(db, {metric, viewerTeam});
            const isSurfaced = surfaced.some((s) => s.contribution.id === request.params.id);
            if (!isSurfaced) {
                return reply
                    .status(404)
                    .send({error: 'Not Found', message: 'No such surfaced practice for this metric'});
            }

            // Append-only: each view is a fresh row (no per-developer/metric dedup
            // here, matching Toprope's append-only posture). The 6.2.4 correlation
            // tolerates repeat rows by anchoring on each developer's FIRST engagement,
            // so a developer re-viewing a practice cannot skew the sample beyond their
            // single first-engagement contribution.
            const event = recordUsageEvent(db, {
                contributionId: request.params.id,
                developerId,
                event: 'viewed',
                metricContext: metric,
            });
            // Return a lean projection — the client only needs to know the view was
            // recorded; don't echo the internal row (developerId/occurredAt) verbatim.
            return reply.status(201).send({data: {id: event.id, event: event.event}});
        },
    );
}
