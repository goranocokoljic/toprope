/**
 * Private "How Could This Be Better" routes (Task 6.5 / #174).
 *
 * The SEPARATE, purpose-built tool for self-directed improvement — its OWN entry
 * point under /api/me/improvement-reviews, distinct from the showcase surface.
 * The session middleware confines these routes to the authenticated developer and
 * the developer id comes STRICTLY from the session (never request input), so a
 * developer can only run/read/delete reviews for their OWN conversations.
 * Invariants enforced here and verified by tests:
 *
 *  1. SELF-SCOPED. A developer can run it ONLY on their own captured sessions;
 *     another developer's id yields 404 (the session-decrypt is owner-scoped) and
 *     reads/deletes of another's review yield 404, never their content.
 *  2. LOCAL-DEFAULT, CLOUD-GATED. Analysis defaults to a local model; cloud runs
 *     ONLY under the Phase 5 double-opt-in (org permits cloud analysis AND the
 *     developer opted in), resolved live per request via the shared gate.
 *  3. FULLY PRIVATE. There is NO publish route and NO manager/admin path here —
 *     an improvement review is never shared outward. This is deliberately separate
 *     from the showcase publish flow: there is no accidental publish path.
 *  4. NO PLAINTEXT LEAK. The developer's key arrives transiently for the operation
 *     and is never stored or logged; the generator decrypts in memory and persists
 *     only the analysis output. These routes never log the key, the body, or any
 *     decrypted content.
 *
 * Generation additionally requires capture enabled for the developer (opt-in #1) —
 * there is nothing to analyse otherwise.
 */

import type {FastifyInstance, FastifyReply} from 'fastify';
import type Database from 'better-sqlite3';
import {requireDeveloperId} from './guards';
import {getDeveloperById} from '../../registry/developers';
import {
    generateImprovementReview,
    ImprovementError,
    type ImprovementAnalyzers,
    type ImprovementErrorCode,
} from '../../coaching/improvement/generator';
import {LocalHeuristicImprovementAnalyzer} from '../../coaching/improvement/analyzer';
import {
    deleteImprovementReviewForDeveloper,
    getImprovementReviewForDeveloper,
    listImprovementReviewsForDeveloper,
} from '../../coaching/improvement/store';
import {isAnalysisLocation, type AnalysisLocation} from '../../coaching/improvement/types';
import {asObject, badRequest, decodeCaptureKey, rejectUnknownKeys} from './body-validation';
import {cloudAllowedFor, ensureCaptureEnabled} from './coaching-gates';

// Allowlist exactly the fields the generate route accepts. The body legitimately
// carries the developer's key (the one transient secret), but any unexpected field
// is refused so the body stays a known, bounded shape.
const GENERATE_KEYS = ['session_id', 'key', 'analysis_location'] as const;

const MAX_SESSION_ID_LEN = 256;

/** Map a generator error code to its HTTP status + stable response code. */
const ERROR_STATUS: Record<ImprovementErrorCode, number> = {
    no_captures: 404,
    cloud_not_allowed: 403,
    cloud_not_configured: 503,
    decrypt_failed: 422,
};

/** Send the typed generator error as its mapped HTTP status; rethrow anything else. */
function sendGeneratorError(err: unknown, reply: FastifyReply): FastifyReply {
    if (err instanceof ImprovementError) {
        return reply.status(ERROR_STATUS[err.code]).send({error: 'Improvement error', code: err.code, message: err.message});
    }
    throw err;
}

export function registerImprovementReviewRoutes(
    app: FastifyInstance,
    db: Database.Database,
    analyzers?: ImprovementAnalyzers,
): void {
    // Default wiring: the bundled self-contained LOCAL analyser, no cloud model.
    // A deployment with a cloud model passes its own analyzers (local + cloud).
    const resolvedAnalyzers: ImprovementAnalyzers = analyzers ?? {local: new LocalHeuristicImprovementAnalyzer()};

    /**
     * Run "how could this be better" on one of the developer's OWN captured
     * conversations. Requires capture enabled (opt-in #1). Body:
     * { session_id, key (base64 AES-256), analysis_location? }. Cloud is honored
     * only under the Phase 5 double-opt-in.
     *
     * Additive, mirroring the retrospective: re-running for the same conversation
     * inserts a fresh review rather than replacing the prior one, so a developer
     * keeps a history (e.g. a local pass and a later cloud pass). They own and can
     * delete any they don't want.
     */
    app.post<{Body: unknown}>('/api/me/improvement-reviews', async (request, reply) => {
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
            const review = await generateImprovementReview(db, {
                developerId,
                sessionId,
                key,
                requestedLocation,
                cloudAllowed: cloudAllowedFor(db, userId, team),
                analyzers: resolvedAnalyzers,
            });
            return reply.status(201).send({data: review});
        } catch (err) {
            return sendGeneratorError(err, reply);
        }
    });

    /** List the developer's own improvement reviews, newest first. Always readable by the owner. */
    app.get('/api/me/improvement-reviews', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        return {data: listImprovementReviewsForDeveloper(db, developerId)};
    });

    /** Fetch one of the developer's own improvement reviews. Owner-scoped; 404 otherwise. */
    app.get<{Params: {id: string}}>('/api/me/improvement-reviews/:id', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const review = getImprovementReviewForDeveloper(db, developerId, request.params.id);
        if (!review) {
            return reply.status(404).send({error: 'Not Found', message: 'Improvement review not found'});
        }
        return {data: review};
    });

    /** Delete one of the developer's own improvement reviews. Owner-scoped; 404 otherwise. */
    app.delete<{Params: {id: string}}>('/api/me/improvement-reviews/:id', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const deleted = deleteImprovementReviewForDeveloper(db, developerId, request.params.id);
        if (!deleted) {
            return reply.status(404).send({error: 'Not Found', message: 'Improvement review not found'});
        }
        return {data: {deleted: true}};
    });
}
