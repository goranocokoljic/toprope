import type Database from 'better-sqlite3';
import {
    DEVELOPER_PREFERENCES,
    GLOBAL_SETTINGS,
    USER_PREFERENCES,
    coercePreferenceValue,
    coerceSettingValue,
    getDeveloperPreferenceDef,
    getPreferenceDef,
    getSettingDef,
    type DeveloperPreferenceDef,
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
 * Whether a managers_can_* governing flag is currently on. The single place the
 * "is this override-governing flag enabled" check lives, so both the registry
 * path (isTeamOverrideAllowed, below) and structured config outside the registry
 * (the anomaly per-metric/engine overrides in src/anomaly/config.ts) resolve it
 * the same way instead of each re-deriving `getGlobalSetting(...) === true`.
 */
export function isGovernedFlagOn(db: Database.Database, flagKey: string): boolean {
    return getGlobalSetting(db, flagKey) === true;
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
    return isGovernedFlagOn(db, def.overrideGovernedBy);
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

/** Upsert one (user_id, key) preference row. Shared by the UI and coaching setters. */
function writePreferenceRow(db: Database.Database, userId: string, key: string, value: boolean | string): void {
    db.prepare(
        `INSERT INTO user_preferences (user_id, key, value, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(userId, key, JSON.stringify(value), nowIso());
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
    writePreferenceRow(db, userId, key, value);
}

// ---------------------------------------------------------------------------
// Developer-level coaching preferences (Task 5.10 / #131)
//
// These live in the SAME user_preferences table as the UI preferences above —
// keyed by (user_id, key), so a developer-role user's coaching choices are
// persisted per developer with no new table. The two registries never share a
// key, and each read filters by its own def lookup, so they coexist cleanly.
//
// The defining behaviour is RESOLUTION: a stored developer choice is honored
// only within the org's permission boundary. `resolveDeveloperPreferences`
// resolves the gating org setting FOR THE DEVELOPER'S TEAM and, when it forbids
// the choice, reports it as blocked and forces the effective value to the def's
// blockedValue — the org boundary always wins over a stored opt-in.
// ---------------------------------------------------------------------------

export function setDeveloperPreference(
    db: Database.Database,
    userId: string,
    key: string,
    value: boolean | string,
): void {
    const def = getDeveloperPreferenceDef(key);
    if (!def) {
        throw new Error(`Unknown coaching preference key: ${key}`);
    }
    // Coerce before persisting (defense-in-depth): the HTTP route already
    // validates, but this is an exported primitive, so it must not let a
    // wrong-typed/out-of-domain value reach the table.
    const result = coercePreferenceValue(def, value);
    if (!result.ok) {
        throw new Error(`Invalid coaching preference value: ${result.error}`);
    }
    writePreferenceRow(db, userId, key, result.value);
}

/** The developer's stored choice for a key (or its effective default), before org gating. */
function storedDeveloperPreference(
    db: Database.Database,
    userId: string,
    def: DeveloperPreferenceDef,
    team: string | null | undefined,
): boolean | string {
    const row = db
        .prepare('SELECT value FROM user_preferences WHERE user_id = ? AND key = ?')
        .get(userId, def.key) as {value: string} | undefined;
    if (row) {
        // A DeveloperPreferenceDef is a PreferenceDef, so the shared decoder
        // re-coerces and falls back to default on a malformed stored value.
        return decodePreference(def, row.value);
    }
    // No stored choice: a preference may inherit the org default (e.g.
    // nudge_frequency follows nudge_default_frequency) so the developer starts
    // from the org's posture rather than a hardcoded constant. The org value is
    // re-coerced against this def's domain so a registry drift can't carry an
    // out-of-domain (or numeric) value into a boolean|string preference.
    if (def.defaultFromOrg) {
        const seeded = coercePreferenceValue(def, resolveSetting(db, def.defaultFromOrg, team));
        if (seeded.ok) {
            return seeded.value;
        }
        // Org value is outside this pref's domain (registry drift between the org
        // enum and the developer enum). Surface it like the sibling decoders rather
        // than silently reverting the developer to the hardcoded default.
        console.warn(
            `[settings] org default ${def.defaultFromOrg} for ${def.key} failed re-coercion (${seeded.error}); using default`,
        );
        return def.default;
    }
    return def.default;
}

/** One developer preference, resolved against the org permission boundary. */
export interface ResolvedDeveloperPreference {
    key: string;
    /** Effective value after org gating — what the system should actually act on. */
    value: boolean | string;
    /** The developer's own stored choice (or its default), independent of gating. */
    stored: boolean | string;
    /** True when an org policy currently forbids this choice. */
    blocked: boolean;
    /** Human-readable reason, present only when `blocked`. */
    reason?: string;
}

/** Resolve ONE developer preference def against the org boundary (see the plural). */
function resolveDeveloperPreferenceDef(
    db: Database.Database,
    userId: string,
    def: DeveloperPreferenceDef,
    team: string | null | undefined,
): ResolvedDeveloperPreference {
    const stored = storedDeveloperPreference(db, userId, def, team);
    const blocked = def.gatedBy ? resolveSetting(db, def.gatedBy, team) !== true : false;
    const value = blocked && def.blockedValue !== undefined ? def.blockedValue : stored;
    return {
        key: def.key,
        value,
        stored,
        blocked,
        ...(blocked && def.blockedReason ? {reason: def.blockedReason} : {}),
    };
}

/**
 * Resolve a SINGLE developer coaching preference for `userId` against the org
 * permission boundary for `team`. The targeted counterpart to
 * {@link resolveDeveloperPreferences}: a consumer that needs only one preference
 * (e.g. the capture gate reading `capture_opt_in`, or the manager aggregate
 * resolving the opted-in cohort over many developers) resolves just that key
 * instead of every preference, which matters when it runs once per developer in
 * a loop. Throws on an unknown key (a programming error, like the setters).
 */
export function resolveDeveloperPreference(
    db: Database.Database,
    userId: string,
    key: string,
    team?: string | null,
): ResolvedDeveloperPreference {
    const def = getDeveloperPreferenceDef(key);
    if (!def) {
        throw new Error(`Unknown coaching preference key: ${key}`);
    }
    return resolveDeveloperPreferenceDef(db, userId, def, team);
}

/**
 * Resolve every developer coaching preference for `userId`, applying the org
 * permission boundary resolved for `team`. For a gated preference whose org flag
 * is off, `blocked` is true, `reason` explains why, and `value` is forced to the
 * def's blockedValue (falling back to the stored value when none is declared) —
 * so a stored opt-in the org forbids is never the effective value. `stored`
 * always carries the developer's own choice so the UI can show what they picked
 * and re-honor it automatically if the org later permits it.
 */
export function resolveDeveloperPreferences(
    db: Database.Database,
    userId: string,
    team?: string | null,
): Record<string, ResolvedDeveloperPreference> {
    const out: Record<string, ResolvedDeveloperPreference> = {};
    for (const def of Object.values(DEVELOPER_PREFERENCES)) {
        out[def.key] = resolveDeveloperPreferenceDef(db, userId, def, team);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Coaching pillar gating (Task 5.10 / #131)
//
// "Disabling a pillar org-wide hides/disables it everywhere": the developer
// coaching surfaces resolve these for the developer's team before serving any
// coaching, so a team override or a global off-switch suppresses the feature.
// ---------------------------------------------------------------------------

export function isCoachingPillar1Enabled(db: Database.Database, team?: string | null): boolean {
    return resolveSetting(db, 'coaching_pillar1_enabled', team) === true;
}

export function isCoachingPillar2Enabled(db: Database.Database, team?: string | null): boolean {
    return resolveSetting(db, 'coaching_pillar2_enabled', team) === true;
}

/**
 * Whether Pillar 3 prompt capture is permitted for a scope. Capture-derived
 * surfaces (e.g. the manager loop/nudge aggregate) gate on this the same way
 * pillars 1 and 2 gate on their flags — keeping every "is pillar N enabled for
 * scope" check in one module rather than re-deriving the `=== true` comparison
 * at each call site.
 */
export function isCoachingCapturePermitted(db: Database.Database, team?: string | null): boolean {
    return resolveSetting(db, 'coaching_capture_permitted', team) === true;
}
