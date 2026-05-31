/**
 * Shared time-range parser for manager-facing endpoints (Task 2.3 / #38).
 *
 * Accepts five range kinds:
 *   30d | 90d | year | lifetime | custom (with from & to dates)
 *
 * All ranges resolve to an inclusive [from, to] pair of YYYY-MM-DD strings that
 * callers feed straight into `date >= ? AND date <= ?` SQL. "lifetime" resolves
 * `from` to the earliest available record for the scope being queried, via the
 * caller-supplied `earliest` callback.
 *
 * The dashboard mirrors this arithmetic client-side in
 * `src/dashboard/frontend/src/timeRange/range.ts` so the selector can preview a
 * window before the API call (the browser bundle can't import this Node module).
 * The two are kept in lock-step by `tests/dashboard/range-parity.test.ts` — keep
 * any change to the preset windows here in sync there.
 */

export type TimeRangeKind = '30d' | '90d' | 'year' | 'lifetime' | 'custom';

export interface TimeRangeInput {
    range?: string;
    from?: string;
    to?: string;
}

export interface TimeRange {
    range: TimeRangeKind;
    from: string;
    to: string;
}

export interface ParseTimeRangeOptions {
    /**
     * Earliest available date (YYYY-MM-DD) for the scope, or null when there is
     * no data. Required to resolve "lifetime"; never called for other kinds.
     */
    earliest?: () => string | null;
    /** Override "now" for deterministic testing. */
    now?: Date;
}

export class TimeRangeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TimeRangeError';
    }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function formatDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

function isValidDate(value: string): boolean {
    if (!DATE_RE.test(value)) {
        return false;
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) {
        return false;
    }
    // Reject rolled-over values like 2026-02-31 that Date silently normalises.
    return formatDate(parsed) === value;
}

function subtractDays(date: Date, days: number): Date {
    const copy = new Date(date.getTime());
    copy.setUTCDate(copy.getUTCDate() - days);
    return copy;
}

export function parseTimeRange(
    input: TimeRangeInput,
    options: ParseTimeRangeOptions = {},
): TimeRange {
    const now = options.now ?? new Date();
    const today = formatDate(now);

    let kind: TimeRangeKind;
    if (input.range) {
        const candidate = input.range.toLowerCase();
        if (
            candidate === '30d' ||
            candidate === '90d' ||
            candidate === 'year' ||
            candidate === 'lifetime' ||
            candidate === 'custom'
        ) {
            kind = candidate;
        } else {
            throw new TimeRangeError(`Unknown range: ${input.range}`);
        }
    } else if (input.from !== undefined || input.to !== undefined) {
        kind = 'custom';
    } else {
        kind = '30d';
    }

    if (kind === 'custom') {
        const {from, to} = input;
        if (!from || !to) {
            throw new TimeRangeError('Custom range requires both from and to dates');
        }
        if (!isValidDate(from) || !isValidDate(to)) {
            throw new TimeRangeError('Custom range dates must be valid YYYY-MM-DD values');
        }
        if (from > to) {
            throw new TimeRangeError('Custom range requires from <= to');
        }
        return {range: kind, from, to};
    }

    if (kind === '30d') {
        return {range: kind, from: formatDate(subtractDays(now, 29)), to: today};
    }

    if (kind === '90d') {
        return {range: kind, from: formatDate(subtractDays(now, 89)), to: today};
    }

    if (kind === 'year') {
        const from = new Date(now.getTime());
        from.setUTCFullYear(from.getUTCFullYear() - 1);
        from.setUTCDate(from.getUTCDate() + 1);
        return {range: kind, from: formatDate(from), to: today};
    }

    // lifetime
    const earliest = options.earliest?.() ?? null;
    return {range: kind, from: earliest ?? today, to: today};
}
