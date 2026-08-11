/**
 * #317 (IG1.1, epic #316) — the `raw_commits` schema.
 *
 * Mirrors `raw-author-daily-migration.test.ts` in style, because this table is its replacement
 * source of record: every CHECK the design pins gets a REJECTION test, so a constraint that is
 * quietly dropped or widened fails here rather than surfacing later as a corrupt projection.
 *
 * The table lands EMPTY AND UNREAD in this child (nothing writes it until IG1.2/#318), so these
 * tests hand-insert rows exactly as the future write boundary will — including the
 * `ON CONFLICT DO NOTHING` upsert shape, which is the whole idempotence argument and therefore
 * has to be provably supported by the schema NOW, not asserted later.
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import {runMigrations} from '../../src/storage/migrator';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');
const MIGRATION_FILE = path.join(MIGRATIONS_DIR, '046_raw_commits.sql');
const DESIGN_DOC = path.resolve(__dirname, '../../dev-docs/Idempotent_Git_Ingestion_Design.md');

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

/** Every index SQLite records against the table — the PK of a WITHOUT ROWID table is not one. */
function indexNames(db: Database.Database, table: string): string[] {
    return (
        db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name")
            .all(table) as {name: string}[]
    ).map((r) => r.name);
}

const COMMIT_COLUMNS = [
    'provider', 'container', 'repo', 'sha', 'raw_author_key', 'author_login', 'author_email',
    'author_display_name', 'author_day', 'committed_at', 'lines_added', 'lines_removed',
    'files_changed', 'is_merge', 'ai_signature', 'first_seen',
];

/** A complete `raw_commits` row (every NOT NULL column present) for insert tests. */
function insertCommit(db: Database.Database, overrides: Record<string, unknown> = {}): void {
    const row = {
        provider: 'github',
        container: 'acme',
        repo: 'repo1',
        sha: 'abc123',
        raw_author_key: 'github:login:alice',
        author_login: 'alice',
        author_email: 'alice@example.com',
        author_display_name: 'Alice A',
        author_day: '2026-07-01',
        committed_at: '2026-07-01T10:00:00.000Z',
        lines_added: 100,
        lines_removed: 20,
        files_changed: 7,
        is_merge: 0,
        ai_signature: 1,
        first_seen: '2026-07-02T00:00:00.000Z',
        ...overrides,
    };
    db.prepare(
        `INSERT INTO raw_commits (${COMMIT_COLUMNS.join(', ')})
         VALUES (${COMMIT_COLUMNS.map((c) => `@${c}`).join(', ')})`,
    ).run(row);
}

/** The write shape the design mandates: a re-observed sha is the same fact, so re-insert is a no-op. */
function insertCommitOnConflictDoNothing(
    db: Database.Database,
    overrides: Record<string, unknown> = {},
): number {
    const row = {
        provider: 'github',
        container: 'acme',
        repo: 'repo1',
        sha: 'abc123',
        raw_author_key: 'github:login:alice',
        author_login: 'alice',
        author_email: 'alice@example.com',
        author_display_name: 'Alice A',
        author_day: '2026-07-01',
        committed_at: '2026-07-01T10:00:00.000Z',
        lines_added: 100,
        lines_removed: 20,
        files_changed: 7,
        is_merge: 0,
        ai_signature: 1,
        first_seen: '2026-07-02T00:00:00.000Z',
        ...overrides,
    };
    return db
        .prepare(
            `INSERT INTO raw_commits (${COMMIT_COLUMNS.join(', ')})
             VALUES (${COMMIT_COLUMNS.map((c) => `@${c}`).join(', ')})
             ON CONFLICT (provider, container, repo, sha) DO NOTHING`,
        )
        .run(row).changes;
}

function rowCount(db: Database.Database, table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n: number}).n;
}

/**
 * The canonical CREATE block of a file, whitespace-normalized so the comparison is about the SQL
 * and not about indentation. `IF NOT EXISTS` is stripped: the migration adds it (so re-executing
 * the schema half is safe), the design doc does not spell it, and it changes no constraint.
 */
function canonicalSql(text: string): string {
    return text
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .replace(/\bIF NOT EXISTS\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

describe('raw_commits schema (046 / #317, design §1)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db, MIGRATIONS_DIR);
    });

    afterEach(() => {
        db.close();
    });

    it('creates the raw_commits table', () => {
        expect(tableExists(db, 'raw_commits')).toBe(true);
    });

    it('has exactly the specified columns — no extras', () => {
        expect(columnNames(db, 'raw_commits').sort()).toEqual([...COMMIT_COLUMNS].sort());
    });

    it('is WITHOUT ROWID, so the PK IS the table btree (a single seek per upsert)', () => {
        // Asserted BEHAVIOURALLY as well as textually: a WITHOUT ROWID table has no `rowid`
        // column, which is the property the sizing argument actually rests on.
        expect(() => db.prepare('SELECT rowid FROM raw_commits').all()).toThrow(/rowid/i);
        const sql = (
            db
                .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'raw_commits'")
                .get() as {sql: string}
        ).sql;
        expect(sql).toMatch(/WITHOUT\s+ROWID/i);
    });

    it('declares the composite PRIMARY KEY (provider, container, repo, sha)', () => {
        const pk = (db.prepare('PRAGMA table_info(raw_commits)').all() as {name: string; pk: number}[])
            .filter((c) => c.pk > 0)
            .sort((a, b) => a.pk - b.pk)
            .map((c) => c.name);
        expect(pk).toEqual(['provider', 'container', 'repo', 'sha']);
    });

    it('creates the ONE declared index and no other — no extra indexes', () => {
        expect(indexNames(db, 'raw_commits')).toEqual(['idx_raw_commits_author_day']);
        const cols = (
            db.prepare('PRAGMA index_info(idx_raw_commits_author_day)').all() as {
                seqno: number;
                name: string;
            }[]
        )
            .sort((a, b) => a.seqno - b.seqno)
            .map((c) => c.name);
        expect(cols).toEqual(['provider', 'container', 'raw_author_key', 'author_day']);
    });

    /**
     * THE DRIFT GUARD the epic's "the design doc is canonical" rule needs teeth from: the
     * migration's fenced canonical block must be the design doc's §1 SQL, modulo whitespace and
     * the added `IF NOT EXISTS`. Editing either copy alone fails here.
     */
    it('matches design §1 byte-for-byte (modulo whitespace / IF NOT EXISTS)', () => {
        const migration = fs.readFileSync(MIGRATION_FILE, 'utf-8');
        const fenced = migration.match(
            /-- >>> DESIGN §1 CANONICAL SQL[\s\S]*?\n([\s\S]*?)\n-- <<< DESIGN §1 CANONICAL SQL/,
        );
        expect(fenced, 'the 046 migration must fence its canonical block').not.toBeNull();

        const design = fs.readFileSync(DESIGN_DOC, 'utf-8');
        const block = design.match(/```sql\r?\n([\s\S]*?)```/);
        expect(block, 'the design doc must still carry its §1 sql block').not.toBeNull();

        expect(canonicalSql(fenced![1])).toBe(canonicalSql(block![1]));
    });

    it('round-trips a hand-inserted row verbatim', () => {
        insertCommit(db);
        const back = db.prepare('SELECT * FROM raw_commits WHERE sha = ?').get('abc123') as Record<
            string,
            unknown
        >;
        expect(back.provider).toBe('github');
        expect(back.container).toBe('acme');
        expect(back.repo).toBe('repo1');
        expect(back.raw_author_key).toBe('github:login:alice');
        expect(back.author_email).toBe('alice@example.com');
        expect(back.author_day).toBe('2026-07-01');
        expect(back.committed_at).toBe('2026-07-01T10:00:00.000Z');
        expect(back.lines_added).toBe(100);
        expect(back.lines_removed).toBe(20);
        expect(back.files_changed).toBe(7);
        expect(back.is_merge).toBe(0);
        expect(back.ai_signature).toBe(1);
        expect(back.first_seen).toBe('2026-07-02T00:00:00.000Z');
    });

    it('accepts NULL login/email/display (a partially-known raw identity)', () => {
        expect(() =>
            insertCommit(db, {author_login: null, author_email: null, author_display_name: null}),
        ).not.toThrow();
    });

    // ─── the idempotence the whole epic rests on ────────────────────────────────
    it('rejects a duplicate (provider, container, repo, sha) — the sha IS the identity', () => {
        insertCommit(db);
        expect(() => insertCommit(db, {lines_added: 999})).toThrow(/UNIQUE|PRIMARY KEY/i);
    });

    it('ON CONFLICT DO NOTHING makes a re-observed sha a no-op, not an overwrite', () => {
        expect(insertCommitOnConflictDoNothing(db)).toBe(1);
        // Same sha, DIFFERENT payload: the stored row must be the FIRST observation, untouched.
        expect(insertCommitOnConflictDoNothing(db, {lines_added: 999, first_seen: '2026-08-01T00:00:00.000Z'})).toBe(0);
        expect(rowCount(db, 'raw_commits')).toBe(1);
        const back = db.prepare('SELECT lines_added, first_seen FROM raw_commits').get() as {
            lines_added: number;
            first_seen: string;
        };
        expect(back.lines_added).toBe(100);
        expect(back.first_seen).toBe('2026-07-02T00:00:00.000Z');
    });

    it('keeps one sha independent per (provider, container, repo) — attribution is per container', () => {
        insertCommit(db);
        expect(() => insertCommit(db, {container: 'other-ws'})).not.toThrow();
        expect(() => insertCommit(db, {repo: 'repo2'})).not.toThrow();
        expect(() => insertCommit(db, {provider: 'gitlab', raw_author_key: 'gitlab:login:alice'})).not.toThrow();
        expect(rowCount(db, 'raw_commits')).toBe(4);
    });

    // ─── one rejection test per CHECK ───────────────────────────────────────────
    it('rejects an unknown provider (CHECK on the closed set)', () => {
        expect(() => insertCommit(db, {provider: 'perforce'})).toThrow();
    });

    it('accepts every valid provider', () => {
        ['github', 'bitbucket', 'gitlab'].forEach((p, i) => {
            expect(() => insertCommit(db, {provider: p, sha: `sha-${i}`})).not.toThrow();
        });
    });

    it('rejects a blank container (CHECK) — no un-attributable bucket', () => {
        expect(() => insertCommit(db, {container: ''})).toThrow();
    });

    it('rejects a blank repo (CHECK)', () => {
        expect(() => insertCommit(db, {repo: ''})).toThrow();
    });

    it('rejects a blank sha (CHECK) — the sha is the identity', () => {
        expect(() => insertCommit(db, {sha: ''})).toThrow();
    });

    it('rejects a blank raw_author_key (CHECK) — no anonymous "" bucket', () => {
        expect(() => insertCommit(db, {raw_author_key: ''})).toThrow();
    });

    it('rejects a malformed author_day (GLOB pins the UTC YYYY-MM-DD shape)', () => {
        expect(() => insertCommit(db, {author_day: '2026-7-1'})).toThrow();
        expect(() => insertCommit(db, {author_day: '2026-07-01T00:00:00Z'})).toThrow();
        expect(() => insertCommit(db, {author_day: '20260701'})).toThrow();
        expect(() => insertCommit(db, {author_day: ''})).toThrow();
    });

    it('rejects negative counters (CHECK on each of the three)', () => {
        expect(() => insertCommit(db, {lines_added: -1})).toThrow();
        expect(() => insertCommit(db, {lines_removed: -1})).toThrow();
        expect(() => insertCommit(db, {files_changed: -1})).toThrow();
    });

    it('rejects a non-boolean is_merge / ai_signature (CHECK IN (0,1))', () => {
        expect(() => insertCommit(db, {is_merge: 2})).toThrow();
        expect(() => insertCommit(db, {is_merge: -1})).toThrow();
        expect(() => insertCommit(db, {ai_signature: 2})).toThrow();
    });

    it('rejects NULL in every NOT NULL column', () => {
        for (const col of [
            'provider', 'container', 'repo', 'sha', 'raw_author_key', 'author_day',
            'committed_at', 'lines_added', 'lines_removed', 'files_changed', 'is_merge',
            'ai_signature', 'first_seen',
        ]) {
            expect(() => insertCommit(db, {[col]: null}), `${col} must be NOT NULL`).toThrow();
        }
    });

    // ─── migration mechanics ────────────────────────────────────────────────────
    it('is idempotent — re-running the migrations is a no-op and the table survives', () => {
        expect(runMigrations(db, MIGRATIONS_DIR)).toBe(0);
        expect(tableExists(db, 'raw_commits')).toBe(true);
        expect(indexNames(db, 'raw_commits')).toEqual(['idx_raw_commits_author_day']);
    });

    it('re-executing the CREATE half directly does not error (IF NOT EXISTS)', () => {
        const migration = fs.readFileSync(MIGRATION_FILE, 'utf-8');
        const fenced = migration.match(
            /-- >>> DESIGN §1 CANONICAL SQL[\s\S]*?\n([\s\S]*?)\n-- <<< DESIGN §1 CANONICAL SQL/,
        );
        // The DELETEs are deliberately destructive and not re-runnable (042/043 precedent) —
        // only the schema half carries IF NOT EXISTS, and only it is re-executed here.
        expect(() => db.exec(fenced![1])).not.toThrow();
    });
});
