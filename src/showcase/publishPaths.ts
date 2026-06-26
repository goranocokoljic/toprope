/**
 * Dual showcase publish paths, unified by the developer-consent gate (Task 6.3.2 / #165).
 *
 * A showcase can reach `published` two ways, but BOTH require the developer's real
 * consent — "the difference between a showcase and surveillance":
 *
 *   * self_publish   — the developer promotes their own conversation. The developer
 *                      is the initiator AND the approver.
 *   * joint_curation — a manager proposes a conversation the developer owns. The
 *                      manager CANNOT publish until the developer explicitly approves
 *                      (the defining privacy property of Epic 6.3).
 *
 * This module is pure orchestration over three lower layers, adding no second source
 * of truth:
 *   - the 6.1.1 contribution spine store (createContribution / getContribution),
 *   - the 6.1.2 state machine (#152) — the canonical draft→submitted→published gate.
 *     A showcase ALWAYS uses the `required-approval` gate, so `published` is
 *     unreachable until an `approved` audit event is recorded for the submission, and
 *   - the 6.3.1 companion store (#164) — showcase_units (the publishable payload with
 *     the mandatory curators' note) and showcase_consent (the recorded approval +
 *     explicit visibility scope).
 *
 * How the privacy property is enforced (and why it cannot be bypassed):
 *   The developer who must consent is pinned at draft time as the contribution's
 *   `author_id` — in BOTH paths the showcase is the developer's work, so the
 *   developer is the author/subject (for joint_curation the proposing manager is
 *   recorded as the actor on a `proposed` audit event, not as the author).
 *   {@link approveAsDeveloper} is the ONLY way to record the `approved` event the
 *   state-machine gate needs, and it refuses unless the approving identity equals
 *   that pinned author (`not_developer`). So a manager — whose authenticated id is
 *   not the author's — can never produce the approval the gate demands, and
 *   {@link publishShowcase} (a `required-approval` publish) refuses with
 *   `gate_not_satisfied`. The route layer is trusted to authenticate the acting
 *   identity it passes in; this module enforces everything above that boundary.
 */

import type Database from 'better-sqlite3';
import {addReviewEvent, createContribution, getContribution} from '../contributions/store';
import {
    approve as smApprove,
    publish as smPublish,
    submit as smSubmit,
    type PrePublishHook,
} from '../contributions/stateMachine';
import type {Contribution} from '../contributions/types';
import {getShowcaseUnit, recordConsent, upsertShowcaseUnit} from './unitsStore';
import {isPublishPath, isVisibilityScope, type PublishPath, type ShowcaseUnit, type VisibilityScope} from './unitsTypes';

/** The content_type every showcase contribution carries on the spine. */
const SHOWCASE_CONTENT_TYPE = 'showcase_example';

/**
 * A showcase always runs through the `required-approval` gate — developer approval
 * is mandatory in BOTH paths, so the showcase never configures `auto-publish`. This
 * is the one place that decision lives.
 */
const SHOWCASE_GATE = 'required-approval' as const;

/** Stable error codes a route/service can switch on without matching message text. */
export type ShowcasePublishErrorCode =
    | 'not_found'
    | 'not_showcase'
    | 'invalid_path'
    | 'invalid_scope'
    | 'invalid_actor'
    | 'self_publish_actor_mismatch'
    | 'not_developer';

/** A typed failure from the publish-path orchestration. */
export class ShowcasePublishError extends Error {
    constructor(
        readonly code: ShowcasePublishErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'ShowcasePublishError';
    }
}

/** A drafted showcase: the spine contribution plus its 1:1 publishable unit. */
export interface ShowcaseDraft {
    contribution: Contribution;
    unit: ShowcaseUnit;
}

interface BaseDraftInput {
    /** Spine title for the showcase contribution. */
    title: string;
    /** The redacted conversation payload (opaque JSON of turns). */
    conversation: string;
    /** MANDATORY curators' note — a blank value is rejected by the unit store. */
    curatorsNote: string;
    /** Spine scope of the contribution; defaults to 'team'. */
    scope?: 'org' | 'team';
    /** Team name when team-scoped; null/omitted for org-wide. */
    scopeTarget?: string | null;
    outcomeLink?: string | null;
    aiAnnotation?: string | null;
    /** UTC ISO timestamp for the created rows; defaults to now. */
    timestamp?: string;
}

export interface SelfPublishDraftInput extends BaseDraftInput {
    /** The developer promoting their own conversation — author, initiator, and approver. */
    developerId: string;
}

export interface JointCurationDraftInput extends BaseDraftInput {
    /** The developer who owns the conversation — pinned as author and the only valid approver. */
    developerId: string;
    /** The manager proposing the showcase — recorded as the actor of a `proposed` audit event. */
    managerId: string;
    /** Optional note attached to the `proposed` audit event. */
    note?: string | null;
}

function requireNonBlank(value: string, code: ShowcasePublishErrorCode, label: string): void {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new ShowcasePublishError(code, `${label} is required and cannot be blank.`);
    }
}

/**
 * Create the spine contribution and its 1:1 showcase unit for a draft, atomically.
 * `author_id` is the developer in both paths (the consent gate pins on it). The
 * curators'-note and publish_path gates live in `upsertShowcaseUnit`; both writes run
 * in one transaction so a showcase contribution can never exist without its unit.
 */
function draft(db: Database.Database, developerId: string, publishPath: PublishPath, input: BaseDraftInput): ShowcaseDraft {
    requireNonBlank(developerId, 'invalid_actor', 'developerId');
    if (!isPublishPath(publishPath)) {
        throw new ShowcasePublishError('invalid_path', `Unrecognized publish path '${String(publishPath)}'.`);
    }

    return db.transaction((): ShowcaseDraft => {
        const contribution = createContribution(db, {
            contentType: SHOWCASE_CONTENT_TYPE,
            title: input.title,
            authorId: developerId,
            scope: input.scope ?? 'team',
            scopeTarget: input.scopeTarget ?? null,
            state: 'draft',
            // The version-1 body mirrors the conversation payload; the showcase-specific
            // payload lives in showcase_units, the conversation lineage on the spine.
            body: input.conversation,
            changeNote: 'showcase draft created',
            timestamp: input.timestamp,
        });
        const unit = upsertShowcaseUnit(db, {
            contributionId: contribution.id,
            conversation: input.conversation,
            curatorsNote: input.curatorsNote,
            publishPath,
            outcomeLink: input.outcomeLink ?? null,
            aiAnnotation: input.aiAnnotation ?? null,
        });
        return {contribution, unit};
    })();
}

/**
 * Self-publish path: the developer promotes their own conversation. The developer is
 * recorded as the contribution author (the consent gate pins on this) and will later
 * both submit and approve. Returns the drafted contribution + unit in `draft` state.
 */
export function draftSelfPublish(db: Database.Database, input: SelfPublishDraftInput): ShowcaseDraft {
    return draft(db, input.developerId, 'self_publish', input);
}

/**
 * Joint-curation path: a manager proposes a conversation the developer owns. The
 * DEVELOPER is pinned as the contribution author (so only their approval can satisfy
 * the gate); the proposing manager is recorded as the actor of a `proposed` audit
 * event so the proposal is never anonymous. Returns the draft in `draft` state — the
 * manager cannot move it any further without the developer's approval.
 */
export function proposeJointCuration(db: Database.Database, input: JointCurationDraftInput): ShowcaseDraft {
    requireNonBlank(input.managerId, 'invalid_actor', 'managerId');
    return db.transaction((): ShowcaseDraft => {
        const drafted = draft(db, input.developerId, 'joint_curation', input);
        // Record the proposal in the audit trail (the spine's review-event log). This
        // is a non-lifecycle governance fact: the manager proposed; the developer has
        // not yet approved. State stays `draft`.
        addReviewEvent(db, {
            contributionId: drafted.contribution.id,
            event: 'proposed',
            actorId: input.managerId,
            note: input.note ?? null,
            occurredAt: input.timestamp,
        });
        return drafted;
    })();
}

interface ActorInput {
    contributionId: string;
    /** The authenticated acting identity. */
    actorId: string;
    note?: string | null;
    timestamp?: string;
}

/**
 * Move a drafted showcase to `submitted` (draft → submitted) through the state
 * machine, always under the `required-approval` gate. Either party may submit — the
 * gate that matters is at publish — so this records the move without an identity
 * check beyond the state machine's non-blank actor rule.
 */
export function submitForReview(db: Database.Database, input: ActorInput): Contribution {
    requireShowcase(db, input.contributionId);
    return smSubmit(db, {
        contributionId: input.contributionId,
        actorId: input.actorId,
        note: input.note ?? null,
        timestamp: input.timestamp,
        gate: SHOWCASE_GATE,
    });
}

export interface ApproveInput {
    contributionId: string;
    /**
     * The authenticated developer approving. MUST equal the contribution's pinned
     * author (the conversation owner) — a non-author (e.g. the proposing manager) is
     * rejected with `not_developer`, which is what makes the manager-cannot-bypass
     * property hold.
     */
    developerId: string;
    /** REQUIRED explicit reach the developer consents to — there is no default. */
    visibilityScope: VisibilityScope;
    note?: string | null;
    timestamp?: string;
}

/**
 * Record the developer's approval — the single act that satisfies the consent gate.
 * It does TWO things, atomically, so the gate fact and the showcase consent record
 * can never drift:
 *   1. writes showcase_consent (approved = 1) with the EXPLICIT visibility scope, and
 *   2. appends the state-machine `approved` audit event the publish gate checks.
 *
 * It refuses unless the approving `developerId` equals the contribution's pinned
 * author (`not_developer`) and unless an explicit, valid `visibilityScope` is given
 * (`invalid_scope`). The contribution must be `submitted` (the state machine enforces
 * this and throws if not).
 */
export function approveAsDeveloper(db: Database.Database, input: ApproveInput): void {
    const contribution = requireShowcase(db, input.contributionId);
    requireNonBlank(input.developerId, 'invalid_actor', 'developerId');
    if (!isVisibilityScope(input.visibilityScope)) {
        throw new ShowcasePublishError(
            'invalid_scope',
            `visibility_scope must be one of 'team' | 'org' (got '${String(input.visibilityScope)}').`,
        );
    }
    if (input.developerId !== contribution.authorId) {
        throw new ShowcasePublishError(
            'not_developer',
            `Only the showcase's developer (author) may approve it; '${input.developerId}' is not the author.`,
        );
    }

    const ts = input.timestamp;
    db.transaction(() => {
        // The state machine records the canonical `approved` gate event (and refuses
        // unless the contribution is `submitted`). Do this first so an out-of-state
        // approval aborts before any consent row is written.
        smApprove(db, {
            contributionId: input.contributionId,
            actorId: input.developerId,
            note: input.note ?? null,
            timestamp: ts,
        });
        recordConsent(db, {
            contributionId: input.contributionId,
            developerId: input.developerId,
            visibilityScope: input.visibilityScope,
            approved: true,
            approvedAt: ts ?? null,
        });
    })();
}

export interface PublishInput extends ActorInput {
    /**
     * The MANDATORY pre-publish scrub/review hooks (the 6.3.5/6.3.6 seam). Run,
     * atomically, immediately before the flip to `published`; a throwing hook rolls
     * the whole publish back, so a failed scrub leaves the showcase unpublished. This
     * task only wires the seam — the concrete scrubber/manual-review is a sibling task.
     */
    prePublishHooks?: PrePublishHook[];
}

/**
 * Publish a showcase (submitted → published) through the `required-approval` gate.
 * The state machine refuses (`gate_not_satisfied`) unless the developer's `approved`
 * event exists for the current submission — so a manager who skipped
 * {@link approveAsDeveloper} cannot publish. Any pre-publish hooks run atomically
 * before the flip. Returns the published contribution.
 */
export function publishShowcase(db: Database.Database, input: PublishInput): Contribution {
    requireShowcase(db, input.contributionId);
    return smPublish(db, {
        contributionId: input.contributionId,
        actorId: input.actorId,
        note: input.note ?? null,
        timestamp: input.timestamp,
        gate: SHOWCASE_GATE,
        prePublishHooks: input.prePublishHooks,
    });
}

/**
 * Load a contribution and assert it exists AND is a showcase (it has a showcase unit
 * — only showcase contributions do). Guards every showcase operation against being
 * pointed at a best-practice or ghost id. Returns the contribution.
 */
function requireShowcase(db: Database.Database, contributionId: string): Contribution {
    const contribution = getContribution(db, contributionId);
    if (!contribution) {
        throw new ShowcasePublishError('not_found', `Contribution '${contributionId}' not found.`);
    }
    if (!getShowcaseUnit(db, contributionId)) {
        throw new ShowcasePublishError(
            'not_showcase',
            `Contribution '${contributionId}' is not a showcase (no showcase unit).`,
        );
    }
    return contribution;
}
