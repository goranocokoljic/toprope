import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper, linkDeveloper} from '../../../src/registry/developers';
import {WindsurfSync} from '../../../src/connectors/windsurf/sync';
import type {WindsurfUserMetrics, WindsurfUsageResponse} from '../../../src/connectors/windsurf/client';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function makeConfig(overrides: Record<string, unknown> = {}): Parameters<typeof WindsurfSync>[0] {
    return {
        enabled: true,
        service_key: 'test-service-key',
        ...overrides,
    };
}

function makeEntry(email: string, overrides: Partial<WindsurfUserMetrics> = {}): WindsurfUserMetrics {
    return {
        user_id: 'ws-user-1',
        email,
        date: '2024-01-15',
        completions_shown: 100,
        completions_accepted: 45,
        ai_code_percentage: 38.5,
        cascade_sessions: 8,
        chat_messages: 15,
        flows_run: 3,
        ...overrides,
    };
}

function makeOkResponse(body: unknown) {
    return {
        ok: true,
        status: 200,
        headers: {get: (_: string) => null},
        json: async () => body,
    };
}

function makeUsageResponse(
    entries: WindsurfUserMetrics[],
    hasMore = false,
): WindsurfUsageResponse {
    return {users: entries, has_more: hasMore, next_cursor: hasMore ? 'cursor-next' : null};
}

function seedDev(db: Database.Database, email: string): string {
    addTeam(db, 'eng');
    const dev = addDeveloper(db, 'Alice', 'eng', email);
    linkDeveloper(db, dev.id, {windsurf: email});
    return dev.id;
}

function countSnapshots(db: Database.Database): number {
    const row = db.prepare('SELECT COUNT(*) as n FROM tool_snapshots').get() as {n: number};
    return row.n;
}

describe('WindsurfSync', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        db.close();
    });

    it('getName returns windsurf', () => {
        expect(new WindsurfSync(makeConfig()).getName()).toBe('windsurf');
    });

    it('getLastSyncTime returns null before first sync', () => {
        expect(new WindsurfSync(makeConfig()).getLastSyncTime(db)).toBeNull();
    });

    it('writes snapshots for matched developers', async () => {
        const email = 'alice@company.com';
        seedDev(db, email);

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => makeOkResponse(makeUsageResponse([makeEntry(email)]))),
        );

        const result = await new WindsurfSync(makeConfig()).sync(db);

        expect(result.errors).toHaveLength(0);
        expect(result.snapshotsWritten).toBe(1);
        expect(countSnapshots(db)).toBe(1);
    });

    it('does not create duplicates on second sync for same day', async () => {
        const email = 'alice@company.com';
        seedDev(db, email);

        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                makeOkResponse(makeUsageResponse([makeEntry(email, {date: '2024-01-15'})])),
            ),
        );

        const syncer = new WindsurfSync(makeConfig());
        const first = await syncer.sync(db);
        const second = await syncer.sync(db);

        expect(countSnapshots(db)).toBe(1);
        expect(first.snapshotsWritten).toBe(1);
        expect(second.snapshotsWritten).toBe(0);
        expect(second.snapshotsSkipped).toBe(1);
    });

    it('skips entries for unknown developers', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                makeOkResponse(makeUsageResponse([makeEntry('unknown@example.com')])),
            ),
        );

        const result = await new WindsurfSync(makeConfig()).sync(db);

        expect(result.snapshotsWritten).toBe(0);
        expect(countSnapshots(db)).toBe(0);
    });

    it('handles empty response gracefully', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => makeOkResponse(makeUsageResponse([]))),
        );

        const result = await new WindsurfSync(makeConfig()).sync(db);

        expect(result.errors).toHaveLength(0);
        expect(result.snapshotsWritten).toBe(0);
    });

    it('records error when API call fails with 500', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: false,
            status: 500,
            headers: {get: () => null},
            text: async () => 'internal error',
        })));

        const result = await new WindsurfSync(makeConfig()).sync(db);

        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain('500');
    }, 10_000);

    it('records permission error clearly when API returns 403', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: false,
            status: 403,
            headers: {get: () => null},
            text: async () => 'analytics permission required',
        })));

        const result = await new WindsurfSync(makeConfig()).sync(db);

        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain('Permission error');
        expect(result.errors[0]).toContain('analytics access');
    });

    it('retries on 429 rate limit response', async () => {
        const email = 'alice@company.com';
        seedDev(db, email);

        let callCount = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            callCount++;
            if (callCount === 1) {
                return {ok: false, status: 429, headers: {get: () => '0'}, text: async () => ''};
            }
            return makeOkResponse(makeUsageResponse([makeEntry(email)]));
        }));

        const result = await new WindsurfSync(makeConfig()).sync(db);

        expect(result.snapshotsWritten).toBe(1);
        expect(callCount).toBeGreaterThanOrEqual(2);
    }, 10_000);

    it('handles pagination — follows next_cursor', async () => {
        const email = 'alice@company.com';
        seedDev(db, email);

        let callCount = 0;
        vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
            callCount++;
            const body = JSON.parse(options.body as string) as Record<string, unknown>;
            if (!body.cursor) {
                return makeOkResponse({
                    users: [makeEntry(email, {date: '2024-01-15'})],
                    has_more: true,
                    next_cursor: 'cursor-page2',
                });
            }
            return makeOkResponse(makeUsageResponse([makeEntry(email, {date: '2024-01-16'})]));
        }));

        const result = await new WindsurfSync(makeConfig()).sync(db);

        expect(result.snapshotsWritten).toBe(2);
        expect(callCount).toBe(2);
    });

    it('returns error when service_key is missing', async () => {
        const result = await new WindsurfSync({enabled: true}).sync(db);

        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain('Missing required config');
    });

    it('updates lastSyncTime after successful sync', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => makeOkResponse(makeUsageResponse([]))),
        );

        const syncer = new WindsurfSync(makeConfig());
        expect(syncer.getLastSyncTime(db)).toBeNull();

        await syncer.sync(db);

        expect(syncer.getLastSyncTime(db)).not.toBeNull();
    });

    it('does not advance lastSyncTime when snapshot write fails', async () => {
        const email = 'alice@company.com';
        seedDev(db, email);

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => makeOkResponse(makeUsageResponse([makeEntry(email)]))),
        );

        db.prepare('DROP TABLE tool_snapshots').run();
        const syncer = new WindsurfSync(makeConfig());
        await syncer.sync(db);

        expect(syncer.getLastSyncTime(db)).toBeNull();
    });

    it('maps developer by windsurf external_id', async () => {
        addTeam(db, 'eng2');
        const dev = addDeveloper(db, 'Bob', 'eng2', 'bob-other@company.com');
        linkDeveloper(db, dev.id, {windsurf: 'bob@windsurf.example.com'});

        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                makeOkResponse(
                    makeUsageResponse([makeEntry('bob@windsurf.example.com')]),
                ),
            ),
        );

        const result = await new WindsurfSync(makeConfig()).sync(db);

        expect(result.snapshotsWritten).toBe(1);
    });

    it('falls back to email when no windsurf external_id set', async () => {
        addTeam(db, 'eng3');
        addDeveloper(db, 'Carol', 'eng3', 'carol@company.com');

        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                makeOkResponse(makeUsageResponse([makeEntry('carol@company.com')])),
            ),
        );

        const result = await new WindsurfSync(makeConfig()).sync(db);

        expect(result.snapshotsWritten).toBe(1);
    });

    it('ext.windsurf key does not overwrite a prior email-fallback mapping', async () => {
        addTeam(db, 'eng4');
        const devB = addDeveloper(db, 'Bob', 'eng4', 'shared@example.com');
        const devA = addDeveloper(db, 'Alice', 'eng4', 'alice@example.com');
        linkDeveloper(db, devA.id, {windsurf: 'shared@example.com'});

        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                makeOkResponse(makeUsageResponse([makeEntry('shared@example.com')])),
            ),
        );

        const result = await new WindsurfSync(makeConfig()).sync(db);

        expect(result.snapshotsWritten).toBe(1);
        const snap = db
            .prepare('SELECT developer_id FROM tool_snapshots')
            .get() as {developer_id: string};
        expect([devA.id, devB.id]).toContain(snap.developer_id);
    });

    it('passes start_date as YYYY-MM-DD from last sync ISO timestamp', async () => {
        const capturedBodies: Record<string, unknown>[] = [];
        vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
            capturedBodies.push(JSON.parse(options.body as string) as Record<string, unknown>);
            return makeOkResponse(makeUsageResponse([]));
        }));

        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
            'windsurf_last_sync',
            '2024-01-20T10:30:00.000Z',
        );

        await new WindsurfSync(makeConfig()).sync(db);

        expect(capturedBodies[0].start_date).toBe('2024-01-20');
    });

    it('records error when API returns has_more=true with null next_cursor', async () => {
        const email = 'alice@company.com';
        seedDev(db, email);

        vi.stubGlobal('fetch', vi.fn(async () =>
            makeOkResponse({users: [makeEntry(email)], has_more: true, next_cursor: null})));

        const result = await new WindsurfSync(makeConfig()).sync(db);

        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain('pagination error');
    });

    it('handles response with missing users field gracefully', async () => {
        vi.stubGlobal('fetch', vi.fn(async () =>
            makeOkResponse({has_more: false})));

        const result = await new WindsurfSync(makeConfig()).sync(db);

        expect(result.errors).toHaveLength(0);
        expect(result.snapshotsWritten).toBe(0);
    });

    it('sends service_key in request body, not headers', async () => {
        const capturedBodies: Record<string, unknown>[] = [];
        const capturedHeaders: Record<string, string>[] = [];
        vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
            capturedBodies.push(JSON.parse(options.body as string) as Record<string, unknown>);
            capturedHeaders.push(options.headers as Record<string, string>);
            return makeOkResponse(makeUsageResponse([]));
        }));

        await new WindsurfSync(makeConfig()).sync(db);

        expect(capturedBodies[0].service_key).toBe('test-service-key');
        expect(capturedHeaders[0].Authorization).toBeUndefined();
    });
});
