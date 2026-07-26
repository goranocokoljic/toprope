import {describe, it, expect} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

/**
 * Migration 043 (#266) — normalize `git_providers.container`, and reset the container-keyed
 * data it can no longer honestly re-attribute.
 *
 * Three things are asserted:
 *   1. an existing row's container is normalized IN PLACE (the provider row survives — it
 *      holds the encrypted token),
 *   2. rows that collide once normalized are deduped to the OLDEST, so the
 *      `UNIQUE(type, container)` index from 042 still holds afterwards, and
 *   3. the reset is CONDITIONAL: an install whose containers are already normalized keeps
 *      every imported row and every cursor, while one that held a mis-cased container has its
 *      container-keyed data and `git_*` cursors cleared TOGETHER (never a cursor without its
 *      data — that is the #262 double-count, re-armed from inside a migration).
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

function migrationFilesUpTo(maxId: number): string[] {
    return fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => /^\d{3}_.*\.sql$/.test(f) && parseInt(f.slice(0, 3), 10) <= maxId)
        .sort();
}

/** A database migrated to 042 exactly — an existing install right before #266. */
function dbAt042(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(
        'CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    for (const f of migrationFilesUpTo(42)) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8'));
        db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
            parseInt(f.slice(0, 3), 10),
            f,
            '2026-07-01T00:00:00.000Z',
        );
    }
    return db;
}

function apply043(db: Database.Database): void {
    const file = fs
        .readdirSync(MIGRATIONS_DIR)
        .find((f) => f.startsWith('043_'));
    expect(file, 'migration 043 must exist').toBeDefined();
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file as string), 'utf-8'));
}

function count(db: Database.Database, table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n: number}).n;
}

function insertProvider(
    db: Database.Database,
    id: string,
    type: string,
    container: string,
    createdAt: string,
): void {
    db.prepare(
        `INSERT INTO git_providers (
            id, type, container, url, include_subgroups, auth_method, auth_username,
            token_ciphertext, token_meta, token_last4, repos_include, repos_exclude,
            enabled, created_at, updated_at, created_by
         ) VALUES (?, ?, ?, NULL, NULL, 'token', NULL, ?, '{}', 'abcd', NULL, NULL, 1, ?, ?, NULL)`,
    ).run(id, type, container, Buffer.from('cipher'), createdAt, createdAt);
}

function insertRawAuthorDay(db: Database.Database, container: string, date: string): void {
    db.prepare(
        `INSERT INTO raw_author_daily (
            id, provider, container, raw_author_key, author_login, author_email,
            author_display_name, date, commits, lines_added, lines_removed, files_changed,
            prs_opened, prs_merged, review_comments_given, avg_time_to_merge_hours,
            code_churn_rate, ai_signature_score, avg_commit_size, commit_burst_count,
            first_seen, last_seen
         ) VALUES (?, 'github', ?, 'github:login:alice', 'alice', 'a@x.dev', NULL, ?,
                   3, 30, 3, 2, 0, 0, 0, NULL, 0, 0, 10, 0, ?, ?)`,
    ).run(`raw-${container}-${date}`, container, date, '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z');
}

function insertPrRecord(db: Database.Database, container: string, prId: string): void {
    db.prepare(
        `INSERT INTO pr_records (
            id, developer_id, provider, container, repo, pr_id, state, created_at,
            merged_at, closed_at, review_comment_count, review_rounds,
            changes_requested_count, time_to_merge_hours, synced_at
         ) VALUES (?, 'dev-1', 'github', ?, 'repo-a', ?, 'merged', '2026-07-01T00:00:00.000Z',
                   NULL, NULL, 0, 0, 0, NULL, '2026-07-02T00:00:00.000Z')`,
    ).run(`pr-${container}-${prId}`, container, prId);
}

function insertSnapshot(db: Database.Database, date: string, projected: number): void {
    db.prepare(
        `INSERT INTO git_snapshots (id, developer_id, date, commits, is_projected)
         VALUES (?, 'dev-1', ?, 3, ?)`,
    ).run(`snap-${date}-${projected}`, date, projected);
}

function insertCursors(db: Database.Database, container: string): void {
    const put = db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)');
    put.run(`git_last_sync:github:${container}`, '2026-07-02T00:00:00.000Z');
    put.run(`git_earliest_sync:github:${container}`, '2026-01-01T00:00:00.000Z');
    put.run(`git_stall:github:${container}`, '{"runs":1}');
}

/** A developer for the FK on pr_records/git_snapshots. */
function seedDeveloper(db: Database.Database): void {
    db.prepare(
        `INSERT INTO teams (name, department, manager, created_at)
         VALUES ('core', NULL, NULL, '2026-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
        `INSERT INTO developers (id, name, email, team, created_at)
         VALUES ('dev-1', 'Alice', 'a@x.dev', 'core', '2026-01-01T00:00:00.000Z')`,
    ).run();
}

describe('migration 043 — container normalization (#266)', () => {
    it('normalizes an existing container in place, keeping the provider row (and its token)', () => {
        const db = dbAt042();
        insertProvider(db, 'p1', 'github', '  Wireless_Media ', '2026-02-01T00:00:00.000Z');
        insertProvider(db, 'p2', 'bitbucket', 'ACME-WS', '2026-02-02T00:00:00.000Z');
        insertProvider(db, 'p3', 'gitlab', 'already-lower', '2026-02-03T00:00:00.000Z');

        apply043(db);

        const rows = db
            .prepare('SELECT id, container, token_last4 FROM git_providers ORDER BY id')
            .all() as {id: string; container: string; token_last4: string}[];
        expect(rows).toEqual([
            {id: 'p1', container: 'wireless_media', token_last4: 'abcd'},
            {id: 'p2', container: 'acme-ws', token_last4: 'abcd'},
            {id: 'p3', container: 'already-lower', token_last4: 'abcd'},
        ]);
        db.close();
    });

    it('dedupes case-variant providers to the OLDEST, so UNIQUE(type, container) still holds', () => {
        const db = dbAt042();
        // Three spellings of one real workspace, connected in a known order.
        insertProvider(db, 'p-old', 'github', 'Wireless_Media', '2026-02-01T00:00:00.000Z');
        insertProvider(db, 'p-mid', 'github', 'wireless_media', '2026-03-01T00:00:00.000Z');
        insertProvider(db, 'p-new', 'github', 'WIRELESS_MEDIA ', '2026-04-01T00:00:00.000Z');
        // A genuinely different container must survive untouched.
        insertProvider(db, 'p-other', 'github', 'other-org', '2026-05-01T00:00:00.000Z');

        apply043(db);

        const rows = db
            .prepare('SELECT id, container FROM git_providers ORDER BY container')
            .all() as {id: string; container: string}[];
        expect(rows).toEqual([
            {id: 'p-other', container: 'other-org'},
            {id: 'p-old', container: 'wireless_media'},
        ]);
        // And the constraint the dedupe exists to protect is still enforceable.
        expect(() =>
            insertProvider(db, 'p-dup', 'github', 'wireless_media', '2026-06-01T00:00:00.000Z'),
        ).toThrow(/UNIQUE/);
        db.close();
    });

    it('resets the container-keyed data AND its cursors together when a container was mis-cased', () => {
        const db = dbAt042();
        seedDeveloper(db);
        insertProvider(db, 'p1', 'github', 'Wireless_Media', '2026-02-01T00:00:00.000Z');
        insertRawAuthorDay(db, 'Wireless_Media', '2026-07-01');
        insertRawAuthorDay(db, 'wireless_media', '2026-07-01');
        insertPrRecord(db, 'Wireless_Media', '1');
        insertSnapshot(db, '2026-07-01', 1);
        insertCursors(db, 'Wireless_Media');
        insertCursors(db, 'wireless_media');
        // An unrelated sync_state row must survive — the reset is scoped to git_* cursors.
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run('copilot_last_sync', 'x');

        apply043(db);

        expect(count(db, 'raw_author_daily')).toBe(0);
        expect(count(db, 'pr_records')).toBe(0);
        expect(count(db, 'git_snapshots')).toBe(0);
        // Cursors go WITH the data — never one without the other (the #262 rule).
        expect(
            (
                db
                    .prepare(
                        `SELECT COUNT(*) AS n FROM sync_state
                          WHERE key LIKE 'git_last_sync:%' OR key LIKE 'git_earliest_sync:%'
                             OR key LIKE 'git_stall:%'`,
                    )
                    .get() as {n: number}
            ).n,
        ).toBe(0);
        expect(
            db.prepare("SELECT value FROM sync_state WHERE key = 'copilot_last_sync'").get(),
        ).toEqual({value: 'x'});
        // The provider row itself survives, normalized.
        expect(
            db.prepare('SELECT container FROM git_providers WHERE id = ?').get('p1'),
        ).toEqual({container: 'wireless_media'});
        db.close();
    });

    it('leaves an already-normalized install completely untouched (no gratuitous resync)', () => {
        const db = dbAt042();
        seedDeveloper(db);
        insertProvider(db, 'p1', 'github', 'wireless_media', '2026-02-01T00:00:00.000Z');
        insertRawAuthorDay(db, 'wireless_media', '2026-07-01');
        insertRawAuthorDay(db, 'wireless_media', '2026-07-02');
        insertPrRecord(db, 'wireless_media', '1');
        insertSnapshot(db, '2026-07-01', 1);
        insertCursors(db, 'wireless_media');

        apply043(db);

        expect(count(db, 'raw_author_daily')).toBe(2);
        expect(count(db, 'pr_records')).toBe(1);
        expect(count(db, 'git_snapshots')).toBe(1);
        expect(count(db, 'sync_state')).toBe(3);
        db.close();
    });

    it('is a no-op on a fresh (empty) database', () => {
        const db = dbAt042();
        apply043(db);
        expect(count(db, 'git_providers')).toBe(0);
        expect(count(db, 'raw_author_daily')).toBe(0);
        expect(count(db, 'sync_state')).toBe(0);
        // The scratch table used to capture "does anything need normalizing?" is dropped, so
        // it can never be mistaken for schema.
        const tables = (
            db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
                name: string;
            }[]
        ).map((t) => t.name);
        expect(tables).not.toContain('_m043_reset');
        db.close();
    });

    it('leaves a legacy (is_projected = 0) snapshot cell alone — only 042 was licensed to drop those', () => {
        const db = dbAt042();
        seedDeveloper(db);
        insertProvider(db, 'p1', 'github', 'Wireless_Media', '2026-02-01T00:00:00.000Z');
        insertSnapshot(db, '2026-07-01', 1);
        insertSnapshot(db, '2026-07-02', 0);

        apply043(db);

        const rows = db.prepare('SELECT date, is_projected FROM git_snapshots').all();
        expect(rows).toEqual([{date: '2026-07-02', is_projected: 0}]);
        db.close();
    });
});
