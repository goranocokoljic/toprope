import {useQuery, type UseQueryResult} from '@tanstack/react-query';
import {api} from '../api/client';
import {queryKeys} from '../api/queryKeys';
import type {Leaderboard, LeaderboardAvailability, LeaderboardMetric} from '../api/types';

/**
 * Hooks for the optional leaderboard (Task 2.17). `useLeaderboardAvailability`
 * is the capability probe the nav and route gate read so the feature shows no
 * trace when disabled; `useLeaderboard` fetches one team's ranked view.
 */
export function useLeaderboardAvailability(): UseQueryResult<LeaderboardAvailability, Error> {
    return useQuery({
        queryKey: queryKeys.leaderboardAvailability,
        queryFn: api.getLeaderboardAvailability,
    });
}

export function useLeaderboard(
    team: string | null,
    metric: LeaderboardMetric,
): UseQueryResult<Leaderboard, Error> {
    return useQuery({
        queryKey: queryKeys.leaderboard(team ?? '', metric),
        queryFn: () => api.getLeaderboard(team as string, metric),
        enabled: Boolean(team),
    });
}
