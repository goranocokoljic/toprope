import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import {runMigrations} from '../../src/storage/migrator';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

const SHOWCASE_TABLES = [
    'showcase_units',
    'showcase_annotations',
    'showcase_consent',
    'scrub_flags',
    'showcase_practice_links',
];

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

describe('migration 037 — showcase schema (#164)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db, MIGRATIONS_DIR);
        // Seed an author + a showcase contribution + a practice contribution the
        // companion-table FKs reference, so a failure isolates the constraint under
        // test rather than the contribution/developer FK.
        db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
            'dev1',
            'Author',
            'a@test.com',
            'eng',
            '2026-06-20T00:00:00.000Z',
        );
        db.prepare(
            `INSERT INTO contributions
             (id, content_type, title, author_id, scope, scope_target, state, current_version, created_at, updated_at)
             VALUES ('sc1', 'showcase_example', 't', 'dev1', 'org', NULL, 'draft', 1, 'now', 'now')`,
        ).run();
        db.prepare(
            `INSERT INTO contributions
             (id, content_type, title, author_id, scope, scope_target, state, current_version, created_at, updated_at)
             VALUES ('bp1', 'best_practice', 't', 'dev1', 'org', NULL, 'published', 1, 'now', 'now')`,
        ).run();
    });

    afterEach(() => {
        db.close();
    });

    it('creates all five companion tables', () => {
        for (const table of SHOWCASE_TABLES) {
            expect(tableExists(db, table), `${table} should exist`).toBe(true);
        }
    });

    it('gives showcase_units exactly its companion columns', () => {
        const cols = columnNames(db, 'showcase_units').sort();
        expect(cols).toEqual(
            ['contribution_id', 'conversation', 'outcome_link', 'curators_note', 'ai_annotation', 'publish_path'].sort(),
        );
    });

    it('gives showcase_annotations exactly its columns', () => {
        const cols = columnNames(db, 'showcase_annotations').sort();
        expect(cols).toEqual(
            ['id', 'contribution_id', 'turn_ref', 'author_id', 'body', 'created_at'].sort(),
        );
    });

    it('gives showcase_consent exactly its columns', () => {
        const cols = columnNames(db, 'showcase_consent').sort();
        expect(cols).toEqual(
            ['id', 'contribution_id', 'developer_id', 'approved', 'visibility_scope', 'approved_at'].sort(),
        );
    });

    it('gives scrub_flags exactly its columns', () => {
        const cols = columnNames(db, 'scrub_flags').sort();
        expect(cols).toEqual(['id', 'contribution_id', 'tier', 'finding', 'resolved', 'created_at'].sort());
    });

    it('gives showcase_practice_links exactly its columns', () => {
        const cols = columnNames(db, 'showcase_practice_links').sort();
        expect(cols).toEqual(['showcase_id', 'practice_id'].sort());
    });

    it('enforces the publish_path CHECK constraint', () => {
        expect(() =>
            db
                .prepare(
                    `INSERT INTO showcase_units (contribution_id, conversation, curators_note, publish_path)
                     VALUES ('sc1', '[]', 'note', 'sneaky')`,
                )
                .run(),
        ).toThrow();
    });

    it('accepts the two valid publish paths', () => {
        expect(() => {
            db.prepare(
                `INSERT INTO showcase_units (contribution_id, conversation, curators_note, publish_path)
                 VALUES ('sc1', '[]', 'note', 'self_publish')`,
            ).run();
        }).not.toThrow();
        // second path on the practice contribution to avoid the PK collision
        expect(() => {
            db.prepare(
                `INSERT INTO showcase_units (contribution_id, conversation, curators_note, publish_path)
                 VALUES ('bp1', '[]', 'note', 'joint_curation')`,
            ).run();
        }).not.toThrow();
    });

    it('requires curators_note (NOT NULL at the column level)', () => {
        expect(() =>
            db
                .prepare(
                    `INSERT INTO showcase_units (contribution_id, conversation, curators_note, publish_path)
                     VALUES ('sc1', '[]', NULL, 'self_publish')`,
                )
                .run(),
        ).toThrow();
    });

    it('enforces the consent visibility_scope CHECK and distinguishes both scopes', () => {
        expect(() =>
            db
                .prepare(
                    `INSERT INTO showcase_consent (id, contribution_id, developer_id, approved, visibility_scope, approved_at)
                     VALUES ('cs1', 'sc1', 'dev1', 1, 'planet', NULL)`,
                )
                .run(),
        ).toThrow();
        expect(() => {
            db.prepare(
                `INSERT INTO showcase_consent (id, contribution_id, developer_id, approved, visibility_scope, approved_at)
                 VALUES ('cs1', 'sc1', 'dev1', 1, 'team', NULL)`,
            ).run();
            db.prepare(
                `INSERT INTO showcase_consent (id, contribution_id, developer_id, approved, visibility_scope, approved_at)
                 VALUES ('cs2', 'sc1', 'dev1', 1, 'org', NULL)`,
            ).run();
        }).not.toThrow();
    });

    it('enforces the consent approved boolean CHECK', () => {
        expect(() =>
            db
                .prepare(
                    `INSERT INTO showcase_consent (id, contribution_id, developer_id, approved, visibility_scope, approved_at)
                     VALUES ('cs1', 'sc1', 'dev1', 2, 'team', NULL)`,
                )
                .run(),
        ).toThrow();
    });

    it('enforces the scrub tier CHECK and distinguishes the two tiers', () => {
        expect(() =>
            db
                .prepare(
                    `INSERT INTO scrub_flags (id, contribution_id, tier, finding, resolved, created_at)
                     VALUES ('sf1', 'sc1', 'maybe', 'x', 0, 'now')`,
                )
                .run(),
        ).toThrow();
        expect(() => {
            db.prepare(
                `INSERT INTO scrub_flags (id, contribution_id, tier, finding, resolved, created_at)
                 VALUES ('sf1', 'sc1', 'secret_high', 'AWS key', 0, 'now')`,
            ).run();
            db.prepare(
                `INSERT INTO scrub_flags (id, contribution_id, tier, finding, resolved, created_at)
                 VALUES ('sf2', 'sc1', 'pii_hint_low', 'possible email', 0, 'now')`,
            ).run();
        }).not.toThrow();
    });

    it('enforces the scrub resolved boolean CHECK', () => {
        expect(() =>
            db
                .prepare(
                    `INSERT INTO scrub_flags (id, contribution_id, tier, finding, resolved, created_at)
                     VALUES ('sf1', 'sc1', 'secret_high', 'x', 5, 'now')`,
                )
                .run(),
        ).toThrow();
    });

    it('rejects a companion row referencing a missing contribution (FK)', () => {
        expect(() =>
            db
                .prepare(
                    `INSERT INTO showcase_units (contribution_id, conversation, curators_note, publish_path)
                     VALUES ('ghost', '[]', 'note', 'self_publish')`,
                )
                .run(),
        ).toThrow();
    });

    it('rejects an annotation referencing a missing developer (FK on author_id)', () => {
        expect(() =>
            db
                .prepare(
                    `INSERT INTO showcase_annotations (id, contribution_id, turn_ref, author_id, body, created_at)
                     VALUES ('an1', 'sc1', 't0', 'ghost-dev', 'body', 'now')`,
                )
                .run(),
        ).toThrow();
    });

    it('rejects a cross-link referencing a missing contribution (FK on both ends)', () => {
        expect(() =>
            db
                .prepare(`INSERT INTO showcase_practice_links (showcase_id, practice_id) VALUES ('sc1', 'ghost')`)
                .run(),
        ).toThrow();
    });

    it('cascades all companion rows when the contribution is hard-deleted', () => {
        db.prepare(
            `INSERT INTO showcase_units (contribution_id, conversation, curators_note, publish_path)
             VALUES ('sc1', '[]', 'note', 'self_publish')`,
        ).run();
        db.prepare(
            `INSERT INTO showcase_annotations (id, contribution_id, turn_ref, author_id, body, created_at)
             VALUES ('an1', 'sc1', 't0', 'dev1', 'why', 'now')`,
        ).run();
        db.prepare(
            `INSERT INTO showcase_consent (id, contribution_id, developer_id, approved, visibility_scope, approved_at)
             VALUES ('cs1', 'sc1', 'dev1', 1, 'team', 'now')`,
        ).run();
        db.prepare(
            `INSERT INTO scrub_flags (id, contribution_id, tier, finding, resolved, created_at)
             VALUES ('sf1', 'sc1', 'secret_high', 'x', 0, 'now')`,
        ).run();
        db.prepare(`INSERT INTO showcase_practice_links (showcase_id, practice_id) VALUES ('sc1', 'bp1')`).run();

        db.prepare(`DELETE FROM contributions WHERE id = 'sc1'`).run();

        for (const table of SHOWCASE_TABLES) {
            const count = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n: number};
            expect(count.n, `${table} should be empty after cascade`).toBe(0);
        }
    });

    it('cascades the cross-link when the OTHER end (the practice) is hard-deleted', () => {
        db.prepare(`INSERT INTO showcase_practice_links (showcase_id, practice_id) VALUES ('sc1', 'bp1')`).run();
        db.prepare(`DELETE FROM contributions WHERE id = 'bp1'`).run();
        const count = db.prepare(`SELECT COUNT(*) AS n FROM showcase_practice_links`).get() as {n: number};
        expect(count.n).toBe(0);
    });

    it('is idempotent — re-running the migrations is a no-op and tables survive', () => {
        const applied = runMigrations(db, MIGRATIONS_DIR);
        expect(applied).toBe(0);
        for (const table of SHOWCASE_TABLES) {
            expect(tableExists(db, table)).toBe(true);
        }
    });

    it('re-executing the raw 037 SQL directly does not error (IF NOT EXISTS)', () => {
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '037_showcase_schema.sql'), 'utf-8');
        expect(() => db.exec(sql)).not.toThrow();
    });
});
