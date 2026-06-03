/**
 * Historical backfill command (Task 3.5 / #74).
 *
 * On first deployment — or when onboarding a company that already has git
 * history pulled by the Phase 1 connectors — backfill computes every historical
 * aggregate from the immutable daily snapshots, producing trend depth
 * immediately instead of waiting weeks for it to accumulate forward.
 *
 * The work itself is delegated entirely to the per-level rollup drivers
 * (computeAll{Weekly,Monthly,Quarterly,Yearly}Aggregates), each of which already
 * folds in deltas and the AI maturity score and UPSERTs by its unique period
 * key. Backfill's only jobs are:
 *   1. resolve the date range (default: trailing 12 months — design §3.5),
 *   2. enumerate every period boundary the range touches, and
 *   3. drive the rollups in CHRONOLOGICAL order at each level so a period's
 *      delta always finds its prior period already stored.
 *
 * Idempotency falls out for free: every rollup UPSERTs its row, so re-running a
 * backfill (or an overlapping range) overwrites and never duplicates. Because
 * each period is computed independently from the append-only daily snapshots and
 * the writes are small per-period upserts (not one long-held transaction), a
 * backfill is safe to run while the daily sync continues to append snapshots.
 */

import type Database from 'better-sqlite3';
import {
    assertDateRange,
    enumerateWeekStarts,
    enumerateMonths,
    enumerateQuarters,
    enumerateYears,
} from './dates';
import {computeAllWeeklyAggregates} from './weekly';
import {computeAllMonthlyAggregates} from './monthly';
import {computeAllQuarterlyAggregates} from './quarterly';
import {computeAllYearlyAggregates} from './yearly';

export type BackfillLevel = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

/** A single period-processed event, emitted as backfill advances. */
export interface BackfillProgress {
    level: BackfillLevel;
    /** The period key just computed (week_start / YYYY-MM / YYYY-Q[1-4] / YYYY). */
    period: string;
    /** 1-based position within this level. */
    levelIndex: number;
    /** Total periods at this level. */
    levelTotal: number;
    /** 1-based position across all levels (for an overall "X / Y" counter). */
    overallIndex: number;
    /** Total periods across all four levels. */
    overallTotal: number;
}

export interface BackfillOptions {
    /** Inclusive range start (YYYY-MM-DD). Defaults to `to` minus 12 months. */
    from?: string;
    /** Inclusive range end (YYYY-MM-DD). Defaults to today (UTC). */
    to?: string;
    /** Injectable clock for the default range and the rollups' computed_at. */
    now?: Date;
    /** Called once per period processed, in chronological order per level. */
    onProgress?: (progress: BackfillProgress) => void;
}

export interface BackfillResult {
    /** The resolved inclusive range actually processed. */
    from: string;
    to: string;
    /** Period counts processed at each level. */
    weeks: number;
    months: number;
    quarters: number;
    years: number;
    /** Total periods across all levels (weeks + months + quarters + years). */
    periodsProcessed: number;
    /** Total aggregate rows written/overwritten across every level. */
    rowsWritten: number;
}

/** Today's date as a YYYY-MM-DD key in UTC, matching the daily-snapshot keying. */
function todayUtc(now: Date): string {
    return now.toISOString().slice(0, 10);
}

/**
 * `date` shifted back `months` calendar months, returned as YYYY-MM-DD (UTC).
 * Day-of-month that overflows the target month (e.g. backing a 31st into a
 * shorter month) rolls forward via Date normalisation rather than throwing — the
 * default range only needs a sane, valid start, not exact calendar arithmetic.
 */
function subtractMonths(date: string, months: number): string {
    const [year, mon, day] = date.split('-').map(Number);
    return new Date(Date.UTC(year, mon - 1 - months, day)).toISOString().slice(0, 10);
}

/**
 * Resolve the [from, to] backfill window from the (possibly omitted) options.
 * `to` defaults to today (UTC); `from` defaults to twelve months before `to`
 * (design §3.5 — keeps the first backfill fast and the trend data relevant).
 * Throws if the resulting range is malformed or reversed.
 */
export function resolveBackfillRange(
    from: string | undefined,
    to: string | undefined,
    now: Date = new Date(),
): {from: string; to: string} {
    const resolvedTo = to ?? todayUtc(now);
    const resolvedFrom = from ?? subtractMonths(resolvedTo, 12);
    assertDateRange(resolvedFrom, resolvedTo);
    return {from: resolvedFrom, to: resolvedTo};
}

/**
 * Backfill all four aggregate levels over the resolved date range. Each level is
 * processed chronologically so deltas resolve against the prior period, and each
 * underlying rollup UPSERTs, making the whole run idempotent. Returns the period
 * and row counts; emits per-period progress via `options.onProgress` if given.
 */
export function runBackfill(db: Database.Database, options: BackfillOptions = {}): BackfillResult {
    const now = options.now ?? new Date();
    const {from, to} = resolveBackfillRange(options.from, options.to, now);

    const weeks = enumerateWeekStarts(from, to);
    const months = enumerateMonths(from, to);
    const quarters = enumerateQuarters(from, to);
    const years = enumerateYears(from, to);
    const overallTotal = weeks.length + months.length + quarters.length + years.length;

    let rowsWritten = 0;
    let overallIndex = 0;

    // One driver shape per level: enumerate-then-compute, chronological. Kept as a
    // small table so adding/reordering levels can't drift the progress accounting.
    const levels: Array<{
        level: BackfillLevel;
        periods: string[];
        compute: (period: string) => {length: number};
    }> = [
        {level: 'weekly', periods: weeks, compute: (p) => computeAllWeeklyAggregates(db, p, now)},
        {level: 'monthly', periods: months, compute: (p) => computeAllMonthlyAggregates(db, p, now)},
        {
            level: 'quarterly',
            periods: quarters,
            compute: (p) => computeAllQuarterlyAggregates(db, p, now),
        },
        {level: 'yearly', periods: years, compute: (p) => computeAllYearlyAggregates(db, p, now)},
    ];

    for (const {level, periods, compute} of levels) {
        periods.forEach((period, i) => {
            const rows = compute(period);
            rowsWritten += rows.length;
            overallIndex += 1;
            options.onProgress?.({
                level,
                period,
                levelIndex: i + 1,
                levelTotal: periods.length,
                overallIndex,
                overallTotal,
            });
        });
    }

    return {
        from,
        to,
        weeks: weeks.length,
        months: months.length,
        quarters: quarters.length,
        years: years.length,
        periodsProcessed: overallTotal,
        rowsWritten,
    };
}
