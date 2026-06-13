/**
 * Org developer pool, per-team-override aware (issue #145).
 *
 * The org coaching roll-ups (Pillar 1 available-data, Pillar 2 PR/review) gate the
 * roll-up on the GLOBAL pillar flag, but historically pooled EVERY developer into
 * the aggregate — so a team that overrode its pillar OFF (a team-overridable flag)
 * still fed the ORG aggregate even though that team's own panel correctly hid the
 * pillar. This helper resolves the flag per the developer's OWN team and keeps only
 * developers whose team has the pillar enabled, mirroring how the loop/nudge
 * (Pillar 3) org aggregate resolves its opted-in cohort per the developer's own team
 * rather than on the global flag alone.
 *
 * It does NOT change the GLOBAL gate the routes/panel apply before calling the org
 * aggregate (issue #145 keeps Pillars 1/2 gated on the global flag); it only removes
 * developers whose team opted the pillar out from the pool the aggregate floors.
 */

import type Database from 'better-sqlite3';

/**
 * The ids of every developer whose OWN team resolves the pillar enabled, given a
 * team-scoped predicate (e.g. `(team) => isCoachingPillar1Enabled(db, team)`).
 *
 * `developers.team` is NOT NULL, so every developer resolves against a concrete
 * team. The predicate is resolved once per distinct team (few teams, many
 * developers) and reused, so the per-developer filter adds no extra query work.
 */
export function orgDeveloperIdsWhereTeamEnabled(
    db: Database.Database,
    isEnabledForTeam: (team: string) => boolean,
): string[] {
    const rows = db.prepare('SELECT id, team FROM developers').all() as Array<{
        id: string;
        team: string;
    }>;
    const byTeam = new Map<string, boolean>();
    const enabled = (team: string): boolean => {
        let value = byTeam.get(team);
        if (value === undefined) {
            value = isEnabledForTeam(team);
            byTeam.set(team, value);
        }
        return value;
    };
    return rows.filter((row) => enabled(row.team)).map((row) => row.id);
}
