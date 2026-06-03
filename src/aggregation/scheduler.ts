/**
 * Aggregation scheduling (Task 3.6 / #75).
 *
 * Automates rollup computation at period boundaries via node-cron so trend
 * aggregates stay current without manual intervention. There are four scheduled
 * jobs, each firing just after its period closes and computing the period that
 * just completed (design §3.4):
 *
 *   Weekly:    Monday      04:00 UTC — the prior ISO week
 *   Monthly:   1st         04:30 UTC — the prior calendar month
 *   Quarterly: quarter 1st 05:00 UTC — the prior calendar quarter
 *   Yearly:    Jan 1       05:00 UTC — the prior calendar year
 *
 * The 04:00+ slots sit deliberately after the Phase 1 connector syncs (which
 * default to 02:00–03:30, see src/scheduler/scheduler.ts), so each aggregation
 * job folds a daily-snapshot table the day's sync has already populated.
 *
 * Three properties the design leans on, and how they hold here:
 *
 *   - Idempotency. Every level's rollup UPSERTs by its unique period key from the
 *     immutable daily snapshots, so re-running any job for any period recomputes
 *     and overwrites rather than duplicating. A missed or retried fire is safe.
 *
 *   - Manual == scheduled. The scheduled job and the `govproxy aggregate
 *     --period <p>` CLI both funnel through runAggregationForPeriod with the same
 *     period key, so a manual trigger reproduces a scheduled run exactly (a bare
 *     manual run targets the same just-completed period; `--date` targets any
 *     historical period for backfill/testing).
 *
 *   - Error isolation. Each job runs inside runScheduledJob, which catches and
 *     logs its own failure and never throws, so one job blowing up (bad data, a
 *     transient DB error) neither crashes the scheduler nor stops the other three
 *     jobs — they are independent cron tasks regardless, but the catch keeps a
 *     failure from escaping into node-cron's handler and being swallowed silently.
 */

import cron from 'node-cron';
import path from 'path';
import type Database from 'better-sqlite3';
import {openDb} from '../storage/db';
import {runMigrations} from '../storage/migrator';
import {
    isoWeekStart,
    monthOf,
    quarterOf,
    yearOf,
    priorWeekStart,
    priorMonth,
    priorQuarter,
    priorYear,
} from './dates';
import {computeAllWeeklyAggregates} from './weekly';
import {computeAllMonthlyAggregates} from './monthly';
import {computeAllQuarterlyAggregates} from './quarterly';
import {computeAllYearlyAggregates} from './yearly';

export type AggregationPeriod = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

/** All four levels in coarsening order — the iteration order for "run everything". */
export const AGGREGATION_PERIODS: readonly AggregationPeriod[] = [
    'weekly',
    'monthly',
    'quarterly',
    'yearly',
] as const;

/**
 * Cron expressions (UTC) for each level's boundary, per design §3.4. Minute,
 * hour, day-of-month, month, day-of-week.
 */
export const AGGREGATION_CRON: Record<AggregationPeriod, string> = {
    weekly: '0 4 * * 1', // Monday 04:00
    monthly: '30 4 1 * *', // 1st of the month 04:30
    quarterly: '0 5 1 1,4,7,10 *', // 1st of Jan/Apr/Jul/Oct 05:00
    yearly: '0 5 1 1 *', // Jan 1 05:00
};

/** Narrows an exhausted switch so an added period can't silently fall through. */
function assertNever(value: never): never {
    throw new Error(`Unhandled aggregation period: ${String(value)}`);
}

/** Today's date as a YYYY-MM-DD key in UTC — the keying the rollups expect. */
function dayKey(now: Date): string {
    return now.toISOString().slice(0, 10);
}

/**
 * The period key (week_start / YYYY-MM / YYYY-Q[1-4] / YYYY) of the period that
 * *contains* `date` (a YYYY-MM-DD day). Used by the manual `--date` trigger to
 * target the period a given day falls in.
 */
export function periodKeyContaining(period: AggregationPeriod, date: string): string {
    switch (period) {
        case 'weekly':
            return isoWeekStart(date);
        case 'monthly':
            return monthOf(date);
        case 'quarterly':
            return quarterOf(date);
        case 'yearly':
            return yearOf(date);
        default:
            return assertNever(period);
    }
}

/**
 * The period key of the just-completed period relative to `now` — i.e. the period
 * immediately before the one `now` falls in. This is what a scheduled job
 * computes: it fires at the *start* of a new period (Monday / the 1st / Jan 1),
 * so the period that just closed is the prior one. Deriving it from `now`'s own
 * period (rather than `now − epsilon`) keeps the result correct even if the job
 * fires a little late.
 */
export function justCompletedPeriod(period: AggregationPeriod, now: Date): string {
    const today = dayKey(now);
    switch (period) {
        case 'weekly':
            return priorWeekStart(isoWeekStart(today));
        case 'monthly':
            return priorMonth(monthOf(today));
        case 'quarterly':
            return priorQuarter(quarterOf(today));
        case 'yearly':
            return priorYear(yearOf(today));
        default:
            return assertNever(period);
    }
}

export interface AggregationJobResult {
    period: AggregationPeriod;
    /** The period key computed (week_start / YYYY-MM / YYYY-Q[1-4] / YYYY). */
    periodKey: string;
    /** Aggregate rows written/overwritten across all developers (or teams). */
    rowsWritten: number;
}

/**
 * Compute and persist one level's aggregate for a single period key, for every
 * developer (weekly/monthly) or team (quarterly/yearly). Pure dispatch over the
 * existing per-level rollup drivers — the single code path shared by the
 * scheduled job and the manual CLI, which is what makes the two produce identical
 * results. Wrapped in one transaction so the period's upserts commit as a unit
 * (one fsync, not one per row) and a mid-period failure rolls back cleanly.
 */
export function runAggregationForPeriod(
    db: Database.Database,
    period: AggregationPeriod,
    periodKey: string,
    now: Date = new Date(),
): AggregationJobResult {
    // The weekly rollup takes any date in the target week; the week_start key is
    // itself such a date, so it passes straight through. The other three take
    // their period key verbatim.
    const compute = (): unknown[] => {
        switch (period) {
            case 'weekly':
                return computeAllWeeklyAggregates(db, periodKey, now);
            case 'monthly':
                return computeAllMonthlyAggregates(db, periodKey, now);
            case 'quarterly':
                return computeAllQuarterlyAggregates(db, periodKey, now);
            case 'yearly':
                return computeAllYearlyAggregates(db, periodKey, now);
            default:
                return assertNever(period);
        }
    };
    const rows = db.transaction(compute)();
    return {period, periodKey, rowsWritten: rows.length};
}

/**
 * Job lifecycle logging — start, completion (with rows + duration), and failure.
 * Injectable so tests can assert what was logged and the server can route it
 * through its own logger; the default writes structured lines to the console.
 */
export interface AggregationLogger {
    jobStart(period: AggregationPeriod, periodKey: string): void;
    jobSuccess(
        period: AggregationPeriod,
        periodKey: string,
        rowsWritten: number,
        durationMs: number,
    ): void;
    jobFailure(period: AggregationPeriod, periodKey: string, error: unknown): void;
}

export const consoleAggregationLogger: AggregationLogger = {
    jobStart(period, periodKey) {
        console.log(
            `[aggregate:${period}] start — period ${periodKey} (${new Date().toISOString()})`,
        );
    },
    jobSuccess(period, periodKey, rowsWritten, durationMs) {
        console.log(
            `[aggregate:${period}] done — period ${periodKey}, ${rowsWritten} row(s) in ${durationMs}ms`,
        );
    },
    jobFailure(period, periodKey, error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[aggregate:${period}] FAILED — period ${periodKey}: ${msg}`);
    },
};

/** A computation function with runAggregationForPeriod's shape, injectable for tests. */
export type PeriodRunner = (
    db: Database.Database,
    period: AggregationPeriod,
    periodKey: string,
    now: Date,
) => AggregationJobResult;

export interface ScheduledJobResult {
    period: AggregationPeriod;
    periodKey: string;
    rowsWritten: number;
    /** Whether the job completed without throwing. */
    ok: boolean;
    /** Failure message when `ok` is false; absent on success. */
    error?: string;
}

/**
 * Run one scheduled job: resolve the just-completed period, compute it, and log
 * the lifecycle. Catches every failure and returns it as `ok: false` rather than
 * throwing — the contract that gives the scheduler its error isolation, so a
 * failing job logs and alerts but never blocks the others.
 */
export function runScheduledJob(
    db: Database.Database,
    period: AggregationPeriod,
    now: Date = new Date(),
    logger: AggregationLogger = consoleAggregationLogger,
    runner: PeriodRunner = runAggregationForPeriod,
): ScheduledJobResult {
    const periodKey = justCompletedPeriod(period, now);
    logger.jobStart(period, periodKey);
    const startedAt = Date.now();
    try {
        const {rowsWritten} = runner(db, period, periodKey, now);
        logger.jobSuccess(period, periodKey, rowsWritten, Date.now() - startedAt);
        return {period, periodKey, rowsWritten, ok: true};
    } catch (err) {
        logger.jobFailure(period, periodKey, err);
        return {
            period,
            periodKey,
            rowsWritten: 0,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

/**
 * Run several scheduled jobs in sequence with per-job isolation — each goes
 * through runScheduledJob, so one failing leaves the rest unaffected. Returns
 * every result (successes and failures). Defaults to all four levels.
 */
export function runScheduledJobs(
    db: Database.Database,
    periods: readonly AggregationPeriod[] = AGGREGATION_PERIODS,
    now: Date = new Date(),
    logger: AggregationLogger = consoleAggregationLogger,
    runner: PeriodRunner = runAggregationForPeriod,
): ScheduledJobResult[] {
    return periods.map((period) => runScheduledJob(db, period, now, logger, runner));
}

const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../storage/migrations');

export interface AggregationSchedulerOptions {
    /** Lifecycle logger; defaults to the console logger. */
    logger?: AggregationLogger;
    /** Migrations directory applied on each fire; defaults to src/storage/migrations. */
    migrationsDir?: string;
    /** Injectable clock for resolving the just-completed period; defaults to wall clock. */
    now?: () => Date;
}

/**
 * Register the four cron jobs (weekly/monthly/quarterly/yearly) against `dbPath`
 * and return the node-cron tasks so the caller can stop them on shutdown. Each
 * fire opens its own short-lived DB handle, applies migrations, and runs the
 * isolated job. Open/migration errors are caught and logged so a transient
 * failure can never tear the scheduler down; the jobs themselves are already
 * isolated by runScheduledJob.
 */
export function startAggregationScheduler(
    dbPath: string,
    options: AggregationSchedulerOptions = {},
): Array<ReturnType<typeof cron.schedule>> {
    const logger = options.logger ?? consoleAggregationLogger;
    const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
    const clock = options.now ?? ((): Date => new Date());

    return AGGREGATION_PERIODS.map((period) =>
        cron.schedule(
            AGGREGATION_CRON[period],
            () => {
                let db: Database.Database;
                try {
                    db = openDb(dbPath);
                } catch (err) {
                    // Couldn't even open the DB — log against the level and bail; the
                    // other levels' tasks are untouched.
                    logger.jobFailure(period, justCompletedPeriod(period, clock()), err);
                    return;
                }
                try {
                    runMigrations(db, migrationsDir);
                    runScheduledJob(db, period, clock(), logger);
                } catch (err) {
                    // runScheduledJob is self-isolating; this guards only the migration
                    // step so a migration error still logs rather than escaping.
                    logger.jobFailure(period, justCompletedPeriod(period, clock()), err);
                } finally {
                    db.close();
                }
            },
            {timezone: 'UTC'},
        ),
    );
}
