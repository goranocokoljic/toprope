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
    ABANDONED_RUN_MIN_AGE_MS,
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

        /** A `running` row left behind `ageMs` ago, as a dead run's would be. */
        function seedOpenRow(id: string, connector: string, ageMs: number): void {
            db.prepare(
                `INSERT INTO sync_logs (id, connector, started_at, records_written, records_skipped, error_count, status)
                 VALUES (?, ?, ?, 0, 0, 0, 'running')`,
            ).run(id, connector, new Date(Date.now() - ageMs).toISOString());
        }

        const OLD = ABANDONED_RUN_MIN_AGE_MS + 60_000;

        it('pins the liveness bound as a literal, not against itself', () => {
            // The other assertions in this block probe ±60s around the constant, so they move with
            // it. Shrinking it to 2h would keep them all green while making the documented failure
            // mode reachable: a live multi-hour git sync's row flipped to `error`, and doctor /
            // /api/coverage reporting a false red for a run that is still working.
            expect(ABANDONED_RUN_MIN_AGE_MS).toBe(24 * 60 * 60 * 1000);
        });

        it('closes a row left running by a run that never returned', () => {
            seedOpenRow('abandoned', 'git', OLD);

            startSyncLog(db, 'git');

            const reaped = row(db, 'abandoned');
            expect(reaped.status).toBe('error');
            expect(reaped.finished_at).not.toBeNull();
            expect(JSON.parse(reaped.errors!)).toEqual([ABANDONED_RUN_ERROR]);
            expect(reaped.error_count).toBe(1);
        });

        it('does NOT touch a row young enough to belong to a live run', () => {
            // The reaper sees rows, not processes. Overlap is reachable — the cron fires
            // unconditionally, and `toprope sync all` can run against the same file while the
            // scheduler is mid-sync — so without an age bound a later run would flip a LIVE
            // run's row to error, and doctor / /api/coverage would report a false red.
            seedOpenRow('in-flight', 'git', 60 * 60_000);

            startSyncLog(db, 'git');

            expect(row(db, 'in-flight').status).toBe('running');
            expect(row(db, 'in-flight').finished_at).toBeNull();
        });

        it('holds the line exactly at the age boundary', () => {
            seedOpenRow('just-under', 'git', ABANDONED_RUN_MIN_AGE_MS - 60_000);
            seedOpenRow('just-over', 'git', ABANDONED_RUN_MIN_AGE_MS + 60_000);

            startSyncLog(db, 'git');

            expect(row(db, 'just-under').status).toBe('running');
            expect(row(db, 'just-over').status).toBe('error');
        });

        it('does not close the row it just opened', () => {
            seedOpenRow('abandoned', 'git', OLD);
            const current = startSyncLog(db, 'git');
            expect(row(db, current).status).toBe('running');
            expect(row(db, current).finished_at).toBeNull();
        });

        it("leaves another connector's abandoned row alone", () => {
            seedOpenRow('copilot-old', 'copilot', OLD);
            startSyncLog(db, 'git');
            expect(row(db, 'copilot-old').status).toBe('running');
        });

        it('never re-opens or overwrites an already-finalized row', () => {
            const done = startSyncLog(db, 'git');
            finishSyncLog(db, done, {records_written: 7, records_skipped: 1, errors: []});
            seedOpenRow('abandoned', 'git', OLD);

            startSyncLog(db, 'git');

            const after = row(db, done);
            expect(after.status).toBe('success');
            expect(after.errors).toBeNull();
        });

        it('closes SEVERAL abandoned rows, not just the newest', () => {
            // The real shape: four consecutive git runs left rows open.
            seedOpenRow('open-a', 'git', OLD);
            seedOpenRow('open-b', 'git', OLD + 86_400_000);
            seedOpenRow('open-c', 'git', OLD + 2 * 86_400_000);

            startSyncLog(db, 'git');

            for (const id of ['open-a', 'open-b', 'open-c']) {
                expect(row(db, id).status).toBe('error');
                expect(row(db, id).finished_at).not.toBeNull();
            }
        });

        it('an abandoned run is never counted as the last successful sync', () => {
            seedOpenRow('abandoned', 'git', OLD);
            startSyncLog(db, 'git');
            expect(getLastSuccessfulSync(db, 'git')).toBeNull();
        });

        it('a reaped row reads back through getRecentSyncLogs with its reason', () => {
            seedOpenRow('abandoned', 'git', OLD);
            startSyncLog(db, 'git');

            const log = getRecentSyncLogs(db).find((l) => l.id === 'abandoned');
            expect(log?.status).toBe('error');
            expect(log?.errors).toEqual([ABANDONED_RUN_ERROR]);
        });
    });

    describe('errors column decoding', () => {
        it('surfaces a malformed errors blob instead of throwing', () => {
            // `errors` is plain TEXT with no CHECK constraint, and this is the only decoder — a
            // single hand-edited or legacy row must not make the whole log unreadable. It used
            // to be a bare JSON.parse.
            db.prepare(
                `INSERT INTO sync_logs (id, connector, started_at, records_written, records_skipped, error_count, errors, status)
                 VALUES ('garbled', 'git', '2026-07-27T03:00:00.000Z', 0, 0, 1, 'not json', 'error')`,
            ).run();

            expect(() => getRecentSyncLogs(db)).not.toThrow();
            expect(getRecentSyncLogs(db)[0].errors).toEqual(['not json']);
        });

        it('surfaces valid JSON that is not an array rather than dropping it', () => {
            db.prepare(
                `INSERT INTO sync_logs (id, connector, started_at, records_written, records_skipped, error_count, errors, status)
                 VALUES ('objish', 'git', '2026-07-27T03:00:00.000Z', 0, 0, 1, '{"repo1":"failed"}', 'error')`,
            ).run();

            // Returning [] here would silently discard a recorded failure — the opposite of what
            // an operator reading this column needs.
            expect(getRecentSyncLogs(db)[0].errors).toEqual(['{"repo1":"failed"}']);
        });
    });
});
