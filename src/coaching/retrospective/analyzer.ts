/**
 * Retrospective analysers (Task 5.7 / #128).
 *
 * An analyser turns a TRANSIENTLY-decrypted captured session (plaintext held in
 * memory only) plus the session's non-sensitive loop metadata into a coaching
 * narrative + structured highlights. The analyser is the one place the plaintext
 * is read; it never logs or returns the raw prompts, only observations about them.
 *
 * Two locations exist, mirroring the privacy contract:
 *   - LOCAL (default): runs in-process on org infrastructure. The bundled
 *     `LocalHeuristicAnalyzer` is fully self-contained (no network), so the raw
 *     prompts genuinely never leave org infra — this is what makes the default
 *     path verifiably private. A deployment may swap in a local-LLM (e.g. Ollama)
 *     analyser that still satisfies `location = 'local'`.
 *   - CLOUD: a deployment-provided analyser that sends prompts to an external
 *     model. It is selected ONLY when the org permits cloud analysis AND the
 *     developer opted in (opt-in #2) — the generator enforces that gate; an
 *     analyser merely declares `location = 'cloud'`.
 *
 * All guidance is WITHIN-DEVELOPER: it describes this developer's own session and
 * never compares them to anyone else. The heuristic analyser below holds no other
 * developer's data and emits no comparative language by construction.
 */

import type {LoopEventMeta} from '../realtime/types';
import type {AnalysisLocation, RetrospectiveHighlights} from './types';

/** The input one analysis run receives. Plaintext is transient — callers never persist/log it. */
export interface SessionAnalysisInput {
    sessionId: string;
    /**
     * The decrypted prompts/responses for the session, concatenated. Present only
     * in memory for the duration of the call; an analyser must not log or echo it.
     */
    plaintext: string;
    /** Non-sensitive loop metadata (Task 5.6) for this session — counts/timestamps only. */
    loopEvents: LoopEventMeta[];
}

/** The narrative + highlights an analysis run produces. */
export interface AnalysisResult {
    retrospectiveText: string;
    highlights: RetrospectiveHighlights;
}

/**
 * A pluggable analyser. `analyze` produces the retrospective; `followUp` answers a
 * developer's conversational question about their OWN session ("why was this
 * flagged?") using the same model and the same transient plaintext — so follow-up
 * inherits the analyser's privacy location rather than opening a new path.
 */
export interface RetrospectiveAnalyzer {
    readonly location: AnalysisLocation;
    /** The model name recorded on the retrospective (e.g. a local model or a cloud model id). */
    readonly model: string;
    analyze(input: SessionAnalysisInput): AnalysisResult | Promise<AnalysisResult>;
    followUp(input: SessionAnalysisInput, retrospectiveText: string, question: string): string | Promise<string>;
}

/** Default model name for the bundled heuristic analyser. */
export const LOCAL_DEFAULT_MODEL = 'local-default';

/** A prompt is "brief" below this many words — a soft signal it may be underspecified. */
const BRIEF_PROMPT_WORDS = 5;

/** Derived, NON-sensitive signals about a session — counts only, never prompt text. */
interface SessionSignals {
    promptCount: number;
    briefPromptCount: number;
    loopCount: number;
    /** Total similar-prompt repetitions across detected loops (rough "wasted turns" proxy). */
    loopRepetitions: number;
    /** Whether at least one prompt carried context an analyser values (errors, code, paths). */
    hasContext: boolean;
}

/** Split the plaintext into individual prompts. Matches `prompt:`/`user:` turn
 * markers when present, else falls back to non-empty lines. */
function extractPrompts(plaintext: string): string[] {
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

/** Compute the within-developer signals the heuristic narrative is built from. */
function computeSignals(input: SessionAnalysisInput): SessionSignals {
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

/**
 * The bundled, self-contained LOCAL analyser. Deterministic and network-free: it
 * reads the plaintext only to count structural signals and emits within-developer
 * coaching from them, so the raw prompts never leave the process. This is the
 * default — a deployment can replace it with a local-LLM analyser that keeps
 * `location = 'local'`.
 */
export class LocalHeuristicAnalyzer implements RetrospectiveAnalyzer {
    readonly location: AnalysisLocation = 'local';
    readonly model: string;

    constructor(model: string = LOCAL_DEFAULT_MODEL) {
        this.model = model;
    }

    analyze(input: SessionAnalysisInput): AnalysisResult {
        const s = computeSignals(input);
        const worked: string[] = [];
        const improve: string[] = [];

        if (s.hasContext) {
            worked.push('You gave the model real context to work with — errors, code, or file paths — which tends to get you to a useful answer faster.');
        }
        if (s.promptCount > 0 && s.briefPromptCount === 0) {
            worked.push('Your prompts were consistently specific, with little wasted back-and-forth.');
        }
        if (s.loopCount === 0 && s.promptCount > 0) {
            worked.push('You kept the session moving without getting stuck re-sending the same request.');
        }
        if (worked.length === 0) {
            // Always offer at least one genuine, within-developer positive.
            worked.push('You worked through the session and kept engaging with the tool — a solid base to build on.');
        }

        if (s.briefPromptCount > 0) {
            improve.push(
                `${s.briefPromptCount} of your ${s.promptCount} prompt(s) were quite brief. Leading with the goal and the key constraints up front usually cuts the follow-up round-trips.`,
            );
        }
        if (s.loopCount > 0) {
            improve.push(
                `The session showed ${s.loopCount} repeated-prompt loop(s) (~${s.loopRepetitions} similar tries). When an approach isn't landing, reframing the ask — or stepping back to add context — saves time and tokens versus re-sending it.`,
            );
        }
        if (!s.hasContext) {
            improve.push(
                'Pasting the actual error, the relevant code, or a file path next time gives the model something concrete to reason about.',
            );
        }

        const text = this.composeNarrative(s, worked, improve);
        return {retrospectiveText: text, highlights: {worked, improve}};
    }

    followUp(input: SessionAnalysisInput, _retrospectiveText: string, question: string): string {
        // Re-derive the same signals from the transient plaintext so the answer is
        // grounded in the session, then explain plainly — within-developer, no peers.
        const s = computeSignals(input);
        const q = question.trim();
        const parts: string[] = [];
        if (/loop|repeat|again|stuck/i.test(q) && s.loopCount > 0) {
            parts.push(
                `It was flagged because ${s.loopCount} loop(s) were detected in this session — roughly ${s.loopRepetitions} near-identical retries. That's the signal behind the suggestion to reframe rather than re-send.`,
            );
        }
        if (/brief|short|specific|vague|underspecified/i.test(q) && s.briefPromptCount > 0) {
            parts.push(
                `${s.briefPromptCount} of your ${s.promptCount} prompt(s) came in under ${BRIEF_PROMPT_WORDS} words, which is why "be more specific" came up — it's about your own session, nothing relative to anyone else.`,
            );
        }
        if (/context|error|code/i.test(q)) {
            parts.push(
                s.hasContext
                    ? 'You did include concrete context in places — that part read well.'
                    : "This session didn't include an explicit error/code/path, which is why adding one was suggested.",
            );
        }
        if (parts.length === 0) {
            parts.push(
                `Here's what this session looked like: ${s.promptCount} prompt(s), ${s.briefPromptCount} brief, ${s.loopCount} loop(s). Ask about any of those and I'll explain the reasoning behind the guidance.`,
            );
        }
        return parts.join(' ');
    }

    /** Compose the signals + highlights into a kind, within-developer paragraph. */
    private composeNarrative(s: SessionSignals, worked: string[], improve: string[]): string {
        const opening = `Here's a look back at your session (${s.promptCount} prompt${s.promptCount === 1 ? '' : 's'}). This is just about your own work — there's no comparison to anyone else.`;
        const wins = `What worked: ${worked.join(' ')}`;
        const next = improve.length > 0 ? `For next time: ${improve.join(' ')}` : 'Nothing stood out as worth changing — keep going.';
        return [opening, wins, next].join('\n\n');
    }
}
