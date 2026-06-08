import {useQuery, type UseQueryResult} from '@tanstack/react-query';
import {api} from '../api/client';
import {queryKeys} from '../api/queryKeys';
import type {CompareTable} from '../api/types';

/**
 * Sortable all-teams ranking table for one period (Task 4.10). `period` is the
 * selected quarter, or undefined to let the server default to the latest
 * rolled-up quarter (the first load, before the selector has resolved a value).
 * Keyed by the period so switching it refetches; the row set is small (one row
 * per team) and read from pre-computed aggregates, so this stays cheap.
 */
export function useCompareTable(period: string | undefined): UseQueryResult<CompareTable, Error> {
    return useQuery({
        queryKey: queryKeys.teamCompareTable(period ?? 'latest'),
        queryFn: () => api.getCompareTable(period),
    });
}
