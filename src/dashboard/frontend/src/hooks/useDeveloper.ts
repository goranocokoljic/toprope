import {useQuery, type UseQueryResult} from '@tanstack/react-query';
import {api} from '../api/client';
import {queryKeys} from '../api/queryKeys';
import type {DeveloperIdentity, DeveloperJourney} from '../api/types';

/**
 * Manager developer-detail hooks (Task 4.11). Thin React Query wrappers over the
 * admin-scoped `/api/developers/:id` surface, keyed by id so each developer
 * caches independently. The journey carries no prompt content and nothing
 * rankable — it is the same aggregate growth story the developer sees of
 * themselves, framed here as journey/health for the manager.
 */

/** A developer's identity (name/team) for the detail header. */
export function useDeveloperIdentity(id: string): UseQueryResult<DeveloperIdentity, Error> {
    return useQuery({
        queryKey: queryKeys.developerIdentity(id),
        queryFn: () => api.getDeveloperIdentity(id),
    });
}

/** A developer's aggregate adoption journey. */
export function useDeveloperJourney(id: string): UseQueryResult<DeveloperJourney, Error> {
    return useQuery({
        queryKey: queryKeys.developerJourney(id),
        queryFn: () => api.getDeveloperJourney(id),
    });
}
