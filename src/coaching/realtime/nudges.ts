/**
 * Local, real-time prompt-quality nudges (Task 5.6 / #127).
 *
 * Pure STRUCTURAL checks on the outgoing prompt — no model, no network, instant
 * and private. Each check looks at the shape of the prompt (its length, whether
 * it references code/an error) and, when a gentle improvement is likely, returns
 * a dismissible, non-blocking `NudgeSuggestion`. The prompt text is read only to
 * compute the check; it never leaves this module. Only the resulting nudge TYPE
 * is metadata the developer may choose to sync.
 *
 * The `repeated_prompt` nudge is NOT here — it is driven by the loop detector
 * (loop-detector.ts), which already does the similarity work; the coach turns a
 * detected loop into that nudge.
 */

import type {NudgeType, StructuralNudge} from './types';

/** Tunables for the structural checks. */
export interface NudgeCheckConfig {
    /** Prompts shorter than this many characters are "short". */
    minPromptLength: number;
}

export const DEFAULT_NUDGE_CONFIG: NudgeCheckConfig = {
    minPromptLength: 25,
};

const MESSAGES: Record<Exclude<NudgeType, 'repeated_prompt'>, string> = {
    short_prompt:
        'This prompt is short — including the relevant code or error usually gets a better result.',
    missing_context:
        'You’re asking about code but didn’t include any — pasting the relevant code or a file reference usually helps.',
    missing_error:
        'You mention an error or bug but didn’t include the actual error output — including it usually gets a better answer.',
};

// Words that indicate the prompt is ABOUT code (so missing_context applies if no
// code/file reference is present).
const CODE_TOPIC_RE = /\b(code|function|class|method|variable|component|module|import|api|endpoint|query|snippet|refactor|implement)\b/i;

// Signals that the prompt actually INCLUDES code or a concrete file reference: a
// code fence, an inline backtick span, or a filename with a common code extension.
const CODE_PRESENT_RE = /```|`[^`]+`|\b[\w./-]+\.(ts|tsx|js|jsx|py|java|go|rs|rb|c|cpp|cs|php|sql|html|css|json|yaml|yml|sh)\b/i;

// Words that indicate the prompt is ABOUT a bug/error/failure.
const ERROR_TOPIC_RE = /\b(error|errors|exception|crash|crashed|crashes|fails|failing|failed|broken|stack\s*trace|traceback|throws|throwing)\b/i;

// Signals the prompt actually INCLUDES error output: a fenced/inline block, a
// typed-error NAME (e.g. TypeError, NullPointerException — note `\w+` so the bare
// topic word "error" does NOT count), an explicit "Error:"/"Exception:" label, a
// "file:line" marker, a stack frame, or a traceback header.
const ERROR_PRESENT_RE = /```|`[^`]+`|\b\w+(Error|Exception)\b|\b(Error|Exception)\s*:|:\s*\d+|\bat\s+[\w.$]+\s*\(|traceback \(most recent/i;

// The checks return the nudge's intrinsic part only (type + message). The
// `dismissible` flag is NOT decided here: it comes from the developer's settings
// and is stamped on exactly once by the coach, so the checks don't carry a
// write-only field the coach would immediately overwrite.

/** length-below-threshold check. */
export function checkShortPrompt(prompt: string, config: NudgeCheckConfig): StructuralNudge | null {
    if (prompt.trim().length < config.minPromptLength) {
        return {type: 'short_prompt', message: MESSAGES.short_prompt};
    }
    return null;
}

/** asks-about-code-but-includes-none check. */
export function checkMissingContext(prompt: string): StructuralNudge | null {
    if (CODE_TOPIC_RE.test(prompt) && !CODE_PRESENT_RE.test(prompt)) {
        return {type: 'missing_context', message: MESSAGES.missing_context};
    }
    return null;
}

/** describes-an-error-but-includes-no-error-text check. */
export function checkMissingError(prompt: string): StructuralNudge | null {
    if (ERROR_TOPIC_RE.test(prompt) && !ERROR_PRESENT_RE.test(prompt)) {
        return {type: 'missing_error', message: MESSAGES.missing_error};
    }
    return null;
}

/**
 * Run every structural check against one prompt and return the nudges that apply,
 * in a stable order (short → missing_context → missing_error). A structural nudge
 * is always advisory and never blocks; the coach adds the settings-driven
 * `dismissible` flag when it delivers them.
 */
export function runStructuralChecks(prompt: string, config: NudgeCheckConfig = DEFAULT_NUDGE_CONFIG): StructuralNudge[] {
    const out: StructuralNudge[] = [];
    const short = checkShortPrompt(prompt, config);
    if (short) {
        out.push(short);
    }
    const context = checkMissingContext(prompt);
    if (context) {
        out.push(context);
    }
    const error = checkMissingError(prompt);
    if (error) {
        out.push(error);
    }
    return out;
}

/** The message the coach uses when a detected loop becomes a repeated_prompt nudge. */
export const REPEATED_PROMPT_MESSAGE =
    'You’ve sent similar requests a few times. Try including the actual error output, or a different framing.';
