import {useMutation, useQuery, useQueryClient, type UseQueryResult} from '@tanstack/react-query';
import {api} from '../api/client';
import {queryKeys} from '../api/queryKeys';
import type {GlobalSettings, TeamSettings} from '../api/types';

export function useGlobalSettings(): UseQueryResult<GlobalSettings, Error> {
    return useQuery({
        queryKey: queryKeys.globalSettings,
        queryFn: api.getGlobalSettings,
    });
}

export function useUpdateGlobalSettings() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (patch: Partial<GlobalSettings>) => api.patchGlobalSettings(patch),
        onSuccess: (data) => {
            queryClient.setQueryData(queryKeys.globalSettings, data);
            // Team views derive their override gates from the global flags, so
            // a global change can change what teams may override — refetch them.
            void queryClient.invalidateQueries({queryKey: ['settings', 'team']});
        },
    });
}

export function useTeamNames(): UseQueryResult<string[], Error> {
    return useQuery({
        queryKey: ['teams', 'names'],
        queryFn: api.getTeamNames,
    });
}

export function useTeamSettings(team: string | null): UseQueryResult<TeamSettings, Error> {
    return useQuery({
        queryKey: queryKeys.teamSettings(team ?? ''),
        queryFn: () => api.getTeamSettings(team as string),
        enabled: Boolean(team),
    });
}

export function useUpdateTeamSettings(team: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (patch: Partial<GlobalSettings>) => api.patchTeamSettings(team, patch),
        onSuccess: (data) => {
            queryClient.setQueryData(queryKeys.teamSettings(team), data);
        },
    });
}
