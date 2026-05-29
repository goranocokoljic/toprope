import {QueryClient, type QueryClientConfig} from '@tanstack/react-query';

/**
 * Production React Query configuration, exported so tests exercise the same
 * caching behavior the app ships with rather than drifting to a different
 * config. `staleTime` keeps fetched data fresh (no refetch) for 30s; window
 * focus refetch is off (a dashboard isn't a live feed).
 */
export const queryClientConfig: QueryClientConfig = {
    defaultOptions: {
        queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
        },
    },
};

export function createQueryClient(): QueryClient {
    return new QueryClient(queryClientConfig);
}
