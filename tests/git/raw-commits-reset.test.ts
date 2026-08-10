/**
 * #317 (IG1.1, epic #316) — migration 046's RESET half.
 *
 * The table half is covered by `raw-commits-migration.test.ts`; this file covers what 046 throws
 * away, what it deliberately keeps, and the operator signal it leaves behind. Every case runs the
 * migration FORWARD onto a database already migrated to 045 and seeded with git data — the shape
 * of a real upgrade — because that is the only state in which the reset does anything at all.
 *
 * The locked decisions under test (deviating from any of them is design drift, not a refactor):
 *   - `pr_records` is NOT cleared: it is state-keyed and replace-idempotent, so a resync
 *     re-upserts it. Clearing it would be scope creep.
 *   - `git_stall:*` / `git_row_refusal:*` are NOT cleared: per-run health verdicts, self-healing
 *     on the resync the notice already mandates.
 *   - `git_snapshots` IS cleared unscoped — legacy (`is_projected = 0`) cells included — because
 *     the projection can never retract one, so any survivor would make later delete cascades
 *     silently partial (the 042 argument).
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import {runMigrations} from '../../src/storage/migrator';
import {addTeam} from '../../src/registry/teams';
import {addDeveloper} from '../../src/registry/developers';
import {gitResetNotice, clearGitResetNotice} from '../../src/connectors/git/reset-notice';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

/** Everything strictly before 046, i.e. an existing install on the day this migration ships. */
function migrateTo045(db: Database.Database): void {
    const files = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => /^\d{3}_.*\.sql$/.test(f) && parseInt(f.slice(0, 3), 10) <= 45)
        .sort();
    db.exec(
        'CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    for (const f of files) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8'));
        db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
            parseInt(f.slice(0, 3), 10),
            f,
            '2026-08-01T00:00:00.000Z',
        );
    }
}

function makeDbAt045(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrateTo045(db);
    return db;
}

function seedDeveloper(db: Database.Database): string {
    addTeam(db, 'eng');
    return addDeveloper(db, 'alice', 'eng', 'alice@example.com', 'Alice').id;
}

function seedRawAuthorDaily(db: Database.Database): void {
    db.prepare(
        `INSERT INTO raw_author_daily
         (id, provider, container, raw_author_key, author_login, author_email, author_display_name,
          date, commits, lines_added, lines_removed, files_changed, prs_opened, prs_merged,
          review_comments_given, avg_time_to_merge_hours, code_churn_rate, ai_signature_score,
          avg_commit_size, commit_burst_count, first_seen, last_seen)
         VALUES ('r1', 'github', 'acme', 'github:login:alice', 'alice', 'alice@example.com',
                 'Alice A', '2026-07-01', 3, 100, 20, 7, 1, 1, 2, 4.5, 0.2, 0.6, 40, 1,
                 '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
    ).run();
}

function seedGitSnapshot(db: Database.Database, developerId: string, id: string, isProjected: 0 | 1): void {
    db.prepare(
        `INSERT INTO git_snapshots (id, developer_id, date, commits, lines_added, is_projected)
         VALUES (?, ?, '2026-07-01', 3, 100, ?)`,
    ).run(id, developerId, isProjected);
}

function seedPrRecord(db: Database.Database, developerId: string): void {
    db.prepare(
        `INSERT INTO pr_records
         (id, developer_id, provider, container, repo, pr_id, state, created_at, merged_at,
          closed_at, review_comment_count, review_rounds, changes_requested_count,
          time_to_merge_hours, synced_at)
         VALUES ('p1', ?, 'github', 'acme', 'repo1', '17', 'merged', '2026-07-01T08:00:00.000Z',
                 '2026-07-01T12:00:00.000Z', '2026-07-01T12:00:00.000Z', 2, 1, 0, 4.0,
                 '2026-07-02T00:00:00.000Z')`,
    ).run(developerId);
}

function seedDiffstat(db: Database.Database): void {
    db.prepare(
        `INSERT INTO commit_diffstats
         (provider, container, repo, sha, additions, deletions, absent, entries, fetched_at)
         VALUES ('github', 'acme', 'repo1', 'abc123', 40, 5, 0,
                 '[{"path":"src/foo.ts","additions":40,"deletions":5,"status":"modified"}]',
                 '2026-07-02T00:00:00.000Z')`,
    ).run();
}

function seedSyncStateKeys(db: Database.Database): void {
    const insert = db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)');
    insert.run('git_last_sync:github:acme', '2026-07-02T00:00:00.000Z');
    insert.run('git_earliest_sync:github:acme', '2026-01-01T00:00:00.000Z');
    insert.run('git_stall:github:acme', '{"runs":2,"since":"2026-07-01T00:00:00.000Z"}');
    insert.run('git_row_refusal:github:acme', '{"at":"2026-07-01T00:00:00.000Z","skipped":3,"retained":0,"runs":1}');
    // A non-git cursor: proof the LIKE patterns are scoped and don't take the whole table with them.
    insert.run('copilot_last_sync', '2026-07-02T00:00:00.000Z');
}

function seedGitProvider(db: Database.Database): void {
    db.prepare(
        `INSERT INTO git_providers
         (id, type, container, auth_method, token_ciphertext, token_meta, enabled,
          created_at, updated_at, last_sync_at, last_sync_status, last_sync_error)
         VALUES ('gp1', 'github', 'acme', 'token', X'00', '{}', 1,
                 '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z',
                 '2026-07-02T00:00:00.000Z', 'ok', NULL)`,
    ).run();
}

function seedWeeklyAggregate(db: Database.Database, developerId: string, totalCommits: number): void {
    db.prepare(
        `INSERT INTO weekly_aggregates (id, developer_id, week_start, team, total_commits, computed_at)
         VALUES ('w1', ?, '2026-06-29', 'eng', ?, '2026-07-06T00:00:00.000Z')`,
    ).run(developerId, totalCommits);
}

function count(db: Database.Database, table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n: number}).n;
}

function syncStateKeys(db: Database.Database): string[] {
    return (db.prepare('SELECT key FROM sync_state ORDER BY key').all() as {key: string}[]).map(
        (r) => r.key,
    );
}

describe('migration 046 reset (#317)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDbAt045();
    });

    afterEach(() => {
        db.close();
    });

    it('applies FORWARD onto a database already migrated to 045', () => {
        expect(
            db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='raw_commits'").get(),
        ).toBeUndefined();

        const applied = runMigrations(db, MIGRATIONS_DIR);

        expect(applied).toBeGreaterThanOrEqual(1);
        expect(db.prepare('SELECT name FROM schema_migrations WHERE id = 46').get()).toEqual({
            name: '046_raw_commits.sql',
        });
        expect(
            db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='raw_commits'").get(),
        ).toEqual({name: 'raw_commits'});
    });

    it('clears the additive git data, the diffstat memo and the cursors — and keeps the rest', () => {
        const devId = seedDeveloper(db);
        seedRawAuthorDaily(db);
        seedGitSnapshot(db, devId, 'g-projected', 1);
        seedPrRecord(db, devId);
        seedDiffstat(db);
        seedSyncStateKeys(db);
        seedGitProvider(db);
        seedWeeklyAggregate(db, devId, 12);

        runMigrations(db, MIGRATIONS_DIR);

        // Gone: the output of the additive merge, its projection, and the memo a resync would
        // otherwise replay instead of re-asking (044's reset contract).
        expect(count(db, 'raw_author_daily')).toBe(0);
        expect(count(db, 'git_snapshots')).toBe(0);
        expect(count(db, 'commit_diffstats')).toBe(0);

        // Gone: both cursor namespaces. Kept: the health verdicts and every non-git key.
        expect(syncStateKeys(db)).toEqual([
            'copilot_last_sync',
            'git_data_reset_pending',
            'git_row_refusal:github:acme',
            'git_stall:github:acme',
        ]);

        // KEPT — the locked decision. `pr_records` is state-keyed and replace-idempotent.
        expect(count(db, 'pr_records')).toBe(1);

        // Kept, but no longer claiming currency (#235): the provider row survives with its token,
        // its sync display columns cleared.
        const provider = db
            .prepare('SELECT last_sync_at, last_sync_status, last_sync_error FROM git_providers WHERE id = ?')
            .get('gp1') as Record<string, unknown>;
        expect(provider).toEqual({last_sync_at: null, last_sync_status: null, last_sync_error: null});

        // Untouched — and that is exactly why the notice below has to exist: the rollups still
        // hold pre-reset totals over zero snapshots until `aggregate backfill` runs.
        expect(count(db, 'weekly_aggregates')).toBe(1);
    });

    it('clears a LEGACY (is_projected = 0) git_snapshots cell too — the projection can never retract one', () => {
        const devId = seedDeveloper(db);
        seedGitSnapshot(db, devId, 'g-legacy', 0);

        runMigrations(db, MIGRATIONS_DIR);

        expect(count(db, 'git_snapshots')).toBe(0);
    });

    // ─── the operator signal ────────────────────────────────────────────────────
    it('raises the 046 reset notice when the database held git data', () => {
        seedRawAuthorDaily(db);

        runMigrations(db, MIGRATIONS_DIR);

        expect(gitResetNotice(db)).toBe('046');
    });

    it('raises nothing on a fresh install that never held git data', () => {
        runMigrations(db, MIGRATIONS_DIR);

        expect(gitResetNotice(db)).toBeNull();
    });

    /**
     * The arm that is easy to get wrong, and the reason 043 needed it: on the pre-042 upgrade
     * path every git TABLE is already empty by the time this file runs, while the derived rollups
     * still hold months of pre-reset totals. Probing only the tables this migration empties would
     * report "nothing to rebuild" for exactly the database with the most to lose.
     */
    it('raises the notice from a git-derived ROLLUP alone, with every git table already empty', () => {
        const devId = seedDeveloper(db);
        seedWeeklyAggregate(db, devId, 12);

        runMigrations(db, MIGRATIONS_DIR);

        expect(gitResetNotice(db)).toBe('046');
    });

    it('does NOT raise for a tool-only install whose rollups carry zero commits', () => {
        const devId = seedDeveloper(db);
        seedWeeklyAggregate(db, devId, 0);

        runMigrations(db, MIGRATIONS_DIR);

        expect(gitResetNotice(db)).toBeNull();
    });

    it('raises from a surviving pr_records row, whose day-counters this reset empties', () => {
        const devId = seedDeveloper(db);
        seedPrRecord(db, devId);

        runMigrations(db, MIGRATIONS_DIR);

        expect(gitResetNotice(db)).toBe('046');
    });

    it('raises from a cached diffstat alone — the memo it deletes is evidence of git data', () => {
        seedDiffstat(db);

        runMigrations(db, MIGRATIONS_DIR);

        expect(gitResetNotice(db)).toBe('046');
    });

    /**
     * The key is deliberately migration-agnostic, so 043's marker may already be sitting there.
     * Re-stamping (rather than aborting on the UNIQUE key, which would fail identically at every
     * subsequent server start) is what makes the newest unmet rebuild the one an operator sees —
     * and `clearGitResetNotice` is value-scoped, so acknowledging 043 cannot clear this one.
     */
    it('re-stamps an existing 043 notice to 046 rather than aborting', () => {
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
            'git_data_reset_pending',
            '043',
        );
        seedRawAuthorDaily(db);

        expect(() => runMigrations(db, MIGRATIONS_DIR)).not.toThrow();

        expect(gitResetNotice(db)).toBe('046');
        expect(clearGitResetNotice(db, '043')).toBe(false);
        expect(gitResetNotice(db)).toBe('046');
    });

    it('is acknowledged by clearGitResetNotice("046") — the one existing mechanism', () => {
        seedRawAuthorDaily(db);
        runMigrations(db, MIGRATIONS_DIR);

        expect(clearGitResetNotice(db, '046')).toBe(true);
        expect(gitResetNotice(db)).toBeNull();
    });
});
