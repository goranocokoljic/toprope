/**
 * Leaderboard access gating (Task 2.17 / #52).
 *
 * A ranked leaderboard conflicts with the product's coaching-not-surveillance
 * principle, so it ships OFF by default and is gated entirely by settings. This
 * module is the single source of truth for "may this principal see the
 * leaderboard for this team?", kept as a PURE function so every combination of
 * global / per-team / role inputs is unit-testable without a database or HTTP.
 *
 * The rule (from the issue + design decision #2):
 *   1. The global master switch `leaderboard_enabled` must be true — when it is
 *      false, NOBODY sees the leaderboard and the UI shows no trace of it.
 *   2. Then:
 *      - admin   → may view any team's leaderboard.
 *      - manager → may view only when `leaderboard_managers_can_enable` is true
 *                  AND the team has it enabled (the resolved per-team value).
 *      - developer (or anything else) → never.
 *
 * `teamEnabled` is expected to be the already-resolved per-team value of
 * `leaderboard_enabled` (see settings/store.ts `resolveSetting`), which itself
 * only honors a team override when the governing managers_can_* flag is on. We
 * still take `managersCanEnable` explicitly so the manager rule is legible here
 * and the full input matrix is exercised by the tests.
 */

export type LeaderboardRole = 'admin' | 'manager' | 'developer';

export interface LeaderboardGateInput {
    /** The requesting principal's role. */
    role: LeaderboardRole;
    /** Global `leaderboard_enabled` — the master availability switch. */
    globalEnabled: boolean;
    /** Global `leaderboard_managers_can_enable` — may managers opt their team in. */
    managersCanEnable: boolean;
    /** Resolved per-team `leaderboard_enabled` (override-aware). */
    teamEnabled: boolean;
}

/**
 * Whether the principal may access the team leaderboard. The global master
 * switch gates everyone first; role then refines. Defaults to denied for any
 * unrecognized role (fail closed).
 */
export function canAccessLeaderboard(input: LeaderboardGateInput): boolean {
    if (!input.globalEnabled) {
        return false;
    }
    switch (input.role) {
        case 'admin':
            return true;
        case 'manager':
            return input.managersCanEnable && input.teamEnabled;
        default:
            return false;
    }
}
