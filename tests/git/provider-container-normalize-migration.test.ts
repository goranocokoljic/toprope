import {describe, it, expect} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
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
 * to EVERY occurrence in the migration file, so an edit to either side cannot silently drift.
 *
 * The set is the full one JS `String.prototype.trim` removes: ASCII controls + space, every
 * Unicode Zs, the two line separators, and U+FEFF.
 */
const SQL_TRIM_CHARS =
    'char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)';
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

/** A database migrated to exactly `maxId` — an existing install at that point in history. */
function dbAt(maxId: number): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(
        'CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    for (const f of migrationFilesUpTo(maxId)) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8'));
        db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
            parseInt(f.slice(0, 3), 10),
            f,
            '2026-07-01T00:00:00.000Z',
        );
    }
    return db;
}

/** A database migrated to 042 exactly — an existing install right before #266. */
function dbAt042(): Database.Database {
    return dbAt(42);
}

/**
 * Apply 043 (and nothing after it) through the real runner. `runMigrations` wraps each file in
 * `db.transaction(...)`, so this also proves 043 applies cleanly under the runner against a
 * POPULATED database and is recorded exactly once.
 *
 * `runMigrations` is given a directory containing only the files up to 43, rather than the whole
 * chain: asserting "the runner applied exactly 1" would pin this entire file to 043 being the
 * newest migration, and once 044 lands its effects would silently fold into every assertion here.
 */
function apply043(db: Database.Database): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toprope-m043-'));
    try {
        for (const f of migrationFilesUpTo(43)) {
            fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
        }
        expect(runMigrations(db, dir)).toBe(1);
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
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

/**
 * `lastSyncAt` defaults to a synced timestamp (the common case), but several tests need it NULL:
 * `last_sync_at IS NOT NULL` is one of the notice's probe arms, so a helper that always set it
 * would mask every OTHER arm — including the `changes()` arm that exists precisely for a
 * never-synced duplicate on an install holding no git data at all.
 */
function insertProvider(
    db: Database.Database,
    id: string,
    type: string,
    container: string,
    createdAt: string,
    lastSyncAt: string | null = '2026-07-20T00:00:00.000Z',
): void {
    db.prepare(
        `INSERT INTO git_providers (
            id, type, container, url, include_subgroups, auth_method, auth_username,
            token_ciphertext, token_meta, token_last4, repos_include, repos_exclude,
            enabled, created_at, updated_at, created_by, last_sync_at, last_sync_status, last_sync_error
         ) VALUES (?, ?, ?, NULL, NULL, 'token', NULL, ?, '{}', 'abcd', NULL, NULL, 1, ?, ?, NULL,
                   ?, CASE WHEN ? IS NULL THEN NULL ELSE 'ok' END, NULL)`,
    ).run(id, type, container, Buffer.from('cipher'), createdAt, createdAt, lastSyncAt, lastSyncAt);
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

    it('re-spells a container padded with NON-ASCII whitespace rather than deleting the connection', () => {
        // NBSP / U+FEFF / the ideographic space are the likeliest invisible pastes, and JS
        // `.trim()` strips all of them — so the charlist must too. Deleting these rows would cost
        // the admin their encrypted credential for a spelling that IS canonicalizable.
        const db = dbAt042();
        insertProvider(db, 'p-nbsp', 'github', 'Acme ', '2026-02-01T00:00:00.000Z');
        insertProvider(db, 'p-bom', 'bitbucket', '﻿Acme-WS', '2026-02-02T00:00:00.000Z');
        insertProvider(db, 'p-ideo', 'gitlab', '　ACME　', '2026-02-03T00:00:00.000Z');

        apply043(db);

        expect(db.prepare('SELECT id, container FROM git_providers ORDER BY id').all()).toEqual([
            {id: 'p-bom', container: 'acme-ws'},
            {id: 'p-ideo', container: 'acme'},
            {id: 'p-nbsp', container: 'acme'},
        ]);
        db.close();
    });

    it('DELETES a provider row whose container is non-ASCII CONTENT or blank, rather than guessing', () => {
        // Non-ASCII content is the one case SQLite cannot casefold the way JS does. Storing a
        // guessed spelling would produce a container no write path can ever emit, so the delete
        // cascade keyed on `record.container` would retract nothing and report success — a
        // permanent ghost. Fail closed: the connection must be re-added.
        const db = dbAt042();
        // `last_sync_at: null` on every row, so `changes() > 0` is the ONLY notice arm that can
        // fire — this install holds no data, no cursors, no rollups and no synced provider.
        insertProvider(db, 'p-upper-nonascii', 'github', 'ÄCME', '2026-02-02T00:00:00.000Z', null);
        insertProvider(db, 'p-accent', 'bitbucket', 'ACMÉ', '2026-02-03T00:00:00.000Z', null);
        insertProvider(db, 'p-blank', 'gitlab', '   ', '2026-02-04T00:00:00.000Z', null);
        insertProvider(db, 'p-ok', 'github', 'Fine-Org', '2026-02-05T00:00:00.000Z', null);

        apply043(db);

        expect(db.prepare('SELECT id, container FROM git_providers').all()).toEqual([
            {id: 'p-ok', container: 'fine-org'},
        ]);
        // A deleted connection is never silent: the encrypted credential cannot be recovered, so
        // the operator has to be told to go looking for the missing provider. Every other notice
        // arm is provably false here (no raw rows, no PRs, no projected snapshots, no cursors, no
        // synced provider, no rollups), so `changes() > 0` is the ONLY arm that can have raised it.
        expect(gitResetNotice(db)).toBe('043');
        db.close();
    });

    it('the expression the equivalence test exercises is the one the migration actually uses', () => {
        // Without this, the equivalence test below could keep passing against a stale
        // restatement while the migration's own charlist drifted. SQL has no way to name the
        // charlist once, so EVERY occurrence is pinned — the dedupe DELETE and the fail-closed
        // DELETE spell it too, and a drift in either would be caught only indirectly otherwise.
        const source = migration043Source();
        expect(source).toContain(`lower(trim(container, ${SQL_TRIM_CHARS}))`);
        expect(source).toContain(`lower(trim(o.container, ${SQL_TRIM_CHARS}))`);
        expect(source).toContain(`trim(container, ${SQL_TRIM_CHARS})`);
        // Every `trim(` in EXECUTABLE SQL uses the shared charlist — no occurrence was missed
        // (comment lines are dropped: the prose discusses SQLite's bare `trim(X)` on purpose).
        const sql = source
            .split('\n')
            .filter((line) => !line.trimStart().startsWith('--'))
            .join('\n');
        expect((sql.match(/trim\(/g) ?? []).length).toBeGreaterThan(0);
        expect((sql.match(/trim\(/g) ?? []).length).toBe(
            (sql.match(new RegExp(SQL_TRIM_CHARS.replace(/[()]/g, '\\$&'), 'g')) ?? []).length,
        );
    });

    it("the migration's SQL normalization equals normalizeContainer, whitespace set included", () => {
        // This is the property the in-place UPDATE rests on. Pinning it means a future edit to
        // either side that breaks the equivalence fails loudly instead of silently storing a
        // container the code cannot resolve.
        const db = dbAt042();
        const sqlNorm = db.prepare(`SELECT ${SQL_NORMALIZE} AS v`);
        const spellings = [
            'wireless_media',
            'Wireless_Media',
            'WIRELESS_MEDIA',
            'Wireless_Media ',
            '  wireless_media',
            '\tTabbed\n',
            '\r\nacme',
            'a b',
            ' a b ',
            'Org.With-Dots_And/Slashes',
            'MiXeD123',
            '   ',
            '',
            // The NON-ASCII whitespace JS `.trim()` also strips: NBSP (U+00A0), U+FEFF, the
            // ideographic space (U+3000), EM SPACE (U+2003) and the line separator U+2028. The
            // charlist covers all of them, so the equivalence must hold here too — a container
            // padded with an invisible pasted out of a rendered page gets re-spelled, not
            // mistaken for un-normalizable and deleted.
            'Acme ',
            ' Acme ',
            'Acme﻿',
            '　ACME',
            ' acme ',
            ' acme',
            ' 　﻿',
        ];
        for (const raw of spellings) {
            const viaSql = (sqlNorm.get(raw) as {v: string}).v;
            expect(viaSql, `SQL vs JS for ${JSON.stringify(raw)}`).toBe(normalizeContainer(raw));
        }
        // U+200B ZWSP is deliberately NOT in the set, because JS does not strip it either — it is
        // part of the container's name under both rules. Asserted so a future "add every invisible
        // character" edit has to justify itself against the JS rule rather than drift past it.
        expect(normalizeContainer('a​b')).toBe('a​b');
        expect((sqlNorm.get('a​b') as {v: string}).v).toBe(normalizeContainer('a​b'));

        // The ASCII-AFTER-TRIM predicate the fail-closed DELETE keys on: 1 when the trimmed value
        // is pure ASCII (where SQLite `lower()` == JS `toLowerCase()`), 0 otherwise.
        const asciiAfterTrim = db.prepare(
            `SELECT length(trim(?, ${SQL_TRIM_CHARS})) = length(CAST(trim(?, ${SQL_TRIM_CHARS}) AS BLOB)) AS ok`,
        );
        for (const raw of spellings) {
            expect((asciiAfterTrim.get(raw, raw) as {ok: number}).ok, raw).toBe(1);
        }
        // Non-ASCII CONTENT is the one place SQL cannot casefold like JS, so it must FAIL the
        // predicate and land in the fail-closed DELETE rather than be re-spelled by guesswork.
        for (const raw of ['ÄCME', 'ACMÉ', 'ＡＣＭＥ']) {
            expect((asciiAfterTrim.get(raw, raw) as {ok: number}).ok, raw).toBe(0);
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
        // Re-running 043 must not re-execute it — the ledger is what makes a destructive migration
        // safe to leave in the chain. (`runMigrations`' idempotence in general is covered in
        // tests/storage/db.test.ts; what matters here is that 043 specifically is recorded.)
        expect(
            (
                db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE id = 43').get() as {
                    n: number;
                }
            ).n,
        ).toBe(1);
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

    it('leaves the DERIVED rollups untouched — which is exactly why the notice exists', () => {
        // The notice's whole second half ("the rollups were NOT reset, so /api/aggregates still
        // serves pre-reset totals; run aggregate backfill") is a claim about these tables. If a
        // future edit also cleared them, the notice would be describing a state that no longer
        // exists and `aggregate backfill` would stop being the right remedy — asserted rather
        // than left as prose in three files.
        const db = dbAt042();
        seedDeveloper(db);
        insertRawAuthorDay(db, 'wireless_media', '2026-07-01');
        db.prepare(
            `INSERT INTO weekly_aggregates (id, developer_id, week_start, team, total_commits, computed_at)
             VALUES ('wa-1', 'dev-1', '2026-06-29', 'core', 40, '2026-07-06T00:00:00.000Z')`,
        ).run();

        apply043(db);

        expect(count(db, 'raw_author_daily')).toBe(0);
        expect(
            db.prepare('SELECT total_commits FROM weekly_aggregates WHERE id = ?').get('wa-1'),
        ).toEqual({total_commits: 40});
        expect(gitResetNotice(db)).toBe('043');
        db.close();
    });

    /**
     * The upgrade path with the MOST to lose: an install that has not yet taken #264. Migration
     * 042 empties `raw_author_daily`, `pr_records`, `git_snapshots` and the `git_*` cursors — in
     * the SAME `runMigrations` pass, immediately before 043 — and leaves no marker of its own. A
     * notice predicate built only from those four tables therefore sees an empty database and
     * reports "nothing to rebuild" for an install whose rollups still hold months of pre-reset
     * totals, which `doctor` would then print as a green currency claim.
     */
    it('raises the signal on the pre-042 upgrade chain, where 042 has already emptied the evidence', () => {
        const db = dbAt(41);
        seedDeveloper(db);
        // Pre-042 shapes: `raw_author_daily` had no container column, and a synced provider's
        // `last_sync_at` is set. 042 will drop the table and clear the cursors.
        db.prepare(
            `INSERT INTO raw_author_daily (
                id, provider, raw_author_key, author_login, author_email, author_display_name,
                date, commits, lines_added, lines_removed, files_changed, prs_opened, prs_merged,
                review_comments_given, avg_time_to_merge_hours, code_churn_rate,
                ai_signature_score, avg_commit_size, commit_burst_count, first_seen, last_seen
             ) VALUES ('r1', 'github', 'github:login:alice', 'alice', 'a@x.dev', NULL,
                       '2026-07-01', 3, 30, 3, 2, 0, 0, 0, NULL, 0, 0, 10, 0,
                       '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z')`,
        ).run();
        insertProvider(db, 'p1', 'github', 'Wireless_Media', '2026-02-01T00:00:00.000Z');
        insertCursors(db, 'Wireless_Media');
        db.prepare(
            `INSERT INTO weekly_aggregates (id, developer_id, week_start, team, total_commits, computed_at)
             VALUES ('wa-1', 'dev-1', '2026-06-29', 'core', 40, '2026-07-06T00:00:00.000Z')`,
        ).run();

        // Both 042 and 043 apply in one pass, exactly as a real upgrade would. The full chain is
        // used deliberately here (this test IS about the two migrations interacting), and the
        // count is not asserted so a future 044 does not break it.
        runMigrations(db, MIGRATIONS_DIR);

        expect(count(db, 'raw_author_daily')).toBe(0);
        expect(gitCursorCount(db)).toBe(0);
        // The stale rollup that makes the notice necessary is still there…
        expect(count(db, 'weekly_aggregates')).toBe(1);
        // …and the notice fired, so `toprope doctor` will not report a green currency claim.
        expect(gitResetNotice(db)).toBe('043');
        expect(
            db.prepare('SELECT container, last_sync_at FROM git_providers WHERE id = ?').get('p1'),
        ).toEqual({container: 'wireless_media', last_sync_at: null});
        db.close();
    });

    it('raises the signal when a SYNCED provider is the only evidence left (sole-raiser)', () => {
        // `git_providers.last_sync_at` is one of the two probe arms 042 does not touch, and it is
        // the one that covers a DB-connected provider whose data 042 already emptied. Every other
        // arm is false here, so removing this probe from the migration would make the test fail.
        const db = dbAt042();
        insertProvider(db, 'p1', 'github', 'wireless_media', '2026-02-01T00:00:00.000Z');
        apply043(db);
        expect(gitResetNotice(db)).toBe('043');
        db.close();
    });

    it('raises the signal for a CONFIG-FILE-only install where a stale rollup is the last evidence (sole-raiser)', () => {
        // The pre-042 case with no `git_providers` row at all: a config-file provider has none, so
        // after 042 empties the raw tables and the cursors, `weekly_aggregates.total_commits` is
        // the only surviving proof that git data was ever imported and rolled up. Removing that
        // probe would make this test fail.
        const db = dbAt042();
        seedDeveloper(db);
        db.prepare(
            `INSERT INTO weekly_aggregates (id, developer_id, week_start, team, total_commits, computed_at)
             VALUES ('wa-1', 'dev-1', '2026-06-29', 'core', 40, '2026-07-06T00:00:00.000Z')`,
        ).run();
        expect(count(db, 'git_providers')).toBe(0);
        apply043(db);
        expect(gitResetNotice(db)).toBe('043');
        db.close();
    });

    it('raises the signal when a DUPLICATE spelling is deduped away, even with no git data at all', () => {
        // The state #266 exists for — one workspace connected twice, never synced (the admin is
        // prompted to narrow repo scope BEFORE the first sync, #211). The dedupe removes the newer
        // row along with its unrecoverable token and its own repo-scope filter, so that must not be
        // a silent outcome. Only `changes() > 0` can raise it here.
        const db = dbAt042();
        insertProvider(db, 'p-old', 'github', 'Wireless_Media', '2026-02-01T00:00:00.000Z', null);
        insertProvider(db, 'p-new', 'github', 'wireless_media', '2026-03-01T00:00:00.000Z', null);

        apply043(db);

        expect(db.prepare('SELECT id, container FROM git_providers').all()).toEqual([
            {id: 'p-old', container: 'wireless_media'},
        ]);
        expect(gitResetNotice(db)).toBe('043');
        db.close();
    });

    it('keeps a CANONICAL row when its only older sibling is one the same statement deletes', () => {
        // The dedupe's sibling qualifier: an older row that fails the canonicalization clause is
        // being deleted in the same breath, so it must not also win the dedupe — otherwise both
        // rows go and the container is freed entirely, silently un-connecting the workspace.
        const db = dbAt042();
        insertProvider(db, 'p-old-bad', 'github', 'ÄCME', '2026-02-01T00:00:00.000Z', null);
        insertProvider(db, 'p-new-good', 'github', 'acme', '2026-03-01T00:00:00.000Z', null);

        apply043(db);

        expect(db.prepare('SELECT id, container FROM git_providers').all()).toEqual([
            {id: 'p-new-good', container: 'acme'},
        ]);
        db.close();
    });

    it('a tool-only install (rollup rows but no git commits) is not told to rebuild git data', () => {
        // `weekly_aggregates` is not git-specific — a Copilot-only install has rows here. Probing
        // its existence rather than `total_commits > 0` would raise a false positive on every
        // install that has ever aggregated anything.
        const db = dbAt042();
        seedDeveloper(db);
        db.prepare(
            `INSERT INTO weekly_aggregates (id, developer_id, week_start, team, total_commits, computed_at)
             VALUES ('wa-0', 'dev-1', '2026-06-29', 'core', 0, '2026-07-06T00:00:00.000Z')`,
        ).run();
        apply043(db);
        expect(gitResetNotice(db)).toBeNull();
        db.close();
    });
});
