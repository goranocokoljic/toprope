/**
 * Data hooks for the best-practice browse UI (Task 6.2.8 / #163).
 *
 * Thin React Query wrappers over the browse client methods: the searchable list, a
 * single practice's detail and history, and the togglable feedback mutation. The
 * feedback mutation updates the detail cache in place (so the affordance reflects the
 * new signal + counts without a refetch) and invalidates the list (whose ordering and
 * ratios depend on feedback).
 */

import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import type {UseMutationResult, UseQueryResult} from '@tanstack/react-query';
import {api, type PracticeBrowseFilters} from '../api/client';
import {queryKeys} from '../api/queryKeys';
import type {
    BrowsePracticeDetail,
    CreatedPractice,
    OwnedPracticeView,
    PracticeBrowseList,
    PracticeFeedbackResult,
    PracticeFeedbackSignal,
    PracticeHistoryEntry,
    PracticePreview,
} from '../api/types';

/** Stable cache key for a filter combination — order-independent of the object's keys. */
export function browseFilterKey(filters: PracticeBrowseFilters): string {
    return JSON.stringify({
        q: filters.q ?? '',
        tag: filters.tag ?? '',
        team: filters.team ?? '',
        scope: filters.scope ?? '',
    });
}

/** The searchable browse list for the current filters. */
export function useBrowsePractices(
    filters: PracticeBrowseFilters,
): UseQueryResult<PracticeBrowseList, Error> {
    return useQuery({
        queryKey: queryKeys.practicesBrowse(browseFilterKey(filters)),
        queryFn: () => api.browsePractices(filters),
    });
}

/** One practice's full detail. */
export function usePracticeDetail(id: string): UseQueryResult<BrowsePracticeDetail, Error> {
    return useQuery({
        queryKey: queryKeys.practiceDetail(id),
        queryFn: () => api.getPracticeDetail(id),
        enabled: id.length > 0,
    });
}

/**
 * A practice's version history. Disabled until `enabled` is true, so the history is
 * fetched only when the viewer actually opens the history section (it is hidden by
 * default).
 */
export function usePracticeHistory(
    id: string,
    enabled: boolean,
): UseQueryResult<PracticeHistoryEntry[], Error> {
    return useQuery({
        queryKey: queryKeys.practiceHistory(id),
        queryFn: () => api.getPracticeHistory(id),
        enabled: enabled && id.length > 0,
    });
}

/**
 * Toggle the viewer's feedback on a practice. On success, patches the detail cache with
 * the resulting signal + fresh counts and invalidates the browse list (feedback affects
 * its ordering and ratios).
 */
export function useTogglePracticeFeedback(
    id: string,
): UseMutationResult<PracticeFeedbackResult, Error, PracticeFeedbackSignal> {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (signal: PracticeFeedbackSignal) => api.togglePracticeFeedback(id, signal),
        onSuccess: (result) => {
            queryClient.setQueryData<BrowsePracticeDetail>(queryKeys.practiceDetail(id), (prev) =>
                prev
                    ? {...prev, feedback: {...result.feedback, viewerSignal: result.signal}}
                    : prev,
            );
            void queryClient.invalidateQueries({queryKey: ['practices', 'browse']});
        },
    });
}

// --- Authoring entry points (Task 6.2.3 routes, driven by the 6.2.8 editor) ---

/** Load one of the viewer's OWN practices for editing. Disabled until `enabled`. */
export function useOwnedPractice(
    id: string,
    enabled: boolean,
): UseQueryResult<OwnedPracticeView, Error> {
    return useQuery({
        queryKey: ['practices', 'owned', id],
        queryFn: () => api.getOwnedPractice(id),
        enabled: enabled && id.length > 0,
    });
}

/** Render a live, sanitized preview of markdown (persists nothing). */
export function usePreviewPractice(): UseMutationResult<PracticePreview, Error, string> {
    return useMutation({mutationFn: (markdown: string) => api.previewPractice(markdown)});
}

/** Create a draft practice. Invalidates the browse list on success. */
export function useCreatePractice(): UseMutationResult<
    CreatedPractice,
    Error,
    {title: string; scope: 'org' | 'team'; markdown: string}
> {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (input) => api.createPractice(input),
        onSuccess: () => void queryClient.invalidateQueries({queryKey: ['practices', 'browse']}),
    });
}

/** Save an edit to one of the viewer's OWN practices; refreshes its browse detail. */
export function useSavePractice(
    id: string,
): UseMutationResult<void, Error, string> {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (markdown: string) => api.savePractice(id, markdown),
        onSuccess: () => {
            void queryClient.invalidateQueries({queryKey: queryKeys.practiceDetail(id)});
            void queryClient.invalidateQueries({queryKey: ['practices', 'owned', id]});
            void queryClient.invalidateQueries({queryKey: queryKeys.practiceHistory(id)});
        },
    });
}
