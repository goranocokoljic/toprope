/**
 * Central registry of React Query keys. Keeping them in one place avoids
 * cache-key drift between the component that reads a query and any code that
 * invalidates it later.
 */
export const queryKeys = {
    overview: ['overview'] as const,
    toolDistribution: ['tools', 'distribution'] as const,
    // Keyed by the resolved window so changing the time range refetches.
    overviewTrend: (window: string) => ['overview', 'trend', window] as const,
    coverage: ['coverage'] as const,
    wasteSummary: ['waste', 'summary'] as const,
    globalSettings: ['settings', 'global'] as const,
    teamSettings: (team: string) => ['settings', 'team', team] as const,
    preferences: ['preferences'] as const,
};
