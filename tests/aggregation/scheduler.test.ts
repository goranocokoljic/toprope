import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import {
    AGGREGATION_CRON,
    AGGREGATION_PERIODS,
    type AggregationLogger,
    type AggregationPeriod,
    justCompletedPeriod,
    periodKeyContaining,
    runAggregationForPeriod,
    runScheduledJob,
    runScheduledJobs,
} from '../../src/aggregation/scheduler';
import {makeDb, addDeveloper, addGitSnapshot, addSubscription} from './helpers';

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

describe('error isolation', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });

    afterEach(() => db.close());

    it('a failing job is caught, logged, and does not stop the others', () => {
        const logger = recordingLogger();

        // A runner that blows up only for the monthly level.
        const flakyRunner = vi.fn((_db, period: AggregationPeriod, periodKey: string) => {
            if (period === 'monthly') {
                throw new Error('boom');
            }
            return {period, periodKey, rowsWritten: 1};
        });

        const results = runScheduledJobs(db, AGGREGATION_PERIODS, WEEKLY_NOW, logger, flakyRunner);

        // All four ran; only monthly failed.
        const byPeriod = Object.fromEntries(results.map((r) => [r.period, r]));
        expect(byPeriod.weekly.ok).toBe(true);
        expect(byPeriod.monthly.ok).toBe(false);
        expect(byPeriod.monthly.error).toBe('boom');
        expect(byPeriod.monthly.rowsWritten).toBe(0);
        expect(byPeriod.quarterly.ok).toBe(true);
        expect(byPeriod.yearly.ok).toBe(true);

        // The runner was still invoked for every level despite monthly throwing.
        expect(flakyRunner).toHaveBeenCalledTimes(4);

        // Logging reflects the isolation: every job started, three succeeded, one failed.
        expect(logger.starts).toEqual(['weekly', 'monthly', 'quarterly', 'yearly']);
        expect(logger.successes).toEqual(['weekly', 'quarterly', 'yearly']);
        expect(logger.failures.map((f) => f.period)).toEqual(['monthly']);
    });

    it('runScheduledJob never throws even when the runner throws', () => {
        const throwingRunner = (): never => {
            throw new Error('db gone');
        };
        expect(() =>
            runScheduledJob(db, 'yearly', WEEKLY_NOW, recordingLogger(), throwingRunner),
        ).not.toThrow();
    });
});

describe('idempotency across a full scheduled run', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        addDeveloper(db, 'dev-1', 'backend');
        addSubscription(db, 'dev-1', {monthly_cost: 30, seat_assigned_at: '2026-01-01'});
        addGitSnapshot(db, 'dev-1', '2026-06-02', {commits: 5, prs_merged: 2, code_churn_rate: 0.3});
    });

    afterEach(() => db.close());

    it('re-running every level twice leaves one row per period with identical values', () => {
        runScheduledJobs(db, AGGREGATION_PERIODS, WEEKLY_NOW, recordingLogger());
        const firstWeekly = db.prepare('SELECT * FROM weekly_aggregates').all();
        const firstMonthly = db.prepare('SELECT * FROM monthly_aggregates').all();

        runScheduledJobs(db, AGGREGATION_PERIODS, WEEKLY_NOW, recordingLogger());

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
