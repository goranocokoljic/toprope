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
