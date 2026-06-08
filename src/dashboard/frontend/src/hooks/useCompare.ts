import {useQuery, type UseQueryResult} from '@tanstack/react-query';
import {api} from '../api/client';
import {queryKeys} from '../api/queryKeys';
import type {TeamComparison} from '../api/types';
import type {TimeRangeValue} from '../timeRange/range';
import {trendQuery, trendWindowKey} from '../timeRange/trendQuery';
import {MIN_COMPARE_TEAMS, MAX_COMPARE_TEAMS} from '../compare/limits';

/**
 * Rich side-by-side comparison of 2–4 teams over the selected window (Task 4.9).
 * The query is disabled until a valid 2–4 team selection exists, so the page can
 * render the selector before any fetch fires (and the >4 case never reaches the
 * API — the UI prevents it, the server validates it as defense-in-depth).
 */
export function useTeamCompare(
    teams: string[],
    range: TimeRangeValue,
): UseQueryResult<TeamComparison, Error> {
    const enabled = teams.length >= MIN_COMPARE_TEAMS && teams.length <= MAX_COMPARE_TEAMS;
    return useQuery({
        queryKey: queryKeys.teamCompare(teams, trendWindowKey(range)),
        queryFn: () => api.getCompare(teams, trendQuery(range)),
        enabled,
    });
}
