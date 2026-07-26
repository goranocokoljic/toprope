import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import {runMigrations} from '../../src/storage/migrator';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

function tableExists(db: Database.Database, name: string): boolean {
    const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name) as {name: string} | undefined;
    return row !== undefined;
}

function indexExists(db: Database.Database, name: string): boolean {
    const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(name) as {name: string} | undefined;
    return row !== undefined;
}

function columnNames(db: Database.Database, table: string): string[] {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as {name: string}[];
    return rows.map((r) => r.name);
}

// A complete raw_author_daily row (every NOT NULL column present) for insert tests.
function insertRaw(db: Database.Database, overrides: Record<string, unknown> = {}): void {
    const row = {
        id: 'r1',
        provider: 'github',
        container: 'acme',
        raw_author_key: 'github:login:alice',
        author_login: 'alice',
        author_email: 'alice@example.com',
        author_display_name: 'Alice A',
        date: '2026-07-01',
        commits: 3,
        lines_added: 100,
        lines_removed: 20,
        files_changed: 7,
        prs_opened: 1,
        prs_merged: 1,
        review_comments_given: 2,
        avg_time_to_merge_hours: 4.5,
        code_churn_rate: 0.2,
        ai_signature_score: 0.6,
        avg_commit_size: 40,
        commit_burst_count: 1,
        first_seen: '2026-07-01T00:00:00.000Z',
        last_seen: '2026-07-01T00:00:00.000Z',
        ...overrides,
    };
    db.prepare(
        `INSERT INTO raw_author_daily
         (id, provider, container, raw_author_key, author_login, author_email, author_display_name,
          date, commits, lines_added, lines_removed, files_changed, prs_opened, prs_merged,
          review_comments_given, avg_time_to_merge_hours, code_churn_rate, ai_signature_score,
          avg_commit_size, commit_burst_count, first_seen, last_seen)
         VALUES
         (@id, @provider, @container, @raw_author_key, @author_login, @author_email, @author_display_name,
          @date, @commits, @lines_added, @lines_removed, @files_changed, @prs_opened, @prs_merged,
          @review_comments_given, @avg_time_to_merge_hours, @code_churn_rate, @ai_signature_score,
          @avg_commit_size, @commit_burst_count, @first_seen, @last_seen)`,
    ).run(row);
}

describe('raw_author_daily schema (040 / #252, widened by 042 / #264)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db, MIGRATIONS_DIR);
    });

    afterEach(() => {
        db.close();
    });

    it('creates the raw_author_daily table', () => {
        expect(tableExists(db, 'raw_author_daily')).toBe(true);
    });

    it('creates every documented index, incl. the container scan the delete cascade uses', () => {
        expect(indexExists(db, 'idx_raw_author_daily_key')).toBe(true);
        expect(indexExists(db, 'idx_raw_author_daily_date')).toBe(true);
        expect(indexExists(db, 'idx_raw_author_daily_container')).toBe(true);
    });

    it('has exactly the specified columns', () => {
        expect(columnNames(db, 'raw_author_daily').sort()).toEqual(
            [
                'id', 'provider', 'container', 'raw_author_key', 'author_login', 'author_email',
                'author_display_name', 'date', 'commits', 'lines_added', 'lines_removed',
                'files_changed', 'prs_opened', 'prs_merged', 'review_comments_given',
                'avg_time_to_merge_hours', 'code_churn_rate', 'ai_signature_score',
                'avg_commit_size', 'commit_burst_count', 'first_seen', 'last_seen',
            ].sort(),
        );
    });

    it('round-trips a hand-inserted row verbatim', () => {
        insertRaw(db);
        const back = db.prepare('SELECT * FROM raw_author_daily WHERE id = ?').get('r1') as Record<string, unknown>;
        expect(back.provider).toBe('github');
        expect(back.raw_author_key).toBe('github:login:alice');
        expect(back.author_email).toBe('alice@example.com');
        expect(back.date).toBe('2026-07-01');
        expect(back.commits).toBe(3);
        expect(back.avg_time_to_merge_hours).toBe(4.5);
        expect(back.ai_signature_score).toBeCloseTo(0.6);
        expect(back.first_seen).toBe('2026-07-01T00:00:00.000Z');
    });

    it('accepts a NULL avg_time_to_merge_hours (nothing merged that day)', () => {
        expect(() => insertRaw(db, {avg_time_to_merge_hours: null})).not.toThrow();
    });

    it('accepts NULL login/email/display (a partially-known raw identity)', () => {
        expect(() =>
            insertRaw(db, {author_login: null, author_email: null, author_display_name: null}),
        ).not.toThrow();
    });

    it('enforces UNIQUE(provider, container, raw_author_key, date)', () => {
        insertRaw(db);
        expect(() => insertRaw(db, {id: 'r2'})).toThrow(/UNIQUE/i);
    });

    // The whole point of #264: two workspaces of one family are two INDEPENDENT
    // contributions to the same author-day, not one row to be merged.
    it('allows the same key/date under a DIFFERENT container (independent attribution)', () => {
        insertRaw(db);
        expect(() => insertRaw(db, {id: 'r2', container: 'other-ws'})).not.toThrow();
        expect(
            (db.prepare('SELECT COUNT(*) AS n FROM raw_author_daily').get() as {n: number}).n,
        ).toBe(2);
    });

    it('rejects a blank container (CHECK) — no un-attributable bucket', () => {
        expect(() => insertRaw(db, {id: 'bad', container: ''})).toThrow();
    });

    it('rejects a NULL container (NOT NULL)', () => {
        expect(() => insertRaw(db, {id: 'bad', container: null})).toThrow();
    });

    it('allows the same key on a DIFFERENT date, and a different key on the same date', () => {
        insertRaw(db);
        expect(() => insertRaw(db, {id: 'r2', date: '2026-07-02'})).not.toThrow();
        expect(() => insertRaw(db, {id: 'r3', raw_author_key: 'github:login:bob'})).not.toThrow();
    });

    it('allows the same raw_author_key under a DIFFERENT provider on the same date', () => {
        insertRaw(db);
        expect(() => insertRaw(db, {id: 'r2', provider: 'gitlab'})).not.toThrow();
    });

    it('rejects an unknown provider (CHECK)', () => {
        expect(() => insertRaw(db, {id: 'bad', provider: 'perforce'})).toThrow();
    });

    it('accepts every valid provider', () => {
        ['github', 'bitbucket', 'gitlab'].forEach((p, i) => {
            expect(() => insertRaw(db, {id: `p-${i}`, provider: p})).not.toThrow();
        });
    });

    it('rejects a blank raw_author_key (CHECK) — no anonymous "" bucket', () => {
        expect(() => insertRaw(db, {id: 'bad', raw_author_key: ''})).toThrow();
    });

    it('rejects a malformed date (CHECK pins the UTC YYYY-MM-DD shape)', () => {
        expect(() => insertRaw(db, {id: 'bad', date: '2026-7-1'})).toThrow();
        expect(() => insertRaw(db, {id: 'bad2', date: '2026-07-01T00:00:00Z'})).toThrow();
    });

    it('rejects negative counters (CHECK)', () => {
        expect(() => insertRaw(db, {id: 'bad', commits: -1})).toThrow();
        expect(() => insertRaw(db, {id: 'bad2', prs_merged: -1})).toThrow();
        expect(() => insertRaw(db, {id: 'bad3', commit_burst_count: -1})).toThrow();
    });

    it('is idempotent — re-running the migrations is a no-op and the table survives', () => {
        expect(runMigrations(db, MIGRATIONS_DIR)).toBe(0);
        expect(tableExists(db, 'raw_author_daily')).toBe(true);
    });

    it('re-executing the raw 040 SQL directly does not error (IF NOT EXISTS)', () => {
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '040_raw_author_daily.sql'), 'utf-8');
        expect(() => db.exec(sql)).not.toThrow();
    });

    it('applies FORWARD onto a DB already migrated to 039 (no full rebuild)', () => {
        const fresh = new Database(':memory:');
        try {
            // Apply everything up to 039 only, exactly as an existing install would sit.
            const upTo039 = fs
                .readdirSync(MIGRATIONS_DIR)
                .filter((f) => /^\d{3}_.*\.sql$/.test(f) && parseInt(f.slice(0, 3), 10) <= 39)
                .sort();
            fresh.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
            for (const f of upTo039) {
                fresh.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8'));
                fresh
                    .prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')
                    .run(parseInt(f.slice(0, 3), 10), f, '2026-07-01T00:00:00.000Z');
            }
            expect(tableExists(fresh, 'raw_author_daily')).toBe(false);

            // Only the not-yet-applied migrations run — 040 among them. Asserted as
            // "040 is now in the ledger" rather than as a literal count, so adding a
            // later migration (041 did) does not fail this forward-apply test.
            const appliedNow = runMigrations(fresh, MIGRATIONS_DIR);
            expect(appliedNow).toBeGreaterThanOrEqual(1);
            expect(
                fresh.prepare('SELECT name FROM schema_migrations WHERE id = 40').get(),
            ).toEqual({name: '040_raw_author_daily.sql'});
            expect(tableExists(fresh, 'raw_author_daily')).toBe(true);
            expect(indexExists(fresh, 'idx_raw_author_daily_key')).toBe(true);
            insertRaw(fresh);
            expect(
                (fresh.prepare('SELECT commits FROM raw_author_daily WHERE id = ?').get('r1') as {commits: number})
                    .commits,
            ).toBe(3);
        } finally {
            fresh.close();
        }
    });
});
