import {useMutation, useQuery, type UseMutationResult, type UseQueryResult} from '@tanstack/react-query';
import {api} from '../api/client';
import {queryKeys} from '../api/queryKeys';
import type {RelatedPractices} from '../api/types';

/**
 * React Query hooks for the contextual best-practice display (Task 6.2.7 / #162).
 *
 * `useRelatedPractices` reads the practices to surface next to a metric (viewer-
 * scoped server-side); `useRecordPracticeView` logs that the developer actually
 * viewed one (feeding the 6.2.4 usage signal). Thin wrappers — the
 * `RelatedPractices` component owns layout and the unobtrusive empty state.
 */

/**
 * The practices to surface next to `metric` for the logged-in developer. `enabled`
 * lets a caller mount the affordance but skip the fetch (e.g. before the metric is
 * known); defaults to on.
 */
export function useRelatedPractices(
    metric: string,
    enabled = true,
): UseQueryResult<RelatedPractices, Error> {
    return useQuery({
        queryKey: queryKeys.relatedPractices(metric),
        queryFn: () => api.getRelatedPractices(metric),
        enabled,
    });
}

/**
 * Record a "viewed" usage event for a surfaced practice. Fire-and-forget from the
 * UI's perspective — a failed view-log must never break the read surface, so callers
 * don't surface its error. No cache invalidation: the surfacing list does not change
 * when a view is logged.
 */
export function useRecordPracticeView(): UseMutationResult<void, Error, {id: string; metric: string}> {
    return useMutation({
        mutationFn: ({id, metric}) => api.recordPracticeView(id, metric),
    });
}
