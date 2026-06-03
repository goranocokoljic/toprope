/**
 * Snapshot-date helpers (Task 3.1 / #70).
 *
 * All boundaries are computed in UTC against YYYY-MM-DD strings — the same
 * canonical form the daily snapshots are keyed on (tool_snapshots.date,
 * git_snapshots.date). Weeks follow ISO-8601: Monday is the first day, Sunday
 * the last. Months are plain calendar months (YYYY-MM).
 *
 * This is the single home for the generic date arithmetic (`addDays`,
 * `daysInMonth`) shared between the aggregation engine and the cost-accounting
 * layer (src/expenses/subscription-tracker.ts imports from here), so the
 * YYYY-MM-DD math lives in one place and cannot drift.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Month 01–12 only: a bare \d{2} shape would admit 2026-13 / 2026-00, and the
// Date arithmetic in monthRange/priorMonth would silently roll those into a
// valid-looking key rather than failing. Bounding the regex makes a malformed
// month throw loudly, matching the 1–4 bound QUARTER_RE already enforces.
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const QUARTER_RE = /^\d{4}-Q[1-4]$/;
const YEAR_RE = /^\d{4}$/;

/** Add `days` (may be negative) to a YYYY-MM-DD date, returning YYYY-MM-DD (UTC). */
export function addDays(date: string, days: number): string {
    const ms = Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000;
    return new Date(ms).toISOString().slice(0, 10);
}

function assertValidDate(date: string): void {
    if (!DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00.000Z`))) {
        throw new Error(`Invalid date (expected YYYY-MM-DD): ${date}`);
    }
}

/**
 * Assert that [start, end] is a well-formed inclusive day range — both valid
 * YYYY-MM-DD and start on or before end. Used to guard the exported aggregation
 * entry points so a malformed window fails loudly instead of silently widening a
 * `date >= ? AND date <= ?` query (an empty string compares lexicographically
 * and would otherwise sweep all history).
 */
export function assertDateRange(start: string, end: string): void {
    assertValidDate(start);
    assertValidDate(end);
    if (start > end) {
        throw new Error(`Invalid range: start ${start} is after end ${end}`);
    }
}

/**
 * The Monday (ISO week start) of the week containing `date`. Accepts any day in
 * the week and returns the YYYY-MM-DD of that week's Monday, so callers can pass
 * an arbitrary date and still land on the canonical week_start.
 */
export function isoWeekStart(date: string): string {
    assertValidDate(date);
    const d = new Date(`${date}T00:00:00.000Z`);
    const day = d.getUTCDay(); // 0=Sunday .. 6=Saturday
    // Shift back to Monday: Sunday (0) is the last day of the ISO week, so it
    // maps to the Monday six days earlier, not the next day.
    const shift = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + shift);
    return d.toISOString().slice(0, 10);
}

export interface DateRange {
    start: string;
    end: string;
}

/** Inclusive [Monday, Sunday] range for the ISO week containing `date`. */
export function weekRange(date: string): DateRange {
    const start = isoWeekStart(date);
    return {start, end: addDays(start, 6)};
}

/** Inclusive [first, last] day range for a calendar month (`YYYY-MM`). */
export function monthRange(month: string): DateRange {
    if (!MONTH_RE.test(month)) {
        throw new Error(`Invalid month (expected YYYY-MM): ${month}`);
    }
    const [year, mon] = month.split('-').map(Number);
    // Day 0 of the *next* month is the last day of this month.
    const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
    return {start: `${month}-01`, end: `${month}-${String(lastDay).padStart(2, '0')}`};
}

/**
 * Inclusive [first, last] day range for a calendar quarter (`YYYY-Q1`..`YYYY-Q4`).
 * Quarters follow calendar months: Q1 Jan–Mar, Q2 Apr–Jun, Q3 Jul–Sep, Q4 Oct–Dec.
 */
export function quarterRange(quarter: string): DateRange {
    if (!QUARTER_RE.test(quarter)) {
        throw new Error(`Invalid quarter (expected YYYY-Q[1-4]): ${quarter}`);
    }
    const [year, q] = quarter.split('-Q').map(Number);
    const firstMonth = (q - 1) * 3 + 1; // Q1→1, Q2→4, Q3→7, Q4→10
    const start = `${year}-${String(firstMonth).padStart(2, '0')}-01`;
    // Day 0 of the month after the quarter's last month is that last day.
    const lastDay = new Date(Date.UTC(year, firstMonth + 2, 0)).getUTCDate();
    const end = `${year}-${String(firstMonth + 2).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    return {start, end};
}

/** Inclusive [Jan 1, Dec 31] day range for a calendar year (`YYYY`). */
export function yearRange(year: string): DateRange {
    if (!YEAR_RE.test(year)) {
        throw new Error(`Invalid year (expected YYYY): ${year}`);
    }
    return {start: `${year}-01-01`, end: `${year}-12-31`};
}

/**
 * The ISO week start (Monday) of the week immediately before the one beginning
 * at `weekStart` — the "previous comparable period" for weekly deltas. `weekStart`
 * must already be a canonical Monday (as stored in weekly_aggregates.week_start).
 */
export function priorWeekStart(weekStart: string): string {
    assertValidDate(weekStart);
    return addDays(weekStart, -7);
}

/** The calendar month before `month` (`YYYY-MM`), e.g. `2026-01` → `2025-12`. */
export function priorMonth(month: string): string {
    if (!MONTH_RE.test(month)) {
        throw new Error(`Invalid month (expected YYYY-MM): ${month}`);
    }
    const [year, mon] = month.split('-').map(Number);
    // Month 0 of the same year is December of the prior year, so subtracting one
    // from the 1-based month and normalising via Date handles the year rollover.
    const d = new Date(Date.UTC(year, mon - 2, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The calendar quarter before `quarter` (`YYYY-Q[1-4]`), e.g. `2026-Q1` → `2025-Q4`. */
export function priorQuarter(quarter: string): string {
    if (!QUARTER_RE.test(quarter)) {
        throw new Error(`Invalid quarter (expected YYYY-Q[1-4]): ${quarter}`);
    }
    const [year, q] = quarter.split('-Q').map(Number);
    return q === 1 ? `${year - 1}-Q4` : `${year}-Q${q - 1}`;
}

/** The calendar year before `year` (`YYYY`), e.g. `2026` → `2025`. */
export function priorYear(year: string): string {
    if (!YEAR_RE.test(year)) {
        throw new Error(`Invalid year (expected YYYY): ${year}`);
    }
    return String(Number(year) - 1);
}

/** Number of days in the calendar month containing `date` (YYYY-MM-DD). */
export function daysInMonth(date: string): number {
    assertValidDate(date);
    const [year, mon] = date.split('-').map(Number);
    return new Date(Date.UTC(year, mon, 0)).getUTCDate();
}

/**
 * Number of days in the inclusive [start, end] window — the "possible active
 * days" of a period. Both bounds count, so a single-day window is 1 and a full
 * calendar quarter is ~90. Used by the maturity score's adoption_consistency
 * component (active_days / possible_days). Guards the range like the snapshot
 * queries so a reversed or malformed window fails loudly.
 */
export function inclusiveDayCount(start: string, end: string): number {
    assertDateRange(start, end);
    const ms = Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`);
    return Math.round(ms / 86_400_000) + 1;
}
