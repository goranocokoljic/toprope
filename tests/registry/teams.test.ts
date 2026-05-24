import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {addTeam, listTeams, teamExists} from '../../src/registry/teams';

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
