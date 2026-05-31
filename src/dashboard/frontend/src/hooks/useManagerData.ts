import {useQuery, type UseQueryResult} from '@tanstack/react-query';
import {api, type TimeRangeQuery} from '../api/client';
import {queryKeys} from '../api/queryKeys';
import type {CoverageData, OverviewTrend, ToolDistribution, WasteTeamSummary} from '../api/types';
import type {TimeRangeValue} from '../timeRange/range';

/**
 * Data hooks backing the manager Organization Overview (Task 2.5). Each is a
 * thin React Query wrapper so the page composes cached, deduped reads of the
 * manager API surface; the page itself owns layout and data-state handling.
 */

/** Per-tool seat/developer/cost distribution. */
export function useToolDistribution(): UseQueryResult<ToolDistribution, Error> {
    return useQuery({
        queryKey: queryKeys.toolDistribution,
        queryFn: api.getToolDistribution,
    });
}

/**
 * Turn a resolved range into the trend query the backend expects. Presets carry
 * a window the server recomputes, so we send only `range`; custom carries
 * explicit dates the server can't derive, so we send `from`+`to`.
 */
function trendQuery(range: TimeRangeValue): TimeRangeQuery {
    return range.kind === 'custom'
        ? {from: range.from, to: range.to}
        : {range: range.kind};
}

/** Stable cache key for a window — preset name, or the custom date span. */
function trendWindowKey(range: TimeRangeValue): string {
    return range.kind === 'custom' ? `custom:${range.from}:${range.to}` : range.kind;
}

/** Active-developer adoption trend for the selected window. */
export function useOverviewTrend(range: TimeRangeValue): UseQueryResult<OverviewTrend, Error> {
    return useQuery({
        queryKey: queryKeys.overviewTrend(trendWindowKey(range)),
        queryFn: () => api.getOverviewTrend(trendQuery(range)),
    });
}

/** Data-coverage snapshot: per-developer quality, connectors, git providers. */
export function useCoverage(): UseQueryResult<CoverageData, Error> {
    return useQuery({
        queryKey: queryKeys.coverage,
        queryFn: api.getCoverage,
    });
}

/** Per-team open-waste rollup, ordered by waste descending. */
export function useWasteSummary(): UseQueryResult<WasteTeamSummary[], Error> {
    return useQuery({
        queryKey: queryKeys.wasteSummary,
        queryFn: api.getWasteSummary,
    });
}
