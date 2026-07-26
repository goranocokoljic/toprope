import {describe, it, expect, beforeEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {loadServerKey, type ServerKeyResult} from '../../src/connectors/git/providers/secret';
import {createProvider, getProvider} from '../../src/connectors/git/providers/store';
import {deleteProviderAndSyncState} from '../../src/connectors/git/providers/delete';
import {
    earliestSyncStateKey,
    stallStateKey,
    syncStateKey,
} from '../../src/connectors/git/sync';
import type {GitProviderConfig} from '../../src/connectors/git/providers/types';

/**
 * #262 — deleting a provider must take its container-keyed sync-state with it, so a
 * provider re-added for the same container cannot inherit a forward cursor (which
 * makes the pipeline discard the admin's first-sync window) or a stale earliest-synced
 * watermark (which makes the resulting history gap unreachable by "sync older
 * history"). The cleanup is container-scoped shared state, so it must be skipped
 * whenever any other provider — DB row or config-file entry — still resolves to the
 * same key.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');
const KEY_B64 = Buffer.alloc(32, 7).toString('base64');

function keyOk(): ServerKeyResult {
    return loadServerKey({TOPROPE_SECRET_KEY: KEY_B64});
}

const BITBUCKET_ACME: GitProviderConfig = {
    type: 'bitbucket',
    workspace: 'acme',
    auth: {type: 'access_token', token: 'bb-at-TOKN9012'},
};

let db: Database.Database;

beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
});

function setState(key: string, value: string): void {
    db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(key, value);
}

function readState(key: string): string | undefined {
    return (db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
        | {value: string}
        | undefined)?.value;
}

function allStateKeys(): string[] {
    return (db.prepare('SELECT key FROM sync_state ORDER BY key').all() as Array<{key: string}>).map(
        (r) => r.key,
    );
}

// Seed the three container-keyed rows a synced provider leaves behind, plus a set of
// NEIGHBOR rows that must never be touched: another container, a container whose name
// this one is a prefix of (the case a LIKE-prefix purge would corrupt), a different
// provider type on the same container name, and another connector's cursor.
const OWN_KEYS = [
    syncStateKey('bitbucket', 'acme'),
    earliestSyncStateKey('bitbucket', 'acme'),
    stallStateKey('bitbucket', 'acme'),
];
const NEIGHBOR_KEYS = [
    syncStateKey('bitbucket', 'acme-labs'),
    earliestSyncStateKey('bitbucket', 'acme-labs'),
    stallStateKey('bitbucket', 'acme-labs'),
    syncStateKey('bitbucket', 'other-ws'),
    syncStateKey('github', 'acme'),
    'copilot_last_sync',
];

function seedSyncState(): void {
    for (const key of OWN_KEYS) setState(key, '2026-01-01T00:00:00.000Z');
    for (const key of NEIGHBOR_KEYS) setState(key, '2026-02-02T00:00:00.000Z');
}

describe('deleteProviderAndSyncState (#262)', () => {
    it('clears exactly the provider container three key kinds and nothing else', () => {
        const rec = createProvider(db, keyOk(), {config: BITBUCKET_ACME, createdBy: null});
        seedSyncState();

        const result = deleteProviderAndSyncState(db, rec.id, []);

        expect(result).toEqual({deleted: true, syncStateCleared: true});
        expect(getProvider(db, rec.id)).toBeUndefined();
        // All three of this container's kinds are gone…
        for (const key of OWN_KEYS) expect(readState(key)).toBeUndefined();
        // …and every neighbor row survives, byte for byte.
        expect(allStateKeys()).toEqual([...NEIGHBOR_KEYS].sort());
    });

    it('leaves sync state intact when a config-file provider shares the container', () => {
        const rec = createProvider(db, keyOk(), {config: BITBUCKET_ACME, createdBy: null});
        seedSyncState();

        // The exact coexistence the resolver allows: a config-file entry and a DB row
        // for one container. Its cursors are still live state after the DB row goes.
        const result = deleteProviderAndSyncState(db, rec.id, [
            {type: 'bitbucket', workspace: 'acme', auth: {type: 'oauth', token: 'cfg-token'}},
        ]);

        expect(result).toEqual({deleted: true, syncStateCleared: false});
        expect(getProvider(db, rec.id)).toBeUndefined();
        for (const key of OWN_KEYS) expect(readState(key)).toBe('2026-01-01T00:00:00.000Z');
    });

    it('leaves sync state intact when another DB row shares the container', () => {
        const doomed = createProvider(db, keyOk(), {config: BITBUCKET_ACME, createdBy: null});
        const survivor = createProvider(db, keyOk(), {config: BITBUCKET_ACME, createdBy: null});
        seedSyncState();

        const result = deleteProviderAndSyncState(db, doomed.id, []);

        expect(result).toEqual({deleted: true, syncStateCleared: false});
        expect(getProvider(db, survivor.id)).toBeDefined();
        for (const key of OWN_KEYS) expect(readState(key)).toBe('2026-01-01T00:00:00.000Z');
    });

    it('purges when a config-file sibling is on the same container name but a DIFFERENT type', () => {
        const rec = createProvider(db, keyOk(), {config: BITBUCKET_ACME, createdBy: null});
        seedSyncState();

        // github:acme resolves to a DIFFERENT key than bitbucket:acme, so it protects
        // nothing here — and its own rows must survive.
        const result = deleteProviderAndSyncState(db, rec.id, [
            {type: 'github', org: 'acme', auth: {type: 'token', api_token: 'ghp_other'}},
        ]);

        expect(result.syncStateCleared).toBe(true);
        for (const key of OWN_KEYS) expect(readState(key)).toBeUndefined();
        expect(readState(syncStateKey('github', 'acme'))).toBe('2026-02-02T00:00:00.000Z');
    });

    it('is a no-op for an unknown id: nothing deleted, no sync state touched', () => {
        createProvider(db, keyOk(), {config: BITBUCKET_ACME, createdBy: null});
        seedSyncState();
        const before = allStateKeys();

        const result = deleteProviderAndSyncState(db, 'no-such-provider', []);

        expect(result).toEqual({deleted: false, syncStateCleared: false});
        expect(allStateKeys()).toEqual(before);
        expect(db.prepare('SELECT COUNT(*) AS n FROM git_providers').get()).toEqual({n: 1});
    });

    it('rolls the row delete back when the sync-state purge fails (one transaction)', () => {
        const rec = createProvider(db, keyOk(), {config: BITBUCKET_ACME, createdBy: null});
        seedSyncState();
        // Make the cursor purge fail mid-transaction. If the row delete were not in the
        // same transaction, the provider would vanish while its cursors survived —
        // precisely the half-removed state this issue is about.
        db.exec(
            `CREATE TRIGGER block_sync_state_delete BEFORE DELETE ON sync_state
             BEGIN SELECT RAISE(ABORT, 'sync_state delete blocked'); END`,
        );

        expect(() => deleteProviderAndSyncState(db, rec.id, [])).toThrow(/blocked/);

        // Both halves rolled back.
        expect(getProvider(db, rec.id)).toBeDefined();
        for (const key of OWN_KEYS) expect(readState(key)).toBe('2026-01-01T00:00:00.000Z');
    });
});
