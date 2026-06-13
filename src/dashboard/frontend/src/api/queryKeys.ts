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
    // Anomaly surfacing (Task 4.8): keyed by status so the open/acknowledged/
    // resolved views cache independently. The team-detail inline flags reuse the
    // open list (same key), so acting on one anomaly refreshes both surfaces.
    anomalies: (status: string) => ['anomalies', status] as const,
    // Teams list + per-team detail surfaces (Task 2.6).
    teams: ['teams'] as const,
    teamDetail: (team: string) => ['teams', 'detail', team] as const,
    // Keyed by team + resolved window so changing either refetches.
    teamTrend: (team: string, window: string) => ['teams', 'trend', team, window] as const,
    teamProviders: (team: string) => ['teams', 'providers', team] as const,
    teamWaste: (team: string) => ['teams', 'waste', team] as const,
    // Rich team comparison (Task 4.9): keyed by the selected teams + resolved
    // window so changing either the selection or the range refetches.
    teamCompare: (teams: string[], window: string) =>
        ['teams', 'compare', teams.join(','), window] as const,
    // Sortable all-teams ranking table (Task 4.10): keyed by the selected period
    // so changing the period refetches. 'latest' stands in before a period is
    // resolved (initial load defaults to the most recent rolled-up quarter).
    teamCompareTable: (period: string) => ['teams', 'compare-table', period] as const,
    globalSettings: ['settings', 'global'] as const,
    teamSettings: (team: string) => ['settings', 'team', team] as const,
    // Structured anomaly detection config (Task 4.12): per-metric + engine knobs.
    anomalyConfig: ['settings', 'anomaly'] as const,
    // Optional leaderboard (Task 2.17): availability probe + per-team ranked view.
    leaderboardAvailability: ['leaderboard', 'availability'] as const,
    leaderboard: (team: string, metric: string) => ['leaderboard', team, metric] as const,
    preferences: ['preferences'] as const,
    // Developer coaching preferences (Task 5.10): the developer's own opt-ins,
    // resolved against the org boundary.
    coachingPreferences: ['preferences', 'coaching'] as const,
    // Developer "My Dashboard" (Task 2.8). Window-keyed surfaces refetch when the
    // selected time range changes; the journey is window-independent.
    meOverview: (window: string) => ['me', 'overview', window] as const,
    meTimeline: (window: string) => ['me', 'timeline', window] as const,
    meJourney: ['me', 'journey'] as const,
    // Manager developer-detail (Task 4.11): per-developer identity + journey,
    // keyed by id so each developer caches independently.
    developerIdentity: (id: string) => ['developers', id, 'identity'] as const,
    developerJourney: (id: string) => ['developers', id, 'journey'] as const,
    // Developer "My Tools" + "My Activity" (Task 2.9). Window-keyed so changing
    // the time range refetches.
    meTools: (window: string) => ['me', 'tools', window] as const,
    meActivity: (window: string) => ['me', 'activity', window] as const,
    // PR/review coaching (Task 5.3). Keyed by period unit so weekly/monthly cache
    // independently; the team aggregate adds the scope (team name or 'org').
    mePRCoaching: (unit: string) => ['me', 'pr-coaching', unit] as const,
    teamPRCoaching: (scope: string, unit: string) =>
        ['coaching', 'pr-review', scope, unit] as const,
    // Manager aggregate coaching panel (Task 5.11): the unified all-pillar surface,
    // keyed by scope (team name or 'org') + period unit.
    managerCoachingPanel: (scope: string, unit: string) =>
        ['coaching', 'manager', scope, unit] as const,
    // Phase 3 (Task 3.12): maturity trend + AI summaries.
    // Maturity trend is keyed by scope ('org' or a team) + resolved window.
    maturityTrend: (scope: string, window: string) => ['maturity', 'trend', scope, window] as const,
    // Summary list is keyed by scope; the detail is keyed by id so an expanded
    // narrative caches independently of the list.
    summaries: (scope: string) => ['summaries', 'list', scope] as const,
    summary: (id: string) => ['summaries', 'detail', id] as const,
    // Admin Management (Task 2.13).
    adminUsers: ['admin', 'users'] as const,
    adminTeams: ['admin', 'teams'] as const,
    adminDevelopers: ['admin', 'developers'] as const,
    adminSubscriptions: ['admin', 'subscriptions'] as const,
    adminDataSources: ['admin', 'data-sources'] as const,
    // Expense reconciliation (Task 4.4): keyed by status so switching the filter
    // refetches the right slice of the queue.
    adminReconciliation: (status: string) => ['admin', 'reconciliation', status] as const,
};
