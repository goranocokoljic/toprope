/**
 * The local real-time coach (Task 5.6 / #127).
 *
 * Ties the loop detector and the structural nudge checks together into one
 * per-session object that runs ON THE DEVELOPER'S MACHINE. Feed it each outgoing
 * prompt; it returns the nudges to show and the METADATA events the developer may
 * optionally sync. The prompt text is consumed locally and never placed on any
 * returned event — the sync payloads carry only counts, types, and timestamps.
 *
 * It honors the developer's nudge settings (Task 5.10):
 *   - `enabled` (nudges_enabled): when off, the coach is inert — no detection
 *     work is surfaced, nothing to sync.
 *   - `frequency` (nudge_frequency: low | normal | high): a throttle on how often
 *     nudges are DELIVERED, expressed as a cooldown in observed prompts. `high`
 *     nudges every qualifying prompt; `low` waits several prompts between nudges.
 *   - `dismissible` (nudge_dismissible_default): stamped onto every delivered
 *     nudge. Nudges never block regardless; this controls whether the UI offers a
 *     dismiss affordance.
 */

import {DEFAULT_LOOP_CONFIG, LoopDetector, type LoopDetectorConfig} from './loop-detector';
import {DEFAULT_NUDGE_CONFIG, REPEATED_PROMPT_MESSAGE, runStructuralChecks, type NudgeCheckConfig} from './nudges';
import type {LoopDetection, LoopEventMeta, NudgeEventMeta, NudgeSuggestion} from './types';

export type NudgeFrequency = 'low' | 'normal' | 'high';

/** The resolved nudge settings the coach acts on (bridged from Task 5.10 prefs). */
export interface NudgeSettings {
    enabled: boolean;
    frequency: NudgeFrequency;
    dismissible: boolean;
}

/**
 * Frequency → cooldown (minimum prompts between delivered nudges). `high` = 0
 * (every qualifying prompt), `normal` and `low` space them out so the coaching
 * stays gentle. Loop DETECTION is independent of this throttle (see below).
 */
const FREQUENCY_COOLDOWN: Record<NudgeFrequency, number> = {
    high: 0,
    normal: 2,
    low: 5,
};

export interface RealtimeCoachConfig {
    settings: NudgeSettings;
    sessionId: string;
    /** Optional override of the loop detector tunables. */
    loop?: Partial<LoopDetectorConfig>;
    /** Optional override of the structural-check tunables. */
    nudge?: Partial<NudgeCheckConfig>;
}

/** What `observePrompt` returns for one prompt. */
export interface CoachResult {
    /** The raw loop detection (local view), or null. Present even if throttled. */
    loop: LoopDetection | null;
    /** Nudges to show the developer right now (after enabled + throttle). */
    nudges: NudgeSuggestion[];
    /** Loop-event metadata to optionally sync — present when a loop was detected. */
    loopEvent: LoopEventMeta | null;
    /** Nudge-event metadata to optionally sync — one per delivered nudge. */
    nudgeEvents: NudgeEventMeta[];
}

const EMPTY_RESULT: CoachResult = {loop: null, nudges: [], loopEvent: null, nudgeEvents: []};

export class RealtimeCoach {
    private readonly detector: LoopDetector;
    private readonly nudgeConfig: NudgeCheckConfig;
    private readonly settings: NudgeSettings;
    private readonly sessionId: string;
    /** How many prompts observed since the last delivered nudge (for the throttle). */
    private promptsSinceNudge = Number.POSITIVE_INFINITY;

    constructor(config: RealtimeCoachConfig) {
        this.settings = config.settings;
        this.sessionId = config.sessionId;
        this.detector = new LoopDetector({...DEFAULT_LOOP_CONFIG, ...config.loop});
        this.nudgeConfig = {...DEFAULT_NUDGE_CONFIG, ...config.nudge};
    }

    /**
     * Observe one outgoing prompt and return the nudges to deliver plus the
     * metadata to optionally sync. When nudges are disabled the coach is fully
     * inert (returns nothing and does no detection), so an opted-out developer
     * never sees a nudge and nothing is ever produced to sync.
     *
     * Loop DETECTION fires whenever the similarity condition holds (the underlying
     * signal), so a `loopEvent` is produced on every detection; the corresponding
     * `repeated_prompt` NUDGE, like the structural ones, is subject to the
     * frequency throttle so a tight loop doesn't spam the developer.
     */
    observePrompt(prompt: string): CoachResult {
        if (!this.settings.enabled) {
            return EMPTY_RESULT;
        }

        this.promptsSinceNudge++;

        const loop = this.detector.observe(prompt);
        const candidates: NudgeSuggestion[] = runStructuralChecks(prompt, this.nudgeConfig);
        if (loop) {
            candidates.push({type: 'repeated_prompt', message: REPEATED_PROMPT_MESSAGE, dismissible: true});
        }

        const loopEvent: LoopEventMeta | null = loop
            ? {sessionId: this.sessionId, detectedAt: new Date().toISOString(), similarPromptCount: loop.similarPromptCount}
            : null;

        // Throttle delivery: only emit nudges when the cooldown for the developer's
        // frequency has elapsed. Detection metadata (loopEvent) is unaffected.
        const cooldown = FREQUENCY_COOLDOWN[this.settings.frequency];
        if (candidates.length === 0 || this.promptsSinceNudge <= cooldown) {
            return {loop, nudges: [], loopEvent, nudgeEvents: []};
        }

        const deliveredAt = new Date().toISOString();
        const nudges = candidates.map((n) => ({...n, dismissible: this.settings.dismissible}));
        const nudgeEvents: NudgeEventMeta[] = nudges.map((n) => ({
            sessionId: this.sessionId,
            nudgeType: n.type,
            deliveredAt,
        }));
        this.promptsSinceNudge = 0;

        return {loop, nudges, loopEvent, nudgeEvents};
    }
}
