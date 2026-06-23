/**
 * Contribution-flow state machine (Task 6.1.2 / #152).
 *
 * The feature-agnostic engine that moves a contribution through its lifecycle:
 *
 *     draft → submitted → (review gate) → published → unpublished → removed
 *
 * It owns exactly two things the spine store (6.1.1) deliberately does NOT:
 *   1. WHICH transitions are legal (the `LEGAL_TRANSITIONS` table), and
 *   2. that a contribution reaching `published` honoured whatever review gate the
 *      feature configured (required-approval vs auto-publish).
 *
 * Everything type-specific stays with the feature: the gate kind is supplied per
 * call (a feature derives it from its content_type / contribution model and
 * settings), and feature-specific pre-publish work (e.g. showcase redaction/scrub)
 * is injected as `prePublishHooks`. Nothing here knows what a best practice or a
 * showcase example is.
 *
 * Atomicity: every transition flips the spine state AND appends its
 * `contribution_review_event` inside a single transaction, so an action can never
 * be recorded without its audit row (or vice versa). Pre-publish hooks run inside
 * that same transaction — a throwing hook rolls the whole publish back, so a
 * failed scrub leaves the contribution unpublished rather than half-published.
 */

import type Database from 'better-sqlite3';
import {addReviewEvent, getContribution, listReviewEvents, updateContributionState} from './store';
import type {Contribution, ContributionState} from './types';

/**
 * The review gate a feature configures for a contribution model:
 *   * `required-approval` — `published` is unreachable until an `approved` event
 *     has been recorded for the current submission (e.g. top-down best practices:
 *     a lead approves; showcase: the developer approves and redaction is done).
 *   * `auto-publish` — submitting carries straight through to `published` with no
 *     approval (e.g. bottom-up best practices that rely on later voting).
 */
export type ReviewGate = 'required-approval' | 'auto-publish';

/** The known review gates. Informational + the basis for {@link isReviewGate}. */
export const REVIEW_GATES = ['required-approval', 'auto-publish'] as const;

/**
 * Runtime validator for a review gate. The gate guards a governance invariant, so
 * it must NOT be trusted into the core on a compile-time type alone: a caller that
 * derives the gate from a settings string / route param could hand in an
 * unrecognized value, and the gate logic must reject it rather than silently
 * fall through. Both {@link submit} and {@link publish} validate with this first.
 */
export function isReviewGate(value: unknown): value is ReviewGate {
    return value === 'required-approval' || value === 'auto-publish';
}

/**
 * The legal transitions, as a single source of truth. A move is legal only if its
 * target appears in the current state's list; everything else is rejected. This is
 * the only place the lifecycle graph lives — the named operations below all check
 * against it rather than re-encoding the rules.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<ContributionState, readonly ContributionState[]>> = {
    draft: ['submitted'],
    submitted: ['published'],
    published: ['unpublished', 'removed'],
    unpublished: ['removed'],
    removed: [],
};

/** Whether moving `from` → `to` is a legal lifecycle transition. */
export function isLegalTransition(from: ContributionState, to: ContributionState): boolean {
    return LEGAL_TRANSITIONS[from].includes(to);
}

/** Stable error codes the caller (route/service) can switch on without matching message text. */
export type ContributionStateErrorCode = 'not_found' | 'illegal_transition' | 'gate_not_satisfied' | 'invalid_gate';

/** A typed failure from the state machine, carrying a code the caller can map to an HTTP status. */
export class ContributionStateError extends Error {
    constructor(
        readonly code: ContributionStateErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'ContributionStateError';
    }
}

/**
 * Context handed to each pre-publish hook. Hooks run inside the publish transaction
 * and MUST be synchronous (better-sqlite3 transactions are synchronous); a hook
 * that throws aborts the publish and rolls back everything done in the call.
 */
export interface PrePublishContext {
    db: Database.Database;
    /** The contribution as it stands immediately before the flip to `published`. */
    contribution: Contribution;
    /** The actor performing the publish — recorded on the audit event. */
    actorId: string;
    /** The shared UTC ISO timestamp used for this transition and its audit row. */
    timestamp: string;
}

/** A feature-specific step to run before a contribution is published (e.g. showcase scrub). */
export type PrePublishHook = (ctx: PrePublishContext) => void;

interface BaseInput {
    contributionId: string;
    /** The acting user — recorded on the audit event so a transition is never anonymous. */
    actorId: string;
    /** Optional human note attached to the audit event. */
    note?: string | null;
    /** UTC ISO timestamp for the transition and its audit row; defaults to now. */
    timestamp?: string;
}

export interface SubmitInput extends BaseInput {
    /**
     * The review gate for this contribution model. `auto-publish` carries straight
     * to published; `required-approval` stops at submitted until approved.
     *
     * SECURITY: a feature MUST derive this server-side from the contribution's
     * resolved model/settings — never echo it from client request input. A
     * client-supplied gate of `auto-publish` would let an author self-publish past
     * a required-approval model. Unrecognized values are rejected (`invalid_gate`).
     */
    gate: ReviewGate;
    /** Pre-publish hooks, used only when `auto-publish` advances this submission to published. */
    prePublishHooks?: PrePublishHook[];
}

export type ApproveInput = BaseInput;

export interface PublishInput extends BaseInput {
    /**
     * The review gate. Publishing is fail-CLOSED: anything other than the explicit
     * `auto-publish` requires a recorded approval for the current submission, so an
     * unrecognized value can never bypass the gate (it is also rejected outright as
     * `invalid_gate`). As with submit, derive this server-side, never from the client.
     */
    gate: ReviewGate;
    /** Feature-specific steps (e.g. redaction) run, atomically, before the publish. */
    prePublishHooks?: PrePublishHook[];
}

export type UnpublishInput = BaseInput;

export type RemoveInput = BaseInput;

function nowIso(): string {
    return new Date().toISOString();
}

/**
 * Load the contribution and assert that `from → to` is a legal move, throwing a
 * typed error otherwise. Returns the current contribution so callers don't re-read.
 */
function requireTransition(
    db: Database.Database,
    contributionId: string,
    to: ContributionState,
): Contribution {
    const contribution = getContribution(db, contributionId);
    if (!contribution) {
        throw new ContributionStateError('not_found', `Contribution '${contributionId}' not found.`);
    }
    if (!isLegalTransition(contribution.state, to)) {
        throw new ContributionStateError(
            'illegal_transition',
            `Illegal transition '${contribution.state}' → '${to}' for contribution '${contributionId}'.`,
        );
    }
    return contribution;
}

/**
 * Whether the current submission has a recorded approval. True when an `approved`
 * event exists no earlier than the most recent `submitted` event — scoping to the
 * latest submission keeps the check correct if a future lifecycle ever re-enters
 * `submitted`, rather than honouring a stale approval from a prior cycle.
 */
function hasApprovalForCurrentSubmission(db: Database.Database, contributionId: string): boolean {
    const events = listReviewEvents(db, contributionId);
    let lastSubmittedAt = '';
    for (const e of events) {
        if (e.event === 'submitted' && e.occurredAt >= lastSubmittedAt) {
            lastSubmittedAt = e.occurredAt;
        }
    }
    return events.some((e) => e.event === 'approved' && e.occurredAt >= lastSubmittedAt);
}

/**
 * The shared publish core: run any pre-publish hooks (inside the caller's
 * transaction), flip the state to `published`, and append the `published` audit
 * event — all with one timestamp. Assumes the legal-transition check already
 * passed and the caller wraps this in a transaction.
 */
function doPublish(
    db: Database.Database,
    contribution: Contribution,
    actorId: string,
    note: string | null,
    ts: string,
    hooks: PrePublishHook[],
): void {
    for (const hook of hooks) {
        hook({db, contribution, actorId, timestamp: ts});
    }
    updateContributionState(db, contribution.id, 'published', ts);
    addReviewEvent(db, {contributionId: contribution.id, event: 'published', actorId, note, occurredAt: ts});
}

/**
 * Submit a draft (draft → submitted), recording a `submitted` audit event. When
 * the gate is `auto-publish`, the same call carries the contribution straight to
 * `published` (running any pre-publish hooks first) — so an auto-publish model
 * reaches `published` without an approval step. With `required-approval` it stops
 * at `submitted` and waits for {@link approve} + {@link publish}.
 *
 * Returns the contribution in its resulting state. Throws `illegal_transition`
 * when the contribution is not a draft, or `not_found` when it does not exist.
 */
export function submit(db: Database.Database, input: SubmitInput): Contribution {
    if (!isReviewGate(input.gate)) {
        throw new ContributionStateError('invalid_gate', `Unrecognized review gate '${String(input.gate)}'.`);
    }
    const ts = input.timestamp ?? nowIso();
    const note = input.note ?? null;
    const hooks = input.prePublishHooks ?? [];
    const contribution = requireTransition(db, input.contributionId, 'submitted');

    return db.transaction((): Contribution => {
        updateContributionState(db, contribution.id, 'submitted', ts);
        addReviewEvent(db, {contributionId: contribution.id, event: 'submitted', actorId: input.actorId, note, occurredAt: ts});
        const submitted: Contribution = {...contribution, state: 'submitted', updatedAt: ts};
        if (input.gate === 'auto-publish') {
            doPublish(db, submitted, input.actorId, note, ts, hooks);
            return {...submitted, state: 'published'};
        }
        return submitted;
    })();
}

/**
 * Record an approval for a submitted contribution (a `required-approval` gate's
 * satisfaction). This appends an `approved` audit event but does NOT change state —
 * approval is a gate fact, not a lifecycle state — so the contribution stays
 * `submitted` until {@link publish}. Throws `illegal_transition` unless the
 * contribution is currently `submitted`.
 *
 * Actor/author separation is NOT enforced here: this primitive records whoever the
 * feature names as `actorId`, so an author may self-approve when the model allows
 * it (e.g. the showcase "developer approves" case). A feature whose model demands
 * a distinct approver (four-eyes) must enforce that before calling `approve`.
 */
export function approve(db: Database.Database, input: ApproveInput): Contribution {
    const ts = input.timestamp ?? nowIso();
    const note = input.note ?? null;
    const contribution = getContribution(db, input.contributionId);
    if (!contribution) {
        throw new ContributionStateError('not_found', `Contribution '${input.contributionId}' not found.`);
    }
    // Approval is only meaningful while a contribution awaits its review gate — it
    // records gate satisfaction for the current submission, so it is refused in any
    // state other than `submitted` (reusing the illegal_transition code: approving
    // a draft or a published item is as out-of-order as any other illegal move).
    if (contribution.state !== 'submitted') {
        throw new ContributionStateError(
            'illegal_transition',
            `Cannot approve contribution '${input.contributionId}' in state '${contribution.state}'; it must be 'submitted'.`,
        );
    }
    addReviewEvent(db, {contributionId: contribution.id, event: 'approved', actorId: input.actorId, note, occurredAt: ts});
    return contribution;
}

/**
 * Publish a submitted contribution (submitted → published). With a
 * `required-approval` gate the publish is REFUSED (`gate_not_satisfied`) unless an
 * `approved` event was recorded for the current submission — this is the
 * gate-cannot-be-bypassed guarantee. Pre-publish hooks run, atomically, before the
 * flip. Throws `illegal_transition` unless the contribution is `submitted`.
 */
export function publish(db: Database.Database, input: PublishInput): Contribution {
    if (!isReviewGate(input.gate)) {
        throw new ContributionStateError('invalid_gate', `Unrecognized review gate '${String(input.gate)}'.`);
    }
    const ts = input.timestamp ?? nowIso();
    const note = input.note ?? null;
    const hooks = input.prePublishHooks ?? [];
    const contribution = requireTransition(db, input.contributionId, 'published');

    // Fail-closed: only an explicit `auto-publish` skips the approval check, so any
    // other gate (including a future one) requires a recorded approval to reach
    // published — the gate cannot be bypassed by an unexpected value.
    if (input.gate !== 'auto-publish' && !hasApprovalForCurrentSubmission(db, input.contributionId)) {
        throw new ContributionStateError(
            'gate_not_satisfied',
            `Contribution '${input.contributionId}' requires approval before it can be published.`,
        );
    }

    return db.transaction((): Contribution => {
        doPublish(db, contribution, input.actorId, note, ts, hooks);
        return {...contribution, state: 'published', updatedAt: ts};
    })();
}

/**
 * Unpublish a published contribution (published → unpublished), recording an
 * `unpublished` audit event. From `unpublished` the only onward move is `removed`
 * (the documented graph has no republish path). Throws `illegal_transition` unless
 * the contribution is `published`.
 */
export function unpublish(db: Database.Database, input: UnpublishInput): Contribution {
    const ts = input.timestamp ?? nowIso();
    const note = input.note ?? null;
    const contribution = requireTransition(db, input.contributionId, 'unpublished');

    return db.transaction((): Contribution => {
        updateContributionState(db, contribution.id, 'unpublished', ts);
        addReviewEvent(db, {contributionId: contribution.id, event: 'unpublished', actorId: input.actorId, note, occurredAt: ts});
        return {...contribution, state: 'unpublished', updatedAt: ts};
    })();
}

/**
 * Remove a published or unpublished contribution (→ removed), recording a
 * `removed` audit event. `removed` is terminal — the legal-transition table allows
 * nothing out of it. This is the soft governance remove that preserves the audit
 * trail (distinct from the store's hard `deleteContribution`). Throws
 * `illegal_transition` unless the contribution is `published` or `unpublished`.
 */
export function remove(db: Database.Database, input: RemoveInput): Contribution {
    const ts = input.timestamp ?? nowIso();
    const note = input.note ?? null;
    const contribution = requireTransition(db, input.contributionId, 'removed');

    return db.transaction((): Contribution => {
        updateContributionState(db, contribution.id, 'removed', ts);
        addReviewEvent(db, {contributionId: contribution.id, event: 'removed', actorId: input.actorId, note, occurredAt: ts});
        return {...contribution, state: 'removed', updatedAt: ts};
    })();
}
