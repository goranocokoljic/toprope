import {describe, it, expect} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import {runMigrations} from '../../src/storage/migrator';
import {normalizeContainer} from '../../src/connectors/git/providers/container';
import {gitResetNotice} from '../../src/connectors/git/reset-notice';

/**
 * Migration 043 (#266) — normalize `git_providers.container`, and reset the container-keyed
 * data it can no longer honestly re-attribute.
 *
 * What is asserted:
 *   1. an existing row's container is normalized IN PLACE (the provider row survives — it
 *      holds the encrypted token),
 *   2. rows that collide once normalized are deduped to the OLDEST (including the `id`
 *      tiebreak when `created_at` ties), so the `UNIQUE(type, container)` index from 042 still
 *      holds afterwards,
 *   3. the reset is UNCONDITIONAL — like 042 — so "the migration ran" always means "git data
 *      is being rebuilt", and imported rows never survive without their cursors or vice versa
 *      (the #262 rule),
 *   4. a container SQL cannot canonicalize the way `normalizeContainer` does (non-ASCII) has
 *      its provider row DELETED rather than re-spelled into a value no write path can produce,
 *   5. the SQL normalization expression and `normalizeContainer` agree exactly on ASCII input,
 *      which is the property the in-place UPDATE relies on, and
 *   6. the operator signal is left behind, because a resync alone does not rebuild the derived
 *      rollups.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

/**
 * The whitespace charlist and the normalization expression the migration uses, restated here so
 * the equivalence test can run it against a parameter. A separate assertion pins this restatement
 * to the migration file itself, so an edit to either side cannot silently drift.
 */
const SQL_TRIM_CHARS = "' ' || char(9) || char(10) || char(11) || char(12) || char(13)";
const SQL_NORMALIZE = `lower(trim(?, ${SQL_TRIM_CHARS}))`;

function migration043Source(): string {
    const file = fs.readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith('043_'));
    if (!file) throw new Error('migration 043 is missing');
    return fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
}

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

/**
 * Apply 043 through the real runner, matching the sibling 042 test. `runMigrations` wraps each
 * file in `db.transaction(...)`, so this also proves 043 applies cleanly under the runner
 * against a POPULATED database and is recorded exactly once.
 */
function apply043(db: Database.Database): void {
    expect(runMigrations(db, MIGRATIONS_DIR)).toBe(1);
    expect(
        (
            db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE id = 43').get() as {
                n: number;
            }
        ).n,
    ).toBe(1);
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
            enabled, created_at, updated_at, created_by, last_sync_at, last_sync_status, last_sync_error
         ) VALUES (?, ?, ?, NULL, NULL, 'token', NULL, ?, '{}', 'abcd', NULL, NULL, 1, ?, ?, NULL,
                   '2026-07-20T00:00:00.000Z', 'ok', NULL)`,
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
    ).run(
        `raw-${container}-${date}`,
        container,
        date,
        '2026-07-02T00:00:00.000Z',
        '2026-07-02T00:00:00.000Z',
    );
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

function gitCursorCount(db: Database.Database): number {
    return (
        db
            .prepare(
                `SELECT COUNT(*) AS n FROM sync_state
                  WHERE key LIKE 'git_last_sync:%' OR key LIKE 'git_earliest_sync:%'
                     OR key LIKE 'git_stall:%'`,
            )
            .get() as {n: number}
    ).n;
}

describe('migration 043 — container normalization (#266)', () => {
    it('normalizes an existing container in place, keeping the provider row (and its token)', () => {
        const db = dbAt042();
        insertProvider(db, 'p1', 'github', '  Wireless_Media ', '2026-02-01T00:00:00.000Z');
        insertProvider(db, 'p2', 'bitbucket', 'ACME-WS', '2026-02-02T00:00:00.000Z');
        insertProvider(db, 'p3', 'gitlab', 'already-lower', '2026-02-03T00:00:00.000Z');
        insertProvider(db, 'p4', 'github', '\tTabbed\n', '2026-02-04T00:00:00.000Z');

        apply043(db);

        const rows = db
            .prepare('SELECT id, container, token_last4 FROM git_providers ORDER BY id')
            .all() as {id: string; container: string; token_last4: string}[];
        expect(rows).toEqual([
            {id: 'p1', container: 'wireless_media', token_last4: 'abcd'},
            {id: 'p2', container: 'acme-ws', token_last4: 'abcd'},
            {id: 'p3', container: 'already-lower', token_last4: 'abcd'},
            {id: 'p4', container: 'tabbed', token_last4: 'abcd'},
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
        // Same NAME under a different family is a different data set — both must survive.
        insertProvider(db, 'p-gl', 'gitlab', 'Wireless_Media', '2026-05-02T00:00:00.000Z');

        apply043(db);

        const rows = db
            .prepare('SELECT id, type, container FROM git_providers ORDER BY type, container')
            .all() as {id: string; type: string; container: string}[];
        expect(rows).toEqual([
            {id: 'p-other', type: 'github', container: 'other-org'},
            {id: 'p-old', type: 'github', container: 'wireless_media'},
            {id: 'p-gl', type: 'gitlab', container: 'wireless_media'},
        ]);
        // And the constraint the dedupe exists to protect is still enforceable.
        expect(() =>
            insertProvider(db, 'p-dup', 'github', 'wireless_media', '2026-06-01T00:00:00.000Z'),
        ).toThrow(/UNIQUE/);
        db.close();
    });

    it('breaks a created_at tie on id, deterministically', () => {
        const db = dbAt042();
        const tie = '2026-02-01T00:00:00.000Z';
        insertProvider(db, 'p-b', 'github', 'WIRELESS_MEDIA', tie);
        insertProvider(db, 'p-a', 'github', 'Wireless_Media', tie);

        apply043(db);

        expect(
            db.prepare('SELECT id, container FROM git_providers').all(),
        ).toEqual([{id: 'p-a', container: 'wireless_media'}]);
        db.close();
    });

    it('resets the container-keyed data AND its cursors together, unconditionally', () => {
        const db = dbAt042();
        seedDeveloper(db);
        // Deliberately ALL-NORMALIZED: the reset must not depend on detecting a mis-cased
        // value. A conditional probe in SQL is strictly weaker than the code's rule, so it
        // would miss exactly the invisible rows that matter and leave their cursors behind.
        insertProvider(db, 'p1', 'github', 'wireless_media', '2026-02-01T00:00:00.000Z');
        insertRawAuthorDay(db, 'wireless_media', '2026-07-01');
        insertRawAuthorDay(db, 'wireless_media', '2026-07-02');
        insertPrRecord(db, 'wireless_media', '1');
        insertSnapshot(db, '2026-07-01', 1);
        insertCursors(db, 'wireless_media');
        // An unrelated sync_state row must survive — the reset is scoped to git_* cursors.
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run('copilot_last_sync', 'x');

        apply043(db);

        expect(count(db, 'raw_author_daily')).toBe(0);
        expect(count(db, 'pr_records')).toBe(0);
        expect(count(db, 'git_snapshots')).toBe(0);
        // Cursors go WITH the data — never one without the other (the #262 rule).
        expect(gitCursorCount(db)).toBe(0);
        expect(
            db.prepare("SELECT value FROM sync_state WHERE key = 'copilot_last_sync'").get(),
        ).toEqual({value: 'x'});
        // The provider row itself survives — but its sync display columns are cleared, so the
        // admin list cannot read "synced 2 hours ago · ok" over zero rows.
        expect(
            db
                .prepare(
                    'SELECT container, last_sync_at, last_sync_status, last_sync_error FROM git_providers WHERE id = ?',
                )
                .get('p1'),
        ).toEqual({
            container: 'wireless_media',
            last_sync_at: null,
            last_sync_status: null,
            last_sync_error: null,
        });
        db.close();
    });

    it('resets a mis-cased container held ONLY in raw_author_daily / pr_records (a config-file provider)', () => {
        // A config-file provider has no `git_providers` row at all, so the only trace of its
        // mis-cased container is the imported rows. Those rows must go: post-#266 every sync
        // writes under the normalized spelling, and `git_snapshots` would project the sum of
        // both — the permanent double-count #266 exists to remove.
        const db = dbAt042();
        seedDeveloper(db);
        insertRawAuthorDay(db, 'Config_Group', '2026-07-01');
        insertPrRecord(db, 'Config_Group', '1');
        insertSnapshot(db, '2026-07-01', 1);
        insertCursors(db, 'Config_Group');

        apply043(db);

        expect(count(db, 'raw_author_daily')).toBe(0);
        expect(count(db, 'pr_records')).toBe(0);
        expect(count(db, 'git_snapshots')).toBe(0);
        expect(gitCursorCount(db)).toBe(0);
        db.close();
    });

    it('DELETES a provider row whose container SQL cannot canonicalize (non-ASCII), rather than storing an unresolvable value', () => {
        const db = dbAt042();
        // NBSP — the single most plausible invisible paste, and one SQLite's ASCII-only
        // `lower()`/`trim()` cannot strip. Re-spelling it in SQL would store a container no
        // write path can ever produce, so the delete cascade keyed on `record.container` would
        // retract nothing and report success. Fail closed: the connection must be re-added.
        insertProvider(db, 'p-nbsp', 'github', 'acme ', '2026-02-01T00:00:00.000Z');
        insertProvider(db, 'p-upper-nonascii', 'github', 'ÄCME', '2026-02-02T00:00:00.000Z');
        insertProvider(db, 'p-blank', 'gitlab', '   ', '2026-02-03T00:00:00.000Z');
        insertProvider(db, 'p-ok', 'github', 'Fine-Org', '2026-02-04T00:00:00.000Z');

        apply043(db);

        expect(db.prepare('SELECT id, container FROM git_providers').all()).toEqual([
            {id: 'p-ok', container: 'fine-org'},
        ]);
        db.close();
    });

    it('the expression the equivalence test exercises is the one the migration actually uses', () => {
        // Without this, the equivalence test below could keep passing against a stale
        // restatement while the migration's own charlist drifted.
        expect(migration043Source()).toContain(`lower(trim(container, ${SQL_TRIM_CHARS}))`);
    });

    it("the migration's SQL normalization equals normalizeContainer for every ASCII spelling", () => {
        // This is the property the in-place UPDATE rests on: it only normalizes ASCII-only
        // containers precisely because SQL and JS are provably identical there. Pinning it here
        // means a future edit to either side that breaks the equivalence fails loudly instead of
        // silently storing a container the code cannot resolve.
        const db = dbAt042();
        const sqlNorm = db.prepare(`SELECT ${SQL_NORMALIZE} AS v`);
        const spellings = [
            'wireless_media',
            'Wireless_Media',
            'WIRELESS_MEDIA',
            'Wireless_Media ',
            '  wireless_media',
            '\tTabbed\n',
            '\r\nacme',
            'a b',
            ' a b ',
            'Org.With-Dots_And/Slashes',
            'MiXeD123',
            '   ',
            '',
        ];
        for (const raw of spellings) {
            const viaSql = (sqlNorm.get(raw) as {v: string}).v;
            expect(viaSql, `SQL vs JS for ${JSON.stringify(raw)}`).toBe(normalizeContainer(raw));
        }
        // …and the ASCII-only predicate the UPDATE uses actually excludes non-ASCII, which is
        // where the two rules are allowed to differ.
        const asciiOnly = db.prepare(
            'SELECT length(?) = length(CAST(? AS BLOB)) AS ascii_only',
        );
        for (const raw of spellings) {
            expect((asciiOnly.get(raw, raw) as {ascii_only: number}).ascii_only, raw).toBe(1);
        }
        for (const raw of ['acme ', 'ÄCME', 'acme﻿']) {
            expect((asciiOnly.get(raw, raw) as {ascii_only: number}).ascii_only, raw).toBe(0);
        }
        db.close();
    });

    it('leaves a legacy (is_projected = 0) snapshot cell alone — only 042 was licensed to drop those', () => {
        const db = dbAt042();
        seedDeveloper(db);
        insertSnapshot(db, '2026-07-01', 1);
        insertSnapshot(db, '2026-07-02', 0);

        apply043(db);

        expect(db.prepare('SELECT date, is_projected FROM git_snapshots').all()).toEqual([
            {date: '2026-07-02', is_projected: 0},
        ]);
        db.close();
    });

    it('leaves the operator signal behind when data was actually reset', () => {
        // The one durable place a pure-SQL migration can say "you owe a resync + an aggregate
        // backfill" — `toprope doctor` reads it and fails until it is acknowledged. A resync
        // alone does not rebuild the derived rollups, so nothing can clear it automatically.
        const db = dbAt042();
        seedDeveloper(db);
        insertRawAuthorDay(db, 'wireless_media', '2026-07-01');
        apply043(db);
        expect(gitResetNotice(db)).toBe('043');
        db.close();
    });

    it('raises the signal for a cursor-only install (data gone, cursor left) too', () => {
        // The cursor is what licenses the additive merge, so an install holding one has state to
        // rebuild even with no rows behind it.
        const db = dbAt042();
        insertCursors(db, 'wireless_media');
        apply043(db);
        expect(gitResetNotice(db)).toBe('043');
        db.close();
    });

    it('does NOT tell a fresh install to rebuild data it never had', () => {
        const db = dbAt042();
        apply043(db);
        expect(gitResetNotice(db)).toBeNull();
        expect(count(db, 'git_providers')).toBe(0);
        expect(count(db, 'raw_author_daily')).toBe(0);
        expect(gitCursorCount(db)).toBe(0);
        // Re-running the runner must not re-execute it.
        expect(runMigrations(db, MIGRATIONS_DIR)).toBe(0);
        db.close();
    });

    it('does not raise the signal when the only snapshot cells are LEGACY (nothing was retracted)', () => {
        // A legacy cell is outside the projection's bound, so this migration removes nothing —
        // claiming a rebuild is owed would be a false positive on an install it did not touch.
        const db = dbAt042();
        seedDeveloper(db);
        insertSnapshot(db, '2026-07-02', 0);
        apply043(db);
        expect(gitResetNotice(db)).toBeNull();
        expect(count(db, 'git_snapshots')).toBe(1);
        db.close();
    });
});
