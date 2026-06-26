/**
 * Mandatory curators' note (hard publish gate) + prominent outcome/note display
 * for a showcase unit (Task 6.3.4 / #167).
 *
 * A showcase unit already CAPTURES the two curation fields at draft time (6.3.2):
 *   - the MANDATORY curators' note ("what to take away"), and
 *   - the optional outcome link (the PR/commit/goal the conversation produced).
 * The 6.3.1 store (`upsertShowcaseUnit`) rejects a blank note at the WRITE boundary.
 * This module adds the two things that boundary cannot give on its own:
 *
 *   1. A HARD PUBLISH GATE for the curators' note. {@link curatorsNoteGate} is a
 *      `PrePublishHook` that re-validates the note at the publish boundary, inside the
 *      publish transaction, and throws (rolling the publish back) when it is
 *      missing/blank — independent of how the unit was created. It is wired into
 *      {@link publishShowcase} so it ALWAYS runs first, before any caller-supplied
 *      scrub/review hooks: a showcase can never reach `published` without a note, even
 *      if a future code path or a direct DB write sidesteps the draft-time gate. This
 *      is the fail-closed reading of the 6.3.4 criterion "publish is blocked if
 *      curators_note is empty (hard gate)" — defense in depth, not a second source of
 *      truth (the note still lives only in showcase_units).
 *
 *   2. A PROMINENT UNIT VIEW. {@link assembleCuratedUnit} surfaces the curators' note
 *      and outcome link as TOP-LEVEL header fields of the unit view — structurally
 *      ABOVE the per-turn body — so a viewer reads "what to take away" and the outcome
 *      at a glance before the conversation itself. It reuses the canonical
 *      `assembleInlineDisplay` (6.3.3) for the annotated turns rather than re-deriving
 *      the turn/annotation merge, so there is one source of truth for the body.
 *
 * Privacy posture: this module is read/validate only over already-consented state. It
 * does not publish, harvest, or relax any consent gate — the developer-approval gate
 * (6.3.2) still owns who may publish.
 */

import type Database from 'better-sqlite3';
import type {PrePublishContext, PrePublishHook} from '../contributions/stateMachine';
import {assembleInlineDisplay, type InlineDisplay} from './annotations';
import {renderAiAnnotation, type RenderedAiAnnotation} from './aiAnnotation';
import {getShowcaseUnit} from './unitsStore';

/** Stable error codes a route/service can switch on without matching message text. */
export type CurationErrorCode = 'not_showcase' | 'missing_curators_note';

/** A typed failure from the curation gate, distinct from the spine's state errors. */
export class CurationError extends Error {
    constructor(
        readonly code: CurationErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'CurationError';
    }
}

/** Whether a value is a present, non-blank string (the note/outcome "filled in" test). */
function isFilledIn(value: unknown): value is string {
    return typeof value === 'string' && value.trim() !== '';
}

/**
 * The MANDATORY curators'-note publish gate, as a `PrePublishHook`. Runs inside the
 * publish transaction immediately before the flip to `published`; throwing rolls the
 * whole publish back, so a showcase whose note is missing/blank stays unpublished.
 *
 * It asserts, in order, that the contribution being published:
 *   - HAS a showcase unit (`not_showcase`) — entity existence; a contribution with no
 *     unit is not a publishable showcase, and
 *   - that unit's curators' note is a non-blank string (`missing_curators_note`).
 *
 * The NOT NULL column and the 6.3.1 draft-time gate already make a blank note unusual;
 * this re-validates it at the publish boundary so the hard gate holds regardless of how
 * the row came to be — the fail-closed defense the 6.3.4 criterion calls for.
 */
export const curatorsNoteGate: PrePublishHook = (ctx: PrePublishContext): void => {
    const unit = getShowcaseUnit(ctx.db, ctx.contribution.id);
    if (!unit) {
        throw new CurationError(
            'not_showcase',
            `Contribution '${ctx.contribution.id}' is not a showcase (no showcase unit); cannot publish.`,
        );
    }
    if (!isFilledIn(unit.curatorsNote)) {
        throw new CurationError(
            'missing_curators_note',
            `Publish blocked: the mandatory curators' note is empty for showcase '${ctx.contribution.id}'.`,
        );
    }
};

/**
 * The prominent view of a curated showcase unit: the curators' note and outcome link
 * as a header above the annotated conversation body.
 */
export interface CuratedUnitView {
    contributionId: string;
    /** The MANDATORY curators' note ("what to take away"), rendered prominently. */
    curatorsNote: string;
    /** The outcome link (PR/commit/goal), or null when none was captured. */
    outcomeLink: string | null;
    /**
     * Whether a usable outcome link is present (non-blank). Lets a renderer decide to
     * show the outcome affordance without re-deriving the blank check — a whitespace-only
     * link counts as absent.
     */
    hasOutcomeLink: boolean;
    /** The annotated conversation body, assembled by the canonical 6.3.3 helper. */
    display: InlineDisplay;
    /**
     * The optional AI prompt-technique annotation (6.3.7), rendered as a clearly-AI,
     * SECONDARY footnote. Always present in the view shape (with `present: false` when
     * none was generated) so a renderer can style it distinctly from — and below —
     * the human voice (the curators' note + inline developer annotations).
     */
    aiAnnotation: RenderedAiAnnotation;
}

/**
 * Assemble the prominent unit view for a showcase: its curators' note and outcome link
 * as TOP-LEVEL header fields, plus the annotated-turn body from the canonical inline
 * display. Returns undefined when the id is not a showcase (no unit), so a route can 404
 * uniformly — mirroring `assembleInlineDisplay`.
 *
 * The "prominent" placement is structural: the note and outcome sit above `display`
 * rather than buried among the turns, so a viewer reads the takeaway and outcome first.
 */
export function assembleCuratedUnit(db: Database.Database, contributionId: string): CuratedUnitView | undefined {
    const unit = getShowcaseUnit(db, contributionId);
    if (!unit) {
        return undefined;
    }
    // The unit exists, so the inline display is defined too; default defensively rather
    // than assert, so a future divergence degrades to an empty body instead of throwing.
    const display = assembleInlineDisplay(db, contributionId) ?? {turns: [], orphaned: []};
    return {
        contributionId,
        curatorsNote: unit.curatorsNote,
        outcomeLink: unit.outcomeLink,
        hasOutcomeLink: isFilledIn(unit.outcomeLink),
        display,
        // The AI annotation is the lowest layer: rendered clearly-AI and secondary, it
        // sits below the human note/outcome/turns rather than among them.
        aiAnnotation: renderAiAnnotation(unit.aiAnnotation),
    };
}
