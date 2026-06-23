import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import {runMigrations} from '../../src/storage/migrator';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

const PRACTICE_TABLES = [
    'practice_details',
    'practice_metric_pins',
    'practice_feedback',
    'practice_usage_events',
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

describe('migration 036 — best-practice schema (#156)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db, MIGRATIONS_DIR);
        // Seed an author + a contribution the companion-table FKs reference, so a
        // failure isolates the constraint under test rather than the contribution FK.
        db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
            'a',
            'Author',
            'a@test.com',
            'eng',
            '2026-06-20T00:00:00.000Z',
        );
        db.prepare(
            `INSERT INTO contributions
             (id, content_type, title, author_id, scope, scope_target, state, current_version, created_at, updated_at)
             VALUES ('c1', 'best_practice', 't', 'a', 'org', NULL, 'published', 1, 'now', 'now')`,
        ).run();
    });

    afterEach(() => {
        db.close();
    });

    it('creates all four companion tables', () => {
        for (const table of PRACTICE_TABLES) {
            expect(tableExists(db, table), `${table} should exist`).toBe(true);
        }
    });

    it('gives practice_details exactly its companion columns', () => {
        const cols = columnNames(db, 'practice_details').sort();
        expect(cols).toEqual(['contribution_id', 'model_used', 'endorsed'].sort());
    });

    it('gives practice_metric_pins exactly its columns', () => {
        const cols = columnNames(db, 'practice_metric_pins').sort();
        expect(cols).toEqual(['id', 'contribution_id', 'metric', 'action', 'actor_id', 'created_at'].sort());
    });

    it('gives practice_feedback exactly its columns', () => {
        const cols = columnNames(db, 'practice_feedback').sort();
        expect(cols).toEqual(
            ['id', 'contribution_id', 'developer_id', 'signal', 'created_at'].sort(),
        );
    });

    it('gives practice_usage_events exactly its columns', () => {
        const cols = columnNames(db, 'practice_usage_events').sort();
        expect(cols).toEqual(
            ['id', 'contribution_id', 'developer_id', 'event', 'metric_context', 'occurred_at'].sort(),
        );
    });

    it('enforces the metric-pin action CHECK constraint', () => {
        expect(() =>
            db
                .prepare(
                    `INSERT INTO practice_metric_pins (id, contribution_id, metric, action, actor_id, created_at)
                     VALUES ('p1', 'c1', 'churn', 'banish', 'a', 'now')`,
                )
                .run(),
        ).toThrow();
    });

    it('accepts the two valid pin actions', () => {
        expect(() => {
            db.prepare(
                `INSERT INTO practice_metric_pins (id, contribution_id, metric, action, actor_id, created_at)
                 VALUES ('p1', 'c1', 'churn', 'pin', 'a', 'now')`,
            ).run();
            db.prepare(
                `INSERT INTO practice_metric_pins (id, contribution_id, metric, action, actor_id, created_at)
                 VALUES ('p2', 'c1', 'churn', 'suppress', 'a', 'now')`,
            ).run();
        }).not.toThrow();
    });

    it('enforces the feedback signal CHECK constraint', () => {
        expect(() =>
            db
                .prepare(
                    `INSERT INTO practice_feedback (id, contribution_id, developer_id, signal, created_at)
                     VALUES ('f1', 'c1', 'a', 'meh', 'now')`,
                )
                .run(),
        ).toThrow();
    });

    it('enforces the endorsed boolean CHECK constraint', () => {
        expect(() =>
            db
                .prepare(
                    `INSERT INTO practice_details (contribution_id, model_used, endorsed) VALUES ('c1', NULL, 2)`,
                )
                .run(),
        ).toThrow();
    });

    it('enforces UNIQUE(contribution_id, developer_id) on feedback', () => {
        db.prepare(
            `INSERT INTO practice_feedback (id, contribution_id, developer_id, signal, created_at)
             VALUES ('f1', 'c1', 'a', 'helpful', 'now')`,
        ).run();
        expect(() =>
            db
                .prepare(
                    `INSERT INTO practice_feedback (id, contribution_id, developer_id, signal, created_at)
                     VALUES ('f2', 'c1', 'a', 'not_helpful', 'now')`,
                )
                .run(),
        ).toThrow();
    });

    it('leaves the usage-event kind an OPEN enum — an unknown event is accepted', () => {
        expect(() =>
            db
                .prepare(
                    `INSERT INTO practice_usage_events (id, contribution_id, developer_id, event, metric_context, occurred_at)
                     VALUES ('u1', 'c1', 'a', 'dismissed', NULL, 'now')`,
                )
                .run(),
        ).not.toThrow();
    });

    it('rejects a companion row referencing a missing contribution (FK)', () => {
        expect(() =>
            db
                .prepare(
                    `INSERT INTO practice_metric_pins (id, contribution_id, metric, action, actor_id, created_at)
                     VALUES ('p1', 'ghost', 'churn', 'pin', 'a', 'now')`,
                )
                .run(),
        ).toThrow();
    });

    it('cascades companion rows when the contribution is hard-deleted', () => {
        db.prepare(`INSERT INTO practice_details (contribution_id, endorsed) VALUES ('c1', 1)`).run();
        db.prepare(
            `INSERT INTO practice_metric_pins (id, contribution_id, metric, action, actor_id, created_at)
             VALUES ('p1', 'c1', 'churn', 'pin', 'a', 'now')`,
        ).run();
        db.prepare(
            `INSERT INTO practice_feedback (id, contribution_id, developer_id, signal, created_at)
             VALUES ('f1', 'c1', 'a', 'helpful', 'now')`,
        ).run();
        db.prepare(
            `INSERT INTO practice_usage_events (id, contribution_id, developer_id, event, metric_context, occurred_at)
             VALUES ('u1', 'c1', 'a', 'viewed', NULL, 'now')`,
        ).run();

        db.prepare(`DELETE FROM contributions WHERE id = 'c1'`).run();

        for (const table of PRACTICE_TABLES) {
            const count = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n: number};
            expect(count.n, `${table} should be empty after cascade`).toBe(0);
        }
    });

    it('is idempotent — re-running the migrations is a no-op and tables survive', () => {
        const applied = runMigrations(db, MIGRATIONS_DIR);
        expect(applied).toBe(0);
        for (const table of PRACTICE_TABLES) {
            expect(tableExists(db, table)).toBe(true);
        }
    });

    it('re-executing the raw 036 SQL directly does not error (IF NOT EXISTS)', () => {
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '036_practice_schema.sql'), 'utf-8');
        expect(() => db.exec(sql)).not.toThrow();
    });
});
