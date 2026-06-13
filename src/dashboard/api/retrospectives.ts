/**
 * Session-retrospective routes (Task 5.7 / #128).
 *
 * The deep async coaching surface. All routes live under /api/me, so the session
 * middleware confines them to the authenticated developer and the developer id
 * comes STRICTLY from the session (never request input) — a developer can only
 * generate/read/delete/ask-about their OWN retrospectives, and there is no
 * manager path here. Invariants enforced here and verified by tests:
 *
 *  1. PRIVATE TO THE DEVELOPER. Owner-scoped reads/writes; another developer's id
 *     yields 404, never their narrative.
 *  2. LOCAL-DEFAULT, CLOUD-GATED. Analysis defaults to a local model; cloud runs
 *     ONLY when the org permits cloud analysis AND the developer opted in (opt-in
 *     #2), resolved live per request.
 *  3. NO PLAINTEXT LEAK. The developer's key arrives transiently for the operation
 *     and is never stored or logged; the generator decrypts in memory and persists
 *     only the analysis output. These routes never log the key, the body, or any
 *     decrypted content.
 *
 * Generation additionally requires capture to be enabled for the developer (opt-in
 * #1) — there is nothing to analyze otherwise — resolved live via `captureGate`.
 */

import type {FastifyInstance, FastifyReply} from 'fastify';
import type Database from 'better-sqlite3';
import {requireDeveloperId} from './guards';
import {getDeveloperById} from '../../registry/developers';
import {captureGate} from '../../capture/gate';
import {resolveDeveloperPreferences} from '../../settings/store';
import {
    answerFollowUp,
    generateRetrospective,
    RetrospectiveError,
    type RetrospectiveAnalyzers,
    type RetrospectiveErrorCode,
} from '../../coaching/retrospective/generator';
import {LocalHeuristicAnalyzer} from '../../coaching/retrospective/analyzer';
import {
    deleteRetrospectiveForDeveloper,
    getRetrospectiveForDeveloper,
    listRetrospectivesForDeveloper,
} from '../../coaching/retrospective/store';
import {isAnalysisLocation, type AnalysisLocation} from '../../coaching/retrospective/types';
import {asObject, badRequest, decodeCaptureKey} from './body-validation';

// Allowlist exactly the fields each route accepts. The generate/follow-up bodies
// legitimately carry the developer's key (the one transient secret), so unlike the
// blind-store routes we don't blanket-reject "content" — but we DO refuse any
// unexpected field so a body stays a known, bounded shape.
const GENERATE_KEYS = ['session_id', 'key', 'analysis_location'] as const;
const FOLLOWUP_KEYS = ['question', 'key'] as const;

const MAX_SESSION_ID_LEN = 256;
const MAX_QUESTION_LEN = 2000;

/** Map a generator error code to its HTTP status + stable response code. */
const ERROR_STATUS: Record<RetrospectiveErrorCode, number> = {
    no_captures: 404,
    cloud_not_allowed: 403,
    cloud_not_configured: 503,
    decrypt_failed: 422,
};

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], reply: FastifyReply): boolean {
    for (const key of Object.keys(obj)) {
        if (!allowed.includes(key)) {
            badRequest(reply, `Field '${key}' is not accepted; this route accepts exactly ${allowed.join(', ')}`);
            return false;
        }
    }
    return true;
}

/** Send the typed generator error as its mapped HTTP status; rethrow anything else. */
function sendGeneratorError(err: unknown, reply: FastifyReply): FastifyReply {
    if (err instanceof RetrospectiveError) {
        return reply.status(ERROR_STATUS[err.code]).send({error: 'Retrospective error', code: err.code, message: err.message});
    }
    throw err;
}

/** Resolve whether cloud analysis is currently permitted for this developer (org permits AND opted in). */
function cloudAllowedFor(db: Database.Database, userId: string, team: string | null): boolean {
    return resolveDeveloperPreferences(db, userId, team).cloud_analysis_opt_in?.value === true;
}

/**
 * Enforce the capture opt-in gate (opt-in #1) for the operations that TRANSIENTLY
 * decrypt session plaintext — generation AND conversational follow-up. Both are
 * "deep analysis" over freshly decrypted prompts, so both are inert (403) once a
 * developer has opted out of capture: opting out must stop new plaintext handling,
 * not just new captures. (Owner-scoped reads/deletes of already-stored output stay
 * ungated — they touch no plaintext.) Returns false and sends the 403 when blocked.
 */
function ensureCaptureEnabled(db: Database.Database, userId: string, team: string | null, reply: FastifyReply): boolean {
    const gate = captureGate(db, userId, team);
    if (!gate.enabled) {
        reply.status(403).send({
            error: 'Forbidden',
            code: 'capture_not_enabled',
            message: gate.reason ?? 'Prompt capture is not enabled for your account.',
        });
        return false;
    }
    return true;
}

export function registerRetrospectiveRoutes(
    app: FastifyInstance,
    db: Database.Database,
    analyzers?: RetrospectiveAnalyzers,
): void {
    // Default wiring: the bundled self-contained LOCAL analyser, no cloud model.
    // A deployment with a cloud model passes its own analyzers (local + cloud).
    const resolvedAnalyzers: RetrospectiveAnalyzers = analyzers ?? {local: new LocalHeuristicAnalyzer()};

    /**
     * Generate a retrospective for one captured session. Requires capture enabled
     * (opt-in #1). Body: { session_id, key (base64 AES-256), analysis_location? }.
     * Cloud is honored only when the org permits AND the developer opted in.
     *
     * Generation is deliberately ADDITIVE, mirroring the issue's schema (id PK, no
     * uniqueness on session_id): re-running for the same session inserts a fresh
     * retrospective rather than replacing the prior one, so a developer keeps a
     * history of analyses (and can run both a local and a later cloud pass over the
     * same session). They own and can delete any they don't want.
     */
    app.post<{Body: unknown}>('/api/me/retrospectives', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const userId = request.authUser!.userId;
        const team = getDeveloperById(db, developerId)?.team ?? null;

        if (!ensureCaptureEnabled(db, userId, team, reply)) {
            return reply;
        }

        const obj = asObject(request.body);
        if (!obj) {
            badRequest(reply, 'Request body must be an object');
            return reply;
        }
        if (!rejectUnknownKeys(obj, GENERATE_KEYS, reply)) {
            return reply;
        }

        const sessionId = typeof obj.session_id === 'string' ? obj.session_id.trim() : '';
        if (!sessionId) {
            badRequest(reply, 'session_id is required');
            return reply;
        }
        if (sessionId.length > MAX_SESSION_ID_LEN) {
            badRequest(reply, `session_id exceeds the ${MAX_SESSION_ID_LEN}-character limit`);
            return reply;
        }

        let requestedLocation: AnalysisLocation = 'local';
        if (obj.analysis_location !== undefined) {
            if (!isAnalysisLocation(obj.analysis_location)) {
                badRequest(reply, 'analysis_location must be one of: local, cloud');
                return reply;
            }
            requestedLocation = obj.analysis_location;
        }

        const key = decodeCaptureKey(obj.key, reply);
        if (!key) {
            return reply;
        }

        try {
            const retrospective = await generateRetrospective(db, {
                developerId,
                sessionId,
                key,
                requestedLocation,
                cloudAllowed: cloudAllowedFor(db, userId, team),
                analyzers: resolvedAnalyzers,
            });
            return reply.status(201).send({data: retrospective});
        } catch (err) {
            return sendGeneratorError(err, reply);
        }
    });

    /** List the developer's own retrospectives, newest first. Always readable by the owner. */
    app.get('/api/me/retrospectives', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        return {data: listRetrospectivesForDeveloper(db, developerId)};
    });

    /** Fetch one of the developer's own retrospectives. Owner-scoped; 404 otherwise. */
    app.get<{Params: {id: string}}>('/api/me/retrospectives/:id', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const retrospective = getRetrospectiveForDeveloper(db, developerId, request.params.id);
        if (!retrospective) {
            return reply.status(404).send({error: 'Not Found', message: 'Retrospective not found'});
        }
        return {data: retrospective};
    });

    /** Delete one of the developer's own retrospectives. Owner-scoped; 404 otherwise. */
    app.delete<{Params: {id: string}}>('/api/me/retrospectives/:id', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const deleted = deleteRetrospectiveForDeveloper(db, developerId, request.params.id);
        if (!deleted) {
            return reply.status(404).send({error: 'Not Found', message: 'Retrospective not found'});
        }
        return {data: {deleted: true}};
    });

    /**
     * Conversational follow-up on one of the developer's own retrospectives
     * ("why was this flagged?"). Body: { question, key }. Answered with the SAME
     * location the retrospective used; a cloud retrospective re-checks the live
     * cloud permission, so a revoked opt-in stops further cloud turns. The answer
     * is conversational and not persisted.
     *
     * Like generation, follow-up TRANSIENTLY decrypts the session, so it requires
     * capture still enabled (opt-in #1): opting out halts all fresh plaintext
     * handling, not just new captures. (Reading/deleting the stored retrospective
     * stays ungated — that output holds no plaintext.)
     */
    app.post<{Params: {id: string}; Body: unknown}>('/api/me/retrospectives/:id/followup', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const retrospective = getRetrospectiveForDeveloper(db, developerId, request.params.id);
        if (!retrospective) {
            return reply.status(404).send({error: 'Not Found', message: 'Retrospective not found'});
        }

        const userId = request.authUser!.userId;
        const team = getDeveloperById(db, developerId)?.team ?? null;
        if (!ensureCaptureEnabled(db, userId, team, reply)) {
            return reply;
        }

        const obj = asObject(request.body);
        if (!obj) {
            badRequest(reply, 'Request body must be an object');
            return reply;
        }
        if (!rejectUnknownKeys(obj, FOLLOWUP_KEYS, reply)) {
            return reply;
        }

        const question = typeof obj.question === 'string' ? obj.question.trim() : '';
        if (!question) {
            badRequest(reply, 'question is required');
            return reply;
        }
        if (question.length > MAX_QUESTION_LEN) {
            badRequest(reply, `question exceeds the ${MAX_QUESTION_LEN}-character limit`);
            return reply;
        }

        const key = decodeCaptureKey(obj.key, reply);
        if (!key) {
            return reply;
        }

        try {
            const answer = await answerFollowUp(db, {
                developerId,
                retrospective,
                key,
                question,
                cloudAllowed: cloudAllowedFor(db, userId, team),
                analyzers: resolvedAnalyzers,
            });
            return {data: {answer, analysisLocation: retrospective.analysisLocation}};
        } catch (err) {
            return sendGeneratorError(err, reply);
        }
    });
}
