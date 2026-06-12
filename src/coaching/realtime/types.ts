/**
 * Shared types for real-time loop detection + prompt-quality nudges
 * (Task 5.6 / #127).
 *
 * The defining property of this feature is that detection runs LOCALLY at the
 * capture layer and prompt text never leaves the machine. These types reflect
 * that split:
 *   - `NudgeSuggestion` / `LoopDetection` are what the local coach hands the UI
 *     to show the developer (they may reference the prompt only on the machine).
 *   - `LoopEventMeta` / `NudgeEventMeta` are the NON-SENSITIVE metadata a
 *     developer may optionally sync to the server — counts, a nudge type,
 *     timestamps. There is deliberately no prompt-text field on either, so the
 *     sync payload structurally cannot carry content.
 */

/** The four structural nudge types — a closed set mirrored by the DB CHECK. */
export const NUDGE_TYPES = ['short_prompt', 'missing_context', 'missing_error', 'repeated_prompt'] as const;
export type NudgeType = (typeof NUDGE_TYPES)[number];

export function isNudgeType(value: unknown): value is NudgeType {
    return typeof value === 'string' && (NUDGE_TYPES as readonly string[]).includes(value);
}

/** A loop the detector found among the session's recent prompts (local only). */
export interface LoopDetection {
    /** How many recent prompts were similar to the new one (>= the configured N). */
    similarPromptCount: number;
}

/** A single gentle, dismissible nudge the local coach surfaces to the developer. */
export interface NudgeSuggestion {
    type: NudgeType;
    /** Human-readable, non-blocking guidance shown to the developer. */
    message: string;
    /** Whether the developer can dismiss it (resolved from settings; always advisory). */
    dismissible: boolean;
}

/**
 * Metadata-only record of a detected loop, suitable to sync to the server. Carries
 * a count and timestamps — NEVER the prompts that formed the loop.
 */
export interface LoopEventMeta {
    sessionId: string;
    detectedAt: string;
    similarPromptCount: number;
}

/**
 * Metadata-only record of a delivered nudge, suitable to sync to the server.
 * Carries the nudge TYPE and a timestamp — never the prompt that triggered it.
 */
export interface NudgeEventMeta {
    sessionId: string;
    nudgeType: NudgeType;
    deliveredAt: string;
}

/** A stored loop event as the owning developer reads it back. */
export interface LoopEvent {
    id: string;
    developerId: string;
    sessionId: string;
    detectedAt: string;
    similarPromptCount: number | null;
    createdAt: string;
}

/** A stored nudge event as the owning developer reads it back. */
export interface NudgeEvent {
    id: string;
    developerId: string;
    sessionId: string;
    nudgeType: NudgeType;
    deliveredAt: string;
    dismissed: boolean;
    createdAt: string;
}
