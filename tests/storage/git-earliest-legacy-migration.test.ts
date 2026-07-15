import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {
    getEarliestSyncedWatermark,
    earliestSyncStateKey,
    earliestUnknownStateKey,
    syncStateKey,
} from '../../src/connectors/git/sync';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');
const MIGRATION_040_ID = 40;
const NOW = '2026-03-15T12:00:00.000Z';

/**
 * Migration 040 seeds the "earliest floor unknown" marker for providers that ALREADY
 * had a forward cursor when it ran. To exercise that honestly we need pre-existing
 * state, so: apply every migration (schema), roll 040 back out of the ledger, seed the
 * legacy state a real pre-#229 deployment would have, then re-run the migrator so 040
 * applies against it — exactly the ordering a real upgrade sees.
 */
function rewind040(db: Database.Database): void {
    db.prepare('DELETE FROM schema_migrations WHERE id = ?').run(MIGRATION_040_ID);
    db.prepare("DELETE FROM sync_state WHERE key LIKE 'git_earliest_unknown:%'").run();
}

describe('migration 040 — legacy earliest-floor marker (#233)', () => {
    let db: Database.Database;

    const seed = (key: string, value: string): void => {
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(key, value);
    };
    const readState = (key: string): string | null =>
        (db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
            | {value: string}
            | undefined)?.value ?? null;

    beforeEach(() => {
        db = new Database(':memory:');
        runMigrations(db, MIGRATIONS_DIR);
        db.prepare("DELETE FROM sync_state WHERE key LIKE 'git_%'").run();
        rewind040(db);
    });

    afterEach(() => {
        db.close();
    });

    it('marks a LEGACY provider — forward cursor but no recorded watermark', () => {
        // The exact shape of a provider first synced before #229.
        seed(syncStateKey('github', 'acme'), '2026-03-01T00:00:00.000Z');

        runMigrations(db, MIGRATIONS_DIR);

        expect(readState(earliestUnknownStateKey('github', 'acme'))).toBe('1');
        // And the accessor now refuses to guess for it — the whole point.
        expect(getEarliestSyncedWatermark(db, 'github', 'acme', NOW)).toEqual({kind: 'unknown'});
    });

    it('does NOT mark a #229-era provider that already has an exact watermark', () => {
        seed(syncStateKey('github', 'acme'), '2026-03-01T00:00:00.000Z');
        seed(earliestSyncStateKey('github', 'acme'), '2025-09-01T00:00:00.000Z');

        runMigrations(db, MIGRATIONS_DIR);

        expect(readState(earliestUnknownStateKey('github', 'acme'))).toBeNull();
        expect(getEarliestSyncedWatermark(db, 'github', 'acme', NOW)).toEqual({
            kind: 'exact',
            watermark: '2025-09-01T00:00:00.000Z',
        });
    });

    it('does NOT mark a never-synced provider (no cursor → nothing imported → no guess)', () => {
        runMigrations(db, MIGRATIONS_DIR);

        expect(readState(earliestUnknownStateKey('github', 'acme'))).toBeNull();
        // Its default floor is honest, not a guess: nothing is imported yet.
        expect(getEarliestSyncedWatermark(db, 'github', 'acme', NOW)).toEqual({
            kind: 'exact',
            watermark: '2025-09-15T12:00:00.000Z',
        });
    });

    it('marks each legacy provider independently across types and containers', () => {
        seed(syncStateKey('github', 'acme'), '2026-03-01T00:00:00.000Z');
        seed(syncStateKey('bitbucket', 'acme-ws'), '2026-03-02T00:00:00.000Z');
        // gitlab groups are path-like — the key derivation must survive the slash.
        seed(syncStateKey('gitlab', 'group/subgroup'), '2026-03-03T00:00:00.000Z');
        // ...and this one is already exact, so it must be left alone.
        seed(syncStateKey('github', 'exact-org'), '2026-03-04T00:00:00.000Z');
        seed(earliestSyncStateKey('github', 'exact-org'), '2025-01-01T00:00:00.000Z');

        runMigrations(db, MIGRATIONS_DIR);

        expect(readState(earliestUnknownStateKey('github', 'acme'))).toBe('1');
        expect(readState(earliestUnknownStateKey('bitbucket', 'acme-ws'))).toBe('1');
        expect(readState(earliestUnknownStateKey('gitlab', 'group/subgroup'))).toBe('1');
        expect(readState(earliestUnknownStateKey('github', 'exact-org'))).toBeNull();
        expect(getEarliestSyncedWatermark(db, 'gitlab', 'group/subgroup', NOW)).toEqual({
            kind: 'unknown',
        });
    });

    it('leaves non-git sync_state keys untouched', () => {
        // sync_state is shared with the other connectors — the LIKE must not overreach.
        seed('copilot_last_sync', '2026-03-01T00:00:00.000Z');
        seed('claude_code_last_sync', '2026-03-01T00:00:00.000Z');

        runMigrations(db, MIGRATIONS_DIR);

        const markers = db
            .prepare("SELECT key FROM sync_state WHERE key LIKE 'git_earliest_unknown:%'")
            .all() as Array<{key: string}>;
        expect(markers).toEqual([]);
        expect(readState('copilot_last_sync')).toBe('2026-03-01T00:00:00.000Z');
    });

    it('is idempotent — re-applying seeds no duplicate and does not throw', () => {
        seed(syncStateKey('github', 'acme'), '2026-03-01T00:00:00.000Z');
        runMigrations(db, MIGRATIONS_DIR);

        rewind040(db);
        // Marker survives the rewind (rewind040 clears it, so re-seed the real "already
        // marked" state the ON CONFLICT clause exists to absorb).
        seed(earliestUnknownStateKey('github', 'acme'), '1');
        expect(() => runMigrations(db, MIGRATIONS_DIR)).not.toThrow();

        const markers = db
            .prepare("SELECT key, value FROM sync_state WHERE key LIKE 'git_earliest_unknown:%'")
            .all() as Array<{key: string; value: string}>;
        expect(markers).toEqual([{key: earliestUnknownStateKey('github', 'acme'), value: '1'}]);
    });
});
