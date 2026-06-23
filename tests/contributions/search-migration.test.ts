import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import {runMigrations} from '../../src/storage/migrator';
import {createContribution, deleteContribution} from '../../src/contributions/store';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');
const SQL_035 = fs.readFileSync(path.join(MIGRATIONS_DIR, '035_contribution_search.sql'), 'utf-8');

const EXPECTED_TRIGGERS = [
    'contribution_search_ai',
    'contribution_search_au',
    'contribution_search_ad',
    'contribution_search_vi',
    'contribution_search_ti',
    'contribution_search_td',
];

function objectExists(db: Database.Database, type: 'table' | 'trigger', name: string): boolean {
    const row = db
        .prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
        .get(type, name) as {name: string} | undefined;
    return row !== undefined;
}

describe('migration 035 — contribution search index (#155)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db, MIGRATIONS_DIR);
        db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run(
            'eng',
            '2026-06-20T00:00:00.000Z',
        );
        db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
            'a',
            'Author',
            'a@test.com',
            'eng',
            '2026-06-20T00:00:00.000Z',
        );
    });

    afterEach(() => {
        db.close();
    });

    it('creates the FTS virtual table', () => {
        expect(objectExists(db, 'table', 'contribution_search')).toBe(true);
    });

    it('creates all six sync triggers', () => {
        for (const trigger of EXPECTED_TRIGGERS) {
            expect(objectExists(db, 'trigger', trigger), `${trigger} should exist`).toBe(true);
        }
    });

    it('is idempotent — re-running the migrations applies zero new ones', () => {
        expect(runMigrations(db, MIGRATIONS_DIR)).toBe(0);
        expect(objectExists(db, 'table', 'contribution_search')).toBe(true);
    });

    it('re-executing the raw 035 SQL directly does not error (IF NOT EXISTS)', () => {
        expect(() => db.exec(SQL_035)).not.toThrow();
    });

    it('backfills contributions that existed before the index was created', () => {
        // Simulate a DB whose contributions predate the search index: drop the
        // index + its triggers, write a contribution (now un-indexed), then re-apply
        // the raw 035 SQL and confirm the backfill SELECT picked the row up.
        for (const trigger of EXPECTED_TRIGGERS) {
            db.exec(`DROP TRIGGER ${trigger}`);
        }
        db.exec('DROP TABLE contribution_search');

        const id = createContribution(db, {
            contentType: 'best_practice',
            title: 'Pre-existing churn note',
            authorId: 'a',
            scope: 'org',
            scopeTarget: null,
            body: JSON.stringify({markdown: 'discusses churn at length'}),
            timestamp: '2026-06-20T00:00:00.000Z',
        }).id;

        // Index does not exist yet → nothing to find (sanity: table is gone).
        expect(objectExists(db, 'table', 'contribution_search')).toBe(false);

        db.exec(SQL_035);

        const hit = db
            .prepare('SELECT contribution_id FROM contribution_search WHERE contribution_search MATCH ?')
            .get('churn') as {contribution_id: string} | undefined;
        expect(hit?.contribution_id).toBe(id);
    });

    it('the delete trigger physically removes the FTS row (not just masked by the live JOIN)', () => {
        // searchContributions JOINs FTS to the live contributions table, so a deleted
        // row vanishes from results even if its FTS row were orphaned. Assert against
        // the index DIRECTLY so this proves the contribution_search_ad trigger fired.
        const id = createContribution(db, {
            contentType: 'best_practice',
            title: 'Doomed',
            authorId: 'a',
            scope: 'org',
            scopeTarget: null,
            body: JSON.stringify({markdown: 'transient churn note'}),
            timestamp: '2026-06-20T00:00:00.000Z',
        }).id;

        const before = db
            .prepare('SELECT count(*) AS n FROM contribution_search WHERE contribution_id = ?')
            .get(id) as {n: number};
        expect(before.n).toBe(1);

        deleteContribution(db, id);

        const after = db
            .prepare('SELECT count(*) AS n FROM contribution_search WHERE contribution_id = ?')
            .get(id) as {n: number};
        expect(after.n).toBe(0);
    });
});
