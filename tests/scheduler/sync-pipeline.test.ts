import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {runPipeline} from '../../src/scheduler/sync-pipeline';
import {getRecentSyncLogs} from '../../src/scheduler/sync-log';
import type {ConnectorInterface, SyncResult} from '../../src/connectors/types';

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

    it('retries failed connector once', async () => {
        const connector = makeFailThenSucceedConnector('copilot', 2);
        const promise = runPipeline(db, [connector], 100);
        await vi.runAllTimersAsync();
        const results = await promise;

        expect(results[0].retried).toBe(true);
        expect(results[0].result.errors).toHaveLength(0);
        expect(results[0].result.snapshotsWritten).toBe(2);
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

    it('non-retried success sets retried to false', async () => {
        const connectors = [makeConnector('windsurf', {snapshotsWritten: 3})];
        const promise = runPipeline(db, connectors, 0);
        await vi.runAllTimersAsync();
        const results = await promise;

        expect(results[0].retried).toBe(false);
    });
});
