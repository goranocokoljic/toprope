import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper, linkDeveloper} from '../../../src/registry/developers';
import {CursorSync} from '../../../src/connectors/cursor/sync';
import {createSelfReport} from '../../../src/selfreport/core';
import type {CursorUserMetrics, CursorUsageResponse} from '../../../src/connectors/cursor/client';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function makeConfig(overrides: Record<string, unknown> = {}): Parameters<typeof CursorSync>[0] {
    return {
        enabled: true,
        service_key: 'test-service-key',
        ...overrides,
    };
}

function makeEntry(email: string, overrides: Partial<CursorUserMetrics> = {}): CursorUserMetrics {
    return {
        user_id: 'cur-user-1',
        email,
        date: '2024-01-15',
        autocomplete_shown: 100,
        autocomplete_accepted: 45,
        composer_requests: 8,
        chat_requests: 15,
        models_used: {'gpt-4o': 18},
        estimated_cost: 3.25,
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

function makeUsageResponse(entries: CursorUserMetrics[], hasMore = false): CursorUsageResponse {
    return {users: entries, has_more: hasMore, next_cursor: hasMore ? 'cursor-next' : null};
}

function seedDev(db: Database.Database, email: string): string {
    addTeam(db, 'eng');
    const dev = addDeveloper(db, 'Alice', 'eng', email);
    linkDeveloper(db, dev.id, {cursor: email});
    return dev.id;
}

function countSnapshots(db: Database.Database): number {
    const row = db.prepare('SELECT COUNT(*) as n FROM tool_snapshots').get() as {n: number};
    return row.n;
}

describe('CursorSync', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        db.close();
    });

    it('getName returns cursor', () => {
        expect(new CursorSync(makeConfig()).getName()).toBe('cursor');
    });

    it('getLastSyncTime returns null before first sync', () => {
        expect(new CursorSync(makeConfig()).getLastSyncTime(db)).toBeNull();
    });

    it('writes snapshots for matched developers', async () => {
        const email = 'alice@company.com';
        seedDev(db, email);

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => makeOkResponse(makeUsageResponse([makeEntry(email)]))),
        );

        const result = await new CursorSync(makeConfig()).sync(db);

        expect(result.errors).toHaveLength(0);
        expect(result.snapshotsWritten).toBe(1);
        expect(countSnapshots(db)).toBe(1);
    });

    it('is idempotent — second sync for same day creates no duplicates', async () => {
        const email = 'alice@company.com';
        seedDev(db, email);

        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                makeOkResponse(makeUsageResponse([makeEntry(email, {date: '2024-01-15'})])),
            ),
        );

        const syncer = new CursorSync(makeConfig());
        const first = await syncer.sync(db);
        const second = await syncer.sync(db);

        expect(countSnapshots(db)).toBe(1);
        expect(first.snapshotsWritten).toBe(1);
        expect(second.snapshotsWritten).toBe(0);
        expect(second.snapshotsSkipped).toBe(1);
    });

    it('API data wins over an earlier self-report (overwrites the self_report snapshot)', async () => {
        const email = 'alice@company.com';
        const devId = seedDev(db, email);

        // A self-report lands first for the same dev/date/tool.
        createSelfReport(db, {
            developerId: devId,
            tool: 'cursor',
            date: '2024-01-15',
            minutes: 30,
            sourceInterface: 'cli',
        });
        const before = db
            .prepare('SELECT data_source, interaction_count FROM tool_snapshots WHERE developer_id = ?')
            .get(devId) as {data_source: string; interaction_count: number | null};
        expect(before.data_source).toBe('self_report');

        // The API sync then arrives with measured data for that same day.
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                makeOkResponse(makeUsageResponse([makeEntry(email, {date: '2024-01-15'})])),
            ),
        );
        const result = await new CursorSync(makeConfig()).sync(db);

        expect(result.snapshotsWritten).toBe(1);
        // Still exactly one row, now API/high with the measured counts — the
        // self-report placeholder was replaced, not duplicated or frozen.
        expect(countSnapshots(db)).toBe(1);
        const after = db
            .prepare(
                'SELECT data_source, data_quality, interaction_count FROM tool_snapshots WHERE developer_id = ?',
            )
            .get(devId) as {data_source: string; data_quality: string; interaction_count: number};
        expect(after.data_source).toBe('api');
        expect(after.data_quality).toBe('high');
        expect(after.interaction_count).toBe(100);

        // The raw self-report is still on record.
        const reports = db
            .prepare('SELECT COUNT(*) AS n FROM self_reports WHERE developer_id = ?')
            .get(devId) as {n: number};
        expect(reports.n).toBe(1);
    });

    it('skips entries for unknown developers', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => makeOkResponse(makeUsageResponse([makeEntry('unknown@example.com')]))),
        );

        const result = await new CursorSync(makeConfig()).sync(db);

        expect(result.snapshotsWritten).toBe(0);
        expect(countSnapshots(db)).toBe(0);
    });

    it('handles empty response gracefully', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => makeOkResponse(makeUsageResponse([]))),
        );

        const result = await new CursorSync(makeConfig()).sync(db);

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

        const result = await new CursorSync(makeConfig()).sync(db);

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

        const result = await new CursorSync(makeConfig()).sync(db);

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

        const result = await new CursorSync(makeConfig()).sync(db);

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

        const result = await new CursorSync(makeConfig()).sync(db);

        expect(result.snapshotsWritten).toBe(2);
        expect(callCount).toBe(2);
    });

    it('returns error when service_key is missing', async () => {
        const result = await new CursorSync({enabled: true}).sync(db);

        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain('Missing required config');
    });

    it('updates lastSyncTime after successful sync', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => makeOkResponse(makeUsageResponse([]))),
        );

        const syncer = new CursorSync(makeConfig());
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
        const syncer = new CursorSync(makeConfig());
        await syncer.sync(db);

        expect(syncer.getLastSyncTime(db)).toBeNull();
    });

    it('maps developer by cursor external_id', async () => {
        addTeam(db, 'eng2');
        const dev = addDeveloper(db, 'Bob', 'eng2', 'bob-other@company.com');
        linkDeveloper(db, dev.id, {cursor: 'bob@cursor.example.com'});

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => makeOkResponse(makeUsageResponse([makeEntry('bob@cursor.example.com')]))),
        );

        const result = await new CursorSync(makeConfig()).sync(db);

        expect(result.snapshotsWritten).toBe(1);
    });

    it('falls back to email when no cursor external_id set', async () => {
        addTeam(db, 'eng3');
        addDeveloper(db, 'Carol', 'eng3', 'carol@company.com');

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => makeOkResponse(makeUsageResponse([makeEntry('carol@company.com')]))),
        );

        const result = await new CursorSync(makeConfig()).sync(db);

        expect(result.snapshotsWritten).toBe(1);
    });

    it('passes start_date as YYYY-MM-DD from last sync ISO timestamp', async () => {
        const capturedBodies: Record<string, unknown>[] = [];
        vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
            capturedBodies.push(JSON.parse(options.body as string) as Record<string, unknown>);
            return makeOkResponse(makeUsageResponse([]));
        }));

        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
            'cursor_last_sync',
            '2024-01-20T10:30:00.000Z',
        );

        await new CursorSync(makeConfig()).sync(db);

        expect(capturedBodies[0].start_date).toBe('2024-01-20');
    });

    it('records error when API returns has_more=true with null next_cursor', async () => {
        const email = 'alice@company.com';
        seedDev(db, email);

        vi.stubGlobal('fetch', vi.fn(async () =>
            makeOkResponse({users: [makeEntry(email)], has_more: true, next_cursor: null})));

        const result = await new CursorSync(makeConfig()).sync(db);

        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain('pagination error');
    });

    it('handles response with missing users field gracefully', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => makeOkResponse({has_more: false})));

        const result = await new CursorSync(makeConfig()).sync(db);

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

        await new CursorSync(makeConfig()).sync(db);

        expect(capturedBodies[0].service_key).toBe('test-service-key');
        expect(capturedHeaders[0].Authorization).toBeUndefined();
    });
});
