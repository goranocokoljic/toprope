/**
 * Showcase promote/redact/publish routes (Task 5.8 / #129).
 *
 * The bridge from a developer's PRIVATE encrypted capture to an ORG-VISIBLE
 * example — and the one place the "sharing is always a deliberate owner act"
 * contract is enforced at the HTTP edge. Every route lives under /api/me, so the
 * session middleware confines them to the authenticated developer and the
 * developer id comes STRICTLY from the session, never request input. Invariants
 * enforced here and verified by tests:
 *
 *  1. OWNER-ONLY PROMOTE, NO OTHER PATH. Both promote (draft) and publish key off
 *     one of the developer's OWN retrospectives, looked up owner-scoped — a
 *     retrospective that isn't theirs yields 404. A manager/admin has no developer
 *     profile, so /api/me/* is 404 for them: there is structurally no path for
 *     anyone to promote or publish on a developer's behalf.
 *  2. MANDATORY REDACTION. Publish is refused (400) unless the owner explicitly
 *     acknowledges they reviewed and redacted the draft. The redaction step cannot
 *     be bypassed.
 *  3. SEPARATE SHARED STORE, CAPTURE UNTOUCHED. Publish persists ONLY the owner's
 *     submitted redacted content to showcase_examples; it never reads or modifies
 *     prompt_captures. Nothing is auto-harvested — the draft's decrypted plaintext
 *     is returned to the owner to redact and is never persisted or logged.
 *  4. SCOPE WITHIN ORG POLICY. The chosen scope must be within the org's
 *     showcase_scope_permitted (resolved for the developer's team), and showcasing
 *     must be enabled — both resolved live in the service.
 */

import type {FastifyInstance, FastifyReply} from 'fastify';
import type Database from 'better-sqlite3';
import {requireDeveloperId} from './guards';
import {getDeveloperById} from '../../registry/developers';
import {captureGate} from '../../capture/gate';
import {getRetrospectiveForDeveloper} from '../../coaching/retrospective/store';
import {
    draftFromSession,
    publishExample,
    ShowcaseError,
    type ShowcaseErrorCode,
} from '../../showcase/service';
import {getShowcaseExampleForAuthor, listShowcaseExamplesByAuthor} from '../../showcase/store';
import {isShowcaseScope, type ShowcaseScope} from '../../showcase/types';
import {asObject, badRequest, decodeCaptureKey} from './body-validation';

// Allowlist exactly the fields each route accepts. The draft body legitimately
// carries the developer's key (the one transient secret); publish never does — it
// takes only the owner's already-redacted content, never ciphertext — so neither
// body should ever carry anything outside its known shape.
const DRAFT_KEYS = ['retrospective_id', 'key'] as const;
const PUBLISH_KEYS = [
    'retrospective_id',
    'scope',
    'title',
    'content',
    'task_type',
    'tool',
    'author_note',
    'redaction_acknowledged',
] as const;

const MAX_TITLE_LEN = 200;
const MAX_CONTENT_LEN = 100_000;
const MAX_TASK_TYPE_LEN = 64;
const MAX_TOOL_LEN = 64;
const MAX_NOTE_LEN = 2000;

/** Map a service error code to its HTTP status. */
const ERROR_STATUS: Record<ShowcaseErrorCode, number> = {
    no_captures: 404,
    decrypt_failed: 422,
    showcase_disabled: 403,
    scope_not_permitted: 403,
    redaction_required: 400,
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

/** Send the typed service error as its mapped HTTP status; rethrow anything else. */
function sendShowcaseError(err: unknown, reply: FastifyReply): FastifyReply {
    if (err instanceof ShowcaseError) {
        return reply.status(ERROR_STATUS[err.code]).send({error: 'Showcase error', code: err.code, message: err.message});
    }
    throw err;
}

/** Enforce the capture opt-in gate for the operation that transiently decrypts plaintext (the draft). */
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

/**
 * Validate an OPTIONAL bounded-string field: absent/null → null; a non-empty
 * string within `maxLen` → its trimmed value; anything else → 400. Used for the
 * publish form's optional descriptors (task_type, tool, author_note).
 */
function optionalString(value: unknown, field: string, maxLen: number, reply: FastifyReply): string | null | false {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'string') {
        badRequest(reply, `${field} must be a string`);
        return false;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return null;
    }
    if (trimmed.length > maxLen) {
        badRequest(reply, `${field} exceeds the ${maxLen}-character limit`);
        return false;
    }
    return trimmed;
}

export function registerShowcaseRoutes(app: FastifyInstance, db: Database.Database): void {
    /**
     * Promote: transiently decrypt one of the developer's OWN retrospectives'
     * sessions into an editable draft to redact. Body: { retrospective_id, key }.
     * Requires capture enabled (it handles fresh plaintext). The decrypted draft is
     * returned to the owner and never persisted or logged.
     */
    app.post<{Body: unknown}>('/api/me/showcase/draft', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }

        const obj = asObject(request.body);
        if (!obj) {
            badRequest(reply, 'Request body must be an object');
            return reply;
        }
        if (!rejectUnknownKeys(obj, DRAFT_KEYS, reply)) {
            return reply;
        }

        const retrospectiveId = typeof obj.retrospective_id === 'string' ? obj.retrospective_id.trim() : '';
        if (!retrospectiveId) {
            badRequest(reply, 'retrospective_id is required');
            return reply;
        }
        // Owner-scoped FIRST: promote has NO path other than the developer's own
        // retrospective. A retrospective that isn't theirs (or doesn't exist) is 404 —
        // resolved before the capture gate so a non-owner is never even told whether
        // their own capture is enabled for a resource that isn't theirs.
        const retrospective = getRetrospectiveForDeveloper(db, developerId, retrospectiveId);
        if (!retrospective) {
            return reply.status(404).send({error: 'Not Found', message: 'Retrospective not found'});
        }

        // The actual decrypt handles fresh plaintext, so the owner must still have
        // capture enabled (opting out halts all fresh plaintext handling).
        const userId = request.authUser!.userId;
        const team = getDeveloperById(db, developerId)?.team ?? null;
        if (!ensureCaptureEnabled(db, userId, team, reply)) {
            return reply;
        }

        const key = decodeCaptureKey(obj.key, reply);
        if (!key) {
            return reply;
        }

        try {
            const draft = draftFromSession(db, {developerId, sessionId: retrospective.sessionId, key});
            return {
                data: {
                    retrospectiveId,
                    sessionId: draft.sessionId,
                    draft: draft.plaintext,
                    captureCount: draft.captureCount,
                },
            };
        } catch (err) {
            return sendShowcaseError(err, reply);
        }
    });

    /**
     * Publish: write the owner's REDACTED content to the separate shared store.
     * Body: { retrospective_id, scope, title, content, redaction_acknowledged,
     * task_type?, tool?, author_note? }. No key — publish never decrypts; it
     * persists exactly the content the owner submits. Owner-scoped on the
     * retrospective (no other path); mandatory redaction acknowledgement; scope
     * within org policy — all enforced before any write.
     */
    app.post<{Body: unknown}>('/api/me/showcase', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const team = getDeveloperById(db, developerId)?.team ?? null;

        const obj = asObject(request.body);
        if (!obj) {
            badRequest(reply, 'Request body must be an object');
            return reply;
        }
        if (!rejectUnknownKeys(obj, PUBLISH_KEYS, reply)) {
            return reply;
        }

        const retrospectiveId = typeof obj.retrospective_id === 'string' ? obj.retrospective_id.trim() : '';
        if (!retrospectiveId) {
            badRequest(reply, 'retrospective_id is required');
            return reply;
        }
        // Owner-scoped: only the developer's OWN retrospective can be promoted. This
        // is what makes publish impossible on another developer's behalf.
        const retrospective = getRetrospectiveForDeveloper(db, developerId, retrospectiveId);
        if (!retrospective) {
            return reply.status(404).send({error: 'Not Found', message: 'Retrospective not found'});
        }

        if (!isShowcaseScope(obj.scope)) {
            badRequest(reply, 'scope must be one of: team, org');
            return reply;
        }
        const scope: ShowcaseScope = obj.scope;

        const title = typeof obj.title === 'string' ? obj.title.trim() : '';
        if (!title) {
            badRequest(reply, 'title is required');
            return reply;
        }
        if (title.length > MAX_TITLE_LEN) {
            badRequest(reply, `title exceeds the ${MAX_TITLE_LEN}-character limit`);
            return reply;
        }

        // The redacted content is the owner's; we require it non-empty but otherwise
        // store it verbatim — the server never alters what the owner chose to publish.
        const content = typeof obj.content === 'string' ? obj.content : '';
        if (content.trim().length === 0) {
            badRequest(reply, 'content is required');
            return reply;
        }
        if (content.length > MAX_CONTENT_LEN) {
            badRequest(reply, `content exceeds the ${MAX_CONTENT_LEN}-character limit`);
            return reply;
        }

        const taskType = optionalString(obj.task_type, 'task_type', MAX_TASK_TYPE_LEN, reply);
        if (taskType === false) {
            return reply;
        }
        const tool = optionalString(obj.tool, 'tool', MAX_TOOL_LEN, reply);
        if (tool === false) {
            return reply;
        }
        const authorNote = optionalString(obj.author_note, 'author_note', MAX_NOTE_LEN, reply);
        if (authorNote === false) {
            return reply;
        }

        // The redaction acknowledgement must be an explicit boolean true. A missing or
        // non-boolean flag is a malformed body (400); the service additionally refuses
        // to publish without it, so the mandatory step has belt-and-suspenders cover.
        if (typeof obj.redaction_acknowledged !== 'boolean') {
            badRequest(reply, 'redaction_acknowledged must be a boolean');
            return reply;
        }

        try {
            const example = publishExample(db, {
                authorDeveloperId: developerId,
                team,
                scope,
                title,
                content,
                taskType,
                tool,
                authorNote,
                redactionAcknowledged: obj.redaction_acknowledged,
            });
            return reply.status(201).send({data: example});
        } catch (err) {
            return sendShowcaseError(err, reply);
        }
    });

    /** List the developer's own published examples, newest first. Owner-scoped. */
    app.get('/api/me/showcase', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        return {data: listShowcaseExamplesByAuthor(db, developerId)};
    });

    /** Fetch one of the developer's own published examples. Owner-scoped; 404 otherwise. */
    app.get<{Params: {id: string}}>('/api/me/showcase/:id', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const example = getShowcaseExampleForAuthor(db, developerId, request.params.id);
        if (!example) {
            return reply.status(404).send({error: 'Not Found', message: 'Showcase example not found'});
        }
        return {data: example};
    });
}
