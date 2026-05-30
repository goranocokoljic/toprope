import {useMutation, useQuery, useQueryClient, type UseQueryResult} from '@tanstack/react-query';
import {api} from '../api/client';
import {queryKeys} from '../api/queryKeys';
import type {UserPreferences} from '../api/types';

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
export function useUpdatePreferences() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (patch: Partial<UserPreferences>) => api.patchPreferences(patch),
        onSuccess: (data) => {
            queryClient.setQueryData(queryKeys.preferences, data);
        },
    });
}
