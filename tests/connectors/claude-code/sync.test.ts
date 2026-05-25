import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper, linkDeveloper} from '../../../src/registry/developers';
import {ClaudeCodeSync} from '../../../src/connectors/claude-code/sync';
import type {ClaudeCodeUsageEntry, ClaudeCodeUsageResponse} from '../../../src/connectors/claude-code/client';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function makeConfig(overrides: Record<string, unknown> = {}): Parameters<typeof ClaudeCodeSync>[0] {
    return {
        enabled: true,
        org_id: 'test-org',
        api_key: 'test-key',
        ...overrides,
    };
}

function makeEntry(email: string, overrides: Partial<ClaudeCodeUsageEntry> = {}): ClaudeCodeUsageEntry {
    return {
        user_id: 'user-1',
        user_email: email,
        date: '2024-01-15',
        model: 'claude-sonnet-4-6',
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cost_usd: 0.25,
        request_count: 10,
        session_count: 2,
        tool_use_count: 5,
        tool_success_count: 4,
        commits: 1,
        prs_created: 0,
        lines_added: 80,
        lines_removed: 20,
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

function makeUsageResponse(entries: ClaudeCodeUsageEntry[], hasMore = false): ClaudeCodeUsageResponse {
    return {data: entries, has_more: hasMore, next_token: hasMore ? 'tok-next' : null};
}

function seedDev(db: Database.Database, email: string): string {
    addTeam(db, 'eng');
    const dev = addDeveloper(db, 'Alice', 'eng', email);
    linkDeveloper(db, dev.id, {claude: email});
    return dev.id;
}

function countSnapshots(db: Database.Database): number {
    const row = db.prepare('SELECT COUNT(*) as n FROM tool_snapshots').get() as {n: number};
    return row.n;
}

describe('ClaudeCodeSync', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        db.close();
    });

    it('getName returns claude_code', () => {
        expect(new ClaudeCodeSync(makeConfig()).getName()).toBe('claude_code');
    });

    it('getLastSyncTime returns null before first sync', () => {
        expect(new ClaudeCodeSync(makeConfig()).getLastSyncTime(db)).toBeNull();
    });

    it('writes snapshots for matched developers', async () => {
        const email = 'alice@company.com';
        seedDev(db, email);

        vi.stubGlobal('fetch', vi.fn(async () =>
            makeOkResponse(makeUsageResponse([makeEntry(email)]))));

        const result = await new ClaudeCodeSync(makeConfig()).sync(db);

        expect(result.errors).toHaveLength(0);
        expect(result.snapshotsWritten).toBe(1);
        expect(countSnapshots(db)).toBe(1);
    });

    it('does not create duplicates on second sync for same day', async () => {
        const email = 'alice@company.com';
        seedDev(db, email);

        vi.stubGlobal('fetch', vi.fn(async () =>
            makeOkResponse(makeUsageResponse([makeEntry(email, {date: '2024-01-15'})]))));

        const syncer = new ClaudeCodeSync(makeConfig());
        await syncer.sync(db);
        await syncer.sync(db);

        expect(countSnapshots(db)).toBe(1);
    });

    it('skips entries for unknown developers', async () => {
        vi.stubGlobal('fetch', vi.fn(async () =>
            makeOkResponse(makeUsageResponse([makeEntry('unknown@example.com')]))));

        const result = await new ClaudeCodeSync(makeConfig()).sync(db);

        expect(result.snapshotsWritten).toBe(0);
        expect(countSnapshots(db)).toBe(0);
    });

    it('handles empty response gracefully', async () => {
        vi.stubGlobal('fetch', vi.fn(async () =>
            makeOkResponse(makeUsageResponse([]))));

        const result = await new ClaudeCodeSync(makeConfig()).sync(db);

        expect(result.errors).toHaveLength(0);
        expect(result.snapshotsWritten).toBe(0);
    });

    it('records error when API call fails', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: false,
            status: 500,
            headers: {get: () => null},
        })));

        const result = await new ClaudeCodeSync(makeConfig()).sync(db);

        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain('500');
    }, 10_000);

    it('retries on 429 rate limit response', async () => {
        const email = 'alice@company.com';
        seedDev(db, email);

        let callCount = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            callCount++;
            if (callCount === 1) {
                return {ok: false, status: 429, headers: {get: () => '0'}};
            }
            return makeOkResponse(makeUsageResponse([makeEntry(email)]));
        }));

        const result = await new ClaudeCodeSync(makeConfig()).sync(db);

        expect(result.snapshotsWritten).toBe(1);
        expect(callCount).toBeGreaterThanOrEqual(2);
    }, 10_000);

    it('handles pagination — follows next_token', async () => {
        const email = 'alice@company.com';
        seedDev(db, email);

        let callCount = 0;
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            callCount++;
            if (!String(url).includes('next_token')) {
                return makeOkResponse({
                    data: [makeEntry(email, {date: '2024-01-15'})],
                    has_more: true,
                    next_token: 'tok-page2',
                });
            }
            return makeOkResponse(makeUsageResponse([makeEntry(email, {date: '2024-01-16'})]));
        }));

        const result = await new ClaudeCodeSync(makeConfig()).sync(db);

        expect(result.snapshotsWritten).toBe(2);
        expect(callCount).toBe(2);
    });

    it('returns error when org_id or api_key is missing', async () => {
        const result = await new ClaudeCodeSync({enabled: true}).sync(db);

        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain('Missing required config');
    });

    it('updates lastSyncTime after successful sync', async () => {
        vi.stubGlobal('fetch', vi.fn(async () =>
            makeOkResponse(makeUsageResponse([]))));

        const syncer = new ClaudeCodeSync(makeConfig());
        expect(syncer.getLastSyncTime(db)).toBeNull();

        await syncer.sync(db);

        expect(syncer.getLastSyncTime(db)).not.toBeNull();
    });

    it('does not advance lastSyncTime when snapshot write fails', async () => {
        const email = 'alice@company.com';
        seedDev(db, email);

        vi.stubGlobal('fetch', vi.fn(async () =>
            makeOkResponse(makeUsageResponse([makeEntry(email)]))));

        db.prepare('DROP TABLE tool_snapshots').run();
        const syncer = new ClaudeCodeSync(makeConfig());
        await syncer.sync(db);

        expect(syncer.getLastSyncTime(db)).toBeNull();
    });

    it('maps developer by email when no explicit claude link', async () => {
        addTeam(db, 'eng2');
        // Developer with just an email, no claude link
        addDeveloper(db, 'Bob', 'eng2', 'bob@company.com');

        vi.stubGlobal('fetch', vi.fn(async () =>
            makeOkResponse(makeUsageResponse([makeEntry('bob@company.com')]))));

        const result = await new ClaudeCodeSync(makeConfig()).sync(db);

        expect(result.snapshotsWritten).toBe(1);
    });

    it('passes dateFrom as YYYY-MM-DD from last sync ISO timestamp', async () => {
        const capturedUrls: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            capturedUrls.push(String(url));
            return makeOkResponse(makeUsageResponse([]));
        }));

        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
            'claude_code_last_sync',
            '2024-01-20T10:30:00.000Z',
        );

        await new ClaudeCodeSync(makeConfig()).sync(db);

        expect(capturedUrls[0]).toContain('date_from=2024-01-20');
        expect(capturedUrls[0]).not.toContain('T10%3A30');
    });

    it('correctly writes cost and tokens to snapshot', async () => {
        const email = 'alice@company.com';
        seedDev(db, email);

        vi.stubGlobal('fetch', vi.fn(async () =>
            makeOkResponse(makeUsageResponse([makeEntry(email, {cost_usd: 2.5, input_tokens: 2000, output_tokens: 800})]))));

        await new ClaudeCodeSync(makeConfig()).sync(db);

        const row = db.prepare('SELECT * FROM tool_snapshots WHERE tool = ?').get('claude_code') as {
            estimated_cost: number;
            tokens_consumed: number;
        };
        expect(row.estimated_cost).toBeCloseTo(2.5, 5);
        expect(row.tokens_consumed).toBe(2800);
    });
});
