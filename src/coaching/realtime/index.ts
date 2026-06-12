/**
 * Public surface of the real-time coaching module (Task 5.6 / #127).
 *
 * Loop detection + prompt-quality nudges that run LOCALLY at the capture layer.
 * The `RealtimeCoach` is the mechanism-agnostic per-session component both capture
 * mechanisms (local agent + editor extension) attach via the shared CaptureClient;
 * the store + settings helpers are the server-side metadata-only persistence and
 * the Task 5.10 settings bridge.
 */

export * from './types';
export {LoopDetector, DEFAULT_LOOP_CONFIG, tokenSet, jaccard, type LoopDetectorConfig} from './loop-detector';
export {
    runStructuralChecks,
    checkShortPrompt,
    checkMissingContext,
    checkMissingError,
    DEFAULT_NUDGE_CONFIG,
    REPEATED_PROMPT_MESSAGE,
    type NudgeCheckConfig,
} from './nudges';
export {
    RealtimeCoach,
    type CoachResult,
    type NudgeSettings,
    type NudgeFrequency,
    type RealtimeCoachConfig,
} from './coach';
export {resolveNudgeSettings, nudgeGate, type NudgeGateResult} from './settings';
export {
    insertLoopEvent,
    insertNudgeEvent,
    listLoopEventsForDeveloper,
    listNudgeEventsForDeveloper,
    dismissNudgeEvent,
} from './store';
