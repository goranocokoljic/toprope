import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import {runMigrations} from '../../src/storage/migrator';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

const SPINE_TABLES = ['contributions', 'contribution_versions', 'contribution_tags', 'contribution_review_events'];

function tableExists(db: Database.Database, name: string): boolean {
    const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name) as {name: string} | undefined;
    return row !== undefined;
}

function columnNames(db: Database.Database, table: string): string[] {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as {name: string}[];
    return rows.map((r) => r.name);
}

describe('migration 033 — contribution spine (#151)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db, MIGRATIONS_DIR);
        // The spine's author_id FK references developers; seed the one author id
        // ('a') these raw-SQL constraint checks use so a failure isolates the
        // constraint under test (scope/state CHECK, UNIQUE) rather than the FK.
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

    it('creates all four spine tables', () => {
        for (const table of SPINE_TABLES) {
            expect(tableExists(db, table), `${table} should exist`).toBe(true);
        }
    });

    it('gives contributions exactly the feature-agnostic spine columns and no feature-specific ones', () => {
        const cols = columnNames(db, 'contributions').sort();
        expect(cols).toEqual(
            [
                'id',
                'content_type',
                'title',
                'author_id',
                'scope',
                'scope_target',
                'state',
                'current_version',
                'created_at',
                'updated_at',
            ].sort(),
        );
    });

    it('enforces the scope CHECK constraint', () => {
        expect(() =>
            db
                .prepare(
                    `INSERT INTO contributions
                     (id, content_type, title, author_id, scope, scope_target, state, current_version, created_at, updated_at)
                     VALUES ('c1', 'best_practice', 't', 'a', 'galaxy', NULL, 'draft', 1, 'now', 'now')`,
                )
                .run(),
        ).toThrow();
    });

    it('enforces the state CHECK constraint', () => {
        expect(() =>
            db
                .prepare(
                    `INSERT INTO contributions
                     (id, content_type, title, author_id, scope, scope_target, state, current_version, created_at, updated_at)
                     VALUES ('c1', 'best_practice', 't', 'a', 'org', NULL, 'archived', 1, 'now', 'now')`,
                )
                .run(),
        ).toThrow();
    });

    it('leaves content_type an OPEN enum — an unknown type is accepted', () => {
        expect(() =>
            db
                .prepare(
                    `INSERT INTO contributions
                     (id, content_type, title, author_id, scope, scope_target, state, current_version, created_at, updated_at)
                     VALUES ('c1', 'future_kind', 't', 'a', 'org', NULL, 'draft', 1, 'now', 'now')`,
                )
                .run(),
        ).not.toThrow();
    });

    it('enforces UNIQUE(contribution_id, version) on versions', () => {
        db.prepare(
            `INSERT INTO contributions
             (id, content_type, title, author_id, scope, scope_target, state, current_version, created_at, updated_at)
             VALUES ('c1', 'best_practice', 't', 'a', 'org', NULL, 'draft', 1, 'now', 'now')`,
        ).run();
        db.prepare(
            `INSERT INTO contribution_versions (id, contribution_id, version, body, author_id, change_note, created_at)
             VALUES ('v1', 'c1', 1, '{}', 'a', NULL, 'now')`,
        ).run();
        expect(() =>
            db
                .prepare(
                    `INSERT INTO contribution_versions (id, contribution_id, version, body, author_id, change_note, created_at)
                     VALUES ('v2', 'c1', 1, '{}', 'a', NULL, 'now')`,
                )
                .run(),
        ).toThrow();
    });

    it('is idempotent — re-running the migrations is a no-op and tables survive', () => {
        // Already applied once in beforeEach; running again must apply zero new migrations.
        const applied = runMigrations(db, MIGRATIONS_DIR);
        expect(applied).toBe(0);
        for (const table of SPINE_TABLES) {
            expect(tableExists(db, table)).toBe(true);
        }
    });

    it('re-executing the raw 033 SQL directly does not error (IF NOT EXISTS)', () => {
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '033_contributions.sql'), 'utf-8');
        expect(() => db.exec(sql)).not.toThrow();
    });
});
