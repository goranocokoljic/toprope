import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {runPipeline} from '../../src/scheduler/sync-pipeline';
import {getRecentSyncLogs} from '../../src/scheduler/sync-log';
import type {ConnectorInterface, SyncResult} from '../../src/connectors/types';
import {UNMATCHED_AUTHORS_PREFIX} from '../../src/connectors/git/sync';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function makeConnector(
    name: string,
    opts: {errors?: string[]; snapshotsWritten?: number; throws?: boolean} = {},
): ConnectorInterface {
    return {
        getName: () => name,
        getLastSyncTime: () => null,
        sync: async () => {
            if (opts.throws) throw new Error(`${name} threw unexpectedly`);
            return {
                connector: name,
                snapshotsWritten: opts.snapshotsWritten ?? 0,
                snapshotsSkipped: 0,
                errors: opts.errors ?? [],
                lastSyncTime: new Date().toISOString(),
            } satisfies SyncResult;
        },
    };
}

function makeFailThenSucceedConnector(name: string, snapshotsWritten = 1): ConnectorInterface {
    let calls = 0;
    return {
        getName: () => name,
        getLastSyncTime: () => null,
        sync: async () => {
            calls++;
            if (calls === 1) {
                return {
                    connector: name,
                    snapshotsWritten: 0,
                    snapshotsSkipped: 0,
                    errors: ['transient error'],
                    lastSyncTime: new Date().toISOString(),
                };
            }
            return {
                connector: name,
                snapshotsWritten,
                snapshotsSkipped: 0,
                errors: [],
                lastSyncTime: new Date().toISOString(),
            };
        },
    };
}

describe('runPipeline', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        vi.useFakeTimers();
    });

    afterEach(() => {
        db.close();
        vi.useRealTimers();
    });

    it('returns one result per connector', async () => {
        const connectors = [
            makeConnector('copilot', {snapshotsWritten: 2}),
            makeConnector('windsurf', {snapshotsWritten: 3}),
        ];
        const promise = runPipeline(db, connectors, 0);
        await vi.runAllTimersAsync();
        const results = await promise;
        expect(results).toHaveLength(2);
        expect(results[0].connector).toBe('copilot');
        expect(results[1].connector).toBe('windsurf');
    });

    it('continues pipeline when a connector fails', async () => {
        const connectors = [
            makeConnector('copilot', {errors: ['API error']}),
            makeConnector('windsurf', {snapshotsWritten: 5}),
        ];
        const promise = runPipeline(db, connectors, 0);
        await vi.runAllTimersAsync();
        const results = await promise;

        expect(results).toHaveLength(2);
        expect(results[0].result.errors).toContain('API error');
        expect(results[1].result.snapshotsWritten).toBe(5);
        expect(results[1].result.errors).toHaveLength(0);
    });

    it('continues pipeline when a connector throws unexpectedly', async () => {
        const connectors = [
            makeConnector('copilot', {throws: true}),
            makeConnector('windsurf', {snapshotsWritten: 3}),
        ];
        const promise = runPipeline(db, connectors, 0);
        await vi.runAllTimersAsync();
        const results = await promise;

        expect(results[0].result.errors[0]).toContain('copilot threw unexpectedly');
        expect(results[1].result.snapshotsWritten).toBe(3);

        // Verify the throwing connector's log is finalized (not left 'running')
        const logs = getRecentSyncLogs(db);
        const copilotLog = logs.find((l) => l.connector === 'copilot');
        expect(copilotLog?.status).toBe('error');
        expect(copilotLog?.finished_at).not.toBeNull();
    });

    it('retries a throwing connector (throw counts as failure)', async () => {
        let calls = 0;
        const connector: ConnectorInterface = {
            getName: () => 'copilot',
            getLastSyncTime: () => null,
            sync: async () => {
                calls++;
                if (calls === 1) throw new Error('transient throw');
                return {connector: 'copilot', snapshotsWritten: 2, snapshotsSkipped: 0, errors: [], lastSyncTime: new Date().toISOString()};
            },
        };
        const promise = runPipeline(db, [connector], 100);
        await vi.runAllTimersAsync();
        const results = await promise;

        expect(calls).toBe(2);
        expect(results[0].retried).toBe(true);
        expect(results[0].result.errors).toHaveLength(0);
        expect(results[0].result.snapshotsWritten).toBe(2);
    });

    it('retries failed connector once', async () => {
        const connector = makeFailThenSucceedConnector('copilot', 2);
        const promise = runPipeline(db, [connector], 100);
        await vi.runAllTimersAsync();
        const results = await promise;

        expect(results[0].retried).toBe(true);
        expect(results[0].result.errors).toHaveLength(0);
        expect(results[0].result.snapshotsWritten).toBe(2);
    });

    it('does NOT retry, and logs SUCCESS, when the only errors are advisories (TST-2)', async () => {
        // `SyncResult.errors` carries advisories as well as failures. Unmatched CI bots and
        // external contributors are the steady state of a healthy repo, so keying either
        // the retry or the log status off `errors.length` meant every scheduled sync of
        // essentially every real deployment did a SECOND complete network fetch and was
        // recorded red — forever, with nothing wrong.
        let calls = 0;
        const connector: ConnectorInterface = {
            getName: () => 'git',
            getLastSyncTime: () => null,
            sync: async () => {
                calls++;
                return {
                    connector: 'git',
                    snapshotsWritten: 3,
                    snapshotsSkipped: 0,
                    errors: [`${UNMATCHED_AUTHORS_PREFIX} github:dependabot[bot]`],
                    lastSyncTime: new Date().toISOString(),
                } satisfies SyncResult;
            },
        };

        const promise = runPipeline(db, [connector], 100);
        await vi.runAllTimersAsync();
        const results = await promise;

        // Fetched once, not twice.
        expect(calls).toBe(1);
        expect(results[0].retried).toBe(false);
        // The advisory is still RECORDED — it is information, not noise…
        expect(results[0].result.errors).toHaveLength(1);
        // …but the run is green, and its snapshots counted.
        const logs = getRecentSyncLogs(db);
        expect(logs[0].status).toBe('success');
        expect(logs[0].records_written).toBe(3);
    });

    it('still retries and logs error when a genuine failure accompanies an advisory (TST-2)', async () => {
        // The other direction: an advisory must not mask a real failure sitting beside it.
        let calls = 0;
        const connector: ConnectorInterface = {
            getName: () => 'git',
            getLastSyncTime: () => null,
            sync: async () => {
                calls++;
                return {
                    connector: 'git',
                    snapshotsWritten: 0,
                    snapshotsSkipped: 0,
                    errors: [
                        `${UNMATCHED_AUTHORS_PREFIX} github:dependabot[bot]`,
                        'GitHub API error 401: bad token',
                    ],
                    lastSyncTime: new Date().toISOString(),
                } satisfies SyncResult;
            },
        };

        const promise = runPipeline(db, [connector], 100);
        await vi.runAllTimersAsync();
        const results = await promise;

        expect(calls).toBe(2);
        expect(results[0].retried).toBe(true);
        expect(getRecentSyncLogs(db)[0].status).toBe('error');
    });

    it('logs sync run to database', async () => {
        const connectors = [makeConnector('copilot', {snapshotsWritten: 1})];
        const promise = runPipeline(db, connectors, 0);
        await vi.runAllTimersAsync();
        await promise;

        const logs = getRecentSyncLogs(db);
        expect(logs).toHaveLength(1);
        expect(logs[0].connector).toBe('copilot');
        expect(logs[0].status).toBe('success');
        expect(logs[0].records_written).toBe(1);
    });

    it('logs error status when all retries fail', async () => {
        const connectors = [makeConnector('copilot', {errors: ['persistent failure']})];
        const promise = runPipeline(db, connectors, 0);
        await vi.runAllTimersAsync();
        const results = await promise;

        const logs = getRecentSyncLogs(db);
        expect(logs[0].status).toBe('error');
        expect(results[0].retried).toBe(true);
        expect(results[0].result.errors).toContain('persistent failure');
    });

    it('preserves connector order in results', async () => {
        const connectors = [
            makeConnector('copilot'),
            makeConnector('claude_code'),
            makeConnector('windsurf'),
            makeConnector('git'),
        ];
        const promise = runPipeline(db, connectors, 0);
        await vi.runAllTimersAsync();
        const results = await promise;

        expect(results.map((r) => r.connector)).toEqual(['copilot', 'claude_code', 'windsurf', 'git']);
    });

    it('does not duplicate snapshots when re-running for same period', async () => {
        // The pipeline itself does not write snapshots directly — the connectors do.
        // Duplicate prevention is in each connector's upsert logic.
        // Here we verify that running pipeline twice writes logs for each run.
        const connectors = [makeConnector('copilot', {snapshotsWritten: 1})];

        const p1 = runPipeline(db, connectors, 0);
        await vi.runAllTimersAsync();
        await p1;

        const p2 = runPipeline(db, connectors, 0);
        await vi.runAllTimersAsync();
        await p2;

        const logs = getRecentSyncLogs(db);
        expect(logs).toHaveLength(2);
    });

    // --- Terminal log rows (#272) ---
    //
    // The git connector's rows sat at status 'running' with finished_at: null forever, so the
    // one place an operator looks for a failed run's collected errors was empty. Two causes:
    // a single row spanned both attempts (staying open across the retry pause and a second
    // multi-hour fetch), and nothing ever closed a row whose run did not return.

    describe('log row finalization', () => {
        it('gives each attempt its own finalized row', async () => {
            const connector = makeFailThenSucceedConnector('git', 4);
            const promise = runPipeline(db, [connector], 100);
            await vi.runAllTimersAsync();
            const results = await promise;

            expect(results[0].retried).toBe(true);
            const logs = getRecentSyncLogs(db).filter((l) => l.connector === 'git');
            expect(logs).toHaveLength(2);
            // Both terminal — neither is left 'running' while the other runs.
            expect(logs.every((l) => l.status !== 'running')).toBe(true);
            expect(logs.every((l) => l.finished_at !== null)).toBe(true);
            // Newest first: the successful retry, then the failed first attempt WITH its
            // errors durably recorded (they used to be lost if the process died mid-retry).
            expect(logs[0].status).toBe('success');
            expect(logs[0].records_written).toBe(4);
            expect(logs[1].status).toBe('error');
            expect(logs[1].errors).toEqual(['transient error']);
        });

        it('finalizes the row even when the connector throws on both attempts', async () => {
            const connector = makeConnector('git', {throws: true});
            const promise = runPipeline(db, [connector], 0);
            await vi.runAllTimersAsync();
            await promise;

            const logs = getRecentSyncLogs(db).filter((l) => l.connector === 'git');
            expect(logs).toHaveLength(2);
            expect(logs.every((l) => l.status === 'error' && l.finished_at !== null)).toBe(true);
            expect(logs[0].errors).toEqual(['git threw unexpectedly']);
        });

        it('closes out a previous run that never finished', async () => {
            // The observed state: a scheduled git run that never returned.
            db.prepare(
                `INSERT INTO sync_logs (id, connector, started_at, records_written, records_skipped, error_count, status)
                 VALUES ('abandoned', 'git', '2026-07-28T03:00:00.000Z', 0, 0, 0, 'running')`,
            ).run();

            const promise = runPipeline(db, [makeConnector('git', {snapshotsWritten: 1})], 0);
            await vi.runAllTimersAsync();
            await promise;

            const abandoned = getRecentSyncLogs(db).find((l) => l.id === 'abandoned');
            expect(abandoned?.status).toBe('error');
            expect(abandoned?.finished_at).not.toBeNull();
            expect(abandoned?.errors?.[0]).toContain('Run did not finish');
        });
    });

    it('non-retried success sets retried to false', async () => {
        const connectors = [makeConnector('windsurf', {snapshotsWritten: 3})];
        const promise = runPipeline(db, connectors, 0);
        await vi.runAllTimersAsync();
        const results = await promise;

        expect(results[0].retried).toBe(false);
    });
});
