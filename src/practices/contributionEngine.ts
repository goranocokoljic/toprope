/**
 * Best-Practice contribution-model engine — the "doing things under a model" layer
 * (Task 6.2.2 / #157).
 *
 * The three models (top_down / bottom_up / hybrid) all sit on the SAME 6.1
 * primitives: the shared contribution spine, the 6.1.2 state machine, and the
 * 6.2.1 practice tables. A model is not a separate code path or schema — it is a
 * configuration of (a) which 6.1.2 review gate a submission gets and (b) which
 * actions a non-lead is allowed to take. This engine resolves the active model for
 * the contribution's team and drives the state machine accordingly, so callers
 * (routes/services) never re-derive the gate or the permission rule.
 *
 * Permission posture: like the rest of the spine (the state machine takes its gate
 * server-side, `hideOrgItemForTeam` takes `permitted` server-side), this engine
 * takes `actorIsLead` as a server-derived capability rather than reading roles
 * itself. The caller decides who is a lead/curator (admin, team manager, …) and
 * passes the boolean; the engine decides what that capability is allowed to do
 * under the active model. NEVER derive `actorIsLead` from client request input.
 */

import type Database from 'better-sqlite3';
import {
    approve as smApprove,
    ContributionStateError,
    publish as smPublish,
    submit as smSubmit,
    type PrePublishHook,
    type ReviewGate,
} from '../contributions/stateMachine';
import type {Contribution} from '../contributions/types';
import {getContribution} from '../contributions/store';
import {getFeedbackCounts, getPracticeDetails, setPracticeEndorsed} from './store';
import {
    gateForModel,
    modelRequiresLeadToPublish,
    modelUsesEndorsement,
    resolveContributionModel,
    type ContributionModel,
} from './contributionModel';

/** Stable error codes the caller can map to an HTTP status without matching message text. */
export type ContributionModelErrorCode =
    | 'not_authorized' // the actor's capability is insufficient for this action under the active model
    | 'not_applicable' // the action is meaningless under the active model (e.g. endorse when not hybrid)
    | 'not_published'; // the action requires a published contribution (e.g. endorsing a draft/removed practice)

/** A typed failure from the engine's model/permission layer (distinct from state-machine errors). */
export class ContributionModelError extends Error {
    constructor(
        readonly code: ContributionModelErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'ContributionModelError';
    }
}

/** Common inputs shared by every engine operation. */
interface BaseEngineInput {
    contributionId: string;
    /** The acting user — recorded on the audit event by the state machine. */
    actorId: string;
    /**
     * Whether the actor is a lead/curator, derived SERVER-SIDE by the caller. The
     * engine trusts this to decide model-gated permissions; a client must never set it.
     */
    actorIsLead: boolean;
    /** The team whose active model governs this action. Omit/null resolves the global default. */
    team?: string | null;
    /** Optional human note attached to the audit event. */
    note?: string | null;
    /** UTC ISO timestamp for the transition; defaults to now (set by the state machine). */
    timestamp?: string;
}

export interface SubmitPracticeInput extends BaseEngineInput {
    /**
     * Feature-specific pre-publish steps. Used only when the active model is an
     * auto-publish one (bottom_up / hybrid) and the submit therefore carries
     * straight to published. Ignored under top_down (publish is a later step).
     */
    prePublishHooks?: PrePublishHook[];
}

export type ApprovePracticeInput = BaseEngineInput;

export interface PublishPracticeInput extends BaseEngineInput {
    prePublishHooks?: PrePublishHook[];
}

export type EndorsePracticeInput = BaseEngineInput;

/** The active model + gate that governed an engine action, returned alongside its result. */
export interface ModelOutcome {
    model: ContributionModel;
    gate: ReviewGate;
}

export interface SubmitPracticeResult extends ModelOutcome {
    contribution: Contribution;
}

export interface PublishPracticeResult extends ModelOutcome {
    contribution: Contribution;
}

/**
 * Submit a draft best practice under the contribution's active model.
 *
 * Submitting is OPEN to any author under every model — the model differs only in
 * what happens next:
 *   * top_down → `required-approval` gate: the contribution stops at `submitted`
 *     and waits for a lead to {@link approvePractice} then {@link publishPractice}.
 *   * bottom_up / hybrid → `auto-publish` gate: the same call carries the
 *     contribution straight to `published`, running any pre-publish hooks first.
 *
 * Returns the resulting contribution together with the model and gate that drove
 * it. Propagates `ContributionStateError` (e.g. the contribution is not a draft).
 */
export function submitPractice(db: Database.Database, input: SubmitPracticeInput): SubmitPracticeResult {
    const model = resolveContributionModel(db, input.team);
    const gate = gateForModel(model);
    const contribution = smSubmit(db, {
        contributionId: input.contributionId,
        actorId: input.actorId,
        note: input.note,
        timestamp: input.timestamp,
        gate,
        prePublishHooks: input.prePublishHooks,
    });
    return {model, gate, contribution};
}

/**
 * Record a lead approval for a submitted top_down practice (the `required-approval`
 * gate's satisfaction). Approval is a LEAD action: a non-lead is rejected with
 * `not_authorized` before the state machine is touched. It is also `not_applicable`
 * under an auto-publish model (bottom_up / hybrid), where there is no approval gate
 * to satisfy — guarding here gives a clear error rather than a confusing
 * `illegal_transition` from approving an already-published contribution.
 *
 * Returns the active model + gate. Propagates `ContributionStateError` (e.g. the
 * contribution is not in `submitted`).
 */
export function approvePractice(db: Database.Database, input: ApprovePracticeInput): ModelOutcome {
    const model = resolveContributionModel(db, input.team);
    const gate = gateForModel(model);
    if (gate !== 'required-approval') {
        throw new ContributionModelError(
            'not_applicable',
            `Approval is only meaningful under a required-approval model; the active model '${model}' auto-publishes.`,
        );
    }
    if (!input.actorIsLead) {
        throw new ContributionModelError(
            'not_authorized',
            'Only a lead/curator may approve a submission under the top-down model.',
        );
    }
    smApprove(db, {
        contributionId: input.contributionId,
        actorId: input.actorId,
        note: input.note,
        timestamp: input.timestamp,
    });
    return {model, gate};
}

/**
 * Publish a submitted practice under the contribution's active model — the single
 * place the "non-leads cannot publish" rule lives.
 *
 * Under top_down the model lead-gates publishing: a non-lead is rejected with
 * `not_authorized` BEFORE the state machine runs, and even a lead must have a
 * recorded approval (the state machine enforces the gate). Under bottom_up / hybrid
 * publishing is open — anyone may publish, and the `auto-publish` gate needs no
 * approval. The only legal entry is `submitted → published`; a contribution that
 * never reached `submitted` (or is already published) gets `illegal_transition`.
 *
 * Returns the resulting contribution with its model + gate. Propagates
 * `ContributionStateError` (e.g. `gate_not_satisfied` when a top_down publish has
 * no approval, or `illegal_transition` when the contribution is not `submitted`).
 */
export function publishPractice(db: Database.Database, input: PublishPracticeInput): PublishPracticeResult {
    const model = resolveContributionModel(db, input.team);
    const gate = gateForModel(model);
    if (modelRequiresLeadToPublish(model) && !input.actorIsLead) {
        throw new ContributionModelError(
            'not_authorized',
            `Only a lead/curator may publish under the '${model}' model.`,
        );
    }
    const contribution = smPublish(db, {
        contributionId: input.contributionId,
        actorId: input.actorId,
        note: input.note,
        timestamp: input.timestamp,
        gate,
        prePublishHooks: input.prePublishHooks,
    });
    return {model, gate, contribution};
}

/**
 * Set (or clear) a lead's endorsement on a hybrid practice — the hybrid model's
 * elevation lever. Endorsing is a LEAD action (`not_authorized` for a non-lead) and
 * is `not_applicable` unless the active model is `hybrid`: under top_down and
 * bottom_up endorsement carries no meaning, so the engine refuses it rather than
 * writing a flag nothing reads.
 *
 * Endorsement also requires a PUBLISHED contribution: it elevates a practice within
 * the published pool, so endorsing a draft/submitted/unpublished/removed practice is
 * meaningless and is refused (`not_published`) rather than writing a flag that drifts
 * out of sync with the lifecycle. A non-existent contribution throws the spine's
 * `not_found` (a `ContributionStateError`) instead of letting the raw FK surface an
 * un-coded SQLite error. Both checks run before the store write so the guard order
 * is: model → authority → existence → state. Persists `practice_details.endorsed`
 * via the 6.2.1 store and returns the active model + gate.
 *
 * `endorsed` defaults to true; pass `false` to withdraw a prior endorsement.
 */
export function endorsePractice(
    db: Database.Database,
    input: EndorsePracticeInput & {endorsed?: boolean},
): ModelOutcome {
    const model = resolveContributionModel(db, input.team);
    const gate = gateForModel(model);
    if (!modelUsesEndorsement(model)) {
        throw new ContributionModelError(
            'not_applicable',
            `Endorsement only applies under the hybrid model; the active model is '${model}'.`,
        );
    }
    if (!input.actorIsLead) {
        throw new ContributionModelError('not_authorized', 'Only a lead/curator may endorse a practice.');
    }
    const contribution = getContribution(db, input.contributionId);
    if (!contribution) {
        throw new ContributionStateError('not_found', `Contribution '${input.contributionId}' not found.`);
    }
    if (contribution.state !== 'published') {
        throw new ContributionModelError(
            'not_published',
            `Only a published practice can be endorsed; '${input.contributionId}' is '${contribution.state}'.`,
        );
    }
    setPracticeEndorsed(db, input.contributionId, input.endorsed ?? true);
    return {model, gate};
}

/** One practice's place in a model-ordered pool, with the signals that placed it. */
export interface RankedPractice {
    contributionId: string;
    /** Hybrid elevation flag (`practice_details.endorsed`); false when no details row. */
    endorsed: boolean;
    helpful: number;
    notHelpful: number;
    /**
     * Net feedback score (`helpful - notHelpful`) — a deliberately lightweight,
     * directional signal for Phase 6. The richer helpful-ratio + usage-signal blend
     * is 6.2.4's job; this is enough to demonstrate feedback ordering.
     */
    score: number;
    createdAt: string;
}

/**
 * Order a set of practices into the pool the active model presents.
 *
 *   * bottom_up → ranked purely by feedback: higher net score first, then more
 *     total feedback, then most recent.
 *   * hybrid → endorsed practices ELEVATED above un-endorsed ones, and within each
 *     group the same feedback ordering as bottom_up.
 *   * top_down → leads curate what is published, so there is no algorithmic
 *     surfacing to apply: ordered most-recent-first as a stable default.
 *
 * Only PUBLISHED practices are ranked: the pool is what a viewer sees, so a
 * draft/submitted/unpublished/removed practice (or an unknown id with no
 * contribution row) is dropped rather than surfaced. The result is therefore a
 * subset of the input, never a list with holes. The ordering is total and
 * deterministic (id is the final tiebreak), so the same input always yields the
 * same order.
 */
export function orderPracticePool(
    db: Database.Database,
    model: ContributionModel,
    contributionIds: readonly string[],
): RankedPractice[] {
    const ranked: RankedPractice[] = [];
    for (const id of contributionIds) {
        const contribution = getContribution(db, id);
        if (!contribution || contribution.state !== 'published') {
            continue;
        }
        const counts = getFeedbackCounts(db, id);
        const details = getPracticeDetails(db, id);
        ranked.push({
            contributionId: id,
            endorsed: details?.endorsed ?? false,
            helpful: counts.helpful,
            notHelpful: counts.notHelpful,
            score: counts.helpful - counts.notHelpful,
            createdAt: contribution.createdAt,
        });
    }

    const byFeedback = (a: RankedPractice, b: RankedPractice): number => {
        if (a.score !== b.score) {
            return b.score - a.score;
        }
        const aTotal = a.helpful + a.notHelpful;
        const bTotal = b.helpful + b.notHelpful;
        if (aTotal !== bTotal) {
            return bTotal - aTotal;
        }
        if (a.createdAt !== b.createdAt) {
            return a.createdAt < b.createdAt ? 1 : -1; // newer first
        }
        return a.contributionId < b.contributionId ? -1 : 1; // stable final tiebreak
    };

    if (model === 'top_down') {
        // Curated: most recent first, id as the stable final tiebreak.
        return ranked.sort((a, b) => {
            if (a.createdAt !== b.createdAt) {
                return a.createdAt < b.createdAt ? 1 : -1;
            }
            return a.contributionId < b.contributionId ? -1 : 1;
        });
    }

    if (model === 'hybrid') {
        // Endorsed elevated above un-endorsed; feedback order within each group.
        return ranked.sort((a, b) => {
            if (a.endorsed !== b.endorsed) {
                return a.endorsed ? -1 : 1;
            }
            return byFeedback(a, b);
        });
    }

    // bottom_up: pure feedback ordering.
    return ranked.sort(byFeedback);
}
