/**
 * Central registry of React Query keys. Keeping them in one place avoids
 * cache-key drift between the component that reads a query and any code that
 * invalidates it later.
 */
export const queryKeys = {
    overview: ['overview'] as const,
};
