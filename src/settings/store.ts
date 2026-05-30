import type Database from 'better-sqlite3';
import {
    GLOBAL_SETTINGS,
    USER_PREFERENCES,
    coercePreferenceValue,
    coerceSettingValue,
    getPreferenceDef,
    getSettingDef,
    type PreferenceDef,
    type SettingDef,
    type SettingValue,
} from './registry';

/**
 * Persistence + resolution for the settings system (Task 2.16 / #51).
 *
 * Storage is JSON-text in the `settings` table; this module owns the round-trip
 * (serialize on write, parse + re-coerce on read) and the global/team
 * resolution rules. The single most important function is `resolveSetting`,
 * which returns the effective value for a key + team: a team override only when
 * the governing managers_can_* flag is on AND an override row exists, otherwise
 * the global value, otherwise the hardcoded registry default.
 */

interface SettingRow {
    value: string;
}

function nowIso(): string {
    return new Date().toISOString();
}

/** Parse stored JSON and re-validate against the def; fall back to default. */
function decodeStored(def: SettingDef, raw: string): SettingValue {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        console.warn(`[settings] unparseable stored value for ${def.key}; using default`);
        return def.default;
    }
    const result = coerceSettingValue(def, parsed);
    if (!result.ok) {
        // A stored row that no longer satisfies the registry (e.g. bounds were
        // tightened by a later migration, or the DB was hand-edited) is logged
        // rather than swallowed silently, so config drift is discoverable
        // instead of surfacing later as an unexplained reset to default.
        console.warn(`[settings] stored value for ${def.key} failed re-coercion (${result.error}); using default`);
        return def.default;
    }
    return result.value;
}

/** Effective global value for a key: stored row if present, else registry default. */
export function getGlobalSetting(db: Database.Database, key: string): SettingValue {
    const def = getSettingDef(key);
    if (!def) {
        throw new Error(`Unknown setting key: ${key}`);
    }
    const row = db
        .prepare("SELECT value FROM settings WHERE scope = 'global' AND scope_name = '' AND key = ?")
        .get(key) as SettingRow | undefined;
    return row ? decodeStored(def, row.value) : def.default;
}

/** Every global setting resolved to its effective value (stored or default). */
export function getAllGlobalSettings(db: Database.Database): Record<string, SettingValue> {
    const out: Record<string, SettingValue> = {};
    for (const key of Object.keys(GLOBAL_SETTINGS)) {
        out[key] = getGlobalSetting(db, key);
    }
    return out;
}

export function setGlobalSetting(db: Database.Database, key: string, value: SettingValue): void {
    const def = getSettingDef(key);
    if (!def) {
        throw new Error(`Unknown setting key: ${key}`);
    }
    db.prepare(
        `INSERT INTO settings (scope, scope_name, key, value, updated_at)
         VALUES ('global', '', ?, ?, ?)
         ON CONFLICT(scope, scope_name, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, JSON.stringify(value), nowIso());
}

/** Raw per-team override for a key, or undefined if no override row exists. */
function readTeamOverride(db: Database.Database, team: string, key: string): SettingValue | undefined {
    const def = getSettingDef(key);
    if (!def) {
        return undefined;
    }
    const row = db
        .prepare("SELECT value FROM settings WHERE scope = 'team' AND scope_name = ? AND key = ?")
        .get(team, key) as SettingRow | undefined;
    if (!row) {
        return undefined;
    }
    return decodeStored(def, row.value);
}

/** All stored team overrides for a team (raw, before any governing-flag gate). */
export function getTeamOverrides(db: Database.Database, team: string): Record<string, SettingValue> {
    const rows = db
        .prepare("SELECT key, value FROM settings WHERE scope = 'team' AND scope_name = ?")
        .all(team) as {key: string; value: string}[];
    const out: Record<string, SettingValue> = {};
    for (const row of rows) {
        const def = getSettingDef(row.key);
        if (def) {
            out[row.key] = decodeStored(def, row.value);
        }
    }
    return out;
}

/**
 * Whether a per-team override of `key` is currently permitted: the key must be
 * team-overridable and, if it has a governing flag, that global flag must be on.
 */
export function isTeamOverrideAllowed(db: Database.Database, key: string): boolean {
    const def = getSettingDef(key);
    if (!def || !def.teamOverridable) {
        return false;
    }
    if (!def.overrideGovernedBy) {
        return true;
    }
    return getGlobalSetting(db, def.overrideGovernedBy) === true;
}

/**
 * Write a raw per-team override. This is an UNGUARDED persistence primitive: it
 * does not verify the team exists, nor that the key is currently overridable
 * (`isTeamOverrideAllowed`). Authorization is the caller's responsibility — the
 * only caller today, the admin-gated PATCH route, checks both the admin role and
 * the governing managers_can_* flag before calling. Any future caller wiring a
 * team value from request input MUST re-apply those gates, or it will persist
 * orphan/forbidden overrides. `resolveSetting` still refuses to honor an override
 * whose flag is off, so a stray row cannot change resolved values, but it is dead
 * weight until cleaned up.
 */
export function setTeamSetting(db: Database.Database, team: string, key: string, value: SettingValue): void {
    const def = getSettingDef(key);
    if (!def) {
        throw new Error(`Unknown setting key: ${key}`);
    }
    db.prepare(
        `INSERT INTO settings (scope, scope_name, key, value, updated_at)
         VALUES ('team', ?, ?, ?, ?)
         ON CONFLICT(scope, scope_name, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(team, key, JSON.stringify(value), nowIso());
}

/**
 * Delete every team override for keys governed by `flagKey`, across all teams.
 * Called when an admin turns a managers_can_* flag off: disabling the flag
 * discards the overrides it gated rather than leaving stale rows that would
 * silently resurrect if the flag were ever re-enabled. A no-op for keys that
 * govern nothing.
 */
export function clearOverridesGovernedBy(db: Database.Database, flagKey: string): void {
    const governedKeys = Object.values(GLOBAL_SETTINGS)
        .filter((d) => d.overrideGovernedBy === flagKey)
        .map((d) => d.key);
    if (governedKeys.length === 0) {
        return;
    }
    const placeholders = governedKeys.map(() => '?').join(',');
    db.prepare(
        `DELETE FROM settings WHERE scope = 'team' AND key IN (${placeholders})`,
    ).run(...governedKeys);
}

/**
 * The effective value of a setting for a given team. This is THE resolution
 * helper other features (ROI logic, leaderboard gating) call. A team override
 * wins only when (a) the key is team-overridable, (b) its governing flag is on,
 * and (c) an override row exists; otherwise the global value is returned.
 */
export function resolveSetting(db: Database.Database, key: string, team?: string | null): SettingValue {
    const def = getSettingDef(key);
    if (!def) {
        throw new Error(`Unknown setting key: ${key}`);
    }
    const globalValue = getGlobalSetting(db, key);
    if (!team || !def.teamOverridable) {
        return globalValue;
    }
    if (!isTeamOverrideAllowed(db, key)) {
        return globalValue;
    }
    const override = readTeamOverride(db, team, key);
    return override !== undefined ? override : globalValue;
}

/** Every setting resolved for a team (override-aware). Useful for the team UI. */
export function resolveAllForTeam(db: Database.Database, team: string): Record<string, SettingValue> {
    const out: Record<string, SettingValue> = {};
    for (const key of Object.keys(GLOBAL_SETTINGS)) {
        out[key] = resolveSetting(db, key, team);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Convenience resolvers for downstream features (2.15 ROI, 2.17 leaderboard).
// These give consumers a typed seam instead of stringly-typed resolveSetting
// calls, and are the integration point those tasks wire into.
// ---------------------------------------------------------------------------

export interface RoiConfig {
    threshold: number;
    settlingDays: number;
}

export function getRoiConfigForTeam(db: Database.Database, team?: string | null): RoiConfig {
    return {
        threshold: resolveSetting(db, 'roi_threshold', team) as number,
        settlingDays: resolveSetting(db, 'roi_settling_days', team) as number,
    };
}

export function isLeaderboardEnabledForTeam(db: Database.Database, team?: string | null): boolean {
    return resolveSetting(db, 'leaderboard_enabled', team) === true;
}

// ---------------------------------------------------------------------------
// Per-user preferences
// ---------------------------------------------------------------------------

function decodePreference(def: PreferenceDef, raw: string): boolean | string {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        console.warn(`[settings] unparseable stored preference for ${def.key}; using default`);
        return def.default;
    }
    const result = coercePreferenceValue(def, parsed);
    if (!result.ok) {
        console.warn(`[settings] stored preference for ${def.key} failed re-coercion (${result.error}); using default`);
        return def.default;
    }
    return result.value;
}

/** All preferences for a user, merged over the registry defaults. */
export function getUserPreferences(db: Database.Database, userId: string): Record<string, boolean | string> {
    const out: Record<string, boolean | string> = {};
    for (const [key, def] of Object.entries(USER_PREFERENCES)) {
        out[key] = def.default;
    }
    const rows = db
        .prepare('SELECT key, value FROM user_preferences WHERE user_id = ?')
        .all(userId) as {key: string; value: string}[];
    for (const row of rows) {
        const def = getPreferenceDef(row.key);
        if (def) {
            out[row.key] = decodePreference(def, row.value);
        }
    }
    return out;
}

export function setUserPreference(
    db: Database.Database,
    userId: string,
    key: string,
    value: boolean | string,
): void {
    const def = getPreferenceDef(key);
    if (!def) {
        throw new Error(`Unknown preference key: ${key}`);
    }
    db.prepare(
        `INSERT INTO user_preferences (user_id, key, value, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(userId, key, JSON.stringify(value), nowIso());
}
