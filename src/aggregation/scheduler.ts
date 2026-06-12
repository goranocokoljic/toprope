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
    isoWeekLabel,
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
import {markStaleSummariesForRecompute} from '../summaries/staleness';
import {runAnomalyScanForPeriod} from '../anomaly/scan';
import {computePRReviewMetricsForPeriod} from '../coaching/pr-review/compute';

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

    // After the recompute, re-check any summaries written for this period: if the
    // underlying snapshots moved (late data, re-sync), the freshly built input no
    // longer matches what a summary was generated from, so it is flagged stale.
    // Read-only against snapshots and best-effort — it never alters the aggregate
    // result and swallows its own per-summary errors, so a summary issue can't
    // break the aggregation run.
    //
    // Deliberately runs AFTER the aggregate transaction commits, not inside it, so a
    // summary problem can never roll back aggregates. The consequence is that
    // is_stale is eventually-consistent, not guaranteed-on-commit: if the process
    // dies between the commit above and this call, affected summaries stay
    // is_stale = 0 until the period is next recomputed (which re-runs this check).
    // Acceptable because every recompute self-heals it and is_stale is advisory.
    //
    // Scope of the guarantee: staleness is keyed on *snapshot* recompute. The
    // summary input also folds the developer registry, so a registry-only change
    // (a late developer import / team reassignment inside an already-summarised
    // period) that isn't accompanied by an aggregate recompute is NOT auto-detected
    // here. Such cases need an explicit regenerate; checkSummaryStaleness re-hashes
    // a single record on demand if a periodic sweep is added later.
    markStaleSummariesForRecompute(db, period, periodKey);

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
 * Run one scheduled job against an open DB: resolve the just-completed period,
 * compute it, and log the lifecycle. Catches every failure and returns it as
 * `ok: false` rather than throwing — the contract that gives the scheduler its
 * error isolation, so a failing job logs and alerts but never blocks the others.
 */
export function runScheduledJob(
    db: Database.Database,
    period: AggregationPeriod,
    now: Date = new Date(),
    logger: AggregationLogger = consoleAggregationLogger,
): ScheduledJobResult {
    const periodKey = justCompletedPeriod(period, now);
    logger.jobStart(period, periodKey);
    const startedAt = Date.now();
    try {
        const {rowsWritten} = runAggregationForPeriod(db, period, periodKey, now);
        logger.jobSuccess(period, periodKey, rowsWritten, Date.now() - startedAt);
        // Anomaly detection (Task 4.7) runs on the weekly period after its
        // aggregates land — the weekly rollup is the source the scan reads. Only
        // the weekly job triggers it (the engine's period unit is the week), and
        // it is best-effort: a scan failure is logged but never fails the
        // aggregation job that succeeded above, mirroring the staleness sweep's
        // after-the-commit, swallow-its-own-errors contract.
        //
        // Cost note: the scan re-folds each team's metrics live for the baseline
        // window (no weekly team-aggregate table exists), so the weekly job's wall
        // time now includes that O(window × developers) team re-fold. Trivial at
        // launch scale; a large org may want a precomputed weekly team aggregate to
        // keep it off this path.
        if (period === 'weekly') {
            try {
                const scan = runAnomalyScanForPeriod(db, periodKey);
                console.log(
                    `[anomaly:scan] done — period ${scan.period}, ${scan.flagged} flagged, ` +
                        `${scan.cleared} cleared, ${scan.buildingBaseline} building-baseline`,
                );
            } catch (scanErr) {
                const msg = scanErr instanceof Error ? scanErr.message : String(scanErr);
                console.error(`[anomaly:scan] FAILED — period ${periodKey}: ${msg}`);
            }
        }
        // PR/review outcome metrics (Task 5.2) run after the weekly and monthly
        // aggregates land, on the same period the job just computed. Best-effort
        // with the same contract as the anomaly scan: a failure is logged but
        // never fails the aggregation job that succeeded above. The weekly job's
        // period key is a week_start date; the metrics are keyed by the ISO week
        // label (YYYY-Www) per the pr_review_metrics schema.
        if (period === 'weekly' || period === 'monthly') {
            const metricsPeriod = period === 'weekly' ? isoWeekLabel(periodKey) : periodKey;
            try {
                const result = computePRReviewMetricsForPeriod(db, period, metricsPeriod, now);
                console.log(
                    `[pr-review:metrics] done — period ${result.period}, ` +
                        `${result.developers} developer(s), ${result.rowsWritten} row(s)`,
                );
            } catch (metricsErr) {
                const msg = metricsErr instanceof Error ? metricsErr.message : String(metricsErr);
                console.error(`[pr-review:metrics] FAILED — period ${metricsPeriod}: ${msg}`);
            }
        }
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

const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../storage/migrations');

export interface AggregationSchedulerOptions {
    /** Lifecycle logger; defaults to the console logger. */
    logger?: AggregationLogger;
    /** Migrations directory applied on each fire; defaults to src/storage/migrations. */
    migrationsDir?: string;
    /** Injectable clock for resolving the just-completed period; defaults to wall clock. */
    now?: () => Date;
    /**
     * Optional anomaly Slack notifier (Task 4.8), invoked after a SUCCESSFUL
     * weekly job (the weekly scan has just run). Takes no period: it sweeps every
     * open, unannounced team anomaly rather than one period's, so a delivery
     * missed on a prior week still goes out. Fire-and-forget by contract — it owns
     * its own DB handle, so it is called AFTER this job's handle closes and any
     * error inside it must never affect the aggregation result. Absent → no
     * anomaly alerts (the launch/no-Slack default).
     */
    notifier?: () => void;
}

/**
 * Run one scheduled level end-to-end against `dbPath`: open a short-lived DB
 * handle, apply migrations, run the isolated job, and close. This is the exact
 * body each cron fire executes, factored out so the production lifecycle —
 * including the two failure branches and the guaranteed close — is directly
 * testable without waiting on the wall clock.
 *
 * Never throws. Returns the job's ScheduledJobResult, or `null` if the DB could
 * not even be opened (the failure is logged either way). Both failure paths are
 * isolated so one level's bad fire never escapes into node-cron or touches the
 * other three independent tasks.
 */
export function runScheduledAggregationJob(
    dbPath: string,
    period: AggregationPeriod,
    options: AggregationSchedulerOptions = {},
): ScheduledJobResult | null {
    const logger = options.logger ?? consoleAggregationLogger;
    const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
    const now = (options.now ?? ((): Date => new Date()))();

    let db: Database.Database;
    try {
        db = openDb(dbPath);
    } catch (err) {
        // Couldn't even open the DB — log against the level and bail; the other
        // levels' tasks are untouched.
        logger.jobFailure(period, justCompletedPeriod(period, now), err);
        return null;
    }
    let result: ScheduledJobResult;
    try {
        runMigrations(db, migrationsDir);
        // runScheduledJob is self-isolating and never throws.
        result = runScheduledJob(db, period, now, logger);
    } catch (err) {
        // Guards only the migration step (the one call above that can throw) so a
        // migration error still logs rather than escaping into node-cron.
        const periodKey = justCompletedPeriod(period, now);
        logger.jobFailure(period, periodKey, err);
        result = {
            period,
            periodKey,
            rowsWritten: 0,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        };
    } finally {
        db.close();
    }

    // Anomaly Slack alerts (Task 4.8): fire AFTER the job's DB handle closes (the
    // notifier owns its own handle) and only on a successful weekly job, where the
    // scan that produced the anomalies has just run. Best-effort: a notifier
    // failure is logged against the level but never changes the job's result.
    if (result.ok && period === 'weekly' && options.notifier) {
        try {
            options.notifier();
        } catch (err) {
            logger.jobFailure(period, result.periodKey, err);
        }
    }
    return result;
}

/**
 * Register the four cron jobs (weekly/monthly/quarterly/yearly) against `dbPath`
 * and return the node-cron tasks so the caller can stop them on shutdown. Each
 * fire delegates to the self-isolating runScheduledAggregationJob, so a transient
 * failure on one level can never tear the scheduler down or affect the others.
 */
export function startAggregationScheduler(
    dbPath: string,
    options: AggregationSchedulerOptions = {},
): Array<ReturnType<typeof cron.schedule>> {
    return AGGREGATION_PERIODS.map((period) =>
        cron.schedule(
            AGGREGATION_CRON[period],
            () => void runScheduledAggregationJob(dbPath, period, options),
            {timezone: 'UTC'},
        ),
    );
}
