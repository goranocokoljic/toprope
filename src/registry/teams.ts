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
