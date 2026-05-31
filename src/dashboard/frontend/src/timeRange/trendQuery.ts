import type {TimeRangeQuery} from '../api/client';
import type {TimeRangeValue} from './range';

/**
 * Shared mapping from a resolved time range to the trend request shape, used by
 * every trend hook (org overview + per-team). Kept beside the range maths so the
 * overview trend and the team trend can never drift on how a window is queried
 * or cache-keyed.
 *
 * Presets carry a window the server recomputes, so we send only `range`; custom
 * carries explicit dates the server can't derive, so we send `from`+`to`.
 */
export function trendQuery(range: TimeRangeValue): TimeRangeQuery {
    return range.kind === 'custom' ? {from: range.from, to: range.to} : {range: range.kind};
}

/** Stable cache key for a window — preset name, or the custom date span. */
export function trendWindowKey(range: TimeRangeValue): string {
    return range.kind === 'custom' ? `custom:${range.from}:${range.to}` : range.kind;
}
