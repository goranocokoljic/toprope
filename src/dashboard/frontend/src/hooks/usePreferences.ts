import {
    useMutation,
    useQuery,
    useQueryClient,
    type UseMutationResult,
    type UseQueryResult,
} from '@tanstack/react-query';
import {api} from '../api/client';
import {queryKeys} from '../api/queryKeys';
import type {CoachingPreferences, CoachingPreferencesPatch, UserPreferences} from '../api/types';

/** Fetches the logged-in user's UI preferences. */
export function usePreferences(): UseQueryResult<UserPreferences, Error> {
    return useQuery({
        queryKey: queryKeys.preferences,
        queryFn: api.getPreferences,
    });
}

/**
 * Mutation that patches preferences and writes the fresh server result straight
 * into the cache, so the UI (dark mode, default time range) reflects the change
 * immediately without a refetch.
 */
export function useUpdatePreferences(): UseMutationResult<
    UserPreferences,
    Error,
    Partial<UserPreferences>
> {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (patch: Partial<UserPreferences>) => api.patchPreferences(patch),
        onSuccess: (data) => {
            queryClient.setQueryData(queryKeys.preferences, data);
        },
    });
}

/** Fetches the developer's coaching preferences, resolved against the org boundary. */
export function useCoachingPreferences(): UseQueryResult<CoachingPreferences, Error> {
    return useQuery({
        queryKey: queryKeys.coachingPreferences,
        queryFn: api.getCoachingPreferences,
    });
}

/**
 * Mutation that patches coaching preferences and writes the fresh server result
 * (which re-resolves org gating) straight into the cache, so a toggle and any
 * resulting blocked state reflect immediately without a refetch.
 */
export function useUpdateCoachingPreferences(): UseMutationResult<
    CoachingPreferences,
    Error,
    CoachingPreferencesPatch
> {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (patch: CoachingPreferencesPatch) => api.patchCoachingPreferences(patch),
        onSuccess: (data) => {
            queryClient.setQueryData(queryKeys.coachingPreferences, data);
        },
    });
}
