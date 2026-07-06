/**
 * Showcase authoring/publish routes (Epic 6.3 follow-up / #189) — the production HTTP
 * edge of the 6.3 unit-model self-publish pipeline that previously existed only in the
 * service layer (reachable only from tests). It wires the whole developer-driven flow:
 *
 *   draft → annotate → scrub → (review-panel / redact) → submit → approve →
 *   confirm-review → publish
 *
 * Everything lives under /api/me, so the session middleware confines it to the
 * authenticated developer and the acting identity (id + team) comes STRICTLY from the
 * session, never request input. Two invariants hold the surface honest:
 *
 *  1. OWNER-SCOPED. Every `:id` action loads one of the developer's OWN showcase units
 *     (a contribution of type `showcase_example` whose `author_id` is the session
 *     developer). A showcase that isn't theirs — or isn't a showcase — is a uniform 404,
 *     so a non-owner can never distinguish "exists but not yours" from "doesn't exist",
 *     nor act on another developer's draft. This is defense-in-depth: the service verbs
 *     also enforce authorship/lifecycle, but the route 404s first so existence never
 *     leaks through a distinguishable status.
 *
 *  2. CONSENT + GATES PRESERVED. Publishing goes through the canonical
 *     {@link publishShowcase}, which ALWAYS prepends the mandatory curators'-note and
 *     manual-review gates ahead of any caller hooks and runs under the
 *     `required-approval` state gate — so a showcase can reach `published` only after
 *     the developer's own `approved` consent AND a curator's `reviewed` confirmation.
 *     This surface adds no bypass: it only calls the service verbs.
 *
 * The handlers validate the request shape, resolve ownership/scope from the session, and
 * map each service's typed error to a status; all authoring logic lives in src/showcase/.
 */

import type {FastifyInstance, FastifyReply} from 'fastify';
import type Database from 'better-sqlite3';
import {requireDeveloperId} from './guards';
import {asObject, badRequest, rejectUnknownKeys} from './body-validation';
import {getDeveloperById} from '../../registry/developers';
import {getContribution} from '../../contributions/store';
import {ContributionStateError, type ContributionStateErrorCode} from '../../contributions/stateMachine';
import {isContributionScope, type Contribution} from '../../contributions/types';
import {
    addShowcaseAnnotation,
    AnnotationError,
    type AnnotationErrorCode,
} from '../../showcase/annotations';
import {CurationError, type CurationErrorCode} from '../../showcase/curation';
import {
    assembleReviewPanel,
    confirmManualReview,
    ManualReviewError,
    redactForReview,
    type ManualReviewErrorCode,
} from '../../showcase/manualReview';
import {
    approveAsDeveloper,
    draftSelfPublish,
    publishShowcase,
    ShowcasePublishError,
    submitForReview,
    type ShowcasePublishErrorCode,
} from '../../showcase/publishPaths';
import {scrubContribution} from '../../showcase/scrubDetector';
import {getShowcaseUnit} from '../../showcase/unitsStore';
import {isValidOutcomeLink, isVisibilityScope, SHOWCASE_CONTENT_TYPE} from '../../showcase/unitsTypes';

const MAX_TITLE_LEN = 200;
const MAX_CONVERSATION_LEN = 200_000;
const MAX_CURATORS_NOTE_LEN = 5_000;
const MAX_AI_ANNOTATION_LEN = 5_000;
const MAX_ANNOTATION_BODY_LEN = 5_000;
const MAX_TURN_REF_LEN = 200;
const MAX_NOTE_LEN = 2_000;
const MAX_OUTCOME_LINK_LEN = 2_000;
const MAX_FLAG_IDS = 200;
const MAX_FLAG_ID_LEN = 200;

const DRAFT_KEYS = ['title', 'conversation', 'curators_note', 'scope', 'outcome_link', 'ai_annotation'] as const;
const ANNOTATION_KEYS = ['turn_ref', 'body'] as const;
const REDACT_KEYS = ['redacted_conversation', 'resolved_flag_ids', 'note'] as const;
const APPROVE_KEYS = ['visibility_scope', 'note'] as const;
const NOTE_ONLY_KEYS = ['note'] as const;

const PUBLISH_ERROR_STATUS: Record<ShowcasePublishErrorCode, number> = {
    not_found: 404,
    not_showcase: 404,
    invalid_path: 400,
    invalid_scope: 400,
    invalid_actor: 400,
    self_publish_actor_mismatch: 403,
    not_developer: 403,
};

const ANNOTATION_ERROR_STATUS: Record<AnnotationErrorCode, number> = {
    not_found: 404,
    not_showcase: 404,
    not_author: 403,
    turn_not_found: 400,
    empty_body: 400,
    not_editable: 409,
    annotation_not_found: 404,
};

const MANUAL_REVIEW_ERROR_STATUS: Record<ManualReviewErrorCode, number> = {
    not_found: 404,
    not_showcase: 404,
    not_pre_publish: 409,
    not_submitted: 409,
    invalid_actor: 400,
    invalid_content: 400,
    unknown_flag: 400,
    review_not_confirmed: 409,
};

const STATE_ERROR_STATUS: Record<ContributionStateErrorCode, number> = {
    not_found: 404,
    illegal_transition: 409,
    gate_not_satisfied: 409,
    invalid_gate: 400,
    invalid_actor: 400,
};

const CURATION_ERROR_STATUS: Record<CurationErrorCode, number> = {
    not_showcase: 404,
    missing_curators_note: 409,
};

/**
 * Map any of the authoring services' typed errors to its HTTP status; rethrow anything
 * unrecognized (a genuine bug) so it surfaces as a 500 rather than being swallowed.
 */
function sendAuthoringError(err: unknown, reply: FastifyReply): FastifyReply {
    if (err instanceof ShowcasePublishError) {
        return reply.status(PUBLISH_ERROR_STATUS[err.code]).send({error: 'Showcase error', code: err.code, message: err.message});
    }
    if (err instanceof AnnotationError) {
        return reply.status(ANNOTATION_ERROR_STATUS[err.code]).send({error: 'Annotation error', code: err.code, message: err.message});
    }
    if (err instanceof ManualReviewError) {
        return reply.status(MANUAL_REVIEW_ERROR_STATUS[err.code]).send({error: 'Manual-review error', code: err.code, message: err.message});
    }
    if (err instanceof CurationError) {
        return reply.status(CURATION_ERROR_STATUS[err.code]).send({error: 'Curation error', code: err.code, message: err.message});
    }
    if (err instanceof ContributionStateError) {
        return reply.status(STATE_ERROR_STATUS[err.code]).send({error: 'State error', code: err.code, message: err.message});
    }
    throw err;
}

/**
 * Load a showcase unit owned by `developerId`, or undefined. The single home for this
 * surface's ownership rule: it resolves to undefined (→ uniform 404) for a missing id, a
 * non-showcase contribution, AND another developer's showcase — none of which this
 * developer may touch — so the response never reveals which of those it was.
 */
function loadOwnedShowcase(db: Database.Database, developerId: string, id: string): Contribution | undefined {
    const contribution = getContribution(db, id);
    if (!contribution || contribution.contentType !== SHOWCASE_CONTENT_TYPE || contribution.authorId !== developerId) {
        return undefined;
    }
    return contribution;
}

/** Send the uniform owner-scoped 404 and return the reply. */
function notOwned(reply: FastifyReply): FastifyReply {
    return reply.status(404).send({error: 'Not Found', message: 'Showcase not found'});
}

/**
 * A mandatory, non-blank, bounded string field: its trimmed value, or 400 (returns
 * null). Trims because these feed titles/notes where surrounding whitespace is noise.
 */
function requireString(value: unknown, field: string, maxLen: number, reply: FastifyReply): string | null {
    if (typeof value !== 'string' || value.trim().length === 0) {
        badRequest(reply, `${field} is required`);
        return null;
    }
    const trimmed = value.trim();
    if (trimmed.length > maxLen) {
        badRequest(reply, `${field} exceeds the ${maxLen}-character limit`);
        return null;
    }
    return trimmed;
}

/**
 * An optional, bounded, trimmed string field: absent/null/blank → null; a non-blank
 * string within `maxLen` → its trimmed value; anything else → 400 (returns false).
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

export function registerShowcaseAuthoringRoutes(app: FastifyInstance, db: Database.Database): void {
    /**
     * Draft a self-publish showcase. Body: { title, conversation, curators_note, scope,
     * outcome_link?, ai_annotation? }. The session developer is the author (the consent
     * gate pins on this); a `team` scope is pinned to the AUTHOR'S OWN team (resolved
     * server-side — the client never names the team), so a developer cannot draft into
     * another team's scope. Returns 201 { contribution, unit } in `draft` state.
     */
    app.post<{Body: unknown}>('/api/me/showcase-units', async (request, reply) => {
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

        const title = requireString(obj.title, 'title', MAX_TITLE_LEN, reply);
        if (title === null) {
            return reply;
        }
        const conversation = requireString(obj.conversation, 'conversation', MAX_CONVERSATION_LEN, reply);
        if (conversation === null) {
            return reply;
        }
        const curatorsNote = requireString(obj.curators_note, 'curators_note', MAX_CURATORS_NOTE_LEN, reply);
        if (curatorsNote === null) {
            return reply;
        }
        if (!isContributionScope(obj.scope)) {
            badRequest(reply, 'scope must be one of: team, org');
            return reply;
        }
        // Team scope pins to the author's OWN team; a developer with no team cannot draft
        // a team-scoped showcase (mirrors the practices authoring rule).
        let scopeTarget: string | null = null;
        if (obj.scope === 'team') {
            scopeTarget = getDeveloperById(db, developerId)?.team ?? null;
            if (!scopeTarget) {
                badRequest(reply, 'a team-scoped showcase requires the author to belong to a team');
                return reply;
            }
        }

        const outcomeLink = optionalString(obj.outcome_link, 'outcome_link', MAX_OUTCOME_LINK_LEN, reply);
        if (outcomeLink === false) {
            return reply;
        }
        // Reject an unsafe scheme at the trust boundary (the write boundary re-checks,
        // fail-closed): a javascript:/data: link would become a script-bearing clickable
        // outcome link (stored XSS) in the detail view.
        if (outcomeLink !== null && !isValidOutcomeLink(outcomeLink)) {
            badRequest(reply, 'outcome_link must be an http(s) URL');
            return reply;
        }
        const aiAnnotation = optionalString(obj.ai_annotation, 'ai_annotation', MAX_AI_ANNOTATION_LEN, reply);
        if (aiAnnotation === false) {
            return reply;
        }

        try {
            const draft = draftSelfPublish(db, {
                developerId,
                title,
                conversation,
                curatorsNote,
                scope: obj.scope,
                scopeTarget,
                outcomeLink,
                aiAnnotation,
            });
            return reply.status(201).send({data: draft});
        } catch (err) {
            return sendAuthoringError(err, reply);
        }
    });

    /**
     * Add an inline developer annotation anchored to a conversation turn. Body:
     * { turn_ref, body }. Owner-scoped; the annotation service additionally enforces the
     * draft-only window, author identity, and that `turn_ref` anchors to a real turn.
     * Returns 201 with the stored annotation.
     */
    app.post<{Params: {id: string}; Body: unknown}>('/api/me/showcase-units/:id/annotations', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        if (!loadOwnedShowcase(db, developerId, request.params.id)) {
            return notOwned(reply);
        }
        const obj = asObject(request.body);
        if (!obj) {
            badRequest(reply, 'Request body must be an object');
            return reply;
        }
        if (!rejectUnknownKeys(obj, ANNOTATION_KEYS, reply)) {
            return reply;
        }
        const turnRef = requireString(obj.turn_ref, 'turn_ref', MAX_TURN_REF_LEN, reply);
        if (turnRef === null) {
            return reply;
        }
        // Do NOT trim the annotation body: leading/trailing whitespace can be meaningful
        // in a reasoning note. The service rejects a blank/whitespace-only body.
        if (typeof obj.body !== 'string' || obj.body.trim().length === 0) {
            badRequest(reply, 'body is required');
            return reply;
        }
        if (obj.body.length > MAX_ANNOTATION_BODY_LEN) {
            badRequest(reply, `body exceeds the ${MAX_ANNOTATION_BODY_LEN}-character limit`);
            return reply;
        }
        try {
            const annotation = addShowcaseAnnotation(db, {
                contributionId: request.params.id,
                turnRef,
                authorId: developerId,
                body: obj.body,
            });
            return reply.status(201).send({data: annotation});
        } catch (err) {
            return sendAuthoringError(err, reply);
        }
    });

    /**
     * Run the two-tier auto-flag scrubber over the showcase's CURRENT conversation and
     * persist each finding as a scrub flag for the manual review. Body: none. Owner-
     * scoped. FLAG-ONLY: it never edits the conversation; the mandatory manual review is
     * the real control. Returns the stored flags (both tiers, deterministic order).
     */
    app.post<{Params: {id: string}}>('/api/me/showcase-units/:id/scrub', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        if (!loadOwnedShowcase(db, developerId, request.params.id)) {
            return notOwned(reply);
        }
        const unit = getShowcaseUnit(db, request.params.id);
        if (!unit) {
            // Owner-guard proved the contribution is a showcase, so a missing unit is a
            // corruption; surface it as the same uniform not-found rather than a 500.
            return notOwned(reply);
        }
        const flags = scrubContribution(db, request.params.id, unit.conversation);
        return {data: {flags}};
    });

    /**
     * The pre-publish manual-review panel: the (possibly redacted) conversation plus its
     * scrub flags split by tier (secrets firm, PII hints fallible) so a renderer keeps
     * them visually distinct. Owner-scoped, read-only. 404 when not the developer's own.
     */
    app.get<{Params: {id: string}}>('/api/me/showcase-units/:id/review-panel', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        if (!loadOwnedShowcase(db, developerId, request.params.id)) {
            return notOwned(reply);
        }
        const panel = assembleReviewPanel(db, request.params.id);
        if (!panel) {
            return notOwned(reply);
        }
        return {data: panel};
    });

    /**
     * Redact the conversation to resolve scrub flags. Body: { redacted_conversation,
     * resolved_flag_ids?, note? }. Owner-scoped; the service versions the edit, updates
     * the live unit, marks the named flags resolved, and records a `redacted` audit event
     * — and rejects a flag id that isn't the showcase's own. A redaction after a review
     * confirmation invalidates it, forcing a re-review before publish.
     */
    app.post<{Params: {id: string}; Body: unknown}>('/api/me/showcase-units/:id/redact', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        if (!loadOwnedShowcase(db, developerId, request.params.id)) {
            return notOwned(reply);
        }
        const obj = asObject(request.body);
        if (!obj) {
            badRequest(reply, 'Request body must be an object');
            return reply;
        }
        if (!rejectUnknownKeys(obj, REDACT_KEYS, reply)) {
            return reply;
        }
        const redactedConversation = requireString(
            obj.redacted_conversation,
            'redacted_conversation',
            MAX_CONVERSATION_LEN,
            reply,
        );
        if (redactedConversation === null) {
            return reply;
        }
        const resolvedFlagIds = parseFlagIds(obj.resolved_flag_ids, reply);
        if (resolvedFlagIds === false) {
            return reply;
        }
        const note = optionalString(obj.note, 'note', MAX_NOTE_LEN, reply);
        if (note === false) {
            return reply;
        }
        try {
            const result = redactForReview(db, {
                contributionId: request.params.id,
                actorId: developerId,
                redactedConversation,
                resolvedFlagIds,
                note,
            });
            return {data: result};
        } catch (err) {
            return sendAuthoringError(err, reply);
        }
    });

    /**
     * Submit a draft for review (draft → submitted) under the `required-approval` gate.
     * Body: { note? }. Owner-scoped. After this the content is frozen for annotation
     * edits, and the developer must approve before it can publish.
     */
    app.post<{Params: {id: string}; Body: unknown}>('/api/me/showcase-units/:id/submit', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        if (!loadOwnedShowcase(db, developerId, request.params.id)) {
            return notOwned(reply);
        }
        const note = parseNoteOnlyBody(request.body, reply);
        if (note === false) {
            return reply;
        }
        try {
            const updated = submitForReview(db, {contributionId: request.params.id, actorId: developerId, note});
            return {data: updated};
        } catch (err) {
            return sendAuthoringError(err, reply);
        }
    });

    /**
     * The developer's approval — the single act that satisfies the consent gate. Body:
     * { visibility_scope, note? }. Owner-scoped, and the service ALSO requires the
     * approving identity to equal the pinned author, so this is the developer's own
     * deliberate consent. Records the explicit visibility scope + the `approved` audit
     * event, atomically. Returns the contribution.
     */
    app.post<{Params: {id: string}; Body: unknown}>('/api/me/showcase-units/:id/approve', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        if (!loadOwnedShowcase(db, developerId, request.params.id)) {
            return notOwned(reply);
        }
        const obj = asObject(request.body);
        if (!obj) {
            badRequest(reply, 'Request body must be an object');
            return reply;
        }
        if (!rejectUnknownKeys(obj, APPROVE_KEYS, reply)) {
            return reply;
        }
        if (!isVisibilityScope(obj.visibility_scope)) {
            badRequest(reply, 'visibility_scope must be one of: team, org');
            return reply;
        }
        const note = optionalString(obj.note, 'note', MAX_NOTE_LEN, reply);
        if (note === false) {
            return reply;
        }
        try {
            approveAsDeveloper(db, {
                contributionId: request.params.id,
                developerId,
                visibilityScope: obj.visibility_scope,
                note,
            });
            return {data: getContribution(db, request.params.id)};
        } catch (err) {
            return sendAuthoringError(err, reply);
        }
    });

    /**
     * Record the curator's explicit "manual review complete" confirmation (a `reviewed`
     * audit event) for the current submission — the second gate publish requires, always
     * mandatory even when the scrubber found nothing. Body: { note? }. Owner-scoped; the
     * service requires the showcase to be `submitted`.
     */
    app.post<{Params: {id: string}; Body: unknown}>('/api/me/showcase-units/:id/confirm-review', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        if (!loadOwnedShowcase(db, developerId, request.params.id)) {
            return notOwned(reply);
        }
        const note = parseNoteOnlyBody(request.body, reply);
        if (note === false) {
            return reply;
        }
        try {
            const event = confirmManualReview(db, {contributionId: request.params.id, actorId: developerId, note});
            return {data: event};
        } catch (err) {
            return sendAuthoringError(err, reply);
        }
    });

    /**
     * Publish a submitted, approved, reviewed showcase (submitted → published). Body:
     * { note? }. Owner-scoped. Delegates to {@link publishShowcase}, which ALWAYS runs
     * the mandatory curators'-note gate then the manual-review gate ahead of any caller
     * hooks, all under the `required-approval` state gate — so publish is refused (409)
     * unless the developer's `approved` consent AND a current `reviewed` confirmation
     * both exist and the note is present. Returns the published contribution.
     */
    app.post<{Params: {id: string}; Body: unknown}>('/api/me/showcase-units/:id/publish', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        if (!loadOwnedShowcase(db, developerId, request.params.id)) {
            return notOwned(reply);
        }
        const note = parseNoteOnlyBody(request.body, reply);
        if (note === false) {
            return reply;
        }
        try {
            const published = publishShowcase(db, {contributionId: request.params.id, actorId: developerId, note});
            return {data: published};
        } catch (err) {
            return sendAuthoringError(err, reply);
        }
    });

    /**
     * Parse an optional `resolved_flag_ids` array of non-blank, bounded strings. Absent →
     * []; a non-array, an over-long list, or a non-string/blank/over-long entry → 400
     * (returns false).
     */
    function parseFlagIds(value: unknown, reply: FastifyReply): string[] | false {
        if (value === undefined || value === null) {
            return [];
        }
        if (!Array.isArray(value)) {
            badRequest(reply, 'resolved_flag_ids must be an array of strings');
            return false;
        }
        if (value.length > MAX_FLAG_IDS) {
            badRequest(reply, `resolved_flag_ids cannot exceed ${MAX_FLAG_IDS} ids`);
            return false;
        }
        const ids: string[] = [];
        for (const entry of value) {
            if (typeof entry !== 'string' || entry.trim().length === 0 || entry.length > MAX_FLAG_ID_LEN) {
                badRequest(reply, 'each resolved_flag_ids entry must be a non-blank string');
                return false;
            }
            ids.push(entry);
        }
        return ids;
    }

    /**
     * Parse a body that carries only an optional `note`. Accepts an absent/empty body,
     * or an object with just `{ note? }`. Returns the note (string|null), or false when
     * the body is malformed / has an unknown key / a bad note (a 400 was sent).
     */
    function parseNoteOnlyBody(body: unknown, reply: FastifyReply): string | null | false {
        if (body === undefined || body === null || body === '') {
            return null;
        }
        const obj = asObject(body);
        if (!obj) {
            badRequest(reply, 'Request body must be an object');
            return false;
        }
        if (!rejectUnknownKeys(obj, NOTE_ONLY_KEYS, reply)) {
            return false;
        }
        return optionalString(obj.note, 'note', MAX_NOTE_LEN, reply);
    }
}
