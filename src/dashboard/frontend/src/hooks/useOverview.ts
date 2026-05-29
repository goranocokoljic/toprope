import {useQuery, type UseQueryResult} from '@tanstack/react-query';
import {api} from '../api/client';
import {queryKeys} from '../api/queryKeys';
import type {OverviewData} from '../api/types';

/**
 * Fetches the org-wide overview. React Query dedupes and caches by key, so
 * multiple components reading this hook share a single in-flight request.
 */
export function useOverview(): UseQueryResult<OverviewData, Error> {
    return useQuery({
        queryKey: queryKeys.overview,
        queryFn: api.getOverview,
    });
}
