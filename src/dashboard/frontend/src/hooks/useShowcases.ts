/**
 * Data hooks for the showcase browse/governance UI (Task 6.3.9 / #172).
 *
 * Thin React Query wrappers over the showcase client methods: the searchable gallery,
 * a single showcase's full detail, the owner-unpublish mutation, and the author's
 * removal-notification feed. The unpublish mutation invalidates the gallery (the
 * unpublished showcase drops out) and the detail (its state changes).
 */

import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import type {UseMutationResult, UseQueryResult} from '@tanstack/react-query';
import {api, type ShowcaseBrowseFilters} from '../api/client';
import {queryKeys} from '../api/queryKeys';
import type {BrowseShowcaseDetail, ShowcaseGalleryList, ShowcaseRemovalNotice} from '../api/types';

/** Stable cache key for a filter combination — order-independent of the object's keys. */
export function showcaseFilterKey(filters: ShowcaseBrowseFilters): string {
    return JSON.stringify({
        q: filters.q ?? '',
        tag: filters.tag ?? '',
        team: filters.team ?? '',
        scope: filters.scope ?? '',
    });
}

/** The searchable showcase gallery for the current filters. */
export function useBrowseShowcases(
    filters: ShowcaseBrowseFilters,
): UseQueryResult<ShowcaseGalleryList, Error> {
    return useQuery({
        queryKey: queryKeys.showcaseBrowse(showcaseFilterKey(filters)),
        queryFn: () => api.browseShowcases(filters),
    });
}

/** One showcase's full detail. */
export function useShowcaseDetail(id: string): UseQueryResult<BrowseShowcaseDetail, Error> {
    return useQuery({
        queryKey: queryKeys.showcaseDetail(id),
        queryFn: () => api.getShowcaseDetail(id),
        enabled: id.length > 0,
    });
}

/**
 * Unpublish one's OWN showcase. On success, invalidates the gallery (the showcase
 * drops out of browse) and this showcase's detail (its state changed).
 */
export function useUnpublishShowcase(id: string): UseMutationResult<string, Error, void> {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => api.unpublishShowcase(id),
        onSuccess: () => {
            void queryClient.invalidateQueries({queryKey: ['showcases', 'browse']});
            void queryClient.invalidateQueries({queryKey: queryKeys.showcaseDetail(id)});
        },
    });
}

/** The author's removal-notification feed — lead removals of their own showcases. */
export function useShowcaseRemovals(): UseQueryResult<ShowcaseRemovalNotice[], Error> {
    return useQuery({
        queryKey: queryKeys.showcaseRemovals,
        queryFn: () => api.getShowcaseRemovals(),
    });
}
