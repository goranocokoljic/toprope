/**
 * Bridge from the Task 5.10 coaching settings to the real-time coach (Task 5.6 / #127).
 *
 * The local coach needs three resolved values, and this is the single place that
 * derives them from the settings system so the local feature and the server's
 * record/read gates agree on "are nudges on for this developer right now":
 *   - enabled     ← developer pref `nudges_enabled`
 *   - frequency   ← developer pref `nudge_frequency` (seeded from the org default
 *                   `nudge_default_frequency` when the developer hasn't chosen)
 *   - dismissible ← org setting `nudge_dismissible_default`, resolved for the team
 *
 * Resolving per request is what makes a developer opting out (or an org/team
 * change) take effect immediately — there is no cached enablement to go stale.
 */

import type Database from 'better-sqlite3';
import {resolveDeveloperPreferences, resolveSetting} from '../../settings/store';
import type {NudgeFrequency, NudgeSettings} from './coach';

function asFrequency(value: unknown): NudgeFrequency {
    return value === 'low' || value === 'high' ? value : 'normal';
}

/**
 * Resolve the effective nudge settings for a developer-role user. `userId` keys
 * the stored developer preferences; `team` resolves the org permission boundary
 * and the org dismissible default around them.
 */
export function resolveNudgeSettings(db: Database.Database, userId: string, team?: string | null): NudgeSettings {
    const prefs = resolveDeveloperPreferences(db, userId, team);
    return {
        enabled: prefs.nudges_enabled?.value === true,
        frequency: asFrequency(prefs.nudge_frequency?.value),
        dismissible: resolveSetting(db, 'nudge_dismissible_default', team) === true,
    };
}

export interface NudgeGateResult {
    /** True only when nudges are enabled for the developer. */
    enabled: boolean;
    /** Present when blocked: a human-readable reason. */
    reason?: string;
}

/**
 * Whether real-time loop/nudge events may be recorded for a developer right now.
 * The server refuses to persist event metadata when the developer has nudges off,
 * so the "respects nudge enabled setting" guarantee holds at the persistence layer
 * too (not only in the local coach). Shared by the record routes so the check
 * lives in exactly one place.
 */
export function nudgeGate(db: Database.Database, userId: string, team?: string | null): NudgeGateResult {
    if (resolveNudgeSettings(db, userId, team).enabled) {
        return {enabled: true};
    }
    return {enabled: false, reason: 'Real-time nudges are not enabled for your account.'};
}
