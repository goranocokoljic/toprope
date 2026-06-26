/**
 * Mandatory manual-review flow for a showcase unit (Task 6.3.6 / #169).
 *
 * The auto-flag scrubber (6.3.5) only FLAGS content; it is never the control. The
 * real safety gate is a human: before a showcase can publish, a curator must look at
 * the conversation + every scrub flag (both tiers, shown distinctly) and EXPLICITLY
 * confirm the review is complete — regardless of what the auto-flag found, and even
 * when it found nothing. This module is that control. It provides:
 *
 *   1. {@link assembleReviewPanel} — the pre-publish review surface. It returns the
 *      conversation plus the scrub flags split into their two tiers (secrets, firm;
 *      PII hints, fallible) so the renderer keeps them visually distinct rather than
 *      blurring a noisy hint into an authoritative secret. Read-only.
 *
 *   2. {@link redactForReview} — the curator edits the conversation to resolve flags.
 *      The redaction is VERSIONED on the contribution spine (a new
 *      `contribution_versions` row), the live unit payload is updated to the redacted
 *      content, the named flags are marked resolved, and a `redacted` audit event is
 *      recorded — all atomically.
 *
 *   3. {@link confirmManualReview} — the curator records the explicit "review
 *      complete" confirmation as a `reviewed` audit event for the current submission.
 *
 *   4. {@link manualReviewGate} — a `PrePublishHook` that BLOCKS publish unless a
 *      `reviewed` event exists for the current submission. Wired into
 *      {@link publishShowcase} so it always runs; it cannot be bypassed (the epic's
 *      cross-cutting criterion). It checks only for the confirmation, never for the
 *      scrub flags — so review is required even when auto-flag found nothing.
 *
 * Why `reviewed`, not `approved`: the publish gate's developer-consent check looks for
 * an `approved` event. The manual review is a SEPARATE control performed by a curator
 * (who may be a manager in the joint path). Recording it as `approved` would let a
 * curator's review masquerade as the developer's consent and bypass the defining
 * privacy property of Epic 6.3. So the confirmation is its own event type, and the two
 * gates are independent: a publish needs BOTH the developer's `approved` AND a
 * curator's `reviewed`.
 */

import type Database from 'better-sqlite3';
import {addContributionVersion, addReviewEvent, getContribution, listReviewEvents} from '../contributions/store';
import type {PrePublishContext, PrePublishHook} from '../contributions/stateMachine';
import type {Contribution, ContributionReviewEvent} from '../contributions/types';
import {getShowcaseUnit, listScrubFlags, resolveScrubFlag, upsertShowcaseUnit} from './unitsStore';
import type {ScrubFlag} from './unitsTypes';

/** The audit event recorded when a curator confirms the manual review is complete. */
const MANUAL_REVIEW_EVENT = 'reviewed';

/** The audit event recorded when a curator redacts content to resolve flags. */
const REDACTION_EVENT = 'redacted';

/**
 * Whether the manual review is confirmed FOR THE CURRENT CONTENT. True only when a
 * `reviewed` event is the most recent review-relevant checkpoint since the latest
 * `submitted` — i.e. it comes AFTER any `redacted` event. A redaction mutates the
 * conversation, so it INVALIDATES an earlier confirmation: the curator attested to
 * content that no longer ships, and must re-review the redacted version before
 * publish. Without this, confirm → redact → publish would ship unreviewed content
 * (the confirmation alone, scoped only to the submission, would still be found).
 *
 * Events are walked in the store's total (occurred_at ASC, rowid ASC) order, and the
 * decision is "whichever of `reviewed`/`redacted` came LAST wins" — so the result is
 * deterministic even when a redaction and a confirmation share a millisecond (the
 * rowid tiebreak in the ordering settles it), and stale events from a prior
 * `submitted` cycle are excluded by starting after the latest `submitted`.
 */
function isReviewConfirmedForCurrentContent(db: Database.Database, contributionId: string): boolean {
    const events = listReviewEvents(db, contributionId);
    let lastSubmittedIdx = -1;
    for (let i = 0; i < events.length; i++) {
        if (events[i].event === 'submitted') {
            lastSubmittedIdx = i;
        }
    }
    let confirmed = false;
    for (let i = lastSubmittedIdx + 1; i < events.length; i++) {
        const ev = events[i].event;
        if (ev === REDACTION_EVENT) {
            confirmed = false;
        } else if (ev === MANUAL_REVIEW_EVENT) {
            confirmed = true;
        }
    }
    return confirmed;
}

/** Stable error codes a route/service can switch on without matching message text. */
export type ManualReviewErrorCode =
    | 'not_found'
    | 'not_showcase'
    | 'not_pre_publish'
    | 'not_submitted'
    | 'invalid_actor'
    | 'invalid_content'
    | 'unknown_flag'
    | 'review_not_confirmed';

/** A typed failure from the manual-review flow. */
export class ManualReviewError extends Error {
    constructor(
        readonly code: ManualReviewErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'ManualReviewError';
    }
}

/**
 * The pre-publish review surface for a showcase: the conversation plus its scrub
 * flags, split by tier so the two are rendered DISTINCTLY (the 6.3.6 / cross-cutting
 * "scrub tiers are visually distinct" criterion). `secretFlags` are the firm
 * secret/credential findings; `piiHintFlags` are the fallible "possible PII" hints.
 */
export interface ReviewPanel {
    contributionId: string;
    /** The (possibly already-redacted) conversation the curator is reviewing. */
    conversation: string;
    /** Firm secret/credential findings (tier `secret_high`), oldest first. */
    secretFlags: ScrubFlag[];
    /** Fallible "possible PII" hints (tier `pii_hint_low`), oldest first. */
    piiHintFlags: ScrubFlag[];
    /** Total secret-tier findings. */
    secretCount: number;
    /** Total PII-hint findings. */
    piiHintCount: number;
    /** Secret-tier findings still unresolved (the reviewer's outstanding work). */
    unresolvedSecretCount: number;
    /** PII-hint findings still unresolved. */
    unresolvedPiiHintCount: number;
    /** Whether a `reviewed` confirmation already exists for the current submission. */
    reviewConfirmed: boolean;
}

/**
 * Assemble the manual-review panel for a showcase: its conversation and its scrub
 * flags grouped into the two tiers. Returns undefined when the id is not a showcase
 * (no unit) so a route can 404 uniformly. Read-only — it never resolves a flag,
 * redacts, or confirms anything.
 */
export function assembleReviewPanel(db: Database.Database, contributionId: string): ReviewPanel | undefined {
    const unit = getShowcaseUnit(db, contributionId);
    if (!unit) {
        return undefined;
    }
    const flags = listScrubFlags(db, contributionId);
    const secretFlags = flags.filter((f) => f.tier === 'secret_high');
    const piiHintFlags = flags.filter((f) => f.tier === 'pii_hint_low');
    return {
        contributionId,
        conversation: unit.conversation,
        secretFlags,
        piiHintFlags,
        secretCount: secretFlags.length,
        piiHintCount: piiHintFlags.length,
        unresolvedSecretCount: secretFlags.filter((f) => !f.resolved).length,
        unresolvedPiiHintCount: piiHintFlags.filter((f) => !f.resolved).length,
        reviewConfirmed: isReviewConfirmedForCurrentContent(db, contributionId),
    };
}

/** Load a contribution and assert it exists AND is a showcase (it has a unit). */
function requireShowcase(db: Database.Database, contributionId: string): Contribution {
    const contribution = getContribution(db, contributionId);
    if (!contribution) {
        throw new ManualReviewError('not_found', `Contribution '${contributionId}' not found.`);
    }
    if (!getShowcaseUnit(db, contributionId)) {
        throw new ManualReviewError(
            'not_showcase',
            `Contribution '${contributionId}' is not a showcase (no showcase unit).`,
        );
    }
    return contribution;
}

function requireActor(actorId: string, label: string): void {
    if (typeof actorId !== 'string' || actorId.trim() === '') {
        throw new ManualReviewError('invalid_actor', `${label} is required and cannot be blank.`);
    }
}

export interface RedactInput {
    contributionId: string;
    /** The curator performing the redaction — recorded on the version and audit event. */
    actorId: string;
    /** The new conversation content with sensitive material removed/edited. */
    redactedConversation: string;
    /** The scrub-flag ids this redaction resolves. Each must belong to this showcase. */
    resolvedFlagIds?: string[];
    /** Optional note attached to the version and the `redacted` audit event. */
    note?: string | null;
    /** UTC ISO timestamp for the version + audit row; defaults to now. */
    timestamp?: string;
}

export interface RedactionResult {
    /** The new version number the redaction created in the contribution lineage. */
    version: number;
    /** The flag ids actually marked resolved by this redaction. */
    resolvedFlagIds: string[];
}

/**
 * Redact a showcase's conversation to resolve scrub flags. The edit is VERSIONED:
 *
 *   1. a new `contribution_versions` row captures the redacted body (the redaction
 *      is recoverable history, never an in-place overwrite of the prior content),
 *   2. the live `showcase_units.conversation` is updated to the redacted content so
 *      the next review panel reflects it,
 *   3. each named flag is marked resolved, and
 *   4. a `redacted` audit event is recorded.
 *
 * All four run in one transaction — a redaction is never half-applied. Fail-closed
 * validations run first: the contribution must be a showcase, in a PRE-PUBLISH state
 * (draft/submitted — a published or removed showcase cannot be redacted), the actor
 * non-blank, the new content non-blank, and EVERY `resolvedFlagIds` entry must be a
 * real flag on this contribution (a typo'd id is rejected, not silently ignored).
 */
export function redactForReview(db: Database.Database, input: RedactInput): RedactionResult {
    const contribution = requireShowcase(db, input.contributionId);
    requireActor(input.actorId, 'actorId');
    if (typeof input.redactedConversation !== 'string' || input.redactedConversation.trim() === '') {
        throw new ManualReviewError('invalid_content', 'redactedConversation is required and cannot be blank.');
    }
    // A redaction only makes sense before publish — once published the content is
    // already out, and a removed/unpublished unit is not a publish candidate.
    if (contribution.state !== 'draft' && contribution.state !== 'submitted') {
        throw new ManualReviewError(
            'not_pre_publish',
            `Cannot redact contribution '${input.contributionId}' in state '${contribution.state}'; it must be draft or submitted.`,
        );
    }

    const flagIds = input.resolvedFlagIds ?? [];
    // Validate every id against the showcase's own flags BEFORE writing, so a ghost/
    // typo'd id can never produce a redaction that "succeeds" yet resolves nothing.
    const ownFlagIds = new Set(listScrubFlags(db, input.contributionId).map((f) => f.id));
    for (const id of flagIds) {
        if (!ownFlagIds.has(id)) {
            throw new ManualReviewError(
                'unknown_flag',
                `Scrub flag '${id}' does not belong to showcase '${input.contributionId}'.`,
            );
        }
    }

    const ts = input.timestamp;
    const unit = getShowcaseUnit(db, input.contributionId);
    if (!unit) {
        // Unreachable after requireShowcase, but keeps the transaction body total.
        throw new ManualReviewError('not_showcase', `Showcase unit for '${input.contributionId}' vanished.`);
    }

    return db.transaction((): RedactionResult => {
        const version = addContributionVersion(db, input.contributionId, {
            body: input.redactedConversation,
            authorId: input.actorId,
            changeNote: input.note ?? 'redaction for manual review',
            timestamp: ts,
        });
        if (!version) {
            // requireShowcase already proved the contribution exists; treat absence here
            // as a not_found rather than a silent no-op.
            throw new ManualReviewError('not_found', `Contribution '${input.contributionId}' not found.`);
        }
        // Keep the live unit payload in sync with the new version (re-passing the unit's
        // existing fields so the mandatory-note and path gates in upsert still hold).
        upsertShowcaseUnit(db, {
            contributionId: input.contributionId,
            conversation: input.redactedConversation,
            curatorsNote: unit.curatorsNote,
            publishPath: unit.publishPath,
            outcomeLink: unit.outcomeLink,
            aiAnnotation: unit.aiAnnotation,
        });
        const resolvedFlagIds: string[] = [];
        for (const id of flagIds) {
            if (resolveScrubFlag(db, id)) {
                resolvedFlagIds.push(id);
            }
        }
        addReviewEvent(db, {
            contributionId: input.contributionId,
            event: REDACTION_EVENT,
            actorId: input.actorId,
            note: input.note ?? null,
            occurredAt: ts,
        });
        return {version: version.version, resolvedFlagIds};
    })();
}

export interface ConfirmReviewInput {
    contributionId: string;
    /** The curator confirming the review is complete — recorded on the audit event. */
    actorId: string;
    note?: string | null;
    /** UTC ISO timestamp; defaults to now. */
    timestamp?: string;
}

/**
 * Record the curator's explicit "manual review complete" confirmation as a `reviewed`
 * audit event — the single act that satisfies {@link manualReviewGate}. The
 * contribution must be a showcase and currently `submitted` (the review happens on a
 * submission awaiting publish); confirming a draft/published/removed showcase is
 * refused. Returns the stored audit event.
 *
 * This does NOT require all scrub flags to be resolved — the curator is the control
 * and decides; the confirmation is their attestation that they reviewed and the
 * content is safe to publish. It is deliberately distinct from the developer's
 * `approved` consent (see the module header).
 */
export function confirmManualReview(db: Database.Database, input: ConfirmReviewInput): ContributionReviewEvent {
    const contribution = requireShowcase(db, input.contributionId);
    requireActor(input.actorId, 'actorId');
    if (contribution.state !== 'submitted') {
        throw new ManualReviewError(
            'not_submitted',
            `Cannot confirm manual review for '${input.contributionId}' in state '${contribution.state}'; it must be 'submitted'.`,
        );
    }
    return addReviewEvent(db, {
        contributionId: input.contributionId,
        event: MANUAL_REVIEW_EVENT,
        actorId: input.actorId,
        note: input.note ?? null,
        occurredAt: input.timestamp,
    });
}

/**
 * The MANDATORY manual-review publish gate, as a `PrePublishHook`. Runs inside the
 * publish transaction immediately before the flip to `published`; throwing rolls the
 * whole publish back. It BLOCKS the publish unless a `reviewed` confirmation event
 * exists for the current submission.
 *
 * It checks ONLY for the confirmation — never for the scrub flags — so the mandatory
 * review is required even when the auto-flag scrubber found nothing (auto-flag never
 * substitutes for the human review). The confirmation must also be CURRENT: a
 * redaction after confirmation invalidates it, so the curator re-reviews the redacted
 * content. Fail-closed: no current confirmation → no publish.
 */
export const manualReviewGate: PrePublishHook = (ctx: PrePublishContext): void => {
    if (!isReviewConfirmedForCurrentContent(ctx.db, ctx.contribution.id)) {
        throw new ManualReviewError(
            'review_not_confirmed',
            `Publish blocked: mandatory manual review is not confirmed for showcase '${ctx.contribution.id}'.`,
        );
    }
};
