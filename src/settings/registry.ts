/**
 * Central registry of every configurable setting (Task 2.16 / #51).
 *
 * The settings system is global-default + optional per-team override. This
 * registry is the single source of truth for which keys exist, their value
 * type, their hardcoded fallback default, and — for team-overridable keys —
 * which global "managers_can_*" flag governs whether a team override is even
 * permitted. The store and the API routes both read this so the permission
 * model and type coercion stay consistent in one place.
 */

export type SettingType = 'boolean' | 'number' | 'enum';

export type SettingValue = boolean | number | string;

export interface SettingDef {
    key: string;
    type: SettingType;
    /** Hardcoded fallback used when no global row has been persisted yet. */
    default: SettingValue;
    /** Whether a per-team override of this key is conceptually allowed. */
    teamOverridable: boolean;
    /**
     * For team-overridable keys: the global boolean flag that must be `true`
     * for a team override to be accepted and honored. The site admin controls
     * these flags, which is how the admin gates whether managers may override.
     */
    overrideGovernedBy?: string;
    /** Inclusive lower bound for numeric settings. */
    min?: number;
    /** Inclusive upper bound for numeric settings. */
    max?: number;
    /** Require a whole number (e.g. a day count) for numeric settings. */
    integer?: boolean;
    /** Closed set of allowed values for `enum` settings (string-valued). */
    allowed?: readonly string[];
}

// Closed value sets shared between the org-level coaching settings and the
// developer-level preferences they gate, so the two sides validate identically.
export const SHOWCASE_SCOPE_OPTIONS = ['team_only', 'org_wide'] as const;
export const NUDGE_FREQUENCY_OPTIONS = ['low', 'normal', 'high'] as const;
export const CAPTURE_MECHANISM_OPTIONS = ['local_agent', 'editor_extension'] as const;
export const CAPTURE_RECOVERY_OPTIONS = ['no_recovery', 'recovery_path'] as const;

export const GLOBAL_SETTINGS: Record<string, SettingDef> = {
    leaderboard_enabled: {
        key: 'leaderboard_enabled',
        type: 'boolean',
        default: false,
        teamOverridable: true,
        overrideGovernedBy: 'leaderboard_managers_can_enable',
    },
    leaderboard_managers_can_enable: {
        key: 'leaderboard_managers_can_enable',
        type: 'boolean',
        default: false,
        teamOverridable: false,
    },
    roi_threshold: {
        key: 'roi_threshold',
        type: 'number',
        default: 3.0,
        teamOverridable: true,
        overrideGovernedBy: 'roi_managers_can_override',
        min: 0,
        max: 1000,
    },
    roi_settling_days: {
        key: 'roi_settling_days',
        type: 'number',
        default: 30,
        teamOverridable: true,
        overrideGovernedBy: 'roi_managers_can_override',
        min: 0,
        max: 365,
        integer: true,
    },
    roi_managers_can_override: {
        key: 'roi_managers_can_override',
        type: 'boolean',
        default: false,
        teamOverridable: false,
    },
    // Data-prompted surveys (Task 4.3 / #98): one auto-send flag per automated
    // trigger type. `true` → a triggered survey is sent automatically; `false`
    // (the default) → it's queued for a manager to review and send. Each is
    // global-default + per-team override, gated by survey_managers_can_override.
    survey_usage_drop_auto: {
        key: 'survey_usage_drop_auto',
        type: 'boolean',
        default: false,
        teamOverridable: true,
        overrideGovernedBy: 'survey_managers_can_override',
    },
    survey_unused_new_seat_auto: {
        key: 'survey_unused_new_seat_auto',
        type: 'boolean',
        default: false,
        teamOverridable: true,
        overrideGovernedBy: 'survey_managers_can_override',
    },
    survey_plan_change_auto: {
        key: 'survey_plan_change_auto',
        type: 'boolean',
        default: false,
        teamOverridable: true,
        overrideGovernedBy: 'survey_managers_can_override',
    },
    survey_anomaly_auto: {
        key: 'survey_anomaly_auto',
        type: 'boolean',
        default: false,
        teamOverridable: true,
        overrideGovernedBy: 'survey_managers_can_override',
    },
    survey_managers_can_override: {
        key: 'survey_managers_can_override',
        type: 'boolean',
        default: false,
        teamOverridable: false,
    },
    // Anomaly surfacing (Task 4.8 / #103): whether notable/high anomalies push a
    // Slack alert to the manager for a team. Global-default + per-team override,
    // gated by anomaly_managers_can_override. Off by default — alerting is opt-in
    // (and additionally requires a configured Slack bot + alert channel; the
    // setting only governs whether a deliverable alert is sent).
    anomaly_alerts_enabled: {
        key: 'anomaly_alerts_enabled',
        type: 'boolean',
        default: false,
        teamOverridable: true,
        overrideGovernedBy: 'anomaly_managers_can_override',
    },
    // Minimum severity that triggers a Slack anomaly alert (Task 4.12 / #107).
    // `notable` (the default) alerts on both notable and high anomalies; `high`
    // suppresses notable ones so only the most severe page a manager. Resolved
    // per team alongside anomaly_alerts_enabled and gated by the same
    // anomaly_managers_can_override flag.
    anomaly_alert_min_severity: {
        key: 'anomaly_alert_min_severity',
        type: 'enum',
        default: 'notable',
        allowed: ['notable', 'high'],
        teamOverridable: true,
        overrideGovernedBy: 'anomaly_managers_can_override',
    },
    anomaly_managers_can_override: {
        key: 'anomaly_managers_can_override',
        type: 'boolean',
        default: false,
        teamOverridable: false,
    },
    // --- Phase 5 coaching policy (Task 5.10 / #131) -----------------------
    //
    // The ORG/ADMIN-level boundary for the coaching features. These set the
    // outer limit of what is permitted; the developer makes their own choices
    // (DEVELOPER_PREFERENCES, below) within it. All are global-default + per-team
    // override, gated by the single coaching_managers_can_override flag — the
    // same pattern as the survey/anomaly blocks above. Privacy-sensitive
    // permissions (prompt capture, cloud analysis) default OFF; the always-safe
    // available-data and PR/review pillars default ON so a git-only developer has
    // useful coaching out of the box.
    coaching_pillar1_enabled: {
        key: 'coaching_pillar1_enabled',
        type: 'boolean',
        default: true,
        teamOverridable: true,
        overrideGovernedBy: 'coaching_managers_can_override',
    },
    coaching_pillar2_enabled: {
        key: 'coaching_pillar2_enabled',
        type: 'boolean',
        default: true,
        teamOverridable: true,
        overrideGovernedBy: 'coaching_managers_can_override',
    },
    // Whether Pillar 3 prompt capture is permitted at all. OFF by default — a
    // developer's capture opt-in is moot until an admin permits it.
    coaching_capture_permitted: {
        key: 'coaching_capture_permitted',
        type: 'boolean',
        default: false,
        teamOverridable: true,
        overrideGovernedBy: 'coaching_managers_can_override',
    },
    // Whether retrospective analysis may use cloud models. OFF by default — some
    // orgs forbid prompts leaving their infrastructure outright.
    coaching_cloud_analysis_permitted: {
        key: 'coaching_cloud_analysis_permitted',
        type: 'boolean',
        default: false,
        teamOverridable: true,
        overrideGovernedBy: 'coaching_managers_can_override',
    },
    showcase_enabled: {
        key: 'showcase_enabled',
        type: 'boolean',
        default: false,
        teamOverridable: true,
        overrideGovernedBy: 'coaching_managers_can_override',
    },
    // The widest sharing scope an org permits for showcased conversations.
    // `team_only` (default) keeps published examples within the author's team;
    // `org_wide` additionally allows org-wide publishing.
    showcase_scope_permitted: {
        key: 'showcase_scope_permitted',
        type: 'enum',
        default: 'team_only',
        allowed: SHOWCASE_SCOPE_OPTIONS,
        teamOverridable: true,
        overrideGovernedBy: 'coaching_managers_can_override',
    },
    // Org default for how often real-time nudges fire; a developer may pick their
    // own nudge_frequency within this (it is the fallback when they haven't).
    nudge_default_frequency: {
        key: 'nudge_default_frequency',
        type: 'enum',
        default: 'normal',
        allowed: NUDGE_FREQUENCY_OPTIONS,
        teamOverridable: true,
        overrideGovernedBy: 'coaching_managers_can_override',
    },
    nudge_dismissible_default: {
        key: 'nudge_dismissible_default',
        type: 'boolean',
        default: true,
        teamOverridable: true,
        overrideGovernedBy: 'coaching_managers_can_override',
    },
    coaching_managers_can_override: {
        key: 'coaching_managers_can_override',
        type: 'boolean',
        default: false,
        teamOverridable: false,
    },
};

export interface PreferenceDef {
    key: string;
    type: 'boolean' | 'string';
    default: boolean | string;
    /** Closed set of allowed values for string preferences. */
    allowed?: readonly string[];
}

// The persisted "default time range" presets. These mirror the preset kinds the
// manager/developer range parser accepts (src/dashboard/api/range.ts) MINUS
// `custom`, which needs explicit from/to dates and so cannot be a single-string
// default. `7d` was intentionally dropped: the range parser never supported it,
// so storing it produced a default the API could not resolve.
export const TIME_RANGE_OPTIONS = ['30d', '90d', 'year', 'lifetime'] as const;

export const USER_PREFERENCES: Record<string, PreferenceDef> = {
    default_time_range: {
        key: 'default_time_range',
        type: 'string',
        default: '30d',
        allowed: TIME_RANGE_OPTIONS,
    },
    dark_mode: {
        key: 'dark_mode',
        type: 'boolean',
        default: false,
    },
};

/**
 * A DEVELOPER-level coaching preference (Task 5.10 / #131). These are the
 * developer's OWN privacy/coaching choices, stored per developer and honored
 * only within the org's permission boundary (the GLOBAL_SETTINGS above). The
 * gating metadata here is what makes "an org policy can veto a developer choice"
 * declarative: the store reads `gatedBy`/`blockedValue` and never lets a stored
 * choice escape the org boundary.
 */
// Extends PreferenceDef (same key/type/default/allowed shape, so the shared
// coerce/decode helpers accept it) with the org-gating metadata that is the only
// thing genuinely new about developer coaching preferences.
export interface DeveloperPreferenceDef extends PreferenceDef {
    /**
     * Org boolean setting (a *_permitted flag) that must resolve to `true` for
     * this developer choice to take effect. When it resolves `false`, the choice
     * is "blocked": resolution reports `blocked: true` and forces the effective
     * value to `blockedValue` (when set) so the org boundary always wins.
     */
    gatedBy?: string;
    /**
     * The effective value when the org blocks this choice. For the consequential
     * opt-ins (capture, cloud analysis) this is `false`, guaranteeing a blocked
     * opt-in is never honored regardless of what the developer stored.
     */
    blockedValue?: boolean | string;
    /**
     * When the developer has stored no value, take the default from this org enum
     * setting (resolved for their team) instead of `default`. Lets the org's
     * nudge_default_frequency seed the developer's nudge_frequency.
     */
    defaultFromOrg?: string;
    /** Human-readable reason surfaced in the UI when the choice is blocked. */
    blockedReason?: string;
}

export const DEVELOPER_PREFERENCES: Record<string, DeveloperPreferenceDef> = {
    // Opt-in #1: does the developer want their prompts captured at all. Forced to
    // false (never captured) when the org has not permitted capture.
    capture_opt_in: {
        key: 'capture_opt_in',
        type: 'boolean',
        default: false,
        gatedBy: 'coaching_capture_permitted',
        blockedValue: false,
        blockedReason: 'Prompt capture is not permitted by your organization.',
    },
    capture_mechanism: {
        key: 'capture_mechanism',
        type: 'string',
        default: 'local_agent',
        allowed: CAPTURE_MECHANISM_OPTIONS,
        gatedBy: 'coaching_capture_permitted',
        blockedReason: 'Prompt capture is not permitted by your organization.',
    },
    capture_recovery_choice: {
        key: 'capture_recovery_choice',
        type: 'string',
        default: 'no_recovery',
        allowed: CAPTURE_RECOVERY_OPTIONS,
        gatedBy: 'coaching_capture_permitted',
        blockedReason: 'Prompt capture is not permitted by your organization.',
    },
    // Opt-in #2: may a retrospective use cloud models. Forced to false when the
    // org forbids cloud analysis — the developer's opt-in is then simply ignored.
    cloud_analysis_opt_in: {
        key: 'cloud_analysis_opt_in',
        type: 'boolean',
        default: false,
        gatedBy: 'coaching_cloud_analysis_permitted',
        blockedValue: false,
        blockedReason: 'Cloud-model analysis is not permitted by your organization.',
    },
    nudges_enabled: {
        key: 'nudges_enabled',
        type: 'boolean',
        default: true,
    },
    nudge_frequency: {
        key: 'nudge_frequency',
        type: 'string',
        default: 'normal',
        allowed: NUDGE_FREQUENCY_OPTIONS,
        defaultFromOrg: 'nudge_default_frequency',
    },
};

export function getSettingDef(key: string): SettingDef | undefined {
    return GLOBAL_SETTINGS[key];
}

export function getDeveloperPreferenceDef(key: string): DeveloperPreferenceDef | undefined {
    return DEVELOPER_PREFERENCES[key];
}

export function getPreferenceDef(key: string): PreferenceDef | undefined {
    return USER_PREFERENCES[key];
}

// Discriminated union: when `ok` is true `value` is always present, so callers
// narrow with a single `if (!result.ok)` rather than re-checking `value`. One
// generic shape serves both the settings and preferences coercers below.
export type Coerced<T> = {ok: true; value: T} | {ok: false; error: string};

export type CoercionResult = Coerced<SettingValue>;
export type PreferenceCoercionResult = Coerced<boolean | string>;

/**
 * Validate and coerce a raw (untrusted) value against a setting's declared
 * type and bounds. Returns the normalized value or a human-readable error.
 */
export function coerceSettingValue(def: SettingDef, raw: unknown): CoercionResult {
    if (def.type === 'boolean') {
        if (typeof raw !== 'boolean') {
            return {ok: false, error: `${def.key} must be a boolean`};
        }
        return {ok: true, value: raw};
    }
    if (def.type === 'enum') {
        if (typeof raw !== 'string') {
            return {ok: false, error: `${def.key} must be a string`};
        }
        if (def.allowed && !def.allowed.includes(raw)) {
            return {ok: false, error: `${def.key} must be one of: ${def.allowed.join(', ')}`};
        }
        return {ok: true, value: raw};
    }
    // number
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return {ok: false, error: `${def.key} must be a finite number`};
    }
    if (def.integer && !Number.isInteger(raw)) {
        return {ok: false, error: `${def.key} must be a whole number`};
    }
    if (def.min !== undefined && raw < def.min) {
        return {ok: false, error: `${def.key} must be >= ${def.min}`};
    }
    if (def.max !== undefined && raw > def.max) {
        return {ok: false, error: `${def.key} must be <= ${def.max}`};
    }
    return {ok: true, value: raw};
}

export function coercePreferenceValue(def: PreferenceDef, raw: unknown): PreferenceCoercionResult {
    if (def.type === 'boolean') {
        if (typeof raw !== 'boolean') {
            return {ok: false, error: `${def.key} must be a boolean`};
        }
        return {ok: true, value: raw};
    }
    // string
    if (typeof raw !== 'string') {
        return {ok: false, error: `${def.key} must be a string`};
    }
    if (def.allowed && !def.allowed.includes(raw)) {
        return {ok: false, error: `${def.key} must be one of: ${def.allowed.join(', ')}`};
    }
    return {ok: true, value: raw};
}

// Developer coaching preferences reuse `coercePreferenceValue` (a
// DeveloperPreferenceDef is a PreferenceDef plus gating metadata, so the
// boolean/string coercion is identical). Coercion is type-only: org permission
// is enforced later, at resolution — a developer may record an opt-in the org
// currently forbids without error; it simply stays ignored until the org permits.
