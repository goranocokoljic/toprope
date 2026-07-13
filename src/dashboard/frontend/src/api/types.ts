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

// --- Anomaly surfacing (Task 4.8) ---------------------------------------

export type AnomalySeverity = 'info' | 'notable' | 'high';
export type AnomalyBasis = 'git_estimate' | 'measured';
export type AnomalyStatus = 'open' | 'acknowledged' | 'resolved';
export type AnomalyMethod = 'statistical' | 'percentage_change';
export type AnomalyMetric =
    | 'commits'
    | 'prs_merged'
    | 'churn'
    | 'ai_signature'
    | 'interactions'
    | 'acceptance_rate'
    | 'cost';

/**
 * A team anomaly as surfaced to the manager panel (Task 4.8). Mirrors the
 * enriched shape from /api/anomalies (src/dashboard/api/anomalies.ts): the raw
 * row plus the honest basis label, a plain-language description, and the
 * direction/percentage the inline flags read. Team-scope only — developer-scope
 * anomalies are individual data and never reach this manager surface.
 */
export interface AnomalyAlert {
    id: string;
    scope: 'team';
    scope_id: string;
    team: string;
    metric: AnomalyMetric;
    metric_label: string;
    period: string;
    method: AnomalyMethod;
    observed_value: number;
    expected_value: number;
    deviation: number;
    change_pct: number | null;
    direction: 'increase' | 'decrease';
    severity: AnomalySeverity;
    basis: AnomalyBasis;
    basis_label: string;
    status: AnomalyStatus;
    detected_at: string;
    description: string;
}

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

// ── PR/review coaching (Task 5.3) ───────────────────────────────────────────
// Developer-private trajectory (/api/me/pr-coaching) and manager team aggregate
// (/api/coaching/pr-review/*). The two scope variants stay separate: all_pr is
// factual, ai_assisted_pr is inferred (lower confidence).

export type PRReviewPeriodUnit = 'weekly' | 'monthly';
export type PRReviewScopeVariant = 'all_pr' | 'ai_assisted_pr';
export type PRReviewBasis = 'factual' | 'inferred';
export type PRReviewCombinedSignal =
    | 'struggling'
    | 'healthy_iteration'
    | 'effective'
    | 'insufficient_data';
export type PRReviewTrendDirection = 'rising' | 'falling' | 'steady' | 'insufficient_data';

/** Movement of a metric across the window — the from→to pair for trajectory copy. */
export interface PRReviewMetricTrend {
    metric: 'rework_rate';
    direction: PRReviewTrendDirection;
    from_period: string | null;
    to_period: string | null;
    from_value: number | null;
    to_value: number | null;
}

/** One period of a developer's own trajectory. */
export interface PRReviewTrajectoryPoint {
    period: string;
    prs_total: number;
    prs_merged: number;
    rework_rate: number | null;
    review_rejection_rate: number | null;
    avg_review_rounds: number | null;
    avg_comment_density: number | null;
    comment_density_vs_baseline: number | null;
    avg_time_to_merge_hours: number | null;
    avg_churn: number | null;
    combined_signal: PRReviewCombinedSignal;
}

export interface PRReviewVariantTrajectory {
    scope_variant: PRReviewScopeVariant;
    basis: PRReviewBasis;
    points: PRReviewTrajectoryPoint[];
    rework_trend: PRReviewMetricTrend;
    latest_signal: PRReviewCombinedSignal;
    sufficient_periods: number;
}

/** Developer's private PR/review coaching. From /api/me/pr-coaching. */
export interface DeveloperPRReviewCoaching {
    period_unit: PRReviewPeriodUnit;
    all_pr: PRReviewVariantTrajectory;
    ai_assisted: PRReviewVariantTrajectory;
}

/**
 * /api/me/pr-coaching response. Pillar 2 (PR/review coaching) can be disabled
 * org-wide or per team (Task 5.10); when it is, the server returns only
 * `{enabled:false}` with no trajectory, and the page shows an off-state instead
 * of the coaching. The `enabled` discriminator lets the UI narrow safely before
 * touching the trajectory fields.
 */
export type MyPRReviewCoaching =
    | {enabled: false}
    | ({enabled: true} & DeveloperPRReviewCoaching);

/** One period of a team aggregate — suppressed (no numbers) or pooled team figures. */
export interface TeamCoachingAggregatePoint {
    period: string;
    suppressed: boolean;
    developers: number | null;
    prs_total: number | null;
    rework_rate: number | null;
    review_rejection_rate: number | null;
    avg_review_rounds: number | null;
    avg_comment_density: number | null;
    avg_time_to_merge_hours: number | null;
    avg_churn: number | null;
    combined_signal: PRReviewCombinedSignal;
}

export interface TeamCoachingVariantTrajectory {
    scope_variant: PRReviewScopeVariant;
    basis: PRReviewBasis;
    points: TeamCoachingAggregatePoint[];
    rework_trend: PRReviewMetricTrend;
    latest_signal: PRReviewCombinedSignal;
    sufficient_periods: number;
}

/** Manager team aggregate (NO individual numbers). From /api/coaching/pr-review/*. */
export interface TeamPRReviewCoaching {
    scope: string;
    period_unit: PRReviewPeriodUnit;
    all_pr: TeamCoachingVariantTrajectory;
    ai_assisted: TeamCoachingVariantTrajectory;
}

// ── Manager aggregate coaching panel (Task 5.11) ────────────────────────────
// The unified manager surface over all three pillars: PR/review trends, churn/
// effectiveness trends, anonymized loop/nudge patterns (opted-in developers
// only), and synthesized team coaching opportunities. TEAM-LEVEL ONLY — no shape
// here carries a developer id or an individual's number, and there is no
// drill-down endpoint to one developer's coaching.

/** The four available-data signal kinds, mirroring the backend signal_type. */
export type AvailableSignalType =
    | 'churn_reflection'
    | 'acceptance_trend'
    | 'journey_coaching'
    | 'personal_insight';

/** One period's available-data team aggregate — suppressed, or a count + tally. */
export interface TeamAvailablePoint {
    period: string;
    suppressed: boolean;
    developers: number | null;
    /** category → count (e.g. {elevated: 2, lower: 1}); null when suppressed. */
    categories: Record<string, number> | null;
}

export interface TeamAvailableSeries {
    signal_type: AvailableSignalType;
    points: TeamAvailablePoint[];
}

/** Manager available-data (churn/effectiveness) aggregate — trends only, no text. */
export interface TeamAvailableCoaching {
    scope: string;
    period_unit: PRReviewPeriodUnit;
    series: TeamAvailableSeries[];
}

/** The structural nudge types, mirroring the backend closed set. */
export type NudgeType = 'short_prompt' | 'missing_context' | 'missing_error' | 'repeated_prompt';

/** One floored count cell (loops, or one nudge type) — suppressed carries no numbers. */
export interface LoopNudgeCell {
    suppressed: boolean;
    developers: number | null;
    total: number | null;
}

export interface LoopNudgeTypeCell extends LoopNudgeCell {
    nudge_type: NudgeType;
}

/** Pillar 3 loop/nudge pattern aggregate — built from opted-in developers only. */
export interface LoopNudgeAggregate {
    scope: string;
    period_unit: PRReviewPeriodUnit;
    /**
     * Developers in scope who effectively opted into capture (eligibility count),
     * floored: exact only at or above the min-group-size, else `null` (too few —
     * including none — to show without risking identifying who opted in).
     */
    opted_in_developers: number | null;
    loops: LoopNudgeCell;
    nudges: LoopNudgeTypeCell[];
}

export type OpportunityPillar = 'pr_review' | 'available' | 'loop_nudge';

/** A team coaching opportunity — a suggestion framed as an opportunity, never a judgment. */
export interface TeamCoachingOpportunity {
    id: string;
    pillar: OpportunityPillar;
    title: string;
    suggestion: string;
}

/** A pillar section discriminated by `enabled` (disabled → hidden by the UI). */
export type PillarSection<T> = {enabled: false} | ({enabled: true} & T);

/** The unified manager coaching panel. From /api/coaching/manager/{org,team}. */
export interface ManagerCoachingPanel {
    scope: string;
    period_unit: PRReviewPeriodUnit;
    pr_review: PillarSection<TeamPRReviewCoaching>;
    available: PillarSection<TeamAvailableCoaching>;
    loop_nudge: PillarSection<LoopNudgeAggregate>;
    opportunities: TeamCoachingOpportunity[];
}

/** First→last detected AI activity — the span of the journey timeline. */
export interface JourneyBounds {
    first_activity: string | null;
    last_activity: string | null;
}

/** One week of the adoption-journey activity trajectory. */
export interface JourneyTrajectoryPoint {
    week_start: string;
    active_days: number;
    interactions: number;
    commits: number;
    ai_signature_score: number | null;
}

export type JourneyAnnotationType = 'first_active_week' | 'sustained_ramp' | 'plateau';

/** A key moment annotated on the trajectory. */
export interface JourneyAnnotation {
    type: JourneyAnnotationType;
    week_start: string;
    label: string;
}

/** Data-quality tier of the journey (high=tool API … none=no data). */
export type JourneyTier = DataQualityTier;

/**
 * The rich adoption journey (Task 4.11): the base per-tool/lifecycle journey plus
 * the timeline bounds, weekly trajectory, annotated key moments, and data tier.
 * Backs both /api/me/journey (own) and /api/developers/:id/journey (manager).
 */
export interface DeveloperJourney extends MeJourney {
    bounds: JourneyBounds;
    trajectory: JourneyTrajectoryPoint[];
    annotations: JourneyAnnotation[];
    tier: JourneyTier;
}

/** Minimal developer identity for the manager developer-detail header. */
export interface DeveloperIdentity {
    id: string;
    name: string;
    email: string | null;
    team: string;
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

/** Severity floor for anomaly Slack alerts (Task 4.12). */
export type AnomalyAlertMinSeverity = 'notable' | 'high';

/**
 * Global settings as returned by GET /api/settings/global. Mirrors the backend
 * registry (src/settings/registry.ts) — every key the admin can configure
 * globally, including the survey/anomaly extensions added in Phase 4.
 */
export interface GlobalSettings {
    leaderboard_enabled: boolean;
    leaderboard_managers_can_enable: boolean;
    roi_threshold: number;
    roi_settling_days: number;
    roi_managers_can_override: boolean;
    // Surveys (Task 4.3 / 4.12): auto-send per automated trigger type.
    survey_usage_drop_auto: boolean;
    survey_unused_new_seat_auto: boolean;
    survey_plan_change_auto: boolean;
    survey_anomaly_auto: boolean;
    survey_managers_can_override: boolean;
    // Anomaly alerts (Task 4.8 / 4.12).
    anomaly_alerts_enabled: boolean;
    anomaly_alert_min_severity: AnomalyAlertMinSeverity;
    anomaly_managers_can_override: boolean;
    // Coaching policy (Task 5.10): the org boundary for the Phase 5 coaching
    // features. Developers make their own choices (CoachingPreferences) within it.
    coaching_pillar1_enabled: boolean;
    coaching_pillar2_enabled: boolean;
    coaching_capture_permitted: boolean;
    coaching_cloud_analysis_permitted: boolean;
    showcase_enabled: boolean;
    showcase_scope_permitted: ShowcaseScope;
    showcase_ai_annotation_enabled: boolean;
    nudge_default_frequency: NudgeFrequency;
    nudge_dismissible_default: boolean;
    coaching_managers_can_override: boolean;
    // Phase 6 settings extensions (Task 6.4 / #173).
    best_practice_contribution_model: ContributionModel;
    bestpractices_enabled: boolean;
    curator_permission: CuratorPermission;
}

/** Closed value sets for the coaching enum settings/preferences (Task 5.10). */
export type ShowcaseScope = 'team_only' | 'org_wide';
// `ContributionModel` (the three best-practice models) is declared with the
// best-practice browse types below and reused here for best_practice_contribution_model.
/** Who may act as a lead/curator (Task 6.4 / #173). */
export type CuratorPermission = 'managers_admins' | 'any_member';
export type NudgeFrequency = 'low' | 'normal' | 'high';
export type CaptureMechanism = 'local_agent' | 'editor_extension';
export type CaptureRecoveryChoice = 'no_recovery' | 'recovery_path';

/** Per-team settings view: resolved values, raw overrides, and override gates. */
export interface TeamSettings {
    team: string;
    effective: GlobalSettings;
    overrides: Partial<GlobalSettings>;
    // Only team-overridable keys appear; each value is whether its governing
    // managers_can_* flag is currently on.
    overridable: Partial<Record<keyof GlobalSettings, boolean>>;
}

// --- Anomaly detection config (Task 4.12) -------------------------------
// Reuses AnomalyMethod / AnomalyMetric / AnomalyBasis from the 4.8 block above.

/** Effective detection config for one metric. */
export interface MetricConfig {
    method: AnomalyMethod;
    threshold: number;
    baselineWindow: number;
    percentageBaseline?: 'prior' | 'average';
}

/** Global engine knobs shared across metrics. */
export interface AnomalyEngineParams {
    minBaselinePeriods: number;
    statisticalHighZ: number;
}

/** One metric's snapshot row in the anomaly config response. */
export interface MetricConfigSnapshot {
    metric: string;
    scopes: string[];
    basis: string;
    config: MetricConfig;
}

/** GET /api/settings/anomaly — the effective global anomaly config. */
export interface AnomalyConfig {
    metrics: MetricConfigSnapshot[];
    engine: AnomalyEngineParams;
}

/** A PATCH body for the anomaly config endpoints. */
export interface AnomalyConfigPatch {
    metrics?: Record<string, Partial<MetricConfig>>;
    engine?: Partial<AnomalyEngineParams>;
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

// --- Developer coaching preferences (Task 5.10 / #131) ------------------

/**
 * One developer coaching preference, resolved against the org boundary. `value`
 * is the effective value after gating; `stored` is the developer's own choice;
 * `blocked` (+ `reason`) is set when an org policy currently forbids the choice,
 * which the UI uses to disable the control and explain why.
 */
export interface ResolvedCoachingPreference {
    key: string;
    value: boolean | string;
    stored: boolean | string;
    blocked: boolean;
    reason?: string;
}

/** GET/PATCH /api/me/coaching-preferences — keyed by preference name. */
export type CoachingPreferences = Record<string, ResolvedCoachingPreference>;

/** A PATCH body for the coaching-preferences endpoint. */
export type CoachingPreferencesPatch = Record<string, boolean | string>;

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
    cursor?: string;
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

// --- Admin: git providers (GC1 / #197–#200) ------------------------------

/** The three git provider types the dynamic form supports. */
export type GitProviderType = 'github' | 'bitbucket' | 'gitlab';

/** Where a provider row comes from: the DB (editable) or a config file (read-only). */
export type GitProviderSource = 'db' | 'config';

/**
 * The masked provider DTO the admin API returns
 * (`GET /api/admin/git/providers`). Mirrors the server's `AdminGitProviderDto`
 * exactly (superset of the store's public projection + a `source`
 * discriminator). Tokens are write-only end to end: this shape NEVER carries the
 * secret — only `token_last4` + `token_masked` for display. `created_at`/
 * `updated_at` are null for config-file providers (no lifecycle timestamps).
 */
export interface AdminGitProvider {
    id: string;
    source: GitProviderSource;
    type: GitProviderType;
    container: string;
    url: string | null;
    include_subgroups: boolean | null;
    auth_method: string;
    auth_username: string | null;
    token_last4: string | null;
    token_masked: string;
    repos_include: string | null;
    repos_exclude: string | null;
    enabled: boolean;
    created_at: string | null;
    updated_at: string | null;
    created_by: string | null;
    last_sync_at: string | null;
    last_sync_status: string | null;
    last_sync_error: string | null;
    /** Non-null only while a sync-now run is in flight for this provider (#209). */
    active_sync: GitProviderActiveSync | null;
}

/** The stages a sync run passes through, in pipeline order (#209). */
export type GitSyncStage = 'listing_repos' | 'fetching' | 'analyzing' | 'writing';

/**
 * The pipeline's latest progress snapshot for an in-flight sync — mirrors the
 * server's `GitSyncProgress` exactly. Counters are cumulative over the run.
 */
export interface GitSyncProgress {
    stage: GitSyncStage;
    /** Repos selected for the run; null until listing has completed. */
    repos_total: number | null;
    repos_processed: number;
    current_repo: string | null;
    commits_fetched: number;
    prs_fetched: number;
    developers_matched: number;
}

/**
 * Live state of an in-flight sync-now run, from the provider list's
 * `active_sync` (#209). `progress` is null until the first pipeline emission.
 */
export interface GitProviderActiveSync {
    started_at: string;
    progress: GitSyncProgress | null;
}

/**
 * One repository as returned by `GET /api/admin/git/providers/:id/repos` — the
 * repo-scope picker's source (GC1.9 / #201, reshaped in #213). Mirrors the
 * server projection exactly: `slug` is the CANONICAL identifier the stored
 * scope filters match against (GitHub repo name, Bitbucket slug, GitLab path)
 * and is what a scope save must send back; `name` is the provider's
 * human-readable display name, display-only. `archived` repos are shown in
 * the picker but excluded from the default selection.
 */
export interface GitProviderRepo {
    slug: string;
    name: string;
    archived: boolean;
    defaultBranch: string | null;
}

/**
 * The connection-probe envelope both test-connection endpoints return. A failed
 * probe is a successful request that resolves to `{ok:false}` with a typed error
 * + a remediation hint — never a thrown HTTP error.
 */
export interface GitProviderProbeResult {
    ok: boolean;
    error?: string;
    hint?: string;
}

/** The write body for create/update — mirrors the server's fail-closed parser. */
export interface GitProviderInput {
    type: GitProviderType;
    container: string;
    auth_method?: string;
    /** Write-only. Omit on update to keep the stored secret; required on create. */
    token?: string;
    /** Bitbucket app_password only. */
    username?: string;
    /** GitLab self-hosted base URL. */
    url?: string;
    /** GitLab only. */
    include_subgroups?: boolean;
    repos?: string[];
    exclude_repos?: string[];
    enabled?: boolean;
}

/** The status handle a sync-now trigger returns (fire-and-forget). */
export interface GitProviderSyncHandle {
    provider_id: string;
    status: 'running';
    started_at: string;
}

// --- Admin: expense reconciliation (Task 4.4 / #99) ----------------------

export type ReconciliationResultType =
    | 'expense_no_subscription'
    | 'subscription_no_expense'
    | 'cost_discrepancy';

export type ReconciliationStatus = 'open' | 'resolved' | 'ignored';

/** One reconciliation result joined with its developer, from GET /api/admin/reconciliation. */
export interface ReconciliationResult {
    id: string;
    run_at: string;
    period: string;
    result_type: ReconciliationResultType;
    developer_id: string | null;
    developer_name: string | null;
    developer_email: string | null;
    team: string | null;
    tool: string | null;
    expense_amount: number | null;
    registry_amount: number | null;
    details: string | null;
    status: ReconciliationStatus;
    resolution: string | null;
    resolved_at: string | null;
}

/** Summary returned by POST /api/admin/reconciliation/run. */
export interface ReconciliationRunSummary {
    period: string;
    run_at: string;
    tolerance: number;
    created: number;
    skipped: number;
    byType: Record<ReconciliationResultType, number>;
}

// --- Phase 3: maturity trend + AI summaries (Task 3.12) ------------------

/**
 * What the maturity score was computed from. At launch everything is a
 * `git_estimate` (inferred from git activity); the label upgrades to `mixed`
 * and then `measured` as tool connectors come online. Mirrors the backend
 * MaturityBasis (src/aggregation/team-period.ts).
 */
export type MaturityBasis = 'git_estimate' | 'mixed' | 'measured';

/** One quarter on the maturity-trend axis. From /api/maturity/:scope/trend. */
export interface MaturityTrendPoint {
    /** Quarter key, e.g. "2026-Q2". */
    period: string;
    /** Quarter span (inclusive YYYY-MM-DD), for tooltips/overlap reasoning. */
    start: string;
    end: string;
    /** 0–100 score, or null when the period has no computed score. */
    score: number | null;
    basis: MaturityBasis | null;
    /** Change vs the previous scored quarter, or null with no prior. */
    score_delta: number | null;
}

/**
 * Maturity score over a resolved window, one point per quarter. `team` echoes
 * the requested scope — a real team name or the literal `org` (the
 * developer-count-weighted org roll-up). From /api/maturity/:scope/trend.
 */
export interface MaturityTrend {
    team: string;
    range: TimeRangeKind;
    from: string;
    to: string;
    points: MaturityTrendPoint[];
}

// --- Team comparison — rich side-by-side (Task 4.9 / #104) ----------------

/**
 * A team's data-quality tier, mirroring the backend DataQualityTier
 * (src/dashboard/api/compare.ts). `high` = every contributing developer has
 * API-grade data (fully connected); `medium` = git-only is the weakest signal;
 * `low` = expense-only is the weakest; `none` = no data-bearing developers.
 */
export type DataQualityTier = 'high' | 'medium' | 'low' | 'none';

/** Per-developer tier counts behind a team's overall tier. */
export interface TierBreakdown {
    high: number;
    medium: number;
    low: number;
    none: number;
}

/** The compared metrics for one team over the window. From /api/compare. */
export interface CompareTeamMetrics {
    developer_count: number;
    active_developer_count: number;
    /** active / total, or null when the team had no members in the window. */
    utilization_rate: number | null;
    total_subscription_cost: number;
    cost_per_pr: number | null;
    avg_code_churn: number | null;
    total_prs_merged: number;
    /** Latest maturity score overlapping the window; null when none computed. */
    ai_maturity_score: number | null;
    /** Basis for that score — 'git_estimate' at launch (honesty label). */
    ai_maturity_basis: MaturityBasis | null;
    /** Distinct tools the team was active on during the window. */
    tool_mix: string[];
}

/** One day on a team's overlaid adoption-trend line. From /api/compare. */
export interface CompareTrendPoint {
    date: string;
    active_developers: number;
}

/** One compared team: identity, tier, metrics, and its trend line. */
export interface CompareTeam {
    name: string;
    department: string | null;
    manager: string | null;
    tier: DataQualityTier;
    tier_breakdown: TierBreakdown;
    metrics: CompareTeamMetrics;
    trend: CompareTrendPoint[];
}

/** A 2–4 team side-by-side comparison over a resolved window. From /api/compare. */
export interface TeamComparison {
    range: TimeRangeKind;
    from: string;
    to: string;
    teams: CompareTeam[];
}

// --- Team comparison — sortable all-teams table (Task 4.10 / #105) ---------

/**
 * One team's pre-computed metrics for the selected period, read from the
 * quarterly_aggregates rollup. From /api/teams/compare-table. Every numeric
 * column is nullable: a period can legitimately have no members (utilization),
 * no PRs (cost-per-PR), or no computed maturity score yet.
 */
export interface CompareTableMetrics {
    developer_count: number;
    active_developer_count: number;
    /** active / total, or null when the team had no members in the period. */
    utilization_rate: number | null;
    total_subscription_cost: number | null;
    cost_per_pr: number | null;
    avg_code_churn: number | null;
    total_prs_merged: number | null;
    /** Latest period maturity score; null when none computed. */
    ai_maturity_score: number | null;
    /**
     * Basis for that score — 'git_estimate' at launch (honesty label). Typed
     * `string` (not the closed MaturityBasis union) because the backend column
     * is unconstrained TEXT: the maturity formatters narrow it, with a safe
     * default for any unrecognized value, rather than asserting the union here.
     */
    ai_maturity_basis: string | null;
    /** Estimated monthly spend wasted on unused/underused seats this period. */
    wasted_spend: number | null;
    /** Count of seats flagged unused this period. */
    unused_seat_count: number | null;
}

/**
 * One row of the all-teams table: identity, the team's current (all-time)
 * data-quality tier, and the selected period's metrics (null when the team has
 * no aggregate row for that period). From /api/teams/compare-table.
 */
export interface CompareTableTeam {
    name: string;
    department: string | null;
    manager: string | null;
    tier: DataQualityTier;
    tier_breakdown: TierBreakdown;
    metrics: CompareTableMetrics | null;
}

/**
 * The sortable all-teams ranking table for one period. `period` is the resolved
 * quarter (null only when no period has been rolled up yet); `available_periods`
 * lists the rolled-up quarters, most recent first, to drive the period selector.
 * From /api/teams/compare-table.
 */
export interface CompareTable {
    period: string | null;
    available_periods: string[];
    teams: CompareTableTeam[];
}

/** The four summary cadences. Mirrors the backend SummaryLevel. */
export type SummaryLevel = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

/** Summary scope token: org-wide or a specific team. */
export type SummaryScopeKind = 'org' | 'team';

/**
 * A summary list row: metadata + staleness + the basis/tier it was generated
 * under (recorded at generation time; null only for legacy rows). The heavy
 * narrative text is omitted here — fetch the detail for it. `is_stale` is the
 * raw SQLite integer flag (0/1). From GET /api/summaries.
 */
export interface SummaryListItem {
    id: string;
    scope: SummaryScopeKind;
    scope_name: string;
    period_type: SummaryLevel;
    period_value: string;
    model_used: string;
    generated_at: string;
    regenerated_count: number;
    is_stale: 0 | 1;
    basis: MaturityBasis | null;
    /** data_quality tier the narrative was written under ('high'|'medium'|'low'|null). */
    tier: string | null;
    /** Human-readable data basis sentence, or null when the basis is unknown. */
    data_basis: string | null;
}

/** A full summary: the list row plus the narrative text + input hash. */
export interface SummaryDetail extends SummaryListItem {
    summary_text: string;
    input_hash: string | null;
}

// --- Contextual best-practice display (Task 6.2.7 / #162) ------------------

/**
 * One best practice surfaced next to a metric. The viewer-safe projection the
 * `/api/me/practices/related` endpoint returns — no author or raw feedback rows,
 * just what the unobtrusive affordance needs to render and link.
 */
export interface RelatedPractice {
    id: string;
    title: string;
    scope: string;
    /** True when a lead pinned this practice to the metric (6.2.6). */
    pinned: boolean;
    /** Lead-endorsement flag (hybrid model). */
    endorsed: boolean;
    /** Raw helpful-ratio in [0,1] for a "found helpful" hint, or null when no feedback yet. */
    helpfulRatio: number | null;
}

/**
 * The practices to surface next to one metric, with the encouraging intro copy.
 * From GET /api/me/practices/related?metric=<m>.
 */
export interface RelatedPractices {
    metric: string;
    /** Encouraging, reviewed framing ("here are a few practices that may help with…"). */
    intro: string;
    practices: RelatedPractice[];
}

// --- Best-practice browse UI (Task 6.2.8) ----------------------------------

/** A team's active best-practice contribution model (6.2.2). */
export type ContributionModel = 'top_down' | 'bottom_up' | 'hybrid';

/** A developer's feedback signal on a practice (6.2.4). */
export type PracticeFeedbackSignal = 'helpful' | 'not_helpful';

/** A practice's aggregate feedback, summarised for display. */
export interface PracticeFeedbackSummary {
    helpful: number;
    notHelpful: number;
    /** Raw helpful-ratio in [0,1], or null when there is no feedback yet. */
    helpfulRatio: number | null;
}

/** One row in the browse list. From GET /api/me/practices/browse. */
export interface BrowsePracticeSummary {
    id: string;
    title: string;
    scope: string;
    scopeTarget: string | null;
    authorId: string;
    authorName: string | null;
    currentVersion: number;
    createdAt: string;
    updatedAt: string;
    /** Metric tags (auto-surfacing metrics) attached to the practice, sorted. */
    metrics: string[];
    /** Lead-endorsement flag (hybrid model). */
    endorsed: boolean;
    feedback: PracticeFeedbackSummary;
}

/** The browse list plus the viewer-team's active model. From GET /api/me/practices/browse. */
export interface PracticeBrowseList {
    model: ContributionModel;
    /** Whether the viewer may author a draft practice (any authenticated developer). */
    canContribute: boolean;
    practices: BrowsePracticeSummary[];
}

/** A showcase cross-linked to a practice ("see it in action"). Populated by 6.3.8. */
export interface ShowcaseCrossLink {
    id: string;
    title: string;
}

/** Full detail of one practice. From GET /api/me/practices/browse/:id. */
export interface BrowsePracticeDetail {
    id: string;
    title: string;
    scope: string;
    scopeTarget: string | null;
    state: string;
    authorId: string;
    authorName: string | null;
    currentVersion: number;
    createdAt: string;
    updatedAt: string;
    /** Sanitized HTML of the current version, safe to inject. */
    html: string;
    metrics: string[];
    feedback: PracticeFeedbackSummary & {viewerSignal: PracticeFeedbackSignal | null};
    endorsed: boolean;
    /** The viewer-team's active contribution model — drives the model-aware copy. */
    model: ContributionModel;
    /** True only when the viewer authored this practice — gates the edit affordance. */
    canEdit: boolean;
    /** Showcases that demonstrate this practice (6.3.8). Empty until that task is built. */
    showcases: ShowcaseCrossLink[];
}

/** One version in a practice's history. From GET /api/me/practices/browse/:id/history. */
export interface PracticeHistoryEntry {
    version: number;
    authorId: string;
    authorName: string | null;
    changeNote: string | null;
    createdAt: string;
}

/** The result of toggling feedback. From POST /api/me/practices/browse/:id/feedback. */
export interface PracticeFeedbackResult {
    /** The viewer's resulting current signal, or null when the toggle cleared it. */
    signal: PracticeFeedbackSignal | null;
    /** True when this press removed an existing signal. */
    removed: boolean;
    feedback: PracticeFeedbackSummary;
}

/** A rendered markdown preview: sanitized HTML + the metric tags it implies (6.2.3). */
export interface PracticePreview {
    html: string;
    metrics: string[];
}

/** The author-facing view of one of the viewer's OWN practices (6.2.3 editor). */
export interface OwnedPracticeView {
    contributionId: string;
    title: string;
    state: string;
    currentVersion: number;
    markdown: string;
    html: string;
    metrics: string[];
}

/** The new contribution returned when a draft practice is created (6.2.3). */
export interface CreatedPractice {
    contribution: {id: string; title: string; scope: string; scopeTarget: string | null; state: string};
    metrics: string[];
}

// --- Showcase browse/governance (Task 6.3.9 / #172) ------------------------

/** Which path published a showcase: developer self-publish or joint manager+dev curation. */
export type ShowcasePublishPath = 'self_publish' | 'joint_curation';

/** One card in the showcase gallery. From GET /api/me/showcase-units/browse. */
export interface BrowseShowcaseSummary {
    id: string;
    title: string;
    scope: string;
    scopeTarget: string | null;
    authorId: string;
    authorName: string | null;
    /** Which path published it — a provenance marker; null on a divergent row. */
    publishPath: ShowcasePublishPath | null;
    /** Whether the unit carries an outcome link (PR/commit/goal). */
    hasOutcomeLink: boolean;
    /** How many inline developer annotations the unit carries (the teaching layer's heft). */
    annotationCount: number;
    createdAt: string;
    updatedAt: string;
}

/** The gallery list. From GET /api/me/showcase-units/browse. */
export interface ShowcaseGalleryList {
    showcases: BrowseShowcaseSummary[];
}

/** One inline developer annotation anchored to a conversation turn (6.3.3). */
export interface ShowcaseAnnotation {
    id: string;
    contributionId: string;
    turnRef: string;
    authorId: string;
    body: string;
    createdAt: string;
}

/** A conversation turn with the annotations anchored to it, for inline display. */
export interface ShowcaseAnnotatedTurn {
    turnRef: string;
    /** The raw turn payload as the conversation carried it (opaque). */
    turn: unknown;
    annotations: ShowcaseAnnotation[];
}

/** The inline display of a showcase: each turn beside the annotations that explain it. */
export interface ShowcaseInlineDisplay {
    turns: ShowcaseAnnotatedTurn[];
    /** Annotations whose anchor no longer matches a turn (normally empty). */
    orphaned: ShowcaseAnnotation[];
}

/** The optional, clearly-AI, SECONDARY prompt-technique annotation (6.3.7). */
export interface RenderedAiAnnotation {
    present: boolean;
    source: 'ai_generated';
    prominence: 'secondary';
    label: string;
    text: string | null;
}

/** Full detail of one showcase unit. From GET /api/me/showcase-units/:id. */
export interface BrowseShowcaseDetail {
    id: string;
    title: string;
    scope: string;
    scopeTarget: string | null;
    state: string;
    authorId: string;
    authorName: string | null;
    publishPath: ShowcasePublishPath | null;
    createdAt: string;
    updatedAt: string;
    /** The MANDATORY curators' note ("what to take away"), shown prominently. */
    curatorsNote: string;
    outcomeLink: string | null;
    hasOutcomeLink: boolean;
    /** The annotated conversation body (turns + inline annotations). */
    display: ShowcaseInlineDisplay;
    /** The clearly-AI, secondary prompt-technique annotation slot. */
    aiAnnotation: RenderedAiAnnotation;
    /** Best practices this showcase demonstrates (6.3.8). Empty when none. */
    practices: ShowcaseCrossLink[];
    /** True only when the viewer authored this showcase — gates the unpublish affordance. */
    canUnpublish: boolean;
}

/** One removal notice in the author's feed. From GET /api/me/showcase-units/removals. */
export interface ShowcaseRemovalNotice {
    showcaseId: string;
    title: string;
    /** The acting lead's user id. */
    removedBy: string;
    reason: string | null;
    occurredAt: string;
}
