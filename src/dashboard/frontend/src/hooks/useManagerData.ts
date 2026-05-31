import {useQuery, type UseQueryResult} from '@tanstack/react-query';
import {api} from '../api/client';
import {queryKeys} from '../api/queryKeys';
import type {CoverageData, OverviewTrend, ToolDistribution, WasteTeamSummary} from '../api/types';
import type {TimeRangeValue} from '../timeRange/range';
import {trendQuery, trendWindowKey} from '../timeRange/trendQuery';

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
