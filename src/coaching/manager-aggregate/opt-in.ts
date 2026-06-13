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
 * Resolution delegates to the one capture gate (capture/gate.ts) — the single
 * home for "opted in AND org permits" — so the manager aggregate's opted-in
 * cohort can never diverge from the gate the developer's own capture surfaces
 * use. The developer→user→team lookups are resolved in ONE batched query rather
 * than per developer, so an org-wide panel doesn't fan out into N×(user + team)
 * round-trips; only the gate's single-preference resolution then runs per
 * opted-in candidate. A developer with no linked user account simply has no row
 * in the join and is excluded — the safe direction.
 */

import type Database from 'better-sqlite3';
import {captureGate} from '../../capture/gate';

interface OptInRow {
    developer_id: string;
    user_id: string;
    team: string;
}

/**
 * Filter a set of developer ids down to those effectively opted into capture.
 * Order is preserved. The caller owns scope (org = all developers, team = the
 * team's members); this only enforces the opt-in boundary on top of that scope.
 *
 * One query resolves every (developer → linked ACTIVE user, current team) in the
 * set; the per-developer work is then just the capture gate's single-preference
 * resolution, gated for the developer's OWN team so a per-team capture override
 * is honored exactly as on the developer's own surfaces. Deactivated accounts are
 * excluded — revoking a developer's access should also stop their patterns
 * contributing to a manager aggregate, not just lock them out of their own view.
 */
export function resolveOptedInDeveloperIds(db: Database.Database, devIds: string[]): string[] {
    if (devIds.length === 0) {
        return [];
    }
    const placeholders = new Array(devIds.length).fill('?').join(', ');
    const rows = db
        .prepare(
            `SELECT u.developer_id AS developer_id, u.id AS user_id, d.team AS team
             FROM users u
             JOIN developers d ON d.id = u.developer_id
             WHERE u.developer_id IN (${placeholders}) AND u.deactivated_at IS NULL`,
        )
        .all(...devIds) as OptInRow[];

    const optedIn = new Set<string>();
    for (const row of rows) {
        if (captureGate(db, row.user_id, row.team).enabled) {
            optedIn.add(row.developer_id);
        }
    }
    // Preserve the caller's order; only developers that cleared the gate survive.
    return devIds.filter((id) => optedIn.has(id));
}
