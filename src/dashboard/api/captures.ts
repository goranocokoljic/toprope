/**
 * Prompt-capture ingestion + private read routes (Task 5.4 / #125).
 *
 * All routes live under /api/me, so the session middleware confines them to the
 * authenticated developer and the developer id comes STRICTLY from the session
 * (never request input) — a developer can only ever ingest/read/delete their own
 * captures. Two invariants are enforced here and verified by tests:
 *
 *  1. STRICT OPT-IN GATE. Ingestion is inert (403) unless the developer opted in
 *     AND the org permits capture — resolved live per request via `captureGate`,
 *     so opting out (or an org/team turning capture off) stops capture at once.
 *
 *  2. CLIENT-SIDE ENCRYPTION ONLY. The server is a blind store: it accepts an
 *     already-encrypted payload (base64 ciphertext + public meta) and explicitly
 *     REJECTS any body that carries apparent plaintext or a raw key, so plaintext
 *     never reaches the server and is never logged or persisted.
 */

import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import type Database from 'better-sqlite3';
import {requireDeveloperId} from './guards';
import {getDeveloperById} from '../../registry/developers';
import {captureGate} from '../../capture/gate';
import {
    insertCapture,
    listCapturesForDeveloper,
    getCaptureForDeveloper,
    deleteCaptureForDeveloper,
} from '../../capture/store';
import {isCaptureMechanism} from '../../capture/types';

// Body keys that would indicate the client is sending readable content. The
// server REFUSES any payload carrying these — encryption is the client's job and
// plaintext must never reach the server, even transiently. This is a structural
// guard backing the privacy guarantee, not a content scan.
const FORBIDDEN_PLAINTEXT_KEYS = ['plaintext', 'prompts', 'responses', 'text', 'content', 'messages'];

// Strict base64 (no interior whitespace / non-base64 chars). The reference client
// emits canonical base64, so this rejects malformed input rather than letting
// Buffer.from silently drop stray characters into a different stored blob.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// Per-capture ciphertext cap (decoded bytes). A single captured session is bounded;
// without a cap an authenticated developer could write arbitrarily large blobs into
// the blind store (availability/storage-exhaustion). 512 KiB is generous for one
// session of prompts+responses.
const MAX_CIPHERTEXT_BYTES = 512 * 1024;

// Whole-request body cap for the ingestion route. Set comfortably above a
// max-ciphertext payload (512 KiB → ~683 KiB base64, plus meta/JSON overhead) so
// an over-cap ciphertext gets validateBody's clean 400 rather than an opaque 413,
// while a genuinely enormous body is still refused before the handler runs.
const CAPTURE_BODY_LIMIT = 1024 * 1024;

function badRequest(reply: FastifyReply, message: string): undefined {
    reply.status(400).send({error: 'Bad Request', message});
    return undefined;
}

function asObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

interface ValidatedCapture {
    sessionId: string;
    capturedAt: string;
    tool: string | null;
    ciphertext: Buffer;
    encryptionMeta: Record<string, unknown>;
    mechanism: 'local_agent' | 'editor_extension';
    promptCount: number | null;
}

/** Validate the (untrusted) ingestion body. Sends a 400 and returns null on any failure. */
function validateBody(body: unknown, reply: FastifyReply): ValidatedCapture | null {
    const obj = asObject(body);
    if (!obj) {
        badRequest(reply, 'Request body must be an object');
        return null;
    }

    // Refuse anything that looks like the caller is shipping readable content.
    for (const key of FORBIDDEN_PLAINTEXT_KEYS) {
        if (key in obj) {
            badRequest(
                reply,
                `Field '${key}' is not accepted: captures must be encrypted client-side and sent as ciphertext only`,
            );
            return null;
        }
    }

    const sessionId = typeof obj.session_id === 'string' ? obj.session_id.trim() : '';
    if (!sessionId) {
        badRequest(reply, 'session_id is required');
        return null;
    }

    // captured_at must be a valid timestamp; default to now when omitted. NORMALIZE
    // to canonical UTC ISO rather than storing the client string verbatim — Date.parse
    // accepts looser forms (date-only, offset-bearing) and the platform invariant is
    // that all stored timestamps are UTC ISO, which the captured_at index relies on.
    let capturedAt: string;
    if (obj.captured_at === undefined || obj.captured_at === null) {
        capturedAt = new Date().toISOString();
    } else if (typeof obj.captured_at === 'string' && !Number.isNaN(Date.parse(obj.captured_at))) {
        capturedAt = new Date(obj.captured_at).toISOString();
    } else {
        badRequest(reply, 'captured_at must be an ISO timestamp string');
        return null;
    }

    if (!isCaptureMechanism(obj.mechanism)) {
        badRequest(reply, 'mechanism must be one of: local_agent, editor_extension');
        return null;
    }
    const mechanism = obj.mechanism;

    if (typeof obj.ciphertext !== 'string' || !BASE64_RE.test(obj.ciphertext)) {
        badRequest(reply, 'ciphertext must be a non-empty base64 string');
        return null;
    }
    const ciphertext = Buffer.from(obj.ciphertext, 'base64');
    if (ciphertext.length === 0) {
        badRequest(reply, 'ciphertext must decode to non-empty bytes');
        return null;
    }
    if (ciphertext.length > MAX_CIPHERTEXT_BYTES) {
        badRequest(reply, `ciphertext exceeds the ${MAX_CIPHERTEXT_BYTES}-byte per-capture limit`);
        return null;
    }

    const meta = asObject(obj.encryption_meta);
    if (!meta) {
        badRequest(reply, 'encryption_meta must be an object');
        return null;
    }
    // The meta carries a key REFERENCE (key_id), never key material. Refuse a raw
    // key outright so a misbehaving client can't smuggle the key into the store.
    if ('key' in meta || 'secret' in meta) {
        badRequest(reply, 'encryption_meta must not contain a key; it stores a key_id reference only');
        return null;
    }
    for (const field of ['algo', 'iv', 'auth_tag', 'key_id']) {
        if (typeof meta[field] !== 'string' || (meta[field] as string).length === 0) {
            badRequest(reply, `encryption_meta.${field} is required`);
            return null;
        }
    }

    let tool: string | null = null;
    if (obj.tool !== undefined && obj.tool !== null) {
        if (typeof obj.tool !== 'string') {
            badRequest(reply, 'tool must be a string');
            return null;
        }
        tool = obj.tool.trim() || null;
    }

    let promptCount: number | null = null;
    if (obj.prompt_count !== undefined && obj.prompt_count !== null) {
        if (typeof obj.prompt_count !== 'number' || !Number.isInteger(obj.prompt_count) || obj.prompt_count < 0) {
            badRequest(reply, 'prompt_count must be a non-negative integer');
            return null;
        }
        promptCount = obj.prompt_count;
    }

    return {sessionId, capturedAt, tool, ciphertext, encryptionMeta: meta, mechanism, promptCount};
}

export function registerCaptureRoutes(app: FastifyInstance, db: Database.Database): void {
    /**
     * Ingest one already-encrypted capture. Inert (403) unless capture is enabled
     * for the developer (opted in AND org permits). The body must be ciphertext +
     * public meta; plaintext/raw-key fields are rejected (400).
     */
    app.post<{Body: unknown}>('/api/me/captures', {bodyLimit: CAPTURE_BODY_LIMIT}, async (request: FastifyRequest<{Body: unknown}>, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const userId = request.authUser!.userId;
        const team = getDeveloperById(db, developerId)?.team ?? null;

        const gate = captureGate(db, userId, team);
        if (!gate.enabled) {
            return reply.status(403).send({
                error: 'Forbidden',
                code: 'capture_not_enabled',
                message: gate.reason ?? 'Prompt capture is not enabled for your account.',
            });
        }

        const valid = validateBody(request.body, reply);
        if (!valid) {
            return reply;
        }

        const summary = insertCapture(db, {
            developerId,
            sessionId: valid.sessionId,
            capturedAt: valid.capturedAt,
            tool: valid.tool,
            ciphertext: valid.ciphertext,
            encryptionMeta: valid.encryptionMeta,
            mechanism: valid.mechanism,
            promptCount: valid.promptCount,
        });
        return reply.status(201).send({data: summary});
    });

    /** List the developer's own captures (metadata only, no ciphertext). */
    app.get('/api/me/captures', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        return {data: listCapturesForDeveloper(db, developerId)};
    });

    /**
     * Fetch one of the developer's own captures WITH its ciphertext, so the
     * developer's client can decrypt it locally. Scoped to the owner: another
     * developer's id yields 404, never their encrypted payload.
     */
    app.get<{Params: {id: string}}>('/api/me/captures/:id', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const capture = getCaptureForDeveloper(db, developerId, request.params.id);
        if (!capture) {
            return reply.status(404).send({error: 'Not Found', message: 'Capture not found'});
        }
        return {data: capture};
    });

    /** Delete one of the developer's own captures. Owner-scoped; 404 otherwise. */
    app.delete<{Params: {id: string}}>('/api/me/captures/:id', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const deleted = deleteCaptureForDeveloper(db, developerId, request.params.id);
        if (!deleted) {
            return reply.status(404).send({error: 'Not Found', message: 'Capture not found'});
        }
        return {data: {deleted: true}};
    });
}
