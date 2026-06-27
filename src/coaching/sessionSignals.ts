/**
 * Shared, network-free derivation of NON-sensitive structural signals from a
 * transiently-decrypted session (extracted from the Task 5.7 retrospective
 * analyser so the deep-coaching consumers share ONE source of truth for "how we
 * read a session's shape").
 *
 * Both the session retrospective (Task 5.7 / #128) and the private "how could
 * this be better" improvement tool (Task 6.5 / #174) need the same structural
 * read of a decrypted session — prompt count, brief-prompt count, loop activity,
 * whether the developer supplied concrete context — and they must agree on it.
 * Cloning the computation per consumer would create a second, silently-drifting
 * definition of those signals, so it lives here once.
 *
 * Everything here is COUNTS ONLY: the plaintext is read to tally structure and is
 * never logged, echoed, or returned. The signals carry no prompt text and no
 * other developer's data, so they are safe to base within-developer coaching on.
 */

import type {LoopEventMeta} from './realtime/types';

/**
 * The input one analysis run receives. Plaintext is transient — callers decrypt
 * it in memory for the duration of the call and never persist or log it.
 */
export interface SessionAnalysisInput {
    sessionId: string;
    /**
     * The decrypted prompts/responses for the session, concatenated. Present only
     * in memory for the duration of the call; a consumer must not log or echo it.
     */
    plaintext: string;
    /** Non-sensitive loop metadata (Task 5.6) for this session — counts/timestamps only. */
    loopEvents: LoopEventMeta[];
}

/** Derived, NON-sensitive signals about a session — counts only, never prompt text. */
export interface SessionSignals {
    promptCount: number;
    briefPromptCount: number;
    loopCount: number;
    /** Total similar-prompt repetitions across detected loops (rough "wasted turns" proxy). */
    loopRepetitions: number;
    /** Whether at least one prompt carried context an analyser values (errors, code, paths). */
    hasContext: boolean;
}

/** A prompt is "brief" below this many words — a soft signal it may be underspecified. */
export const BRIEF_PROMPT_WORDS = 5;

/**
 * Split the plaintext into individual prompts. Matches `prompt:`/`user:` turn
 * markers when present, else falls back to non-empty lines.
 */
export function extractPrompts(plaintext: string): string[] {
    const lines = plaintext.split(/\r?\n/);
    const marked = lines
        .map((line) => /^\s*(prompt|user)\s*:(.*)$/i.exec(line))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => m[2].trim())
        .filter((s) => s.length > 0);
    if (marked.length > 0) {
        return marked;
    }
    return lines.map((l) => l.trim()).filter((l) => l.length > 0);
}

/** Compute the within-developer signals a heuristic narrative is built from. */
export function computeSignals(input: SessionAnalysisInput): SessionSignals {
    const prompts = extractPrompts(input.plaintext);
    const briefPromptCount = prompts.filter((p) => p.split(/\s+/).filter(Boolean).length < BRIEF_PROMPT_WORDS).length;
    // Context markers an analyser would reward: an error/stack trace, a fenced code
    // block, or a file path — all signals the developer gave the model something to
    // work with. Checked over the whole plaintext, case-insensitively.
    const hasContext = /```|error|exception|stack trace|\.\w{1,5}:\d+|\/[\w./-]+\.\w+/i.test(input.plaintext);
    const loopCount = input.loopEvents.length;
    const loopRepetitions = input.loopEvents.reduce((sum, e) => sum + Math.max(0, e.similarPromptCount), 0);
    return {promptCount: prompts.length, briefPromptCount, loopCount, loopRepetitions, hasContext};
}
