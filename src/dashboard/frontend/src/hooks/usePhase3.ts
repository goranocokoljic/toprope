import {
    useMutation,
    useQuery,
    useQueryClient,
    type UseMutationResult,
    type UseQueryResult,
} from '@tanstack/react-query';
import {api} from '../api/client';
import {queryKeys} from '../api/queryKeys';
import type {MaturityTrend, SummaryDetail, SummaryLevel, SummaryListItem} from '../api/types';
import type {TimeRangeValue} from '../timeRange/range';
import {trendQuery, trendWindowKey} from '../timeRange/trendQuery';

/**
 * React Query hooks backing the Phase 3 dashboard surfaces (Task 3.12): the AI
 * maturity trend chart and the summaries view (list, detail, regenerate, and
 * on-demand generate). Thin wrappers, like the other manager data hooks — the
 * components own layout and data-state handling.
 *
 * `scope` is the API token throughout: 'org' for the org roll-up, or the team
 * name for the maturity trend and 'team:<name>' for the summaries filter.
 */

/** Maturity score trend for a scope ('org' or a team) over the selected window. */
export function useMaturityTrend(scope: string, range: TimeRangeValue): UseQueryResult<MaturityTrend, Error> {
    return useQuery({
        queryKey: queryKeys.maturityTrend(scope, trendWindowKey(range)),
        queryFn: () => api.getMaturityTrend(scope, trendQuery(range)),
    });
}

/**
 * Summaries for a scope, newest first. `scope` is the summaries API token
 * ('org' | 'team:<name>'). The panel selects cadences (latest weekly/monthly,
 * history) from this single list in-memory, so no server-side level filter is
 * needed here.
 */
export function useSummaries(scope: string): UseQueryResult<SummaryListItem[], Error> {
    return useQuery({
        queryKey: queryKeys.summaries(scope),
        queryFn: () => api.getSummaries({scope}),
    });
}

/**
 * One summary's full narrative + metadata. Disabled until an id is supplied, so
 * a panel can mount the hook and only fetch once the user expands a summary.
 */
export function useSummary(id: string | null): UseQueryResult<SummaryDetail, Error> {
    return useQuery({
        queryKey: queryKeys.summary(id ?? ''),
        queryFn: () => api.getSummary(id as string),
        enabled: id !== null,
    });
}

/** Invalidate every summaries list + the affected detail after a (re)generation. */
function invalidateSummaries(qc: ReturnType<typeof useQueryClient>, id?: string): void {
    // Lists are keyed by scope+level, so invalidate the whole 'summaries/list'
    // prefix — a regenerate flips is_stale and a generate can add a row to any
    // matching list (e.g. the unfiltered 'all' view and the level-filtered one).
    void qc.invalidateQueries({queryKey: ['summaries', 'list']});
    if (id) {
        void qc.invalidateQueries({queryKey: queryKeys.summary(id)});
    }
}

/** Regenerate a summary (optional focus), refreshing the detail + lists. */
export function useRegenerateSummary(): UseMutationResult<
    SummaryDetail,
    Error,
    {id: string; focus?: string}
> {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: ({id, focus}) => api.regenerateSummary(id, focus),
        onSuccess: (summary) => {
            // Seed the detail cache with the fresh text so the open view updates
            // immediately, then invalidate so any stale list rows refetch.
            qc.setQueryData(queryKeys.summary(summary.id), summary);
            invalidateSummaries(qc, summary.id);
        },
    });
}

/** Generate a summary on demand (quarterly/yearly), refreshing the lists. */
export function useGenerateSummary(): UseMutationResult<
    SummaryDetail,
    Error,
    {level: SummaryLevel; period: string; scope: string}
> {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: (input) => api.generateSummary(input),
        onSuccess: (summary) => {
            qc.setQueryData(queryKeys.summary(summary.id), summary);
            invalidateSummaries(qc, summary.id);
        },
    });
}
