/**
 * Opted-in cohort resolution for capture-derived manager aggregates
 * (Task 5.11 / #132).
 *
 * Loop/nudge patterns are Pillar 3 (prompt-capture) data, so the manager
 * aggregate over them must include ONLY developers who have effectively opted
 * into capture — "effectively" meaning their stored opt-in AND the org permission
 * boundary both allow it. This is the single home for that filter, so the
 * "opted-in developers only" rule lives in exactly one place and the read layer
 * cannot accidentally pool a developer who never chose in (or whose org forbids
 * capture).
 *
 * The chain is deliberate: a developer_id → its linked user account → that user's
 * resolved coaching preferences for the developer's CURRENT team. A developer with
 * no linked user account, or a stored opt-in the org currently forbids, resolves
 * to NOT opted in — the safe direction.
 */

import type Database from 'better-sqlite3';
import {getUserByDeveloperId} from '../../auth/users';
import {getDeveloperById} from '../../registry/developers';
import {captureGate} from '../../capture/gate';

/**
 * Whether ONE developer has effectively opted into capture. Delegates to the
 * single capture gate (capture/gate.ts) — the one home for "opted in AND org
 * permits" — so the manager aggregate's opted-in cohort can never diverge from
 * the gate the developer's own capture surfaces use. True only when a linked user
 * account exists and the gate resolves enabled for the developer's current team.
 */
export function isDeveloperOptedIn(db: Database.Database, developerId: string): boolean {
    const user = getUserByDeveloperId(db, developerId);
    if (!user) {
        // No account → no opt-in could ever have been recorded; exclude.
        return false;
    }
    const team = getDeveloperById(db, developerId)?.team ?? null;
    return captureGate(db, user.id, team).enabled;
}

/**
 * Filter a set of developer ids down to those effectively opted into capture.
 * Order is preserved. The caller owns scope (org = all developers, team = the
 * team's members); this only enforces the opt-in boundary on top of that scope.
 */
export function resolveOptedInDeveloperIds(db: Database.Database, devIds: string[]): string[] {
    return devIds.filter((id) => isDeveloperOptedIn(db, id));
}
