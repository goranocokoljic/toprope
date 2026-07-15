import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {setHistoryFloor, GIT_PROVIDER_TYPES} from '../../src/cli/git-history-floor';
import {
    getEarliestSyncedWatermark,
    earliestSyncStateKey,
    earliestUnknownStateKey,
} from '../../src/connectors/git/sync';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');
const NOW = '2026-03-15T12:00:00.000Z';
const FLOOR = '2025-01-01T00:00:00.000Z';

describe('toprope git set-history-floor (#233)', () => {
    let db: Database.Database;

    const readState = (key: string): string | null =>
        (db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
            | {value: string}
            | undefined)?.value ?? null;
    const markLegacy = (type = 'github', container = 'acme'): void => {
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
            `git_earliest_unknown:${type}:${container}`,
            '1',
        );
    };

    beforeEach(() => {
        db = new Database(':memory:');
        runMigrations(db, MIGRATIONS_DIR);
        db.prepare("DELETE FROM sync_state WHERE key LIKE 'git_%'").run();
    });

    afterEach(() => {
        db.close();
    });

    it('declares the floor for a legacy provider and reports it', () => {
        markLegacy();
        const result = setHistoryFloor(db, {provider: 'github', container: 'acme', at: FLOOR}, NOW);

        expect(result.ok).toBe(true);
        expect(result.message).toContain(FLOOR);
        expect(readState(earliestSyncStateKey('github', 'acme'))).toBe(FLOOR);
        expect(readState(earliestUnknownStateKey('github', 'acme'))).toBeNull();
        // The observable point of the command: backfill is unblocked.
        expect(getEarliestSyncedWatermark(db, 'github', 'acme', NOW)).toEqual({
            kind: 'exact',
            watermark: FLOOR,
        });
    });

    it.each(GIT_PROVIDER_TYPES)('accepts the allowlisted provider type %s', (type) => {
        markLegacy(type);
        const result = setHistoryFloor(db, {provider: type, container: 'acme', at: FLOOR}, NOW);
        expect(result.ok).toBe(true);
        expect(readState(earliestSyncStateKey(type, 'acme'))).toBe(FLOOR);
    });

    it.each([
        ['an unknown provider', 'gitea'],
        ['a case variant (allowlist is exact)', 'GitHub'],
        ['an empty type', ''],
    ])('rejects %s and writes nothing', (_label, provider) => {
        // The runtime allowlist is the real gate — the TS union does not exist here.
        markLegacy(provider);
        const result = setHistoryFloor(db, {provider, container: 'acme', at: FLOOR}, NOW);

        expect(result.ok).toBe(false);
        expect(result.message).toContain('unknown provider type');
        const written = db
            .prepare("SELECT key FROM sync_state WHERE key LIKE 'git_earliest_sync:%'")
            .all();
        expect(written).toEqual([]);
    });

    it.each([
        ['an empty container', ''],
        ['a whitespace-only container', '   '],
    ])('rejects %s rather than write a key matching no provider', (_label, container) => {
        const result = setHistoryFloor(db, {provider: 'github', container, at: FLOOR}, NOW);
        expect(result.ok).toBe(false);
        expect(result.message).toContain('--container');
        expect(db.prepare("SELECT key FROM sync_state WHERE key LIKE 'git_%'").all()).toEqual([]);
    });

    it('rejects a malformed --at with an actionable message', () => {
        markLegacy();
        const result = setHistoryFloor(db, {provider: 'github', container: 'acme', at: '2025-01-01'}, NOW);
        expect(result.ok).toBe(false);
        expect(result.message).toContain('invalid --at value');
        expect(readState(earliestUnknownStateKey('github', 'acme'))).toBe('1');
    });

    it('rejects a future --at', () => {
        markLegacy();
        const result = setHistoryFloor(
            db,
            {provider: 'github', container: 'acme', at: '2027-01-01T00:00:00.000Z'},
            NOW,
        );
        expect(result.ok).toBe(false);
        expect(result.message).toContain('must be in the past');
        expect(readState(earliestSyncStateKey('github', 'acme'))).toBeNull();
    });

    it('rejects a non-legacy provider, naming why there is nothing to declare', () => {
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
            earliestSyncStateKey('github', 'acme'),
            '2024-06-01T00:00:00.000Z',
        );
        const result = setHistoryFloor(db, {provider: 'github', container: 'acme', at: FLOOR}, NOW);

        expect(result.ok).toBe(false);
        expect(result.message).toContain('not a legacy provider');
        // The recorded floor is intact — this command must never overwrite one.
        expect(readState(earliestSyncStateKey('github', 'acme'))).toBe('2024-06-01T00:00:00.000Z');
    });
});
