/**
 * Real-time loop/nudge coaching routes (Task 5.6 / #127).
 *
 * Loop detection and nudges run LOCALLY at the capture layer; these routes only
 * receive the NON-SENSITIVE METADATA a developer chooses to sync (a loop's
 * similar-prompt count, a nudge's type, timestamps) and let the developer read
 * back and dismiss their own events. Two invariants, enforced here and tested:
 *
 *  1. METADATA ONLY. The record routes ALLOWLIST exactly the metadata fields they
 *     accept and reject any other key, so prompt content cannot reach the server
 *     even under an unanticipated field name — backing the schema's structural
 *     no-content guarantee (the same allowlist posture as the capture routes).
 *
 *  2. PRIVATE TO THE DEVELOPER. Every route lives under /api/me and derives the
 *     developer id from the session, never from input — so a developer can only
 *     record/read/dismiss their OWN events and there is no manager path here.
 *
 * Recording is additionally INERT (403) unless nudges are enabled for the
 * developer (Task 5.10 `nudges_enabled`), resolved live per request — so opting
 * out stops the metadata sync at once.
 */

import type {FastifyInstance, FastifyReply} from 'fastify';
import type Database from 'better-sqlite3';
import {requireDeveloperId} from './guards';
import {getDeveloperById} from '../../registry/developers';
import {nudgeGate, resolveNudgeSettings} from '../../coaching/realtime/settings';
import {
    dismissNudgeEvent,
    insertLoopEvent,
    insertNudgeEvent,
    listLoopEventsForDeveloper,
    listNudgeEventsForDeveloper,
} from '../../coaching/realtime/store';
import {isNudgeType} from '../../coaching/realtime/types';
import {asObject, badRequest} from './body-validation';

// The exact metadata fields each record route accepts. Allowlisting (rather than
// denylisting guessed "content" field names) is the house pattern for this
// concern — see validateMetaAllowlist in body-validation.ts — and is strictly
// stronger: ANY unexpected field, including a differently-named or nested attempt
// to smuggle prompt content, is refused outright, so the body that reaches the
// handler is always a known, flat, metadata-only shape.
const LOOP_EVENT_KEYS = ['session_id', 'detected_at', 'similar_prompt_count'] as const;
const NUDGE_EVENT_KEYS = ['session_id', 'nudge_type', 'delivered_at'] as const;

const MAX_SESSION_ID_LEN = 256;
// A loop is a handful of similar prompts; cap the count well above any real loop so
// a malformed producer can't store an absurd value, while never rejecting a real one.
const MAX_SIMILAR_PROMPT_COUNT = 10000;

/**
 * Reject a body carrying any key outside the route's allowlist. Returns false
 * (sent 400) on the first unexpected field, so prompt content can't reach the
 * server even under a field name we didn't anticipate — the structural backing
 * for the metadata-only guarantee.
 */
function rejectUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], reply: FastifyReply): boolean {
    for (const key of Object.keys(obj)) {
        if (!allowed.includes(key)) {
            badRequest(
                reply,
                `Field '${key}' is not accepted: loop/nudge events are metadata only and accept exactly ${allowed.join(', ')}`,
            );
            return false;
        }
    }
    return true;
}

/** Validate session_id: required, non-empty, bounded. Returns the trimmed value or null (sent 400). */
function validateSessionId(obj: Record<string, unknown>, reply: FastifyReply): string | null {
    const sessionId = typeof obj.session_id === 'string' ? obj.session_id.trim() : '';
    if (!sessionId) {
        badRequest(reply, 'session_id is required');
        return null;
    }
    if (sessionId.length > MAX_SESSION_ID_LEN) {
        badRequest(reply, `session_id exceeds the ${MAX_SESSION_ID_LEN}-character limit`);
        return null;
    }
    return sessionId;
}

/** Normalize an optional ISO timestamp to canonical UTC, defaulting to now. Null (sent 400) on bad input. */
function normalizeTimestamp(raw: unknown, field: string, reply: FastifyReply): string | null {
    if (raw === undefined || raw === null) {
        return new Date().toISOString();
    }
    if (typeof raw === 'string') {
        const parsed = new Date(raw);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toISOString();
        }
    }
    badRequest(reply, `${field} must be an ISO timestamp string`);
    return null;
}

export function registerRealtimeCoachingRoutes(app: FastifyInstance, db: Database.Database): void {
    /**
     * The developer's resolved real-time coaching settings, so their local agent/
     * extension knows whether nudges are on, at what frequency, and whether they're
     * dismissible. Reflects Task 5.10 prefs + org policy, resolved for their team.
     */
    app.get('/api/me/coaching/realtime-settings', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const team = getDeveloperById(db, developerId)?.team ?? null;
        return {data: resolveNudgeSettings(db, request.authUser!.userId, team)};
    });

    /**
     * Record one loop-detection metadata event. Inert (403) when nudges are off.
     * Body: { session_id, detected_at?, similar_prompt_count }. No content fields.
     */
    app.post<{Body: unknown}>('/api/me/coaching/loop-events', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const team = getDeveloperById(db, developerId)?.team ?? null;
        const gate = nudgeGate(db, request.authUser!.userId, team);
        if (!gate.enabled) {
            return reply.status(403).send({error: 'Forbidden', code: 'nudges_not_enabled', message: gate.reason});
        }

        const obj = asObject(request.body);
        if (!obj) {
            badRequest(reply, 'Request body must be an object');
            return reply;
        }
        if (!rejectUnknownKeys(obj, LOOP_EVENT_KEYS, reply)) {
            return reply;
        }
        const sessionId = validateSessionId(obj, reply);
        if (!sessionId) {
            return reply;
        }
        const detectedAt = normalizeTimestamp(obj.detected_at, 'detected_at', reply);
        if (!detectedAt) {
            return reply;
        }
        if (
            typeof obj.similar_prompt_count !== 'number' ||
            !Number.isInteger(obj.similar_prompt_count) ||
            obj.similar_prompt_count < 0 ||
            obj.similar_prompt_count > MAX_SIMILAR_PROMPT_COUNT
        ) {
            badRequest(reply, 'similar_prompt_count must be a non-negative integer');
            return reply;
        }

        const event = insertLoopEvent(db, developerId, {
            sessionId,
            detectedAt,
            similarPromptCount: obj.similar_prompt_count,
        });
        return reply.status(201).send({data: event});
    });

    /**
     * Record one nudge-delivery metadata event. Inert (403) when nudges are off.
     * Body: { session_id, nudge_type, delivered_at? }. No content fields.
     */
    app.post<{Body: unknown}>('/api/me/coaching/nudge-events', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const team = getDeveloperById(db, developerId)?.team ?? null;
        const gate = nudgeGate(db, request.authUser!.userId, team);
        if (!gate.enabled) {
            return reply.status(403).send({error: 'Forbidden', code: 'nudges_not_enabled', message: gate.reason});
        }

        const obj = asObject(request.body);
        if (!obj) {
            badRequest(reply, 'Request body must be an object');
            return reply;
        }
        if (!rejectUnknownKeys(obj, NUDGE_EVENT_KEYS, reply)) {
            return reply;
        }
        const sessionId = validateSessionId(obj, reply);
        if (!sessionId) {
            return reply;
        }
        if (!isNudgeType(obj.nudge_type)) {
            badRequest(reply, 'nudge_type must be one of: short_prompt, missing_context, missing_error, repeated_prompt');
            return reply;
        }
        const deliveredAt = normalizeTimestamp(obj.delivered_at, 'delivered_at', reply);
        if (!deliveredAt) {
            return reply;
        }

        const event = insertNudgeEvent(db, developerId, {sessionId, nudgeType: obj.nudge_type, deliveredAt});
        return reply.status(201).send({data: event});
    });

    /** List the developer's own loop events (metadata only), newest first. */
    app.get('/api/me/coaching/loop-events', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        return {data: listLoopEventsForDeveloper(db, developerId)};
    });

    /** List the developer's own nudge events (metadata only), newest first. */
    app.get('/api/me/coaching/nudge-events', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        return {data: listNudgeEventsForDeveloper(db, developerId)};
    });

    /**
     * Dismiss one of the developer's own nudge events. Owner-scoped: another
     * developer's id yields 404, never a cross-developer mutation. Recording the
     * dismissal is metadata only and never blocks the developer's action.
     */
    app.post<{Params: {id: string}}>('/api/me/coaching/nudge-events/:id/dismiss', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const dismissed = dismissNudgeEvent(db, developerId, request.params.id);
        if (!dismissed) {
            return reply.status(404).send({error: 'Not Found', message: 'Nudge event not found'});
        }
        return {data: {dismissed: true}};
    });
}
