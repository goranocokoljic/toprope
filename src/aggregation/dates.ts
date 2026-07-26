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

/**
 * Is `value` the canonical UTC day SHAPE (YYYY-MM-DD)?
 *
 * The shape check alone, without {@link assertValidDate}'s calendar validation — for callers
 * that must pin the shape BEFORE comparing two day strings with `<`/`>`, because a
 * non-conforming value (`'not-a-date'`) byte-sorts arbitrarily and would silently invert the
 * comparison rather than failing. Exposed as a predicate so those callers do not each carry
 * their own copy of the regex.
 */
export function isUtcDay(value: string): boolean {
    return DATE_RE.test(value);
}

/** Today as a YYYY-MM-DD key in UTC, matching the daily-snapshot keying. */
export function todayUtc(now: Date): string {
    return now.toISOString().slice(0, 10);
}

/**
 * `date` shifted back `months` calendar months, returned as YYYY-MM-DD (UTC), via `Date`
 * normalization so the result is always a valid ISO date. A day-of-month that does not exist
 * in the target month normalizes FORWARD (Jan 31 − 1mo → Mar 3), which for a range floor only
 * ever shortens the span — never lengthens it past the caller's intended bound.
 */
export function subtractMonths(date: string, months: number): string {
    const [year, mon, day] = date.split('-').map(Number);
    return new Date(Date.UTC(year, mon - 1 - months, day)).toISOString().slice(0, 10);
}
// ISO week-numbering label: YYYY-Wnn with the week zero-padded to two digits
// (W01..W53). The summary layer keys weekly periods by this label rather than by
// the Monday date so the period label matches the YYYY-Wnn form the numbers-only
// payload allowlist expects.
const ISO_WEEK_RE = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;
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

/**
 * Whether a quarter's calendar span overlaps an inclusive [from, to] window:
 * quarter.start <= to AND quarter.end >= from. The single home for the
 * "is this quarter in the window" rule the maturity trend and the team
 * comparison both apply, so the two can't drift. All inputs are `YYYY-MM-DD`,
 * compared lexically (same order as chronologically).
 */
export function quarterOverlaps(quarter: string, from: string, to: string): boolean {
    const span = quarterRange(quarter);
    return span.start <= to && span.end >= from;
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

/**
 * The ISO-8601 week-numbering label (`YYYY-Wnn`) of the week containing `date`.
 * ISO weeks start Monday and week 1 is the week containing the year's first
 * Thursday, so the week-numbering YEAR can differ from the calendar year for days
 * in early January or late December (e.g. 2027-01-01 falls in 2026-W53). Computed
 * via the week's Thursday, whose calendar year IS the ISO week-numbering year.
 */
export function isoWeekLabel(date: string): string {
    assertValidDate(date);
    const d = new Date(`${date}T00:00:00.000Z`);
    // Shift to the Thursday of this ISO week (Mon=0..Sun=6 → +3 lands on Thursday).
    const dayNum = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dayNum + 3);
    const isoYear = d.getUTCFullYear();
    // Thursday of ISO week 1 is the Thursday of the week containing Jan 4.
    const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
    const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
    const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
    return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/**
 * Inclusive [Monday, Sunday] day range for an ISO week label (`YYYY-Wnn`). The
 * start is the canonical week_start (Monday) that {@link isoWeekLabel} round-trips
 * back to. Throws on a malformed label so a bad period key fails loudly rather
 * than sweeping an unintended window.
 */
export function isoWeekRange(label: string): DateRange {
    if (!ISO_WEEK_RE.test(label)) {
        throw new Error(`Invalid ISO week (expected YYYY-Wnn): ${label}`);
    }
    const [yearPart, weekPart] = label.split('-W');
    const isoYear = Number(yearPart);
    const week = Number(weekPart);
    // Monday of ISO week 1 is the Monday of the week containing Jan 4.
    const jan4 = new Date(Date.UTC(isoYear, 0, 4));
    const jan4DayNum = (jan4.getUTCDay() + 6) % 7;
    const week1Monday = new Date(jan4.getTime() - jan4DayNum * 86_400_000);
    const start = new Date(week1Monday.getTime() + (week - 1) * 7 * 86_400_000)
        .toISOString()
        .slice(0, 10);
    return {start, end: addDays(start, 6)};
}

/**
 * The ISO week label immediately before `label` (`YYYY-Wnn`) — the previous
 * comparable period for weekly summary deltas. Derived through the Monday date so
 * the year-boundary cases (W01 → prior year's W52/W53) fall out of the calendar
 * arithmetic rather than needing special-casing.
 */
export function priorIsoWeek(label: string): string {
    return isoWeekLabel(priorWeekStart(isoWeekRange(label).start));
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

/** The calendar month (`YYYY-MM`) a day falls in. */
export function monthOf(date: string): string {
    assertValidDate(date);
    return date.slice(0, 7);
}

/** The calendar quarter (`YYYY-Q[1-4]`) a day falls in. */
export function quarterOf(date: string): string {
    assertValidDate(date);
    const [year, mon] = date.split('-').map(Number);
    const q = Math.floor((mon - 1) / 3) + 1; // months 1–3→Q1, 4–6→Q2, …
    return `${year}-Q${q}`;
}

/** The calendar year (`YYYY`) a day falls in. */
export function yearOf(date: string): string {
    assertValidDate(date);
    return date.slice(0, 4);
}

/** The calendar month after `month` (`YYYY-MM`), e.g. `2026-12` → `2027-01`. */
export function nextMonth(month: string): string {
    if (!MONTH_RE.test(month)) {
        throw new Error(`Invalid month (expected YYYY-MM): ${month}`);
    }
    const [year, mon] = month.split('-').map(Number);
    // mon is 1-based, so Date's 0-based month index `mon` is the month after this one.
    const d = new Date(Date.UTC(year, mon, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The calendar quarter after `quarter` (`YYYY-Q[1-4]`), e.g. `2026-Q4` → `2027-Q1`. */
export function nextQuarter(quarter: string): string {
    if (!QUARTER_RE.test(quarter)) {
        throw new Error(`Invalid quarter (expected YYYY-Q[1-4]): ${quarter}`);
    }
    const [year, q] = quarter.split('-Q').map(Number);
    return q === 4 ? `${year + 1}-Q1` : `${year}-Q${q + 1}`;
}

/**
 * Every ISO week start (Monday) whose week intersects the inclusive [from, to]
 * window, in chronological order. The first entry is `isoWeekStart(from)` — the
 * Monday of the week `from` falls in, which may precede `from`; computing that
 * week's aggregate is correct since the rollup folds the whole canonical ISO
 * week from the immutable daily snapshots. Always returns at least one week.
 * Backfill walks these in order so each week's deltas see the prior week's row.
 */
export function enumerateWeekStarts(from: string, to: string): string[] {
    assertDateRange(from, to);
    const weeks: string[] = [];
    let weekStart = isoWeekStart(from);
    while (weekStart <= to) {
        weeks.push(weekStart);
        weekStart = addDays(weekStart, 7);
    }
    return weeks;
}

/**
 * Every calendar month (`YYYY-MM`) that intersects the inclusive [from, to]
 * window, in chronological order — from `from`'s month through `to`'s month.
 */
export function enumerateMonths(from: string, to: string): string[] {
    assertDateRange(from, to);
    const months: string[] = [];
    const last = monthOf(to);
    let month = monthOf(from);
    // YYYY-MM keys are zero-padded, so lexicographic <= is chronological.
    while (month <= last) {
        months.push(month);
        month = nextMonth(month);
    }
    return months;
}

/**
 * Every calendar quarter (`YYYY-Q[1-4]`) that intersects the inclusive [from, to]
 * window, in chronological order — from `from`'s quarter through `to`'s quarter.
 */
export function enumerateQuarters(from: string, to: string): string[] {
    assertDateRange(from, to);
    const quarters: string[] = [];
    const last = quarterOf(to);
    let quarter = quarterOf(from);
    // YYYY-Q[1-4] keys compare lexicographically in chronological order.
    while (quarter <= last) {
        quarters.push(quarter);
        quarter = nextQuarter(quarter);
    }
    return quarters;
}

/**
 * Every calendar year (`YYYY`) that intersects the inclusive [from, to] window,
 * in chronological order — from `from`'s year through `to`'s year.
 */
export function enumerateYears(from: string, to: string): string[] {
    assertDateRange(from, to);
    const years: string[] = [];
    const last = Number(yearOf(to));
    for (let year = Number(yearOf(from)); year <= last; year++) {
        years.push(String(year));
    }
    return years;
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
