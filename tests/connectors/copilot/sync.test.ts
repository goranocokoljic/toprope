import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper, linkDeveloper} from '../../../src/registry/developers';
import {CopilotSync} from '../../../src/connectors/copilot/sync';
import type {CopilotUserMetrics, CopilotSeat, CopilotSeatsResponse} from '../../../src/connectors/copilot/client';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function makeConfig(overrides: Record<string, unknown> = {}): Parameters<typeof CopilotSync>[0] {
    return {
        enabled: true,
        github_org: 'test-org',
        api_token: 'test-token',
        ...overrides,
    };
}

function makeMetrics(login: string, date = '2024-01-15'): CopilotUserMetrics {
    return {
        login,
        date,
        total_suggestions_count: 80,
        total_acceptances_count: 40,
        total_lines_suggested: 400,
        total_lines_accepted: 200,
        total_active_chat_count: 5,
        total_chat_insertion_events: 2,
        total_chat_copy_events: 1,
        breakdown: [{model: 'gpt-4o', acceptances_count: 40}],
    };
}

function makeSeat(login: string, lastActivity: string | null = null): CopilotSeat {
    return {
        login,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        pending_cancellation_date: null,
        last_activity_at: lastActivity,
        last_activity_editor: null,
        plan_type: 'copilot_business',
        assignee: {login},
        assigning_team: null,
    };
}

function seedDev(db: Database.Database, login: string): string {
    addTeam(db, 'eng');
    const dev = addDeveloper(db, 'Alice', 'eng', 'alice@test.com', login);
    linkDeveloper(db, dev.id, {copilot: login});
    return dev.id;
}

function countSnapshots(db: Database.Database): number {
    const row = db.prepare('SELECT COUNT(*) as n FROM tool_snapshots').get() as {n: number};
    return row.n;
}

describe('CopilotSync', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        db.close();
    });

    it('getName returns copilot', () => {
        const syncer = new CopilotSync(makeConfig());
        expect(syncer.getName()).toBe('copilot');
    });

    it('getLastSyncTime returns null before first sync', () => {
        const syncer = new CopilotSync(makeConfig());
        expect(syncer.getLastSyncTime(db)).toBeNull();
    });

    it('writes snapshots for matched developers', async () => {
        const login = 'alice';
        seedDev(db, login);

        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => {
                if (String(url).includes('billing/seats')) {
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({total_seats: 1, seats: [makeSeat(login, new Date().toISOString())]} satisfies CopilotSeatsResponse),
                    };
                }
                return {
                    ok: true,
                    status: 200,
                    json: async () => [makeMetrics(login)],
                };
            }),
        );

        const syncer = new CopilotSync(makeConfig());
        const result = await syncer.sync(db);

        expect(result.errors).toHaveLength(0);
        expect(result.snapshotsWritten).toBe(1);
        expect(countSnapshots(db)).toBe(1);
    });

    it('does not create duplicates on second sync for same day', async () => {
        const login = 'alice';
        seedDev(db, login);

        const fakeFetch = vi.fn(async (url: string) => {
            if (String(url).includes('billing/seats')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({total_seats: 1, seats: [makeSeat(login, new Date().toISOString())]} satisfies CopilotSeatsResponse),
                };
            }
            return {
                ok: true,
                status: 200,
                json: async () => [makeMetrics(login, '2024-01-15')],
            };
        });
        vi.stubGlobal('fetch', fakeFetch);

        const syncer = new CopilotSync(makeConfig());
        await syncer.sync(db);
        await syncer.sync(db);

        expect(countSnapshots(db)).toBe(1);
    });

    it('skips metrics for unknown developers', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => {
                if (String(url).includes('billing/seats')) {
                    return {ok: true, status: 200, json: async () => ({total_seats: 0, seats: []})};
                }
                return {
                    ok: true,
                    status: 200,
                    json: async () => [makeMetrics('unknown-user')],
                };
            }),
        );

        const syncer = new CopilotSync(makeConfig());
        const result = await syncer.sync(db);

        expect(result.snapshotsWritten).toBe(0);
        expect(countSnapshots(db)).toBe(0);
    });

    it('handles empty org metrics gracefully', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => {
                if (String(url).includes('billing/seats')) {
                    return {ok: true, status: 200, json: async () => ({total_seats: 0, seats: []})};
                }
                return {ok: true, status: 200, json: async () => []};
            }),
        );

        const syncer = new CopilotSync(makeConfig());
        const result = await syncer.sync(db);

        expect(result.errors).toHaveLength(0);
        expect(result.snapshotsWritten).toBe(0);
    });

    it('records error and returns partial result when metrics API fails', async () => {
        const login = 'alice';
        seedDev(db, login);

        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => {
                if (String(url).includes('billing/seats')) {
                    return {ok: true, status: 200, json: async () => ({total_seats: 1, seats: [makeSeat(login)]})};
                }
                return {ok: false, status: 500, text: async () => 'Internal Server Error'};
            }),
        );

        const syncer = new CopilotSync(makeConfig());
        const result = await syncer.sync(db);

        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain('500');
        expect(countSnapshots(db)).toBe(0);
    });

    it('retries on 429 rate limit response', async () => {
        const login = 'alice';
        seedDev(db, login);

        let callCount = 0;
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => {
                if (String(url).includes('billing/seats')) {
                    return {ok: true, status: 200, json: async () => ({total_seats: 0, seats: []})};
                }
                callCount++;
                if (callCount === 1) {
                    return {
                        ok: false,
                        status: 429,
                        headers: {get: () => '0'},
                        json: async () => ({}),
                    };
                }
                return {ok: true, status: 200, json: async () => [makeMetrics(login)]};
            }),
        );

        const syncer = new CopilotSync(makeConfig());
        const result = await syncer.sync(db);

        expect(result.snapshotsWritten).toBe(1);
        expect(callCount).toBeGreaterThanOrEqual(2);
    }, 10_000);

    it('handles malformed API response without crashing', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => {
                if (String(url).includes('billing/seats')) {
                    return {ok: true, status: 200, json: async () => ({total_seats: 0, seats: []})};
                }
                return {
                    ok: true,
                    status: 200,
                    json: async () => [{login: 'alice', date: '2024-01-15'}],
                };
            }),
        );

        const syncer = new CopilotSync(makeConfig());

        await expect(syncer.sync(db)).resolves.toBeDefined();
    });

    it('returns error result when org or token is missing', async () => {
        const syncer = new CopilotSync({enabled: true});
        const result = await syncer.sync(db);

        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain('Missing required config');
    });

    it('updates lastSyncTime after successful sync', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => {
                if (String(url).includes('billing/seats')) {
                    return {ok: true, status: 200, json: async () => ({total_seats: 0, seats: []})};
                }
                return {ok: true, status: 200, json: async () => []};
            }),
        );

        const syncer = new CopilotSync(makeConfig());
        expect(syncer.getLastSyncTime(db)).toBeNull();

        await syncer.sync(db);

        expect(syncer.getLastSyncTime(db)).not.toBeNull();
    });

    it('correctly calculates acceptance_rate in written snapshot', async () => {
        const login = 'alice';
        seedDev(db, login);

        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => {
                if (String(url).includes('billing/seats')) {
                    return {ok: true, status: 200, json: async () => ({total_seats: 1, seats: [makeSeat(login, new Date().toISOString())]})};
                }
                return {
                    ok: true,
                    status: 200,
                    json: async () => [makeMetrics(login)],
                };
            }),
        );

        const syncer = new CopilotSync(makeConfig());
        await syncer.sync(db);

        const row = db
            .prepare('SELECT * FROM tool_snapshots WHERE tool = ?')
            .get('copilot') as {acceptance_rate: number; interaction_count: number; acceptance_count: number};

        expect(row.interaction_count).toBe(80);
        expect(row.acceptance_count).toBe(40);
        expect(row.acceptance_rate).toBeCloseTo(0.5, 5);
    });
});
