import Database from 'better-sqlite3';
import type {Team} from './types';

interface TeamRow {
    name: string;
    department: string | null;
    manager: string | null;
    created_at: string;
    archived_at: string | null;
}

function rowToTeam(row: TeamRow): Team {
    return {
        name: row.name,
        department: row.department,
        manager: row.manager,
        created_at: row.created_at,
        archived_at: row.archived_at,
    };
}

export function addTeam(
    db: Database.Database,
    name: string,
    department?: string,
    manager?: string,
): Team {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, ?, ?, ?)').run(
        name,
        department ?? null,
        manager ?? null,
        now,
    );
    return {name, department: department ?? null, manager: manager ?? null, created_at: now, archived_at: null};
}

export function listTeams(db: Database.Database, includeArchived = false): Team[] {
    const rows = (
        includeArchived
            ? db.prepare('SELECT * FROM teams ORDER BY name').all()
            : db.prepare('SELECT * FROM teams WHERE archived_at IS NULL ORDER BY name').all()
    ) as TeamRow[];
    return rows.map(rowToTeam);
}

export function getTeam(db: Database.Database, name: string): Team | null {
    const row = db.prepare('SELECT * FROM teams WHERE name = ?').get(name) as TeamRow | undefined;
    return row ? rowToTeam(row) : null;
}

/**
 * The team a hands-off onboarding path should write into: return it, creating it if it does
 * not exist — or refuse when it exists but is ARCHIVED.
 *
 * One helper for every "default team" path (GitHub-org discovery, DO1.6's auto-create)
 * rather than an inline `if (!teamExists) INSERT` per caller: two copies drift the moment
 * one of them starts caring about archived teams, which is precisely the case that matters.
 * An archived team is a fail-closed refusal, not a silent write: a developer created into
 * one is invisible in every team aggregate, so the write "succeeds" and the person never
 * appears — the silent-data-loss shape this epic exists to end.
 *
 * Returns null ONLY for the archived case, so `null` has exactly one meaning. Callers map it
 * to their own surface (a config error, a CLI stderr line, an HTTP 400).
 *
 * Read-then-write: run inside the caller's transaction when the create must be atomic with
 * what follows it (the sync write path does).
 */
export function ensureTeam(db: Database.Database, name: string): Team | null {
    const existing = getTeam(db, name);
    if (existing) return existing.archived_at ? null : existing;
    return addTeam(db, name);
}

export function teamExists(db: Database.Database, name: string): boolean {
    return !!db.prepare('SELECT 1 FROM teams WHERE name = ?').get(name);
}

export interface TeamUpdates {
    department?: string | null;
    manager?: string | null;
}

/**
 * Patch a team's department and/or manager. Only the provided keys are written,
 * so an update of one field never clobbers the other. Returns the updated team,
 * or null if the team does not exist.
 */
export function updateTeam(db: Database.Database, name: string, updates: TeamUpdates): Team | null {
    const row = db.prepare('SELECT * FROM teams WHERE name = ?').get(name) as TeamRow | undefined;
    if (!row) return null;

    const department = updates.department !== undefined ? updates.department : row.department;
    const manager = updates.manager !== undefined ? updates.manager : row.manager;
    db.prepare('UPDATE teams SET department = ?, manager = ? WHERE name = ?').run(
        department,
        manager,
        name,
    );
    return rowToTeam({...row, department, manager});
}

/**
 * Archive a team (soft delete). Idempotent: re-archiving an already-archived
 * team leaves its original archived_at untouched. Returns true when a live team
 * was archived by this call.
 */
export function archiveTeam(db: Database.Database, name: string): boolean {
    const res = db
        .prepare('UPDATE teams SET archived_at = ? WHERE name = ? AND archived_at IS NULL')
        .run(new Date().toISOString(), name);
    return res.changes > 0;
}

/** Restore an archived team. Returns true when an archived team was reactivated. */
export function unarchiveTeam(db: Database.Database, name: string): boolean {
    const res = db
        .prepare('UPDATE teams SET archived_at = NULL WHERE name = ? AND archived_at IS NOT NULL')
        .run(name);
    return res.changes > 0;
}
