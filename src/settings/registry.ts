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

export type SettingType = 'boolean' | 'number';

export type SettingValue = boolean | number;

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
}

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
    },
    roi_managers_can_override: {
        key: 'roi_managers_can_override',
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

export const TIME_RANGE_OPTIONS = ['7d', '30d', '90d'] as const;

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

export function getSettingDef(key: string): SettingDef | undefined {
    return GLOBAL_SETTINGS[key];
}

export function getPreferenceDef(key: string): PreferenceDef | undefined {
    return USER_PREFERENCES[key];
}

export interface CoercionResult {
    ok: boolean;
    value?: SettingValue;
    error?: string;
}

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
    // number
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return {ok: false, error: `${def.key} must be a finite number`};
    }
    if (def.min !== undefined && raw < def.min) {
        return {ok: false, error: `${def.key} must be >= ${def.min}`};
    }
    if (def.max !== undefined && raw > def.max) {
        return {ok: false, error: `${def.key} must be <= ${def.max}`};
    }
    return {ok: true, value: raw};
}

export interface PreferenceCoercionResult {
    ok: boolean;
    value?: boolean | string;
    error?: string;
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
