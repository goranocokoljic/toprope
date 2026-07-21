import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {addTeam, listTeams, teamExists, ensureTeam, archiveTeam, getTeam} from '../../src/registry/teams';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

describe('addTeam', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });

    afterEach(() => {
        db.close();
    });

    it('creates a team with all fields', () => {
        const team = addTeam(db, 'frontend', 'engineering', 'alice');
        expect(team.name).toBe('frontend');
        expect(team.department).toBe('engineering');
        expect(team.manager).toBe('alice');
        expect(team.created_at).toBeTruthy();
    });

    it('creates a team with only name', () => {
        const team = addTeam(db, 'backend');
        expect(team.name).toBe('backend');
        expect(team.department).toBeNull();
        expect(team.manager).toBeNull();
    });

    it('persists the team to the database', () => {
        addTeam(db, 'devops', 'infrastructure');
        const row = db.prepare('SELECT * FROM teams WHERE name = ?').get('devops') as {
            name: string;
            department: string;
        };
        expect(row).toBeDefined();
        expect(row.name).toBe('devops');
        expect(row.department).toBe('infrastructure');
    });

    it('throws on duplicate team name', () => {
        addTeam(db, 'frontend');
        expect(() => addTeam(db, 'frontend')).toThrow();
    });
});

describe('listTeams', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });

    afterEach(() => {
        db.close();
    });

    it('returns empty array when no teams exist', () => {
        expect(listTeams(db)).toEqual([]);
    });

    it('returns all teams ordered by name', () => {
        addTeam(db, 'zebra');
        addTeam(db, 'alpha');
        addTeam(db, 'middle');
        const teams = listTeams(db);
        expect(teams.map((t) => t.name)).toEqual(['alpha', 'middle', 'zebra']);
    });

    it('includes department and manager in returned records', () => {
        addTeam(db, 'frontend', 'engineering', 'bob');
        const [team] = listTeams(db);
        expect(team.department).toBe('engineering');
        expect(team.manager).toBe('bob');
    });
});

describe('teamExists', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });

    afterEach(() => {
        db.close();
    });

    it('returns true for an existing team', () => {
        addTeam(db, 'backend');
        expect(teamExists(db, 'backend')).toBe(true);
    });

    it('returns false for a non-existent team', () => {
        expect(teamExists(db, 'nonexistent')).toBe(false);
    });
});

describe('ensureTeam (#256)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });

    afterEach(() => {
        db.close();
    });

    it('creates the team when it does not exist', () => {
        expect(getTeam(db, 'discovered')).toBeNull();

        const team = ensureTeam(db, 'discovered');

        expect(team?.name).toBe('discovered');
        expect(getTeam(db, 'discovered')).not.toBeNull();
    });

    it('returns the existing team without creating a second one', () => {
        addTeam(db, 'eng', 'Engineering', 'ada');

        const team = ensureTeam(db, 'eng');

        // The EXISTING row, with its fields intact — not a blank overwrite.
        expect(team?.department).toBe('Engineering');
        expect(team?.manager).toBe('ada');
        expect(listTeams(db)).toHaveLength(1);
    });

    it('returns null for an ARCHIVED team rather than writing into it', () => {
        addTeam(db, 'retired');
        archiveTeam(db, 'retired');

        expect(ensureTeam(db, 'retired')).toBeNull();
        // And it must NOT have been resurrected or duplicated as a side effect.
        expect(listTeams(db, true)).toHaveLength(1);
        expect(getTeam(db, 'retired')?.archived_at).not.toBeNull();
    });
});
