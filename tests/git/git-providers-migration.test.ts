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

// A complete git_providers row (all NOT NULL columns present) for insert tests.
function insertProvider(db: Database.Database, overrides: Record<string, unknown> = {}): void {
    const row = {
        id: 'gp1',
        type: 'github',
        container: 'acme',
        url: null,
        include_subgroups: null,
        auth_method: 'token',
        auth_username: null,
        token_ciphertext: Buffer.from('cipher'),
        token_meta: '{"algo":"aes-256-gcm","iv":"x","auth_tag":"y","key_id":"k1"}',
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
          @enabled, @created_at, @updated_at, @created_by, @last_sync_at, @last_sync_status, @last_sync_error)`,
    ).run(row);
}

describe('migration 039 — git_providers schema (#193)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db, MIGRATIONS_DIR);
        // Seed a user for the created_by FK.
        db.prepare(
            `INSERT INTO users (id, email, password_hash, role, created_at)
             VALUES ('u1', 'admin@test.com', 'hash', 'admin', '2026-07-06T00:00:00.000Z')`,
        ).run();
    });

    afterEach(() => {
        db.close();
    });

    it('creates the git_providers table', () => {
        expect(tableExists(db, 'git_providers')).toBe(true);
    });

    it('creates the (type, container) index', () => {
        expect(indexExists(db, 'idx_git_providers_type_container')).toBe(true);
    });

    // #264 AC1: 039 shipped a NON-unique index, which allowed two rows for one workspace —
    // both syncing it through the one shared container-keyed cursor. 042 replaces it with a
    // UNIQUE one, so "one provider = one independent data set" holds by construction.
    it('the (type, container) index is UNIQUE (042 / #264)', () => {
        const row = db
            .prepare("SELECT [unique] FROM pragma_index_list('git_providers') WHERE name = ?")
            .get('idx_git_providers_type_container') as {unique: number} | undefined;
        expect(row?.unique).toBe(1);
    });

    it('rejects a second provider for the same (type, container)', () => {
        insertProvider(db, {id: 'first', type: 'github', container: 'acme'});
        expect(() => insertProvider(db, {id: 'second', type: 'github', container: 'acme'})).toThrow(
            /UNIQUE/i,
        );
        // A different family for the same NAME is a different container — still allowed.
        expect(() =>
            insertProvider(db, {id: 'third', type: 'gitlab', container: 'acme'}),
        ).not.toThrow();
    });

    it('has exactly the specified columns', () => {
        expect(columnNames(db, 'git_providers').sort()).toEqual(
            [
                'id', 'type', 'container', 'url', 'include_subgroups', 'auth_method', 'auth_username',
                'token_ciphertext', 'token_meta', 'token_last4', 'repos_include', 'repos_exclude',
                'enabled', 'created_at', 'updated_at', 'created_by', 'last_sync_at',
                'last_sync_status', 'last_sync_error',
            ].sort(),
        );
    });

    it('inserts a row and reads it back verbatim', () => {
        insertProvider(db, {created_by: 'u1', token_last4: 'ab12'});
        const back = db.prepare('SELECT * FROM git_providers WHERE id = ?').get('gp1') as Record<string, unknown>;
        expect(back.type).toBe('github');
        expect(back.container).toBe('acme');
        expect(back.auth_method).toBe('token');
        expect(back.token_last4).toBe('ab12');
        expect(back.created_by).toBe('u1');
        expect(Buffer.isBuffer(back.token_ciphertext)).toBe(true);
        expect((back.token_ciphertext as Buffer).toString()).toBe('cipher');
    });

    it('defaults enabled to 1', () => {
        db.prepare(
            `INSERT INTO git_providers
             (id, type, container, auth_method, token_ciphertext, token_meta, created_at, updated_at)
             VALUES ('gp2', 'github', 'acme', 'token', X'00', '{}', 'now', 'now')`,
        ).run();
        const back = db.prepare('SELECT enabled FROM git_providers WHERE id = ?').get('gp2') as {enabled: number};
        expect(back.enabled).toBe(1);
    });

    it('rejects an unknown provider type (CHECK)', () => {
        expect(() => insertProvider(db, {id: 'bad', type: 'perforce'})).toThrow();
    });

    it('rejects an unknown auth_method (CHECK)', () => {
        expect(() => insertProvider(db, {id: 'bad', auth_method: 'ssh_key'})).toThrow();
    });

    it('accepts every valid auth_method', () => {
        const methods = ['token', 'app_password', 'access_token', 'oauth', 'personal_access_token', 'job_token'];
        // Distinct containers per row: (type, container) is UNIQUE since 042 (#264), so
        // reusing one container would fail on the constraint rather than on auth_method.
        methods.forEach((m, i) => {
            expect(() =>
                insertProvider(db, {id: `gp-${i}`, auth_method: m, container: `acme-${i}`}),
            ).not.toThrow();
        });
    });

    it('rejects a non-boolean include_subgroups (CHECK)', () => {
        expect(() => insertProvider(db, {id: 'bad', include_subgroups: 2})).toThrow();
    });

    it('rejects a non-boolean enabled (CHECK)', () => {
        expect(() => insertProvider(db, {id: 'bad', enabled: 5})).toThrow();
    });

    it('rejects an unknown last_sync_status (CHECK)', () => {
        expect(() => insertProvider(db, {id: 'bad', last_sync_status: 'pending'})).toThrow();
    });

    it('accepts the three valid last_sync_status values', () => {
        ['ok', 'error', 'never'].forEach((s, i) => {
            expect(() =>
                insertProvider(db, {id: `st-${i}`, last_sync_status: s, container: `acme-st-${i}`}),
            ).not.toThrow();
        });
    });

    it('nulls created_by when the referenced user is deleted (ON DELETE SET NULL)', () => {
        insertProvider(db, {created_by: 'u1'});
        db.prepare('DELETE FROM users WHERE id = ?').run('u1');
        const back = db.prepare('SELECT created_by FROM git_providers WHERE id = ?').get('gp1') as {
            created_by: string | null;
        };
        expect(back.created_by).toBeNull();
    });

    it('rejects created_by referencing a missing user (FK)', () => {
        expect(() => insertProvider(db, {created_by: 'ghost'})).toThrow();
    });

    it('is idempotent — re-running the migrations is a no-op and the table survives', () => {
        expect(runMigrations(db, MIGRATIONS_DIR)).toBe(0);
        expect(tableExists(db, 'git_providers')).toBe(true);
    });

    it('re-executing the raw 039 SQL directly does not error (IF NOT EXISTS)', () => {
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '039_git_providers.sql'), 'utf-8');
        expect(() => db.exec(sql)).not.toThrow();
    });
});
