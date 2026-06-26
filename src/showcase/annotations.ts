/**
 * Inline developer annotations for a showcase (Task 6.3.3 / #166).
 *
 * The highest-value layer of a showcase: a developer's own short notes anchored to
 * SPECIFIC conversation turns, explaining the reasoning behind a prompt ("I gave it
 * the failing test first on purpose"). This module is the policy layer over the raw
 * companion-table CRUD from 6.3.1 (`addAnnotation` / `listAnnotations` /
 * `updateAnnotationBody` in unitsStore). It owns the four properties the issue
 * requires, none of which the bare store enforces:
 *
 *   1. ANCHORING. An annotation must reference an existing turn of the showcase's
 *      conversation. The conversation is the opaque JSON payload on the unit; this
 *      module is the one place its turn shape is interpreted (see {@link turnRefs}).
 *      A `turnRef` that does not anchor to a real turn is rejected (`turn_not_found`)
 *      at the write boundary, so a typo can never persist a dangling annotation.
 *
 *   2. AUTHOR RESTRICTION. Only the conversation's developer — the contribution's
 *      pinned `author_id` (the same identity the consent gate trusts, 6.3.2) — may
 *      write or edit annotations: they are the developer's reasoning, no one else's.
 *      A manager (or any non-author) is rejected (`not_author`). This is verified at
 *      the trust boundary, not assumed from the caller.
 *
 *   3. EDITABLE PRE-PUBLISH, VERSIONED WITH THE UNIT (6.1.3 / #153). Annotations are
 *      editable only while the showcase is a `draft` — its content is still being
 *      authored. Each mutation (add or edit) snapshots the whole annotation layer as a
 *      new version of the contribution THROUGH the 6.1.3 versioning engine, so the
 *      edit history is retained on the unit's single version lineage rather than in a
 *      cloned per-annotation history table. Once the showcase is `submitted` the
 *      content is FROZEN: the developer approves (6.3.2) exactly the annotations that
 *      will publish, so editing after submission is refused (`not_editable`). This is
 *      the fail-closed reading of "before publish" — it forecloses a
 *      submit→approve→edit→publish gap where the published reasoning differs from what
 *      the developer approved.
 *
 *   4. INLINE DISPLAY. {@link assembleInlineDisplay} merges the live annotations back
 *      beside their anchored turns, in turn order, so a viewer reads each note next to
 *      the turn it explains.
 *
 * Feature boundary: a contribution version `body` is an opaque JSON string to the
 * spine. For a showcase that body is `{"conversation": <turns>, "annotations": [...]}`;
 * this module is the one place that envelope is encoded/decoded, exactly as
 * `practices/authoring.ts` owns the `{markdown}` envelope. The conversation itself is
 * read from the canonical `showcase_units.conversation` (never mutated here); the
 * version body is the audit snapshot.
 */

import type Database from 'better-sqlite3';
import {getContribution} from '../contributions/store';
import {editContribution, getVersionHistory} from '../contributions/versioning';
import type {Contribution} from '../contributions/types';
import {addAnnotation, getAnnotation, getShowcaseUnit, listAnnotations, updateAnnotationBody} from './unitsStore';
import type {ShowcaseAnnotation, ShowcaseUnit} from './unitsTypes';

/** Stable error codes a route/service can switch on without matching message text. */
export type AnnotationErrorCode =
    | 'not_found'
    | 'not_showcase'
    | 'not_author'
    | 'turn_not_found'
    | 'empty_body'
    | 'not_editable'
    | 'annotation_not_found';

/** A typed failure from the annotation layer, distinct from the spine's `VersioningError`. */
export class AnnotationError extends Error {
    constructor(
        readonly code: AnnotationErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'AnnotationError';
    }
}

// --- Conversation / turn anchoring ------------------------------------------

/** One turn as the conversation JSON carries it. The shape is otherwise opaque. */
interface ConversationTurn {
    /** An explicit stable turn id, when the conversation provides one. */
    id?: unknown;
}

/**
 * The ordered list of valid turn references for a conversation. The conversation is
 * an opaque JSON payload; this is the ONE interpretation of its turn shape. It accepts
 * either a top-level array of turns or an object `{turns: [...]}`. A turn's reference
 * is its `id` field when that is a non-empty string, otherwise its zero-based index as
 * a string ("0", "1", …) — so a conversation whose turns carry no ids still anchors by
 * position. A payload that is not parseable, or carries no turns, yields an empty list
 * (nothing anchors), which is what makes a bad anchor fail closed.
 */
function turnRefs(conversation: string): string[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(conversation);
    } catch {
        return [];
    }
    const turns: unknown = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object'
          ? (parsed as {turns?: unknown}).turns
          : undefined;
    if (!Array.isArray(turns)) {
        return [];
    }
    return turns.map((turn, index): string => {
        const id = (turn as ConversationTurn | null)?.id;
        return typeof id === 'string' && id.trim() !== '' ? id : String(index);
    });
}

/** Whether `turnRef` anchors to an existing turn of the conversation. */
function anchors(conversation: string, turnRef: string): boolean {
    return turnRefs(conversation).includes(turnRef);
}

// --- Version-body envelope (the unit's audit snapshot) ----------------------

/** A single annotation as captured in a version snapshot. */
interface AnnotationSnapshot {
    id: string;
    turnRef: string;
    authorId: string;
    body: string;
    createdAt: string;
}

/** The decoded showcase version body: the conversation plus its annotation layer. */
export interface ShowcaseBody {
    conversation: string;
    annotations: AnnotationSnapshot[];
}

function encodeBody(conversation: string, annotations: readonly ShowcaseAnnotation[]): string {
    return JSON.stringify({
        conversation,
        annotations: annotations.map((a) => ({
            id: a.id,
            turnRef: a.turnRef,
            authorId: a.authorId,
            body: a.body,
            createdAt: a.createdAt,
        })),
    });
}

/**
 * Decode a showcase version body. Lenient by design: the version-1 body written at
 * draft time (6.3.2) is the raw conversation string with no envelope, so anything that
 * is not our `{conversation, annotations}` shape is treated as a bare conversation with
 * an empty annotation layer — a read never throws on an unexpected body.
 */
export function decodeBody(body: string): ShowcaseBody {
    try {
        const parsed: unknown = JSON.parse(body);
        if (
            parsed &&
            typeof parsed === 'object' &&
            !Array.isArray(parsed) &&
            typeof (parsed as {conversation?: unknown}).conversation === 'string' &&
            Array.isArray((parsed as {annotations?: unknown}).annotations)
        ) {
            const p = parsed as {conversation: string; annotations: AnnotationSnapshot[]};
            return {conversation: p.conversation, annotations: p.annotations};
        }
    } catch {
        // Not our envelope — fall through to treating the body as a bare conversation.
    }
    return {conversation: body, annotations: []};
}

// --- Guards -----------------------------------------------------------------

/**
 * Load the contribution and its unit, asserting it exists and is a showcase. Mirrors
 * `publishPaths.requireShowcase`: a showcase is a contribution that HAS a showcase unit
 * — pointing this at a best practice or a ghost id is rejected rather than silently
 * writing an annotation against a non-showcase.
 */
function requireShowcase(db: Database.Database, contributionId: string): {contribution: Contribution; unit: ShowcaseUnit} {
    const contribution = getContribution(db, contributionId);
    if (!contribution) {
        throw new AnnotationError('not_found', `Contribution '${contributionId}' not found.`);
    }
    const unit = getShowcaseUnit(db, contributionId);
    if (!unit) {
        throw new AnnotationError('not_showcase', `Contribution '${contributionId}' is not a showcase (no showcase unit).`);
    }
    return {contribution, unit};
}

/**
 * Assert the showcase is still in its editable window. Annotations are editable ONLY
 * while the showcase is a `draft`: once `submitted`, its content is frozen so the
 * developer approves (6.3.2) exactly what publishes. Any later state (submitted,
 * published, unpublished, removed) is refused — fail closed.
 */
function requireDraft(contribution: Contribution): void {
    if (contribution.state !== 'draft') {
        throw new AnnotationError(
            'not_editable',
            `Annotations are editable only while the showcase is a draft (state is '${contribution.state}').`,
        );
    }
}

/** Assert the acting identity is the conversation's developer (the contribution author). */
function requireAuthor(contribution: Contribution, actorId: string): void {
    if (typeof actorId !== 'string' || actorId.trim() === '' || actorId !== contribution.authorId) {
        throw new AnnotationError(
            'not_author',
            `Only the conversation's developer (author '${contribution.authorId}') may write its annotations; '${String(actorId)}' may not.`,
        );
    }
}

/** Reject an empty/whitespace-only annotation body. */
function requireNonEmptyBody(body: string): void {
    if (typeof body !== 'string' || body.trim() === '') {
        throw new AnnotationError('empty_body', 'An annotation body cannot be empty.');
    }
}

/**
 * Snapshot the unit's current annotation layer as a new contribution version through
 * the 6.1.3 engine, so an annotation mutation is retained on the unit's version
 * lineage. The conversation is read from the canonical unit payload (it never changes
 * here); the annotation set is the live set after the mutation. Called inside the
 * mutation's transaction so the row write and the version snapshot commit together.
 */
function snapshotVersion(
    db: Database.Database,
    contributionId: string,
    unit: ShowcaseUnit,
    actorId: string,
    changeNote: string,
    timestamp?: string,
): void {
    const annotations = listAnnotations(db, contributionId);
    editContribution(db, contributionId, {
        actorId,
        body: encodeBody(unit.conversation, annotations),
        changeNote,
        timestamp,
    });
}

// --- Create / edit ----------------------------------------------------------

export interface AddAnnotationInput {
    contributionId: string;
    /** The turn this annotation anchors to — must reference an existing conversation turn. */
    turnRef: string;
    /** The acting developer — must be the conversation's author. */
    authorId: string;
    body: string;
    /** UTC ISO timestamp; defaults to now (in the store / version engine). */
    timestamp?: string;
}

/**
 * Add an inline annotation to a showcase. Enforces, in order: the target is a showcase
 * (`not_found` / `not_showcase`), it is still editable (`not_editable`), the author is
 * the conversation's developer (`not_author`), the body is non-blank (`empty_body`),
 * and the `turnRef` anchors to a real turn (`turn_not_found`). The row write and the
 * 6.1.3 version snapshot run in one transaction. Returns the stored annotation.
 */
export function addShowcaseAnnotation(db: Database.Database, input: AddAnnotationInput): ShowcaseAnnotation {
    const {contribution, unit} = requireShowcase(db, input.contributionId);
    requireDraft(contribution);
    requireAuthor(contribution, input.authorId);
    requireNonEmptyBody(input.body);
    if (!anchors(unit.conversation, input.turnRef)) {
        throw new AnnotationError(
            'turn_not_found',
            `Turn '${input.turnRef}' does not exist in the conversation of showcase '${input.contributionId}'.`,
        );
    }

    return db.transaction((): ShowcaseAnnotation => {
        const annotation = addAnnotation(db, {
            contributionId: input.contributionId,
            turnRef: input.turnRef,
            authorId: input.authorId,
            body: input.body,
            createdAt: input.timestamp,
        });
        snapshotVersion(db, input.contributionId, unit, input.authorId, `annotation added on turn ${input.turnRef}`, input.timestamp);
        return annotation;
    })();
}

export interface EditAnnotationInput {
    /** The acting developer — must be the conversation's author AND the annotation's author. */
    actorId: string;
    body: string;
    timestamp?: string;
}

/**
 * Edit an existing annotation's body (pre-publish only). Enforces: the annotation
 * exists (`annotation_not_found`), its showcase is still editable (`not_editable`), the
 * actor is the conversation's developer (`not_author`), and the new body is non-blank
 * (`empty_body`). The body is replaced in place and the whole annotation layer is
 * re-snapshotted as a new 6.1.3 version, in one transaction — so the prior body is
 * retained on the unit's version lineage even though the live row is overwritten.
 * Returns the updated annotation.
 */
export function editShowcaseAnnotation(db: Database.Database, annotationId: string, input: EditAnnotationInput): ShowcaseAnnotation {
    const existing = getAnnotation(db, annotationId);
    if (!existing) {
        throw new AnnotationError('annotation_not_found', `Annotation '${annotationId}' not found.`);
    }
    const {contribution, unit} = requireShowcase(db, existing.contributionId);
    requireDraft(contribution);
    requireAuthor(contribution, input.actorId);
    requireNonEmptyBody(input.body);

    return db.transaction((): ShowcaseAnnotation => {
        const updated = updateAnnotationBody(db, annotationId, input.body);
        // requireShowcase + getAnnotation already proved the row exists and this is
        // single-writer, so the update cannot miss. A missing row here is an invariant
        // break, not the ordinary not-found the typed errors model.
        if (!updated) {
            throw new Error(`Invariant: updateAnnotationBody missed existing annotation '${annotationId}'.`);
        }
        snapshotVersion(db, existing.contributionId, unit, input.actorId, `annotation ${annotationId} edited`, input.timestamp);
        return updated;
    })();
}

/** A contribution's live annotations, oldest-first (delegates to the store reader). */
export function listShowcaseAnnotations(db: Database.Database, contributionId: string): ShowcaseAnnotation[] {
    return listAnnotations(db, contributionId);
}

// --- Inline display ---------------------------------------------------------

/** A conversation turn with the annotations anchored to it, for inline display. */
export interface AnnotatedTurn {
    /** The turn's reference (its id, or its index as a string). */
    turnRef: string;
    /** The raw turn payload as the conversation carried it. */
    turn: unknown;
    /** The annotations anchored to this turn, oldest-first. */
    annotations: ShowcaseAnnotation[];
}

/** The inline display of a showcase: each turn beside the annotations that explain it. */
export interface InlineDisplay {
    turns: AnnotatedTurn[];
    /**
     * Annotations whose `turnRef` no longer matches any turn. Anchoring is validated on
     * write, so this is normally empty; it surfaces any historical drift rather than
     * silently dropping a note.
     */
    orphaned: ShowcaseAnnotation[];
}

/**
 * Assemble the inline display: merge the live annotations back beside their anchored
 * turns, in turn order. Reads the conversation from the canonical unit payload and the
 * annotations from the live set. Returns undefined when the id is not a showcase (so a
 * route can 404 uniformly). Within a turn, annotations keep the store's oldest-first
 * order; any annotation that no longer anchors is collected under `orphaned` rather
 * than dropped.
 */
export function assembleInlineDisplay(db: Database.Database, contributionId: string): InlineDisplay | undefined {
    const unit = getShowcaseUnit(db, contributionId);
    if (!unit) {
        return undefined;
    }
    const refs = turnRefs(unit.conversation);
    let rawTurns: unknown[] = [];
    try {
        const parsed: unknown = JSON.parse(unit.conversation);
        rawTurns = Array.isArray(parsed)
            ? parsed
            : parsed && typeof parsed === 'object' && Array.isArray((parsed as {turns?: unknown}).turns)
              ? ((parsed as {turns: unknown[]}).turns)
              : [];
    } catch {
        rawTurns = [];
    }

    const annotations = listAnnotations(db, contributionId);
    const byRef = new Map<string, ShowcaseAnnotation[]>();
    for (const ann of annotations) {
        const bucket = byRef.get(ann.turnRef);
        if (bucket) {
            bucket.push(ann);
        } else {
            byRef.set(ann.turnRef, [ann]);
        }
    }

    const turns: AnnotatedTurn[] = refs.map((ref, index) => ({
        turnRef: ref,
        turn: rawTurns[index],
        annotations: byRef.get(ref) ?? [],
    }));

    const knownRefs = new Set(refs);
    const orphaned = annotations.filter((a) => !knownRefs.has(a.turnRef));

    return {turns, orphaned};
}

// --- Version history --------------------------------------------------------

/**
 * The annotation-layer edit history for a showcase: every version's decoded annotation
 * snapshot, oldest-first, as retained on the unit's 6.1.3 version lineage. The
 * version-1 body (the raw conversation) decodes to an empty annotation layer. This is
 * the read side of "changes versioned" — it lets a caller see what the annotations were
 * at each prior version without the table itself keeping per-row history.
 */
export function getAnnotationHistory(db: Database.Database, contributionId: string): AnnotationSnapshot[][] {
    return getVersionHistory(db, contributionId).map((version) => decodeBody(version.body).annotations);
}
