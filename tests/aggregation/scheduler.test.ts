import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {randomUUID} from 'crypto';
import {
    AGGREGATION_CRON,
    AGGREGATION_PERIODS,
    type AggregationLogger,
    type AggregationPeriod,
    justCompletedPeriod,
    periodKeyContaining,
    runAggregationForPeriod,
    runScheduledAggregationJob,
    runScheduledJob,
} from '../../src/aggregation/scheduler';
import {openDb} from '../../src/storage/db';
import {runMigrations} from '../../src/storage/migrator';
import {makeDb, addDeveloper, addGitSnapshot, addSubscription} from './helpers';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

// Monday 2026-06-08 04:00 UTC — a representative weekly-job fire. The week that
// just closed is 2026-06-01 … 2026-06-07 (key = its Monday, 2026-06-01).
const WEEKLY_NOW = new Date('2026-06-08T04:00:00.000Z');

function count(db: Database.Database, sql: string): number {
    return (db.prepare(sql).get() as {n: number}).n;
}

/** A logger that records every lifecycle call for assertions. */
function recordingLogger(): AggregationLogger & {
    starts: AggregationPeriod[];
    successes: AggregationPeriod[];
    failures: Array<{period: AggregationPeriod; error: unknown}>;
} {
    const starts: AggregationPeriod[] = [];
    const successes: AggregationPeriod[] = [];
    const failures: Array<{period: AggregationPeriod; error: unknown}> = [];
    return {
        starts,
        successes,
        failures,
        jobStart: (period) => void starts.push(period),
        jobSuccess: (period) => void successes.push(period),
        jobFailure: (period, _key, error) => void failures.push({period, error}),
    };
}

describe('schedule wiring', () => {
    it('exposes all four levels in coarsening order', () => {
        expect(AGGREGATION_PERIODS).toEqual(['weekly', 'monthly', 'quarterly', 'yearly']);
    });

    it('uses the cron expressions from the design (UTC boundaries)', () => {
        expect(AGGREGATION_CRON).toEqual({
            weekly: '0 4 * * 1', // Monday 04:00
            monthly: '30 4 1 * *', // 1st 04:30
            quarterly: '0 5 1 1,4,7,10 *', // quarter starts 05:00
            yearly: '0 5 1 1 *', // Jan 1 05:00
        });
    });
});

describe('justCompletedPeriod', () => {
    it('weekly → the ISO week before the one now falls in', () => {
        // 2026-06-08 is a Monday; the just-closed week starts the prior Monday.
        expect(justCompletedPeriod('weekly', WEEKLY_NOW)).toBe('2026-06-01');
    });

    it('monthly → the prior calendar month', () => {
        expect(justCompletedPeriod('monthly', new Date('2026-06-01T04:30:00.000Z'))).toBe('2026-05');
    });

    it('quarterly → the prior calendar quarter (incl. year rollover)', () => {
        expect(justCompletedPeriod('quarterly', new Date('2026-04-01T05:00:00.000Z'))).toBe(
            '2026-Q1',
        );
        expect(justCompletedPeriod('quarterly', new Date('2026-01-01T05:00:00.000Z'))).toBe(
            '2025-Q4',
        );
    });

    it('yearly → the prior calendar year', () => {
        expect(justCompletedPeriod('yearly', new Date('2026-01-01T05:00:00.000Z'))).toBe('2025');
    });

    it('stays correct when the job fires a little late (mid-period now)', () => {
        // A job that fires Tuesday instead of Monday still targets the same week.
        expect(justCompletedPeriod('weekly', new Date('2026-06-09T04:00:00.000Z'))).toBe(
            '2026-06-01',
        );
    });
});

describe('periodKeyContaining', () => {
    it('maps a day to the period that contains it, per level', () => {
        expect(periodKeyContaining('weekly', '2026-06-03')).toBe('2026-06-01'); // Wed → Mon
        expect(periodKeyContaining('monthly', '2026-06-03')).toBe('2026-06');
        expect(periodKeyContaining('quarterly', '2026-06-03')).toBe('2026-Q2');
        expect(periodKeyContaining('yearly', '2026-06-03')).toBe('2026');
    });

    it('throws on a malformed date', () => {
        expect(() => periodKeyContaining('weekly', 'not-a-date')).toThrow();
    });
});

describe('runAggregationForPeriod', () => {
    let db: Database.Database;
    const NOW = new Date('2026-06-08T04:00:00.000Z');

    beforeEach(() => {
        db = makeDb();
        // One developer with two active days inside the week 2026-06-01 … 06-07.
        addDeveloper(db, 'dev-1', 'backend');
        addSubscription(db, 'dev-1', {monthly_cost: 30, seat_assigned_at: '2026-01-01'});
        addGitSnapshot(db, 'dev-1', '2026-06-02', {commits: 5, prs_merged: 2, code_churn_rate: 0.3});
        addGitSnapshot(db, 'dev-1', '2026-06-04', {commits: 3, prs_merged: 1, code_churn_rate: 0.2});
    });

    afterEach(() => db.close());

    it('writes the weekly aggregate for the targeted period', () => {
        const result = runAggregationForPeriod(db, 'weekly', '2026-06-01', NOW);

        expect(result).toEqual({period: 'weekly', periodKey: '2026-06-01', rowsWritten: 1});

        const row = db
            .prepare(
                'SELECT total_commits, total_prs_merged FROM weekly_aggregates WHERE developer_id = ? AND week_start = ?',
            )
            .get('dev-1', '2026-06-01') as {total_commits: number; total_prs_merged: number};
        // 5 + 3 commits, 2 + 1 PRs across the two active days in the week.
        expect(row.total_commits).toBe(8);
        expect(row.total_prs_merged).toBe(3);
    });

    it('is idempotent — re-running a period overwrites without duplicating', () => {
        runAggregationForPeriod(db, 'weekly', '2026-06-01', NOW);
        const first = db
            .prepare('SELECT * FROM weekly_aggregates WHERE developer_id = ? AND week_start = ?')
            .get('dev-1', '2026-06-01');

        const second = runAggregationForPeriod(db, 'weekly', '2026-06-01', NOW);
        const after = db
            .prepare('SELECT * FROM weekly_aggregates WHERE developer_id = ? AND week_start = ?')
            .get('dev-1', '2026-06-01');

        expect(second.rowsWritten).toBe(1);
        // Exactly one row, and its full contents are byte-for-byte identical.
        expect(count(db, 'SELECT COUNT(*) AS n FROM weekly_aggregates')).toBe(1);
        expect(after).toEqual(first);
    });
});

describe('runScheduledJob — manual == scheduled', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        addDeveloper(db, 'dev-1', 'backend');
        addSubscription(db, 'dev-1', {monthly_cost: 30, seat_assigned_at: '2026-01-01'});
        addGitSnapshot(db, 'dev-1', '2026-06-02', {commits: 5, prs_merged: 2, code_churn_rate: 0.3});
        addGitSnapshot(db, 'dev-1', '2026-06-04', {commits: 3, prs_merged: 1, code_churn_rate: 0.2});
    });

    afterEach(() => db.close());

    it('a scheduled fire and a manual --date run of the same period write identical rows', () => {
        const logger = recordingLogger();

        // Scheduled: fires Monday 2026-06-08, computes the just-closed week.
        const scheduled = runScheduledJob(db, 'weekly', WEEKLY_NOW, logger);
        expect(scheduled).toEqual({
            period: 'weekly',
            periodKey: '2026-06-01',
            rowsWritten: 1,
            ok: true,
        });
        const scheduledRow = db
            .prepare('SELECT * FROM weekly_aggregates WHERE developer_id = ?')
            .get('dev-1');

        // Manual: `aggregate --period weekly --date 2026-06-03` resolves to the
        // same week key, and with the same clock recomputes an identical row.
        const manualKey = periodKeyContaining('weekly', '2026-06-03');
        expect(manualKey).toBe(scheduled.periodKey);
        const manual = runAggregationForPeriod(db, 'weekly', manualKey, WEEKLY_NOW);
        const manualRow = db
            .prepare('SELECT * FROM weekly_aggregates WHERE developer_id = ?')
            .get('dev-1');

        expect(manual.rowsWritten).toBe(1);
        expect(manualRow).toEqual(scheduledRow);

        // The lifecycle was logged: one start, one success, no failures.
        expect(logger.starts).toEqual(['weekly']);
        expect(logger.successes).toEqual(['weekly']);
        expect(logger.failures).toEqual([]);
    });
});

describe('PR/review metrics hookup (Task 5.2)', () => {
    let db: Database.Database;

    function seedPRRecord(developerId: string, prId: string, createdAt: string): void {
        db.prepare(
            `INSERT INTO pr_records
             (id, developer_id, provider, repo, pr_id, state, created_at, merged_at, closed_at,
              review_comment_count, review_rounds, changes_requested_count, time_to_merge_hours, synced_at)
             VALUES (?, ?, 'github', 'repo-a', ?, 'merged', ?, ?, ?, 2, 1, 0, 24, ?)`,
        ).run(randomUUID(), developerId, prId, createdAt, createdAt, createdAt, createdAt);
    }

    beforeEach(() => {
        db = makeDb();
        addDeveloper(db, 'dev-1', 'backend');
        addSubscription(db, 'dev-1', {monthly_cost: 30, seat_assigned_at: '2026-01-01'});
        addGitSnapshot(db, 'dev-1', '2026-06-02', {commits: 5, code_churn_rate: 0.3});
    });

    afterEach(() => db.close());

    it('the weekly job computes pr_review_metrics for the just-closed ISO week', () => {
        // Week 2026-06-01 … 06-07 = ISO week 2026-W23.
        seedPRRecord('dev-1', '1', '2026-06-02T08:00:00.000Z');

        const result = runScheduledJob(db, 'weekly', WEEKLY_NOW, recordingLogger());

        expect(result.ok).toBe(true);
        const rows = db
            .prepare("SELECT scope_variant FROM pr_review_metrics WHERE period = '2026-W23'")
            .all() as Array<{scope_variant: string}>;
        expect(rows.map((r) => r.scope_variant).sort()).toEqual(['ai_assisted_pr', 'all_pr']);
    });

    it('the weekly job also recomputes trailing weeks so late-arriving verdicts land', () => {
        // 2026-05-27 falls in ISO week 2026-W22 — one week before the
        // just-closed W23. The trailing recompute must re-fold it.
        seedPRRecord('dev-1', '1', '2026-05-27T08:00:00.000Z');

        const result = runScheduledJob(db, 'weekly', WEEKLY_NOW, recordingLogger());

        expect(result.ok).toBe(true);
        expect(
            count(db, "SELECT COUNT(*) AS n FROM pr_review_metrics WHERE period = '2026-W22'"),
        ).toBe(2);
    });

    it('the monthly job computes pr_review_metrics for the just-closed month', () => {
        seedPRRecord('dev-1', '2', '2026-05-15T08:00:00.000Z');

        const result = runScheduledJob(
            db,
            'monthly',
            new Date('2026-06-01T04:30:00.000Z'),
            recordingLogger(),
        );

        expect(result.ok).toBe(true);
        expect(
            count(db, "SELECT COUNT(*) AS n FROM pr_review_metrics WHERE period = '2026-05'"),
        ).toBe(2);
    });

    it('quarterly and yearly jobs do not compute PR/review metrics', () => {
        seedPRRecord('dev-1', '3', '2026-05-15T08:00:00.000Z');

        runScheduledJob(db, 'quarterly', new Date('2026-07-01T05:00:00.000Z'), recordingLogger());
        runScheduledJob(db, 'yearly', new Date('2027-01-01T05:00:00.000Z'), recordingLogger());

        expect(count(db, 'SELECT COUNT(*) AS n FROM pr_review_metrics')).toBe(0);
    });
});

describe('error isolation', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });

    afterEach(() => {
        if (db.open) db.close();
    });

    it('a job whose compute throws is caught, logged, and never re-thrown', () => {
        const logger = recordingLogger();

        // Force a real failure through the actual compute path: a closed DB makes
        // runAggregationForPeriod's transaction throw. No injected runner — this is
        // the genuine production path failing. The call returning at all (rather
        // than throwing) is the isolation contract.
        db.close();

        const result = runScheduledJob(db, 'monthly', WEEKLY_NOW, logger);

        expect(result).toMatchObject({period: 'monthly', ok: false, rowsWritten: 0});
        expect(result.error).toBeTruthy();
        // The lifecycle was logged: started, then failed (no success).
        expect(logger.starts).toEqual(['monthly']);
        expect(logger.successes).toEqual([]);
        expect(logger.failures.map((f) => f.period)).toEqual(['monthly']);
    });

    it('a healthy job and a failing job are independent (one failing leaves the other green)', () => {
        // Healthy level succeeds.
        const healthy = runScheduledJob(db, 'weekly', WEEKLY_NOW, recordingLogger());
        expect(healthy.ok).toBe(true);

        // A second, broken level (closed DB) fails in isolation — the first
        // remains committed and unaffected.
        db.close();
        const broken = runScheduledJob(db, 'yearly', WEEKLY_NOW, recordingLogger());
        expect(broken.ok).toBe(false);
    });
});

describe('idempotency across a full scheduled run', () => {
    let db: Database.Database;

    /** Run all four levels in sequence with per-job isolation, as the four cron tasks do. */
    function runAllLevels(): void {
        for (const period of AGGREGATION_PERIODS) {
            runScheduledJob(db, period, WEEKLY_NOW, recordingLogger());
        }
    }

    beforeEach(() => {
        db = makeDb();
        addDeveloper(db, 'dev-1', 'backend');
        addSubscription(db, 'dev-1', {monthly_cost: 30, seat_assigned_at: '2026-01-01'});
        addGitSnapshot(db, 'dev-1', '2026-06-02', {commits: 5, prs_merged: 2, code_churn_rate: 0.3});
    });

    afterEach(() => db.close());

    it('re-running every level twice leaves one row per period with identical values', () => {
        runAllLevels();
        const firstWeekly = db.prepare('SELECT * FROM weekly_aggregates').all();
        const firstMonthly = db.prepare('SELECT * FROM monthly_aggregates').all();

        runAllLevels();

        // No duplication: one developer → one weekly/monthly row, one team → one
        // quarterly/yearly row.
        expect(count(db, 'SELECT COUNT(*) AS n FROM weekly_aggregates')).toBe(1);
        expect(count(db, 'SELECT COUNT(*) AS n FROM monthly_aggregates')).toBe(1);
        expect(count(db, 'SELECT COUNT(*) AS n FROM quarterly_aggregates')).toBe(1);
        expect(count(db, 'SELECT COUNT(*) AS n FROM yearly_aggregates')).toBe(1);

        // And the values are unchanged by the second run.
        expect(db.prepare('SELECT * FROM weekly_aggregates').all()).toEqual(firstWeekly);
        expect(db.prepare('SELECT * FROM monthly_aggregates').all()).toEqual(firstMonthly);
    });
});

describe('runScheduledAggregationJob — the production cron-fire path', () => {
    let dbPath: string;

    beforeEach(() => {
        // A real on-disk DB so the function can open its own short-lived handle,
        // exactly as a cron fire does.
        dbPath = path.join(os.tmpdir(), `govproxy-sched-${randomUUID()}.db`);
        const seed = openDb(dbPath);
        try {
            runMigrations(seed, MIGRATIONS_DIR);
            addDeveloper(seed, 'dev-1', 'backend');
            addSubscription(seed, 'dev-1', {monthly_cost: 30, seat_assigned_at: '2026-01-01'});
            addGitSnapshot(seed, 'dev-1', '2026-06-02', {
                commits: 5,
                prs_merged: 2,
                code_churn_rate: 0.3,
            });
        } finally {
            seed.close();
        }
    });

    afterEach(() => {
        for (const suffix of ['', '-wal', '-shm']) {
            fs.rmSync(`${dbPath}${suffix}`, {force: true});
        }
    });

    it('opens, migrates, computes the just-completed period, and closes', () => {
        const logger = recordingLogger();
        const result = runScheduledAggregationJob(dbPath, 'weekly', {
            now: () => WEEKLY_NOW,
            migrationsDir: MIGRATIONS_DIR,
            logger,
        });

        expect(result).toMatchObject({
            period: 'weekly',
            periodKey: '2026-06-01',
            rowsWritten: 1,
            ok: true,
        });
        expect(logger.successes).toEqual(['weekly']);

        // The row really landed, and the handle was released (we can reopen it).
        const check = openDb(dbPath);
        try {
            const row = check
                .prepare('SELECT total_commits FROM weekly_aggregates WHERE week_start = ?')
                .get('2026-06-01') as {total_commits: number};
            expect(row.total_commits).toBe(5);
        } finally {
            check.close();
        }
    });

    it('returns null and logs when the DB cannot be opened, without throwing', () => {
        const logger = recordingLogger();
        // A directory path cannot be opened as a SQLite file → openDb throws.
        // Returning null (rather than throwing) is the isolation contract.
        const badPath = os.tmpdir();

        const result = runScheduledAggregationJob(badPath, 'monthly', {
            now: () => WEEKLY_NOW,
            migrationsDir: MIGRATIONS_DIR,
            logger,
        });

        expect(result).toBeNull();
        expect(logger.failures.map((f) => f.period)).toEqual(['monthly']);
        // It never reached a successful compute.
        expect(logger.successes).toEqual([]);
    });
});
