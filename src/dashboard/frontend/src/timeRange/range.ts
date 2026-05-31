import type {TimeRangeKind, TimeRangePreset} from '../api/types';

/**
 * Client-side time-range maths, mirroring the backend parser in
 * src/dashboard/api/range.ts so the selector previews exactly the window the
 * API will resolve. All dates are inclusive `YYYY-MM-DD` (UTC) strings that drop
 * straight into the range query params.
 */

/** A fully resolved range: the kind the user picked plus its concrete window. */
export interface TimeRangeValue {
    kind: TimeRangeKind;
    from: string;
    to: string;
}

/** Presets in display order. `custom` is handled separately by the selector. */
export const PRESET_ORDER: TimeRangePreset[] = ['30d', '90d', 'year', 'lifetime'];

/** Full labels for menus/dropdowns (e.g. the Preferences page). */
export const PRESET_LABELS: Record<TimeRangePreset, string> = {
    '30d': 'Last 30 days',
    '90d': 'Last 90 days',
    year: 'Last year',
    lifetime: 'All time',
};

/** Compact labels for the inline selector buttons. */
export const PRESET_SHORT_LABELS: Record<TimeRangePreset, string> = {
    '30d': '30d',
    '90d': '90d',
    year: 'Year',
    lifetime: 'All',
};

/** The registry default preset — used to detect "user hasn't chosen". */
export const DEFAULT_PRESET: TimeRangePreset = '30d';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function formatDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/** True for a real, non-rolled-over calendar date in `YYYY-MM-DD` form. */
export function isValidDateString(value: string): boolean {
    if (!DATE_RE.test(value)) {
        return false;
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) {
        return false;
    }
    // Reject values like 2026-02-31 that Date silently normalises.
    return formatDate(parsed) === value;
}

function subtractDays(date: Date, days: number): Date {
    const copy = new Date(date.getTime());
    copy.setUTCDate(copy.getUTCDate() - days);
    return copy;
}

/** Whole days between two `YYYY-MM-DD` dates, inclusive of both endpoints. */
export function inclusiveDayCount(from: string, to: string): number {
    const a = new Date(`${from}T00:00:00.000Z`).getTime();
    const b = new Date(`${to}T00:00:00.000Z`).getTime();
    if (Number.isNaN(a) || Number.isNaN(b) || b < a) {
        return 0;
    }
    return Math.round((b - a) / 86_400_000) + 1;
}

export interface ResolveOptions {
    /** Earliest available data date for the scope (drives `lifetime`). */
    earliest?: string | null;
    /** Override "now" for deterministic rendering/tests. */
    now?: Date;
}

/**
 * Resolve a preset to its `[from, to]` window. `lifetime` spans from the scope's
 * earliest real data to today, so the axis never shows empty leading days; with
 * no data it collapses to a single day (today).
 */
export function resolvePreset(preset: TimeRangePreset, options: ResolveOptions = {}): {from: string; to: string} {
    const now = options.now ?? new Date();
    const to = formatDate(now);

    if (preset === '30d') {
        return {from: formatDate(subtractDays(now, 29)), to};
    }
    if (preset === '90d') {
        return {from: formatDate(subtractDays(now, 89)), to};
    }
    if (preset === 'year') {
        const from = new Date(now.getTime());
        from.setUTCFullYear(from.getUTCFullYear() - 1);
        from.setUTCDate(from.getUTCDate() + 1);
        return {from: formatDate(from), to};
    }
    if (preset === 'lifetime') {
        const earliest = options.earliest ?? null;
        return {from: earliest && isValidDateString(earliest) ? earliest : to, to};
    }
    // Unknown kind — the param is typed `TimeRangePreset`, so this is only
    // reachable on contract drift (e.g. a server preset the bundle predates).
    // Fall back to the safe default window rather than silently resolving to
    // "all time", which would over-fetch.
    return {from: formatDate(subtractDays(now, 29)), to};
}

/** Build a resolved value for a preset kind. */
export function presetValue(preset: TimeRangePreset, options: ResolveOptions = {}): TimeRangeValue {
    return {kind: preset, ...resolvePreset(preset, options)};
}

// Bounded presets, smallest window first. `lifetime` is the catch-all.
const BOUNDED_PRESETS: TimeRangePreset[] = ['30d', '90d', 'year'];

/**
 * The smallest preset whose window actually contains all available history.
 * The decision is tied to each preset's *resolved* window (its `from` must fall
 * on or before the scope's earliest data day), so it can never drift from
 * `resolvePreset` — e.g. there's no separate "365 vs 366 days" constant to keep
 * in sync. With no data, defaults to 30d; history older than the year window
 * falls through to `lifetime`.
 */
export function smartDefaultPreset(options: ResolveOptions = {}): TimeRangePreset {
    const {earliest} = options;
    if (!earliest || !isValidDateString(earliest)) {
        return '30d';
    }
    for (const preset of BOUNDED_PRESETS) {
        // YYYY-MM-DD compares lexically the same as chronologically.
        if (resolvePreset(preset, options).from <= earliest) {
            return preset;
        }
    }
    return 'lifetime';
}
