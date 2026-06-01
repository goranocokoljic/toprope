import {
    useMutation,
    useQuery,
    useQueryClient,
    type UseMutationResult,
    type UseQueryResult,
} from '@tanstack/react-query';
import {api} from '../api/client';
import {queryKeys} from '../api/queryKeys';
import type {WasteAlert, WasteResolutionReason} from '../api/types';

/**
 * React Query hooks backing the manager Waste Detection screen (Task 2.7). The
 * active and resolved lists are read separately so the "active" and "resolved
 * audit trail" tabs cache independently; resolving an alert invalidates both,
 * plus the overview/summary surfaces that show org-wide waste totals.
 */

/** Every active (unresolved) waste alert across the org. */
export function useWasteAlerts(): UseQueryResult<WasteAlert[], Error> {
    return useQuery({
        queryKey: queryKeys.wasteAlerts,
        queryFn: api.getWasteAlerts,
    });
}

/** Resolved waste alerts — the audit trail of manager actions. */
export function useResolvedWaste(): UseQueryResult<WasteAlert[], Error> {
    return useQuery({
        queryKey: queryKeys.wasteResolved,
        queryFn: api.getResolvedWaste,
    });
}

/** Resolve an alert with a structured reason, refreshing every waste surface. */
export function useResolveWaste(): UseMutationResult<
    WasteAlert,
    Error,
    {id: string; reason: WasteResolutionReason}
> {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: ({id, reason}) => api.resolveWaste(id, reason),
        onSuccess: () => {
            // The active list shrinks, the resolved trail grows, and the
            // overview/summary waste totals shift — refresh all four.
            void qc.invalidateQueries({queryKey: queryKeys.wasteAlerts});
            void qc.invalidateQueries({queryKey: queryKeys.wasteResolved});
            void qc.invalidateQueries({queryKey: queryKeys.wasteSummary});
            void qc.invalidateQueries({queryKey: queryKeys.overview});
        },
    });
}
