/**
 * Improvement analysers for the private "How Could This Be Better" tool
 * (Task 6.5 / #174).
 *
 * An analyser turns a TRANSIENTLY-decrypted conversation (plaintext held in
 * memory only) plus the session's non-sensitive loop metadata into a
 * constructive, learning-oriented "how could this be better" review — a narrative
 * plus structured, SPECIFIC suggestions. Where the Phase 5 retrospective is
 * deliberately celebratory, this is where sharper, more direct feedback lives —
 * but it is still kind and entirely within-developer: it describes the
 * developer's own conversation and compares them to no one else.
 *
 * Two locations exist, mirroring the privacy contract shared with the
 * retrospective:
 *   - LOCAL (default): runs in-process on org infrastructure. The bundled
 *     `LocalHeuristicImprovementAnalyzer` is fully self-contained (no network), so
 *     the raw prompts genuinely never leave org infra — this is what makes the
 *     default path verifiably private.
 *   - CLOUD: a deployment-provided analyser that sends prompts to an external
 *     model, selected ONLY under the Phase 5 double-opt-in (org permits cloud
 *     analysis AND the developer opted in). The generator enforces that gate; an
 *     analyser merely declares `location = 'cloud'`.
 *
 * Every suggestion the bundled analyser emits is grounded in a concrete signal
 * from THIS conversation (a count, a detected loop, missing context), so the
 * output is specific by construction rather than generic boilerplate.
 */

import {BRIEF_PROMPT_WORDS, computeSignals, type SessionAnalysisInput, type SessionSignals} from '../sessionSignals';
import type {AnalysisLocation, ImprovementSuggestion} from './types';

// The transient-session input is the same shape the retrospective consumes; both
// import it from ../sessionSignals (the single home). Re-export for callers/tests.
export type {SessionAnalysisInput} from '../sessionSignals';

/** The narrative + specific suggestions an improvement run produces. */
export interface ImprovementResult {
    reviewText: string;
    suggestions: ImprovementSuggestion[];
}

/**
 * A pluggable improvement analyser. `analyze` produces the review. (Unlike the
 * retrospective, there is intentionally no conversational follow-up here — the
 * issue scopes this tool to "run it on a conversation → get specific suggestions",
 * and a follow-up channel would widen the privacy surface for no required use.)
 */
export interface ImprovementAnalyzer {
    readonly location: AnalysisLocation;
    /** The model name recorded on the review (e.g. a local model or a cloud model id). */
    readonly model: string;
    analyze(input: SessionAnalysisInput): ImprovementResult | Promise<ImprovementResult>;
}

/** Default model name for the bundled heuristic improvement analyser. */
export const LOCAL_DEFAULT_IMPROVEMENT_MODEL = 'local-default';

/**
 * The bundled, self-contained LOCAL improvement analyser. Deterministic and
 * network-free: it reads the plaintext only to count structural signals and emits
 * within-developer, conversation-specific suggestions from them, so the raw
 * prompts never leave the process. Each suggestion names a concrete number from
 * the conversation, which is what keeps the output specific rather than generic.
 */
export class LocalHeuristicImprovementAnalyzer implements ImprovementAnalyzer {
    readonly location: AnalysisLocation = 'local';
    readonly model: string;

    constructor(model: string = LOCAL_DEFAULT_IMPROVEMENT_MODEL) {
        this.model = model;
    }

    analyze(input: SessionAnalysisInput): ImprovementResult {
        const s = computeSignals(input);
        const suggestions = this.deriveSuggestions(s);
        return {reviewText: this.composeNarrative(s, suggestions), suggestions};
    }

    /**
     * Build the specific, constructive suggestions from the session signals. Each
     * entry references a concrete count from THIS conversation. If the conversation
     * showed no weak signals, a `next_level` suggestion still grounds itself in the
     * prompt count so the developer always gets a specific, actionable nudge rather
     * than a generic "looks good".
     */
    private deriveSuggestions(s: SessionSignals): ImprovementSuggestion[] {
        const suggestions: ImprovementSuggestion[] = [];

        if (s.briefPromptCount > 0) {
            suggestions.push({
                category: 'specificity',
                suggestion:
                    `${s.briefPromptCount} of your ${s.promptCount} prompt(s) were under ${BRIEF_PROMPT_WORDS} words. ` +
                    'Try leading each with the concrete goal and the key constraints — a sharper opening prompt usually replaces two or three vague follow-ups.',
            });
        }
        if (!s.hasContext) {
            suggestions.push({
                category: 'context',
                suggestion:
                    `None of the ${s.promptCount} prompt(s) in this conversation included a concrete error, code block, or file path. ` +
                    'Pasting the actual stack trace or the relevant lines gives the model something specific to reason about instead of guessing at your setup.',
            });
        }
        if (s.loopCount > 0) {
            suggestions.push({
                category: 'iteration',
                suggestion:
                    `This conversation hit ${s.loopCount} repeated-prompt loop(s) (~${s.loopRepetitions} near-identical retries). ` +
                    "When the second attempt doesn't land, reframe the ask or add a missing constraint rather than re-sending the same prompt — that's where the time and tokens go.",
            });
        }
        if (s.loopRepetitions >= 3 || s.briefPromptCount >= 2) {
            // Name only the costs this conversation actually incurred, so the
            // suggestion never reads "the 0 repeated tries" — it stays specific.
            const costs: string[] = [];
            if (s.briefPromptCount > 0) {
                costs.push(`${s.briefPromptCount} brief prompt${s.briefPromptCount === 1 ? '' : 's'}`);
            }
            if (s.loopRepetitions > 0) {
                costs.push(`${s.loopRepetitions} repeated tr${s.loopRepetitions === 1 ? 'y' : 'ies'}`);
            }
            suggestions.push({
                category: 'efficiency',
                suggestion: `Tightening the ${costs.join(' and the ')} up front could have cut several round-trips out of this conversation.`,
            });
        }

        if (suggestions.length === 0) {
            // An already-strong conversation: stay specific by grounding the push in
            // the real prompt count rather than offering an empty "looks good".
            suggestions.push({
                category: 'next_level',
                suggestion:
                    `This was a tight conversation — your ${s.promptCount} prompt(s) were specific, context-rich, and loop-free. ` +
                    'To push further, try stating the acceptance check up front ("done when the test passes") so the model verifies its own answer before you do.',
            });
        }
        return suggestions;
    }

    /** Compose the signals + suggestions into a direct-but-kind within-developer review. */
    private composeNarrative(s: SessionSignals, suggestions: ImprovementSuggestion[]): string {
        const opening =
            `Here's an honest look at how this conversation (${s.promptCount} prompt${s.promptCount === 1 ? '' : 's'}) ` +
            'could have gone better. This is just about your own work — there is no comparison to anyone else, and it never leaves your account.';
        const body = suggestions.map((sg) => `• ${sg.suggestion}`).join('\n');
        const close = 'Small, specific changes here compound fast — pick the one that stings a little and try it next session.';
        return [opening, body, close].join('\n\n');
    }
}
