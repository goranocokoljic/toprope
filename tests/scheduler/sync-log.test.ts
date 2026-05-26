import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {startSyncLog, finishSyncLog, getRecentSyncLogs, getLastSuccessfulSync} from '../../src/scheduler/sync-log';

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
});
