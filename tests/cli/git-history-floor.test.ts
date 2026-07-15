import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {setHistoryFloor} from '../../src/cli/git-history-floor';
import {
    getEarliestSyncedWatermark,
    earliestSyncStateKey,
    syncStateKey,
} from '../../src/connectors/git/sync';
import type {GitProviderType} from '../../src/connectors/git/providers/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');
const NOW = '2026-03-15T12:00:00.000Z';
const FLOOR = '2025-01-01T00:00:00.000Z';

describe('toprope git set-history-floor (#233)', () => {
    let db: Database.Database;

    const readState = (key: string): string | null =>
        (db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
            | {value: string}
            | undefined)?.value ?? null;
    // Legacy = a pre-#229 first sync's leftovers: a forward cursor, no recorded floor.
    const markLegacy = (type: GitProviderType = 'github', container = 'acme'): void => {
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
            syncStateKey(type, container),
            '2026-03-01T00:00:00.000Z',
        );
    };

    beforeEach(() => {
        db = new Database(':memory:');
        runMigrations(db, MIGRATIONS_DIR);
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
        // The observable point of the command: backfill is unblocked.
        expect(getEarliestSyncedWatermark(db, 'github', 'acme', NOW)).toEqual({
            kind: 'exact',
            watermark: FLOOR,
        });
    });

    it('states the consequence of the declared floor, not just that it was written', () => {
        // The admin typed this instant from memory and it silently decides whether the
        // next backfill double-counts — the echo is their only chance to catch a typo.
        markLegacy();
        const result = setHistoryFloor(db, {provider: 'github', container: 'acme', at: FLOOR}, NOW);

        expect(result.ok).toBe(true);
        expect(result.message).toMatch(/older/i);
        expect(result.message).toMatch(/double-count/i);
        expect(result.message).toContain('--force');
    });

    // Hardcoded, NOT derived from the GIT_PROVIDER_TYPES constant under test: driving
    // this from the allowlist itself would assert "every member of X is accepted by a
    // gate whose accept-set is X" — true by construction, and silently green if a new
    // GitProviderType is added and this hand-maintained copy is not updated.
    it.each(['github', 'bitbucket', 'gitlab'] as const)('accepts provider type %s', (type) => {
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
        // Still legacy after the rejection — nothing was written.
        expect(getEarliestSyncedWatermark(db, 'github', 'acme', NOW)).toEqual({kind: 'unknown'});
    });

    it('trims --container so a padded value is not misreported as a state fact', () => {
        // '--container " acme "' would key a provider that cannot exist; without the
        // trim the miss surfaces as "no unknown floor to declare", sending the admin
        // hunting for a watermark rather than for their typo.
        markLegacy();
        const result = setHistoryFloor(db, {provider: 'github', container: '  acme  ', at: FLOOR}, NOW);
        expect(result.ok).toBe(true);
        expect(readState(earliestSyncStateKey('github', 'acme'))).toBe(FLOOR);
    });

    it('--force corrects a floor that was already declared', () => {
        markLegacy();
        const typo = '2025-06-01T00:00:00.000Z';
        expect(setHistoryFloor(db, {provider: 'github', container: 'acme', at: typo}, NOW).ok).toBe(true);
        // Refused without --force…
        const refused = setHistoryFloor(db, {provider: 'github', container: 'acme', at: FLOOR}, NOW);
        expect(refused.ok).toBe(false);
        expect(refused.message).toContain('--force');
        expect(readState(earliestSyncStateKey('github', 'acme'))).toBe(typo);
        // …and applied with it.
        const forced = setHistoryFloor(
            db,
            {provider: 'github', container: 'acme', at: FLOOR, force: true},
            NOW,
        );
        expect(forced.ok).toBe(true);
        expect(readState(earliestSyncStateKey('github', 'acme'))).toBe(FLOOR);
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

    it('refuses --force on a never-synced provider, and does not point the typo at --force', () => {
        // A mistyped --container lands in never_synced. The message must send the admin
        // to the spelling, NOT to --force: forcing here would invent a floor for a
        // provider that has synced nothing, stranding history permanently.
        const result = setHistoryFloor(
            db,
            {provider: 'github', container: 'acmee', at: FLOOR, force: true},
            NOW,
        );
        expect(result.ok).toBe(false);
        expect(result.message).toContain('never synced');
        expect(result.message).toContain('spelling');
        expect(result.message).not.toContain('--force');
        expect(readState(earliestSyncStateKey('github', 'acmee'))).toBeNull();
    });

    it('rejects a non-legacy provider, naming why there is nothing to declare', () => {
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
            earliestSyncStateKey('github', 'acme'),
            '2024-06-01T00:00:00.000Z',
        );
        const result = setHistoryFloor(db, {provider: 'github', container: 'acme', at: FLOOR}, NOW);

        expect(result.ok).toBe(false);
        expect(result.message).toContain('already has an exact history floor recorded');
        // …and this state — unlike never_synced — is a legitimate --force target.
        expect(result.message).toContain('--force');
        // The recorded floor is intact — overwriting one takes an explicit --force.
        expect(readState(earliestSyncStateKey('github', 'acme'))).toBe('2024-06-01T00:00:00.000Z');
    });
});
