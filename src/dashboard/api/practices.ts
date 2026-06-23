/**
 * Best-practice authoring routes (Task 6.2.3 / #158).
 *
 * The HTTP edge of the rich authoring editor. Every route lives under /api/me, so
 * the session middleware confines it to the authenticated developer and the author
 * id comes STRICTLY from the session, never request input. Invariants enforced here:
 *
 *  1. OWNER-SCOPED. Save / read / history / revert all key off one of the developer's
 *     OWN best practices, looked up author-scoped — a practice that isn't theirs (or
 *     isn't a best practice) is indistinguishable from a missing one (404). There is
 *     structurally no path to edit another developer's practice through this surface.
 *  2. SCOPE INTEGRITY. A team-scoped practice is pinned to the AUTHOR'S team, resolved
 *     server-side from their developer record — the client never names the team, so it
 *     cannot publish into another team's scope.
 *  3. SAFE PREVIEW. The preview/read render is sanitized by the authoring engine, so
 *     no markdown a developer types can return executable script to a viewer.
 *
 * Rendering, sanitization, metric-ref→tag extraction, and save-through-versioning all
 * live in the authoring engine (src/practices/authoring.ts); these handlers only
 * validate the request shape, resolve ownership/scope, and map typed errors to status.
 */

import type {FastifyInstance, FastifyReply} from 'fastify';
import type Database from 'better-sqlite3';
import {requireDeveloperId} from './guards';
import {asObject, badRequest, rejectUnknownKeys} from './body-validation';
import {getDeveloperById} from '../../registry/developers';
import {getContribution, listContributions} from '../../contributions/store';
import {getVersionHistory, VersioningError, type VersioningErrorCode} from '../../contributions/versioning';
import {isContributionScope, type Contribution} from '../../contributions/types';
import {
    AuthoringError,
    createPractice,
    getPracticeView,
    MAX_PRACTICE_MARKDOWN_LEN,
    MAX_PRACTICE_TITLE_LEN,
    PRACTICE_CONTENT_TYPE,
    renderPractice,
    revertPractice,
    savePractice,
    type AuthoringErrorCode,
} from '../../practices/authoring';

const CREATE_KEYS = ['title', 'scope', 'markdown', 'change_note', 'model_used'] as const;
const PREVIEW_KEYS = ['markdown'] as const;
const SAVE_KEYS = ['markdown', 'change_note'] as const;
const REVERT_KEYS = ['version', 'change_note'] as const;

const MAX_CHANGE_NOTE_LEN = 2000;
const MAX_MODEL_USED_LEN = 64;

const AUTHORING_ERROR_STATUS: Record<AuthoringErrorCode, number> = {
    empty_markdown: 400,
    empty_title: 400,
    not_a_practice: 404,
};

const VERSIONING_ERROR_STATUS: Record<VersioningErrorCode, number> = {
    not_found: 404,
    version_not_found: 404,
    contribution_removed: 409,
    empty_body: 400,
    invalid_actor: 400,
};

/** Map a typed authoring/versioning error to its HTTP status; rethrow anything else. */
function sendAuthoringError(err: unknown, reply: FastifyReply): FastifyReply {
    if (err instanceof AuthoringError) {
        return reply
            .status(AUTHORING_ERROR_STATUS[err.code])
            .send({error: 'Authoring error', code: err.code, message: err.message});
    }
    if (err instanceof VersioningError) {
        return reply
            .status(VERSIONING_ERROR_STATUS[err.code])
            .send({error: 'Versioning error', code: err.code, message: err.message});
    }
    throw err;
}

/**
 * Load a best practice owned by `developerId`, or undefined. The single home for
 * this surface's ownership rule: it 404s identically for a missing id, a non-practice
 * contribution, and another developer's practice — none of which this developer may
 * touch — so the response never reveals which of those it was.
 */
function loadOwnedPractice(db: Database.Database, developerId: string, id: string): Contribution | undefined {
    const contribution = getContribution(db, id);
    if (!contribution || contribution.contentType !== PRACTICE_CONTENT_TYPE || contribution.authorId !== developerId) {
        return undefined;
    }
    return contribution;
}

/**
 * Validate an optional bounded string field: absent/null → null; a non-empty string
 * within `maxLen` → its trimmed value; anything else → 400 (returns false).
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

/**
 * Validate the markdown field: a non-empty string within the size bound, or 400
 * (returns null). Empty/whitespace is rejected here AND by the engine, so the
 * mandatory-content rule has belt-and-suspenders cover.
 */
function requireMarkdown(value: unknown, reply: FastifyReply): string | null {
    if (typeof value !== 'string' || value.trim().length === 0) {
        badRequest(reply, 'markdown is required');
        return null;
    }
    if (value.length > MAX_PRACTICE_MARKDOWN_LEN) {
        badRequest(reply, `markdown exceeds the ${MAX_PRACTICE_MARKDOWN_LEN}-character limit`);
        return null;
    }
    return value;
}

export function registerPracticeAuthoringRoutes(app: FastifyInstance, db: Database.Database): void {
    /**
     * Create a best practice from markdown. Body: { title, scope, markdown,
     * change_note?, model_used? }. A team scope pins to the AUTHOR'S team (resolved
     * server-side); an org scope is org-wide. Returns the new contribution (state
     * draft) and the metric tags its references produced.
     */
    app.post<{Body: unknown}>('/api/me/practices', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }

        const obj = asObject(request.body);
        if (!obj) {
            badRequest(reply, 'Request body must be an object');
            return reply;
        }
        if (!rejectUnknownKeys(obj, CREATE_KEYS, reply)) {
            return reply;
        }

        const title = typeof obj.title === 'string' ? obj.title.trim() : '';
        if (!title) {
            badRequest(reply, 'title is required');
            return reply;
        }
        if (title.length > MAX_PRACTICE_TITLE_LEN) {
            badRequest(reply, `title exceeds the ${MAX_PRACTICE_TITLE_LEN}-character limit`);
            return reply;
        }

        if (!isContributionScope(obj.scope)) {
            badRequest(reply, 'scope must be one of: team, org');
            return reply;
        }
        // Team scope is pinned to the author's OWN team — the client never names it, so
        // it cannot mint a practice in another team's scope. A developer with no team
        // cannot author a team-scoped practice.
        let scopeTarget: string | null = null;
        if (obj.scope === 'team') {
            scopeTarget = getDeveloperById(db, developerId)?.team ?? null;
            if (!scopeTarget) {
                badRequest(reply, 'a team-scoped practice requires the author to belong to a team');
                return reply;
            }
        }

        const md = requireMarkdown(obj.markdown, reply);
        if (md === null) {
            return reply;
        }
        const changeNote = optionalString(obj.change_note, 'change_note', MAX_CHANGE_NOTE_LEN, reply);
        if (changeNote === false) {
            return reply;
        }
        const modelUsed = optionalString(obj.model_used, 'model_used', MAX_MODEL_USED_LEN, reply);
        if (modelUsed === false) {
            return reply;
        }

        try {
            const created = createPractice(db, {
                title,
                authorId: developerId,
                scope: obj.scope,
                scopeTarget,
                markdown: md,
                changeNote,
                modelUsed,
            });
            return reply.status(201).send({data: created});
        } catch (err) {
            return sendAuthoringError(err, reply);
        }
    });

    /**
     * Live preview: render markdown to sanitized HTML + the metric tags it implies,
     * WITHOUT persisting anything. Body: { markdown }. Stateless — drives the editor's
     * live preview pane. Authenticated-developer only (the render is pure, but the
     * surface stays behind /api/me like the rest of the editor).
     */
    app.post<{Body: unknown}>('/api/me/practices/preview', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const obj = asObject(request.body);
        if (!obj) {
            badRequest(reply, 'Request body must be an object');
            return reply;
        }
        if (!rejectUnknownKeys(obj, PREVIEW_KEYS, reply)) {
            return reply;
        }
        // Preview accepts an empty body (an empty preview is meaningful while typing),
        // but still bounds size so a huge paste can't be rendered unbounded.
        const md = typeof obj.markdown === 'string' ? obj.markdown : '';
        if (md.length > MAX_PRACTICE_MARKDOWN_LEN) {
            badRequest(reply, `markdown exceeds the ${MAX_PRACTICE_MARKDOWN_LEN}-character limit`);
            return reply;
        }
        return {data: renderPractice(md)};
    });

    /** List the developer's OWN best practices, newest first. Owner-scoped. */
    app.get('/api/me/practices', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        return {
            data: listContributions(db, {contentType: PRACTICE_CONTENT_TYPE, authorId: developerId}),
        };
    });

    /** Fetch one of the developer's OWN practices, rendered. Owner-scoped; 404 otherwise. */
    app.get<{Params: {id: string}}>('/api/me/practices/:id', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        if (!loadOwnedPractice(db, developerId, request.params.id)) {
            return reply.status(404).send({error: 'Not Found', message: 'Best practice not found'});
        }
        const view = getPracticeView(db, request.params.id);
        if (!view) {
            return reply.status(404).send({error: 'Not Found', message: 'Best practice not found'});
        }
        return {data: view};
    });

    /**
     * Save an edit: append a new version through the versioning primitive and
     * re-sync metric tags. Body: { markdown, change_note? }. Owner-scoped — 404 for a
     * practice that isn't the developer's own.
     */
    app.post<{Params: {id: string}; Body: unknown}>('/api/me/practices/:id/save', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        if (!loadOwnedPractice(db, developerId, request.params.id)) {
            return reply.status(404).send({error: 'Not Found', message: 'Best practice not found'});
        }
        const obj = asObject(request.body);
        if (!obj) {
            badRequest(reply, 'Request body must be an object');
            return reply;
        }
        if (!rejectUnknownKeys(obj, SAVE_KEYS, reply)) {
            return reply;
        }
        const md = requireMarkdown(obj.markdown, reply);
        if (md === null) {
            return reply;
        }
        const changeNote = optionalString(obj.change_note, 'change_note', MAX_CHANGE_NOTE_LEN, reply);
        if (changeNote === false) {
            return reply;
        }
        try {
            const saved = savePractice(db, request.params.id, {actorId: developerId, markdown: md, changeNote});
            return {data: saved};
        } catch (err) {
            return sendAuthoringError(err, reply);
        }
    });

    /** Version history for one of the developer's OWN practices, oldest first. Owner-scoped. */
    app.get<{Params: {id: string}}>('/api/me/practices/:id/history', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        if (!loadOwnedPractice(db, developerId, request.params.id)) {
            return reply.status(404).send({error: 'Not Found', message: 'Best practice not found'});
        }
        return {data: getVersionHistory(db, request.params.id)};
    });

    /**
     * Revert to a prior version: recreates that version's body as a new version
     * (history preserved) and re-syncs tags. Body: { version, change_note? }.
     * Owner-scoped.
     */
    app.post<{Params: {id: string}; Body: unknown}>('/api/me/practices/:id/revert', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        if (!loadOwnedPractice(db, developerId, request.params.id)) {
            return reply.status(404).send({error: 'Not Found', message: 'Best practice not found'});
        }
        const obj = asObject(request.body);
        if (!obj) {
            badRequest(reply, 'Request body must be an object');
            return reply;
        }
        if (!rejectUnknownKeys(obj, REVERT_KEYS, reply)) {
            return reply;
        }
        if (typeof obj.version !== 'number' || !Number.isInteger(obj.version) || obj.version < 1) {
            badRequest(reply, 'version must be a positive integer');
            return reply;
        }
        const changeNote = optionalString(obj.change_note, 'change_note', MAX_CHANGE_NOTE_LEN, reply);
        if (changeNote === false) {
            return reply;
        }
        try {
            const reverted = revertPractice(db, request.params.id, obj.version, {actorId: developerId, changeNote});
            return {data: reverted};
        } catch (err) {
            return sendAuthoringError(err, reply);
        }
    });
}
