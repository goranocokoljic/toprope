import {
    useMutation,
    useQuery,
    useQueryClient,
    type UseMutationResult,
    type UseQueryResult,
} from '@tanstack/react-query';
import {api} from '../api/client';
import {queryKeys} from '../api/queryKeys';
import type {AnomalyAlert, AnomalyStatus} from '../api/types';

/**
 * React Query hooks backing anomaly surfacing (Task 4.8). The open list feeds the
 * manager panel AND the per-team inline flags; acknowledging or resolving an
 * anomaly invalidates every status list so the open set shrinks and the
 * acknowledged/resolved audit views pick the row up.
 */

/** Team anomalies for a status (default open). */
export function useAnomalies(status: AnomalyStatus = 'open'): UseQueryResult<AnomalyAlert[], Error> {
    return useQuery({
        queryKey: queryKeys.anomalies(status),
        queryFn: () => api.getAnomalies(status),
    });
}

function invalidateAllAnomalyLists(qc: ReturnType<typeof useQueryClient>): void {
    // A transition moves a row between statuses, so refresh every cached status
    // list rather than just the one currently shown.
    void qc.invalidateQueries({queryKey: ['anomalies']});
}

/** Acknowledge an anomaly, refreshing every anomaly list. */
export function useAcknowledgeAnomaly(): UseMutationResult<AnomalyAlert, Error, string> {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => api.acknowledgeAnomaly(id),
        onSuccess: () => invalidateAllAnomalyLists(qc),
    });
}

/** Resolve an anomaly, refreshing every anomaly list. */
export function useResolveAnomaly(): UseMutationResult<AnomalyAlert, Error, string> {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => api.resolveAnomaly(id),
        onSuccess: () => invalidateAllAnomalyLists(qc),
    });
}
