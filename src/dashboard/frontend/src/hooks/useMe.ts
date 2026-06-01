import {useQuery, type UseQueryResult} from '@tanstack/react-query';
import {api, type TimeRangeQuery} from '../api/client';
import {queryKeys} from '../api/queryKeys';
import type {MeJourney, MeOverview, MeTimeline} from '../api/types';
import type {TimeRangeValue} from '../timeRange/range';
import {trendQuery, trendWindowKey} from '../timeRange/trendQuery';

/**
 * Data hooks backing the developer "My Dashboard" (Task 2.8). Each is a thin
 * React Query wrapper over a session-scoped `/api/me/*` endpoint — the server
 * resolves the developer strictly from the session, so nothing here passes an
 * id. The page composes these into the personal stat cards, adoption journey,
 * and activity trend.
 */

/**
 * Personal stat summary for an explicit window. The stat cards use fixed
 * trailing windows (this week / this month) rather than the trend selector, so
 * this takes a raw `TimeRangeQuery` and is cache-keyed by its window descriptor.
 */
export function useMeOverview(params: TimeRangeQuery): UseQueryResult<MeOverview, Error> {
    // Key on the preset name, or the custom span when no preset is given —
    // the same window descriptor trendWindowKey produces for the timeline hooks.
    const windowKey = params.range ?? `custom:${params.from ?? ''}:${params.to ?? ''}`;
    return useQuery({
        queryKey: queryKeys.meOverview(windowKey),
        queryFn: () => api.getMeOverview(params),
    });
}

/** Personal activity timeline for the selected trend window. */
export function useMeTimeline(range: TimeRangeValue): UseQueryResult<MeTimeline, Error> {
    return useQuery({
        queryKey: queryKeys.meTimeline(trendWindowKey(range)),
        queryFn: () => api.getMeTimeline(trendQuery(range)),
    });
}

/** Personal adoption journey: per-tool status + lifecycle milestones. */
export function useMeJourney(): UseQueryResult<MeJourney, Error> {
    return useQuery({
        queryKey: queryKeys.meJourney,
        queryFn: api.getMeJourney,
    });
}
