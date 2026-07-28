import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {
    startSyncLog,
    finishSyncLog,
    getRecentSyncLogs,
    getLastSuccessfulSync,
    ABANDONED_RUN_ERROR,
} from '../../src/scheduler/sync-log';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

describe('sync-log', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });

    afterEach(() => {
        db.close();
    });

    it('startSyncLog inserts a running row', () => {
        const id = startSyncLog(db, 'copilot');
        expect(id).toBeTruthy();
        const row = db.prepare('SELECT * FROM sync_logs WHERE id = ?').get(id) as {status: string; connector: string};
        expect(row).toBeDefined();
        expect(row.status).toBe('running');
        expect(row.connector).toBe('copilot');
    });

    it('finishSyncLog marks success when no errors', () => {
        const id = startSyncLog(db, 'copilot');
        finishSyncLog(db, id, {records_written: 5, records_skipped: 2, errors: []});
        const row = db.prepare('SELECT * FROM sync_logs WHERE id = ?').get(id) as {
            status: string;
            records_written: number;
            records_skipped: number;
            errors: string | null;
            error_count: number;
        };
        expect(row.status).toBe('success');
        expect(row.records_written).toBe(5);
        expect(row.records_skipped).toBe(2);
        expect(row.errors).toBeNull();
        expect(row.error_count).toBe(0);
    });

    it('finishSyncLog marks error when errors present', () => {
        const id = startSyncLog(db, 'windsurf');
        finishSyncLog(db, id, {records_written: 0, records_skipped: 0, errors: ['API timeout']});
        const row = db.prepare('SELECT * FROM sync_logs WHERE id = ?').get(id) as {
            status: string;
            error_count: number;
            errors: string;
        };
        expect(row.status).toBe('error');
        expect(row.error_count).toBe(1);
        expect(JSON.parse(row.errors)).toEqual(['API timeout']);
    });

    it('getRecentSyncLogs returns logs newest first', () => {
        const id1 = startSyncLog(db, 'copilot');
        finishSyncLog(db, id1, {records_written: 1, records_skipped: 0, errors: []});
        const id2 = startSyncLog(db, 'windsurf');
        finishSyncLog(db, id2, {records_written: 2, records_skipped: 0, errors: []});

        const logs = getRecentSyncLogs(db, 10);
        expect(logs.length).toBe(2);
        // Most recent first
        expect(logs[0].id).toBe(id2);
        expect(logs[1].id).toBe(id1);
    });

    it('getRecentSyncLogs deserialises errors array', () => {
        const id = startSyncLog(db, 'git');
        finishSyncLog(db, id, {records_written: 0, records_skipped: 0, errors: ['err1', 'err2']});
        const logs = getRecentSyncLogs(db);
        expect(logs[0].errors).toEqual(['err1', 'err2']);
    });

    it('getLastSuccessfulSync returns null when none', () => {
        expect(getLastSuccessfulSync(db, 'copilot')).toBeNull();
    });

    it('getLastSuccessfulSync returns most recent success', () => {
        const id1 = startSyncLog(db, 'copilot');
        finishSyncLog(db, id1, {records_written: 1, records_skipped: 0, errors: []});
        const id2 = startSyncLog(db, 'copilot');
        finishSyncLog(db, id2, {records_written: 3, records_skipped: 0, errors: []});

        const log = getLastSuccessfulSync(db, 'copilot');
        expect(log).not.toBeNull();
        expect(log!.id).toBe(id2);
    });

    it('getLastSuccessfulSync ignores error logs', () => {
        const id = startSyncLog(db, 'copilot');
        finishSyncLog(db, id, {records_written: 0, records_skipped: 0, errors: ['fail']});
        expect(getLastSuccessfulSync(db, 'copilot')).toBeNull();
    });

    // --- Abandoned-run reaping (#272) ---
    //
    // A row is only finalized by the run that opened it, so a run that never returns leaves
    // it `running` with `finished_at: null` forever. Four such git rows were the entire
    // record of the 2026-07-28 incident. Only a later run can observe that, so a later run
    // is where it is repaired.

    describe('abandoned run reaping', () => {
        function row(db: Database.Database, id: string): {
            status: string;
            finished_at: string | null;
            error_count: number;
            errors: string | null;
        } {
            return db.prepare('SELECT * FROM sync_logs WHERE id = ?').get(id) as {
                status: string;
                finished_at: string | null;
                error_count: number;
                errors: string | null;
            };
        }

        it('closes a still-running row when the next run of the same connector starts', () => {
            const abandoned = startSyncLog(db, 'git');
            expect(row(db, abandoned).status).toBe('running');

            startSyncLog(db, 'git');

            const reaped = row(db, abandoned);
            expect(reaped.status).toBe('error');
            expect(reaped.finished_at).not.toBeNull();
            expect(JSON.parse(reaped.errors!)).toEqual([ABANDONED_RUN_ERROR]);
            expect(reaped.error_count).toBe(1);
        });

        it('does not close the row it just opened', () => {
            startSyncLog(db, 'git');
            const current = startSyncLog(db, 'git');
            expect(row(db, current).status).toBe('running');
            expect(row(db, current).finished_at).toBeNull();
        });

        it('leaves another connector"s in-flight row alone', () => {
            const copilot = startSyncLog(db, 'copilot');
            startSyncLog(db, 'git');
            expect(row(db, copilot).status).toBe('running');
        });

        it('never re-opens or overwrites an already-finalized row', () => {
            const done = startSyncLog(db, 'git');
            finishSyncLog(db, done, {records_written: 7, records_skipped: 1, errors: []});
            startSyncLog(db, 'git');

            const after = row(db, done);
            expect(after.status).toBe('success');
            expect(after.errors).toBeNull();
        });

        it('closes SEVERAL abandoned rows, not just the newest', () => {
            const first = startSyncLog(db, 'git');
            // Simulate the real shape: a second run also died, so two rows are open at once.
            db.prepare(
                `INSERT INTO sync_logs (id, connector, started_at, records_written, records_skipped, error_count, status)
                 VALUES ('second-open', 'git', '2026-07-27T03:00:00.000Z', 0, 0, 0, 'running')`,
            ).run();

            startSyncLog(db, 'git');

            expect(row(db, first).status).toBe('error');
            expect(row(db, 'second-open').status).toBe('error');
        });

        it('preserves errors the abandoned run had already recorded', () => {
            db.prepare(
                `INSERT INTO sync_logs (id, connector, started_at, records_written, records_skipped, error_count, errors, status)
                 VALUES ('partial', 'git', '2026-07-27T03:00:00.000Z', 0, 0, 1, '["repo1 fetch failed"]', 'running')`,
            ).run();

            startSyncLog(db, 'git');

            const reaped = row(db, 'partial');
            expect(JSON.parse(reaped.errors!)).toEqual(['repo1 fetch failed', ABANDONED_RUN_ERROR]);
            expect(reaped.error_count).toBe(2);
        });

        it('survives a malformed errors blob rather than throwing', () => {
            db.prepare(
                `INSERT INTO sync_logs (id, connector, started_at, records_written, records_skipped, error_count, errors, status)
                 VALUES ('garbled', 'git', '2026-07-27T03:00:00.000Z', 0, 0, 1, 'not json', 'running')`,
            ).run();

            expect(() => startSyncLog(db, 'git')).not.toThrow();
            expect(JSON.parse(row(db, 'garbled').errors!)).toEqual([ABANDONED_RUN_ERROR]);
        });

        it('an abandoned run is never counted as the last successful sync', () => {
            startSyncLog(db, 'git');
            startSyncLog(db, 'git');
            expect(getLastSuccessfulSync(db, 'git')).toBeNull();
        });
    });
});
