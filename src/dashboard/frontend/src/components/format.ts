/**
 * Small presentation formatters shared by the Teams screens (Task 2.6). Kept in
 * one place so a team's cost/utilization read identically in the list and the
 * detail view.
 */

/** Whole-dollar currency, e.g. 1234 → "$1,234". */
export function formatCurrency(value: number): string {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
    }).format(value);
}

/** Whole-number percent for 0..1 ratios, e.g. 0.666 → "67%". */
export function formatPercent(ratio: number): string {
    return `${Math.round(ratio * 100)}%`;
}

/** 'YYYY-MM-DD' → a short, locale-aware axis tick (e.g. "May 5"). */
export function formatDateTick(value: string | number): string {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) {
        return String(value);
    }
    return new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric', timeZone: 'UTC'}).format(date);
}
