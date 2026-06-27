/**
 * Shared types for the private "How Could This Be Better" tool (Task 6.5 / #174).
 *
 * This is the SEPARATE, purpose-built counterpart to the deliberately-excluded
 * showcase critique: a developer runs it on their OWN conversations for
 * self-directed improvement. It shares the privacy posture and the local-default
 * model pattern of the Phase 5 retrospective (Task 5.7) but is its own tool with
 * its own store, generator, and entry point.
 *
 * An improvement review is the OUTPUT of analysing one of a developer's captured
 * conversations. As with the retrospective, the raw prompts/responses are NEVER
 * part of any persisted shape here — only the constructive narrative and the
 * structured, specific suggestions, plus where the analysis ran. It is private to
 * the developer: NEVER published, NEVER manager-visible.
 *
 * The analysis location enum is reused from the retrospective (the canonical home
 * for `local | cloud`) rather than re-declared, so the two features cannot drift.
 */

import {decodeAnalysisLocation, isAnalysisLocation, type AnalysisLocation} from '../retrospective/types';

export {decodeAnalysisLocation, isAnalysisLocation};
export type {AnalysisLocation};

/**
 * The aspect of the conversation a suggestion is about. A closed, runtime-validated
 * set (see `isImprovementCategory`) so a stored value can't masquerade as a
 * category the UI trusts. `next_level` is for an already-strong conversation —
 * "this was good; here's how to push further".
 */
export type ImprovementCategory = 'specificity' | 'context' | 'iteration' | 'efficiency' | 'next_level';

const IMPROVEMENT_CATEGORIES: readonly ImprovementCategory[] = [
    'specificity',
    'context',
    'iteration',
    'efficiency',
    'next_level',
] as const;

export function isImprovementCategory(value: unknown): value is ImprovementCategory {
    return typeof value === 'string' && (IMPROVEMENT_CATEGORIES as readonly string[]).includes(value);
}

/**
 * One specific, constructive, learning-oriented improvement suggestion. Every
 * suggestion is grounded in a concrete signal from THIS conversation (a count, a
 * detected loop, missing context) — never generic boilerplate — and is a
 * within-developer observation that compares the developer to no one else.
 */
export interface ImprovementSuggestion {
    category: ImprovementCategory;
    /** The actionable, conversation-specific suggestion text. */
    suggestion: string;
}

/** A stored improvement review as the owning developer reads it back. */
export interface ImprovementReview {
    id: string;
    developerId: string;
    sessionId: string;
    generatedAt: string;
    /** The local or cloud model name that produced this. */
    analysisModel: string;
    /** Where analysis ran — surfaced to the developer so they always know. */
    analysisLocation: AnalysisLocation;
    /** The constructive "how could this be better" narrative (private to the developer). */
    reviewText: string;
    /** The structured, specific suggestions. Always at least one. */
    suggestions: ImprovementSuggestion[];
    /** Provenance: how many capture rows the review was built from. */
    analyzedCaptureCount: number;
    createdAt: string;
}

/** The analysis output a generator persists (everything but the server-assigned id/timestamps). */
export interface ImprovementReviewOutput {
    developerId: string;
    sessionId: string;
    generatedAt: string;
    analysisModel: string;
    analysisLocation: AnalysisLocation;
    reviewText: string;
    suggestions: ImprovementSuggestion[];
    analyzedCaptureCount: number;
}
