import {useQuery, type UseQueryResult} from '@tanstack/react-query';
import {api} from '../api/client';
import {queryKeys} from '../api/queryKeys';
import type {
    PRReviewPeriodUnit,
    TeamDetail,
    TeamListItem,
    TeamPRReviewCoachingResponse,
    TeamProviders,
    TeamTrend,
    WasteAlert,
} from '../api/types';
import type {TimeRangeValue} from '../timeRange/range';
import {trendQuery, trendWindowKey} from '../timeRange/trendQuery';

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

/**
 * Team (or org) PR/review coaching aggregate (Task 5.3). `scope` is a team name
 * or the literal 'org'; keyed by scope + unit so each caches independently.
 */
export function useTeamPRReviewCoaching(
    scope: string,
    unit: PRReviewPeriodUnit,
): UseQueryResult<TeamPRReviewCoachingResponse, Error> {
    return useQuery({
        queryKey: queryKeys.teamPRCoaching(scope, unit),
        queryFn: () => api.getTeamPRReviewCoaching(scope, unit),
    });
}
