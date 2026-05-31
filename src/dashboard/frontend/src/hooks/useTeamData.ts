import {useQuery, type UseQueryResult} from '@tanstack/react-query';
import {api, type TimeRangeQuery} from '../api/client';
import {queryKeys} from '../api/queryKeys';
import type {TeamDetail, TeamListItem, TeamProviders, TeamTrend, WasteAlert} from '../api/types';
import type {TimeRangeValue} from '../timeRange/range';

/**
 * Data hooks backing the manager Teams list + Team Detail screens (Task 2.6).
 * Each is a thin React Query wrapper so the pages compose cached, deduped reads
 * of the manager API; the pages own layout and data-state handling.
 */

/** Every team's list-row summary (paged through client-side by the api client). */
export function useTeams(): UseQueryResult<TeamListItem[], Error> {
    return useQuery({
        queryKey: queryKeys.teams,
        queryFn: api.getTeams,
    });
}

/** Full detail (summary + per-developer aggregates) for one team. */
export function useTeamDetail(team: string): UseQueryResult<TeamDetail, Error> {
    return useQuery({
        queryKey: queryKeys.teamDetail(team),
        queryFn: () => api.getTeamDetail(team),
    });
}

/**
 * Turn a resolved range into the trend query the backend expects. Presets carry
 * a window the server recomputes, so we send only `range`; custom carries
 * explicit dates the server can't derive, so we send `from`+`to`.
 */
function trendQuery(range: TimeRangeValue): TimeRangeQuery {
    return range.kind === 'custom' ? {from: range.from, to: range.to} : {range: range.kind};
}

/** Stable cache key for a window — preset name, or the custom date span. */
function trendWindowKey(range: TimeRangeValue): string {
    return range.kind === 'custom' ? `custom:${range.from}:${range.to}` : range.kind;
}

/** Adoption trend for one team over the selected window. */
export function useTeamTrend(team: string, range: TimeRangeValue): UseQueryResult<TeamTrend, Error> {
    return useQuery({
        queryKey: queryKeys.teamTrend(team, trendWindowKey(range)),
        queryFn: () => api.getTeamTrend(team, trendQuery(range)),
    });
}

/** Git provider(s) hosting the team's repos, by developer git activity. */
export function useTeamProviders(team: string): UseQueryResult<TeamProviders, Error> {
    return useQuery({
        queryKey: queryKeys.teamProviders(team),
        queryFn: () => api.getTeamProviders(team),
    });
}

/** Open waste alerts scoped to one team. */
export function useTeamWaste(team: string): UseQueryResult<WasteAlert[], Error> {
    return useQuery({
        queryKey: queryKeys.teamWaste(team),
        queryFn: () => api.getTeamWaste(team),
    });
}
