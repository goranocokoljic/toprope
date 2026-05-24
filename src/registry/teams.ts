import Database from 'better-sqlite3';
import type {Team} from './types';

interface TeamRow {
    name: string;
    department: string | null;
    manager: string | null;
    created_at: string;
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
    return {name, department: department ?? null, manager: manager ?? null, created_at: now};
}

export function listTeams(db: Database.Database): Team[] {
    return db.prepare('SELECT * FROM teams ORDER BY name').all() as TeamRow[];
}

export function teamExists(db: Database.Database, name: string): boolean {
    return !!db.prepare('SELECT 1 FROM teams WHERE name = ?').get(name);
}
