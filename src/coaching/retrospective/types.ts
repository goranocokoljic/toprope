/**
 * Shared types for the session-retrospective feature (Task 5.7 / #128).
 *
 * A retrospective is the OUTPUT of analysing a developer's captured session. The
 * raw prompts/responses are NEVER part of any persisted shape here — only the
 * coaching narrative and structured highlights, plus where the analysis ran.
 */

/** Where a retrospective's analysis ran. `local` is the default and keeps prompts on org infra. */
export type AnalysisLocation = 'local' | 'cloud';

export function isAnalysisLocation(value: unknown): value is AnalysisLocation {
    return value === 'local' || value === 'cloud';
}

/**
 * Structured "what worked / what to improve" highlights produced alongside the
 * narrative. Both lists are within-developer observations — never a comparison to
 * peers — so the shape carries no other developer's identity or metrics.
 */
export interface RetrospectiveHighlights {
    /** Concrete things the developer did well in the session. */
    worked: string[];
    /** Kind, specific suggestions for next time (underspecified prompts, loops, …). */
    improve: string[];
}

/** A stored retrospective as the owning developer reads it back. */
export interface Retrospective {
    id: string;
    developerId: string;
    sessionId: string;
    generatedAt: string;
    /** The local or cloud model name that produced this. */
    analysisModel: string;
    /** Where analysis ran — surfaced to the developer so they always know. */
    analysisLocation: AnalysisLocation;
    /** The coaching narrative (private to the developer). */
    retrospectiveText: string;
    /** Structured highlights, or null if none were produced. */
    highlights: RetrospectiveHighlights | null;
    createdAt: string;
}

/** The analysis output a generator persists (everything but the server-assigned id/timestamps). */
export interface RetrospectiveOutput {
    developerId: string;
    sessionId: string;
    generatedAt: string;
    analysisModel: string;
    analysisLocation: AnalysisLocation;
    retrospectiveText: string;
    highlights: RetrospectiveHighlights | null;
}
