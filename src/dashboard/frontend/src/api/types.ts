/**
 * Types mirroring the Phase 1 REST API responses. Kept hand-written (rather
 * than generated) for now — the surface is small and these document the exact
 * shape the dashboard depends on. The backend wraps payloads in `{ data: ... }`.
 */

export interface ApiEnvelope<T> {
    data: T;
}

export type DataQuality = 'high' | 'medium' | 'low' | 'none';

export interface OverviewData {
    total_developers: number;
    active_developers: number;
    total_subscriptions: number;
    total_monthly_cost: number;
    active_tools: string[];
    data_quality_distribution: Record<DataQuality, number>;
    active_waste_alert_count: number;
    total_monthly_waste: number;
}

// --- Manager organization overview (Task 2.5) ---------------------------

/** Seats, distinct developers, and cost for one tool. From /api/tools/distribution. */
export interface ToolDistributionEntry {
    tool: string;
    seats: number;
    developers: number;
    monthly_cost: number;
}

/** Org-wide tool distribution: per-tool seat/cost mix plus totals. */
export interface ToolDistribution {
    tools: ToolDistributionEntry[];
    total_seats: number;
    total_monthly_cost: number;
}

/** One day on the adoption-trend axis. From /api/overview/trend. */
export interface TrendPoint {
    date: string;
    active_developers: number;
    interactions: number;
    acceptances: number;
}

/** Adoption trend over a resolved window. */
export interface OverviewTrend {
    range: TimeRangeKind;
    from: string;
    to: string;
    points: TrendPoint[];
}

/** Latest connector sync status. From /api/coverage. */
export interface CoverageConnector {
    connector: string;
    connected: boolean;
    status: string | null;
    last_sync: string | null;
}

/**
 * Git provider coverage. The Phase-1 schema does not track repositories, so the
 * backend reports the number of developers with git activity per provider, not a
 * repo count — `developer_count` is the honest unit here.
 */
export interface CoverageGitProvider {
    provider: string;
    connected: boolean;
    developer_count: number;
    last_sync: string | null;
}

/** Honest data-coverage snapshot: per-developer quality, connectors, git providers. */
export interface CoverageData {
    // Per-developer best-signal tier counts (high=API, medium=git, low=expense, none).
    data_quality: Record<DataQuality, number>;
    connectors: CoverageConnector[];
    git_providers: CoverageGitProvider[];
}

/** One team's open-waste rollup. From /api/waste/summary. */
export interface WasteTeamSummary {
    team: string;
    alert_count: number;
    total_monthly_waste: number;
    alert_types: string[];
}

// --- Manager teams list + detail (Task 2.6) -----------------------------

/** Pagination envelope returned alongside list responses (e.g. /api/teams). */
export interface Pagination {
    page: number;
    limit: number;
    total: number;
}

export interface PaginatedResponse<T> {
    data: T[];
    pagination: Pagination;
}

/** One row of the teams list. From /api/teams. */
export interface TeamListItem {
    name: string;
    department: string | null;
    manager: string | null;
    developer_count: number;
    active_count: number;
    tool_mix: string[];
    total_monthly_cost: number;
    /** active_count / developer_count, 0..1 (0 when the team has no developers). */
    utilization_rate: number;
}

/** One developer's aggregate metrics within a team. From /api/teams/:team. */
export interface DeveloperInTeam {
    id: string;
    name: string;
    email: string | null;
    tools: string[];
    activity_summary: {
        active_days_30d: number;
        total_interactions_30d: number;
    };
    subscription_cost: number;
    has_waste: boolean;
}

/** One tool's adoption + cost within a team. Part of TeamDetail. */
export interface TeamToolBreakdown {
    tool: string;
    /** Distinct developers in the team active on this tool in the last 30 days. */
    developers: number;
    /** Team's monthly spend on this tool. */
    monthly_cost: number;
}

/** Full per-team detail. From /api/teams/:team. */
export interface TeamDetail {
    name: string;
    department: string | null;
    manager: string | null;
    developer_count: number;
    /** Distinct developers active in the last 30 days (defined server-side). */
    active_count: number;
    total_monthly_cost: number;
    total_monthly_waste: number;
    developers: DeveloperInTeam[];
    tool_breakdown: TeamToolBreakdown[];
}

/** Adoption trend scoped to one team. From /api/teams/:team/trend. */
export interface TeamTrend {
    team: string;
    range: TimeRangeKind;
    from: string;
    to: string;
    points: TrendPoint[];
}

/**
 * Git provider usage for a team. The Phase-1 schema tracks no repositories, so
 * `developer_count` (developers with git activity per provider) is the honest
 * unit, not a repo count. From /api/teams/:team/providers.
 */
export interface TeamProviderUsage {
    provider: string;
    developer_count: number;
    snapshot_count: number;
}

export interface TeamProviders {
    team: string;
    providers: TeamProviderUsage[];
}

/**
 * One waste alert. From /api/waste (active, optionally team-scoped via ?team=)
 * or /api/waste/resolved (audit trail). `resolved_at` / `resolution` are only
 * populated on the resolved endpoint; the active list omits them.
 */
export interface WasteAlert {
    id: string;
    developer_id: string | null;
    developer_name: string | null;
    team: string;
    alert_type: string;
    tool: string | null;
    details: Record<string, unknown>;
    monthly_waste: number | null;
    detected_at: string;
    resolved_at?: string | null;
    resolution?: string | null;
}

/**
 * Structured reasons a manager may attach when resolving a waste alert. Mirrors
 * WASTE_RESOLUTION_REASONS on the backend (src/expenses/waste-detector.ts) — the
 * server validates the value, so this list must stay in lockstep with it.
 */
export type WasteResolutionReason =
    | 'reallocated'
    | 'upgraded'
    | 'justified'
    | 'downgrade_recommended'
    | 'monitor_longer'
    | 'dismissed';

// --- Developer "My Dashboard" (Task 2.8) --------------------------------

export type TrendDirection = 'up' | 'down' | 'flat';

/** Personal stat summary. From /api/me/overview. */
export interface MeOverview {
    range: TimeRangeKind;
    from: string;
    to: string;
    active_days: number;
    primary_tools: string[];
    acceptance_rate: {
        current: number | null;
        previous: number | null;
        trend: TrendDirection;
    };
    estimated_monthly_cost: number;
}

/** One day on the personal activity timeline. From /api/me/timeline. */
export interface DeveloperTimelinePoint {
    date: string;
    tool_activity: {
        is_active: boolean;
        interaction_count: number;
        tools: string[];
    };
    git_activity: {
        commits: number;
        lines_added: number;
        lines_removed: number;
        prs_opened: number;
        prs_merged: number;
        ai_signature_score: number | null;
    };
}

/** Personal activity timeline over a resolved window. From /api/me/timeline. */
export interface MeTimeline {
    range: TimeRangeKind;
    from: string;
    to: string;
    points: DeveloperTimelinePoint[];
}

// --- Developer "My Tools" + "My Activity" (Task 2.9) --------------------

/** One feature's usage count for a tool over the window. From /api/me/tools. */
export interface FeatureUsage {
    feature: string;
    count: number;
}

/** One day of a tool's own interaction count, for the per-tool activity trend. */
export interface ToolActivityPoint {
    date: string;
    interactions: number;
}

/** Per-tool breakdown scoped to the developer. From /api/me/tools. */
export interface MeToolBreakdown {
    tool: string;
    active_days: number;
    interactions: number;
    acceptances: number;
    acceptance_rate: number | null;
    /** Per-feature usage counts, most-used first. */
    feature_usage: FeatureUsage[];
    /** Daily interaction counts over the window, ascending. */
    activity: ToolActivityPoint[];
    estimated_monthly_cost: number;
}

/** Per-tool usage detail over a resolved window. From /api/me/tools. */
export interface MeTools {
    range: TimeRangeKind;
    from: string;
    to: string;
    tools: MeToolBreakdown[];
}

/** One git provider's contribution to the developer's activity. */
export interface MeProviderActivity {
    provider: string;
    commits: number;
    lines_added: number;
    lines_removed: number;
    files_changed: number;
    prs_opened: number;
    prs_merged: number;
}

/**
 * The developer's git activity over a window. `totals` are the authoritative
 * cross-provider sums; `providers` is the per-source breakdown (a day active on
 * more than one provider is stored merged under a 'multi' bucket). `avg_churn_rate`
 * is a 0..1 ratio and a rough trend indicator only. From /api/me/activity.
 */
export interface MeActivity {
    range: TimeRangeKind;
    from: string;
    to: string;
    totals: {
        commits: number;
        lines_added: number;
        lines_removed: number;
        files_changed: number;
        prs_opened: number;
        prs_merged: number;
        avg_churn_rate: number | null;
    };
    providers: MeProviderActivity[];
}

export type MeJourneyEventType = 'started' | 'plan_change' | 'tool_switch';

/** Current per-tool status on the adoption journey. */
export interface MeJourneyTool {
    tool: string;
    started_on: string | null;
    last_active_on: string | null;
    current_plan: string | null;
    current_monthly_cost: number | null;
    active: boolean;
}

/** A milestone on the adoption journey (first use, plan change, tool switch). */
export interface MeJourneyEvent {
    date: string;
    type: MeJourneyEventType;
    tool: string;
    from_tool: string | null;
    from_plan: string | null;
    to_plan: string | null;
    old_monthly_cost: number | null;
    new_monthly_cost: number | null;
}

/** The developer's adoption journey. From /api/me/journey. */
export interface MeJourney {
    tools: MeJourneyTool[];
    events: MeJourneyEvent[];
}

export type UserRole = 'admin' | 'developer';

/** The current session identity, as returned by GET /api/auth/me. */
export interface AuthUser {
    email: string;
    role: UserRole;
    developer_id: string | null;
    must_change_password: boolean;
}

// --- Settings & preferences (Task 2.16) ---------------------------------

/** Global settings as returned by GET /api/settings/global. */
export interface GlobalSettings {
    leaderboard_enabled: boolean;
    leaderboard_managers_can_enable: boolean;
    roi_threshold: number;
    roi_settling_days: number;
    roi_managers_can_override: boolean;
}

/** Per-team settings view: resolved values, raw overrides, and override gates. */
export interface TeamSettings {
    team: string;
    effective: GlobalSettings;
    overrides: Partial<GlobalSettings>;
    // Only team-overridable keys appear; each value is whether its governing
    // managers_can_* flag is currently on.
    overridable: Partial<Record<keyof GlobalSettings, boolean>>;
}

/**
 * Time-range presets. These mirror the backend range parser
 * (src/dashboard/api/range.ts) and the persistable preference set
 * (TIME_RANGE_OPTIONS in src/settings/registry.ts). `custom` is a selectable
 * kind but NOT a preset — it carries explicit from/to dates and is never
 * persisted as the single-string default preference.
 */
export type TimeRangePreset = '30d' | '90d' | 'year' | 'lifetime';
export type TimeRangeKind = TimeRangePreset | 'custom';

/** Per-user preferences as returned by GET /api/me/preferences. */
export interface UserPreferences {
    default_time_range: TimeRangePreset;
    dark_mode: boolean;
}

// --- Optional leaderboard (Task 2.17) -----------------------------------

/** Ranking metrics the leaderboard can sort by. From /api/leaderboard/:team. */
export type LeaderboardMetric = 'activity' | 'acceptance' | 'output';

/**
 * Whether the current principal may see a leaderboard at all. Drives whether the
 * nav entry point and route exist — when `available` is false the leaderboard
 * leaves no trace in the UI. From GET /api/leaderboard/availability.
 */
export interface LeaderboardAvailability {
    available: boolean;
}

/** One ranked developer on a team leaderboard. */
export interface LeaderboardEntry {
    rank: number;
    developer_id: string;
    name: string;
    /** Value of the selected metric: interactions, a 0..1 rate, or commits. */
    value: number;
    interactions: number;
    acceptances: number;
    acceptance_rate: number;
    commits: number;
}

/** A ranked team leaderboard over the trailing window. From /api/leaderboard/:team. */
export interface Leaderboard {
    team: string;
    metric: LeaderboardMetric;
    from: string;
    to: string;
    entries: LeaderboardEntry[];
}

// --- Admin Management (Task 2.13) ---------------------------------------

/** A user account as returned by the admin users API (never includes a hash). */
export interface AdminUser {
    id: string;
    email: string;
    role: UserRole;
    developer_id: string | null;
    developer_name: string | null;
    must_change_password: boolean;
    created_at: string;
    deactivated_at: string | null;
    active: boolean;
}

/** Result of creating a user / resetting a password — temp password shown once. */
export interface AdminUserWithTempPassword extends AdminUser {
    temp_password: string;
}

export interface AdminPasswordReset {
    id: string;
    temp_password: string;
}

/** A team as returned by the admin teams API. */
export interface AdminTeam {
    name: string;
    department: string | null;
    manager: string | null;
    created_at: string;
    archived_at: string | null;
    developer_count: number;
}

/** A developer's external-identity map, editable in the admin UI. */
export interface DeveloperExternalIds {
    github?: string;
    copilot?: string;
    claude?: string;
    windsurf?: string;
    bitbucket?: string;
    gitlab?: string;
    git_emails?: string;
    [key: string]: string | undefined;
}

/** A developer as returned by the admin developers API. */
export interface AdminDeveloper {
    id: string;
    name: string;
    email: string | null;
    team: string;
    external_ids: DeveloperExternalIds;
    created_at: string;
}

/** A subscription as returned by the admin subscriptions API. */
export interface AdminSubscription {
    id: string;
    developer_id: string;
    developer_name: string;
    developer_email: string | null;
    team: string;
    tool: string;
    plan: string | null;
    billing_model: string;
    monthly_cost: number | null;
    seat_assigned_at: string | null;
    seat_revoked_at: string | null;
    data_source: string;
}

/** Read-only data-sources status from GET /api/admin/data-sources. */
export interface AdminDataSources {
    connectors: CoverageConnector[];
    git_providers: CoverageGitProvider[];
}
