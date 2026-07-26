import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import {runMigrations} from '../../src/storage/migrator';

/**
 * Migration 042 (#264) — per-container attribution of imported git data.
 *
 * Two distinct things are asserted here:
 *   1. the RESULTING schema (container columns, widened unique keys, the UNIQUE
 *      (type, container) on git_providers), and
 *   2. the RESET the migration performs when it lands on a POPULATED pre-042 database —
 *      the three data tables emptied and the `git_*` cursors cleared. That half matters
 *      because pre-042 rows cannot be split retroactively (which workspace a merged
 *      `(github, alice, 2026-07-01)` row came from is simply not recorded), and leaving a
 *      cursor behind with no data under it re-creates the #262 gap from inside the
 *      migration itself.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

function migrationFilesUpTo(maxId: number): string[] {
    return fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => /^\d{3}_.*\.sql$/.test(f) && parseInt(f.slice(0, 3), 10) <= maxId)
        .sort();
}

/** A database migrated to 041 exactly — an existing install right before #264. */
function dbAt041(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(
        'CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    for (const f of migrationFilesUpTo(41)) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8'));
        db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
            parseInt(f.slice(0, 3), 10),
            f,
            '2026-07-01T00:00:00.000Z',
        );
    }
    return db;
}

function columnNames(db: Database.Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as {name: string}[]).map((r) => r.name);
}

function count(db: Database.Database, table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n: number}).n;
}

/** The unique index columns SQLite reports for a table, one array per unique index. */
function uniqueKeys(db: Database.Database, table: string): string[][] {
    const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as {
        name: string;
        unique: number;
    }[];
    return indexes
        .filter((i) => i.unique === 1)
        .map((i) =>
            (db.prepare(`PRAGMA index_info(${i.name})`).all() as {name: string | null}[])
                .map((c) => c.name ?? '')
                .filter((n) => n !== ''),
        );
}

function insertProvider(
    db: Database.Database,
    overrides: Record<string, unknown> = {},
): void {
    const row = {
        id: 'gp1',
        type: 'bitbucket',
        container: 'ws-a',
        url: null,
        include_subgroups: null,
        auth_method: 'access_token',
        auth_username: null,
        token_ciphertext: Buffer.from('cipher'),
        token_meta: '{"algo":"AES-256-GCM","iv":"x","auth_tag":"y","key_id":"k1"}',
        token_last4: '1234',
        repos_include: null,
        repos_exclude: null,
        enabled: 1,
        created_at: '2026-07-06T00:00:00.000Z',
        updated_at: '2026-07-06T00:00:00.000Z',
        created_by: null,
        last_sync_at: null,
        last_sync_status: null,
        last_sync_error: null,
        ...overrides,
    };
    db.prepare(
        `INSERT INTO git_providers
         (id, type, container, url, include_subgroups, auth_method, auth_username,
          token_ciphertext, token_meta, token_last4, repos_include, repos_exclude,
          enabled, created_at, updated_at, created_by, last_sync_at, last_sync_status, last_sync_error)
         VALUES
         (@id, @type, @container, @url, @include_subgroups, @auth_method, @auth_username,
          @token_ciphertext, @token_meta, @token_last4, @repos_include, @repos_exclude,
          @enabled, @created_at, @updated_at, @created_by, @last_sync_at, @last_sync_status,
          @last_sync_error)`,
    ).run(row);
}

describe('migration 042 — the resulting schema (#264)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db, MIGRATIONS_DIR);
    });

    afterEach(() => db.close());

    it('gives raw_author_daily a container column keyed into its unique quad', () => {
        expect(columnNames(db, 'raw_author_daily')).toContain('container');
        expect(uniqueKeys(db, 'raw_author_daily')).toContainEqual([
            'provider',
            'container',
            'raw_author_key',
            'date',
        ]);
    });

    it('gives pr_records a container column keyed into its unique quad', () => {
        expect(columnNames(db, 'pr_records')).toContain('container');
        expect(uniqueKeys(db, 'pr_records')).toContainEqual([
            'provider',
            'container',
            'repo',
            'pr_id',
        ]);
    });

    it('keeps git_snapshots at the (developer_id, date) grain — no container column', () => {
        // It is a PROJECTION of the raw store, so a delete re-projects the affected days
        // rather than deleting by provenance. Adding a column here would fork that model
        // and break its many readers.
        expect(columnNames(db, 'git_snapshots')).not.toContain('container');
    });

    it('makes (type, container) UNIQUE on git_providers', () => {
        insertProvider(db, {id: 'a', type: 'bitbucket', container: 'ws-a'});
        expect(() =>
            insertProvider(db, {id: 'b', type: 'bitbucket', container: 'ws-a'}),
        ).toThrow(/UNIQUE/i);
    });

    it('is idempotent through the migrator — re-running applies nothing', () => {
        expect(runMigrations(db, MIGRATIONS_DIR)).toBe(0);
        expect(columnNames(db, 'raw_author_daily')).toContain('container');
    });
});

describe('migration 042 — reset of a POPULATED pre-042 database (#264)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = dbAt041();
        // A developer for pr_records' FK, and a legacy + projected snapshot row.
        db.prepare(
            `INSERT INTO developers (id, name, email, team, external_ids, created_at)
             VALUES ('dev-1', 'Alice', 'alice@example.com', 'eng', '{"github":"alice"}', '2026-01-01T00:00:00.000Z')`,
        ).run();
        // Pre-042 raw_author_daily rows: no container column at all.
        db.prepare(
            `INSERT INTO raw_author_daily
             (id, provider, raw_author_key, author_login, author_email, author_display_name,
              date, commits, lines_added, lines_removed, files_changed, prs_opened, prs_merged,
              review_comments_given, avg_time_to_merge_hours, code_churn_rate, ai_signature_score,
              avg_commit_size, commit_burst_count, first_seen, last_seen)
             VALUES ('r1', 'bitbucket', 'bitbucket:login:alice', 'alice', 'alice@example.com', NULL,
                     '2026-07-01', 9, 90, 9, 3, 1, 1, 2, 4.0, 0.1, 0.5, 10, 0,
                     '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
        ).run();
        db.prepare(
            `INSERT INTO pr_records
             (id, developer_id, provider, repo, pr_id, state, created_at, merged_at, closed_at,
              review_comment_count, review_rounds, changes_requested_count, time_to_merge_hours, synced_at)
             VALUES ('pr1', 'dev-1', 'bitbucket', 'repo1', '7', 'merged',
                     '2026-07-01T00:00:00.000Z', NULL, NULL, 0, 0, 0, NULL, '2026-07-01T00:00:00.000Z')`,
        ).run();
        db.prepare(
            `INSERT INTO git_snapshots (id, developer_id, date, commits, is_projected)
             VALUES ('gs-legacy', 'dev-1', '2026-06-01', 5, 0),
                    ('gs-proj', 'dev-1', '2026-07-01', 9, 1)`,
        ).run();
        for (const [key, value] of [
            ['git_last_sync:bitbucket:ws-a', '2026-07-20T00:00:00.000Z'],
            ['git_earliest_sync:bitbucket:ws-a', '2026-01-20T00:00:00.000Z'],
            ['git_stall:bitbucket:ws-a', '{"runs":2,"since":"2026-07-01T00:00:00.000Z"}'],
            // Must SURVIVE: not a git cursor.
            ['copilot_last_sync', '2026-07-20T00:00:00.000Z'],
        ]) {
            db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(key, value);
        }
    });

    afterEach(() => db.close());

    it('runs clean and empties exactly the three data tables', () => {
        expect(count(db, 'raw_author_daily')).toBe(1);
        expect(count(db, 'pr_records')).toBe(1);
        expect(count(db, 'git_snapshots')).toBe(2);

        expect(() => runMigrations(db, MIGRATIONS_DIR)).not.toThrow();

        expect(count(db, 'raw_author_daily')).toBe(0);
        expect(count(db, 'pr_records')).toBe(0);
        // BOTH snapshot rows go — including the legacy one. That is the correctness reason
        // for the reset: a legacy cell is immutable to the projection in both directions, so
        // a delete cascade could never retract a provider's contribution to it.
        expect(count(db, 'git_snapshots')).toBe(0);
        // Developers are untouched by the reset.
        expect(count(db, 'developers')).toBe(1);
    });

    it('clears every git_* cursor kind and nothing else', () => {
        runMigrations(db, MIGRATIONS_DIR);
        const keys = (
            db.prepare('SELECT key FROM sync_state ORDER BY key').all() as {key: string}[]
        ).map((r) => r.key);
        expect(keys).toEqual(['copilot_last_sync']);
    });

    it('records 042 in the ledger and leaves the new shape in place', () => {
        runMigrations(db, MIGRATIONS_DIR);
        expect(db.prepare('SELECT name FROM schema_migrations WHERE id = 42').get()).toEqual({
            name: '042_provider_container_attribution.sql',
        });
        expect(columnNames(db, 'raw_author_daily')).toContain('container');
        expect(columnNames(db, 'pr_records')).toContain('container');
    });

    it('de-duplicates git_providers rows for one (type, container), keeping the oldest', () => {
        // Two rows for ONE workspace — allowed by 039's non-unique index, and a latent bug:
        // both would sync it through the single container-keyed cursor.
        insertProvider(db, {id: 'older', container: 'ws-dup', created_at: '2026-01-01T00:00:00.000Z'});
        insertProvider(db, {id: 'newer', container: 'ws-dup', created_at: '2026-06-01T00:00:00.000Z'});
        insertProvider(db, {id: 'solo', container: 'ws-solo', created_at: '2026-03-01T00:00:00.000Z'});

        runMigrations(db, MIGRATIONS_DIR);

        const ids = (
            db.prepare('SELECT id FROM git_providers ORDER BY id').all() as {id: string}[]
        ).map((r) => r.id);
        expect(ids).toEqual(['older', 'solo']);
        // And the constraint now holds for real.
        expect(() => insertProvider(db, {id: 'again', container: 'ws-solo'})).toThrow(/UNIQUE/i);
    });
});
