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
    // Waste Detection screen (Task 2.7): active alert list + resolved audit trail.
    wasteAlerts: ['waste', 'alerts'] as const,
    wasteResolved: ['waste', 'resolved'] as const,
    // Teams list + per-team detail surfaces (Task 2.6).
    teams: ['teams'] as const,
    teamDetail: (team: string) => ['teams', 'detail', team] as const,
    // Keyed by team + resolved window so changing either refetches.
    teamTrend: (team: string, window: string) => ['teams', 'trend', team, window] as const,
    teamProviders: (team: string) => ['teams', 'providers', team] as const,
    teamWaste: (team: string) => ['teams', 'waste', team] as const,
    globalSettings: ['settings', 'global'] as const,
    teamSettings: (team: string) => ['settings', 'team', team] as const,
    // Optional leaderboard (Task 2.17): availability probe + per-team ranked view.
    leaderboardAvailability: ['leaderboard', 'availability'] as const,
    leaderboard: (team: string, metric: string) => ['leaderboard', team, metric] as const,
    preferences: ['preferences'] as const,
    // Developer "My Dashboard" (Task 2.8). Window-keyed surfaces refetch when the
    // selected time range changes; the journey is window-independent.
    meOverview: (window: string) => ['me', 'overview', window] as const,
    meTimeline: (window: string) => ['me', 'timeline', window] as const,
    meJourney: ['me', 'journey'] as const,
    // Admin Management (Task 2.13).
    adminUsers: ['admin', 'users'] as const,
    adminTeams: ['admin', 'teams'] as const,
    adminDevelopers: ['admin', 'developers'] as const,
    adminSubscriptions: ['admin', 'subscriptions'] as const,
    adminDataSources: ['admin', 'data-sources'] as const,
};
