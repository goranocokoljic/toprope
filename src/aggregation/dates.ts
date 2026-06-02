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
const MONTH_RE = /^\d{4}-\d{2}$/;

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

/** Number of days in the calendar month containing `date` (YYYY-MM-DD). */
export function daysInMonth(date: string): number {
    assertValidDate(date);
    const [year, mon] = date.split('-').map(Number);
    return new Date(Date.UTC(year, mon, 0)).getUTCDate();
}
