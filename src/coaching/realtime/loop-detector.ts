/**
 * Local, real-time loop detection (Task 5.6 / #127).
 *
 * Runs ENTIRELY on the developer's machine at the capture layer. It maintains a
 * rolling window of the session's recent prompts (as token SETS — never sent
 * anywhere) and, for each new prompt, measures token-set Jaccard similarity
 * against the ones in the window. When at least N recent prompts are similar at
 * or above the threshold, that is a loop: the developer is re-asking the same
 * thing without making progress.
 *
 * No model, no network: this is pure string/set math, so it is instant and fully
 * private. The only thing that ever leaves this module is METADATA (a count) via
 * `LoopDetection` — never the prompt text or the tokens.
 */

import type {LoopDetection} from './types';

/** Tunables for the detector; defaults are sensible for chat-style prompts. */
export interface LoopDetectorConfig {
    /** Jaccard similarity at/above which two prompts count as "similar" (0..1). */
    similarityThreshold: number;
    /** Minimum number of similar recent prompts that constitutes a loop (>= 2). */
    minSimilar: number;
    /** How many recent prompts to keep in the rolling window. */
    windowSize: number;
}

export const DEFAULT_LOOP_CONFIG: LoopDetectorConfig = {
    similarityThreshold: 0.6,
    minSimilar: 3,
    windowSize: 10,
};

/**
 * Tokenize a prompt into a lowercase set of word tokens. Punctuation and case are
 * discarded so "Fix the bug!" and "fix the bug" compare as identical. Returns a
 * Set so duplicate words don't skew the overlap — this is a token-SET measure.
 */
export function tokenSet(prompt: string): Set<string> {
    const tokens = prompt
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 0);
    return new Set(tokens);
}

/**
 * Jaccard similarity of two token sets: |intersection| / |union|, in [0, 1]. Two
 * empty prompts are defined as similarity 0 (no signal), not 1 — an empty prompt
 * is not "the same request" as another empty one for loop purposes.
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) {
        return 0;
    }
    let intersection = 0;
    for (const t of a) {
        if (b.has(t)) {
            intersection++;
        }
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

/**
 * A stateful, per-session loop detector. Hold one per capture session in local
 * memory; feed each outgoing prompt to `observe`. The window stores token sets
 * only (already a lossy projection of the prompt), and nothing here is ever
 * transmitted — the caller chooses whether to sync the returned metadata.
 */
export class LoopDetector {
    private readonly window: Set<string>[] = [];
    private readonly config: LoopDetectorConfig;

    constructor(config: Partial<LoopDetectorConfig> = {}) {
        this.config = {...DEFAULT_LOOP_CONFIG, ...config};
    }

    /**
     * Observe one new prompt. Returns loop metadata when the new prompt is similar
     * (>= threshold) to at least `minSimilar` prompts already in the window, else
     * null. The new prompt is then added to the rolling window (evicting the
     * oldest beyond `windowSize`) so the next call sees it.
     *
     * `similarPromptCount` counts the matching PRIOR prompts plus the new one, so
     * it reflects how many prompts in total form the loop (the count a developer
     * would recognize as "I've asked this 3 times").
     */
    observe(prompt: string): LoopDetection | null {
        const tokens = tokenSet(prompt);
        let similar = 0;
        for (const prior of this.window) {
            if (jaccard(tokens, prior) >= this.config.similarityThreshold) {
                similar++;
            }
        }

        this.window.push(tokens);
        if (this.window.length > this.config.windowSize) {
            this.window.shift();
        }

        // `minSimilar` is the total size of the loop (e.g. 3 means "the 3rd time");
        // we have `similar` prior matches plus this prompt, so the loop fires when
        // prior matches reach minSimilar - 1.
        if (similar >= this.config.minSimilar - 1) {
            return {similarPromptCount: similar + 1};
        }
        return null;
    }
}
