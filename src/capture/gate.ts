/**
 * The strict opt-in gate for prompt capture (Task 5.4 / #125).
 *
 * Capture is INERT unless the developer opted in (Task 5.10 `capture_opt_in`)
 * AND the org permits capture (`coaching_capture_permitted`). Both conditions
 * collapse into a single resolved value: `resolveDeveloperPreferences` already
 * forces `capture_opt_in` to its blockedValue (false) whenever the org flag is
 * off, so the effective value is true ONLY when the developer opted in and the
 * org currently permits it. Reading it live on every request is what makes
 * opting out (or an org/team turning capture off) stop capture immediately —
 * there is no cached enablement to go stale.
 *
 * This is the single home for "is capture allowed for this developer right now",
 * shared by the ingestion route and any future capture consumer so the
 * double-condition lives in exactly one place.
 */

import type Database from 'better-sqlite3';
import {resolveDeveloperPreferences} from '../settings/store';

export interface CaptureGateResult {
    /** True only when the developer opted in AND the org currently permits capture. */
    enabled: boolean;
    /** Present when blocked: a human-readable reason (org policy, or simply not opted in). */
    reason?: string;
}

/**
 * Resolve whether capture is currently enabled for a developer-role user. `team`
 * is the developer's team, so a per-team override of `coaching_capture_permitted`
 * is honored. The userId keys the stored developer preferences (they live in
 * user_preferences); the team resolves the org permission boundary around them.
 */
export function captureGate(
    db: Database.Database,
    userId: string,
    team?: string | null,
): CaptureGateResult {
    const prefs = resolveDeveloperPreferences(db, userId, team);
    const optIn = prefs.capture_opt_in;
    if (optIn?.value === true) {
        return {enabled: true};
    }
    // Distinguish "org forbids" (blocked, with the policy reason) from "developer
    // simply hasn't opted in" so the caller can surface an accurate message.
    if (optIn?.blocked && optIn.reason) {
        return {enabled: false, reason: optIn.reason};
    }
    return {enabled: false, reason: 'Prompt capture is not enabled for your account.'};
}

export function isCaptureEnabled(db: Database.Database, userId: string, team?: string | null): boolean {
    return captureGate(db, userId, team).enabled;
}
