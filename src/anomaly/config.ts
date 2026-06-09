/**
 * Per-metric anomaly configuration + resolution (Task 4.7 / #102).
 *
 * Two things live here:
 *
 *  1. The metric registry (METRIC_DEFS) — the closed set of metrics the engine
 *     understands, each with its scope applicability, its data tier (`basis`),
 *     and its hardcoded default detection config. This is the single source of
 *     truth for "which metrics exist and how are they detected by default."
 *
 *  2. Resolution of the EFFECTIVE config for a metric + team, following the
 *     Phase 2 pattern: hardcoded default ← global override ← per-team override,
 *     merged field-by-field so a team can override just the threshold while
 *     inheriting the method, etc.
 *
 * Overrides are persisted in the existing `settings` table (the generic
 * scope/scope_name/key/value store from migration 011) under two JSON keys —
 * `anomaly_config` (per-metric map) and `anomaly_engine_params` (global knobs).
 * We write/read these rows directly rather than through the settings *registry*
 * (src/settings/registry.ts), because that registry models flat scalar keys and
 * gates team overrides behind managers_can_* flags — both a poor fit for the
 * structured per-metric config here. The same global→team precedence is
 * reproduced here.
 *
 * Task 4.12 (Settings Extensions) wires the admin permission model in: a per-team
 * override (metric config OR engine params) is honored only when the global
 * `anomaly_managers_can_override` flag is on, mirroring the registry's
 * managers_can_* gate. The flag lives in the settings registry; this module reads
 * it via getGlobalSetting so the structured config and the flat keys share one
 * source of truth for who may override.
 */

import type Database from 'better-sqlite3';
import {isGovernedFlagOn} from '../settings/store';
import type {AnomalyBasis, AnomalyMetric, AnomalyScope} from './types';
import type {EngineParams, MetricConfig} from './engine';

const CONFIG_KEY = 'anomaly_config';
const ENGINE_PARAMS_KEY = 'anomaly_engine_params';

/**
 * The global managers_can_* flag governing per-team anomaly overrides. This is
 * the SAME flag the registry declares as `overrideGovernedBy` for the flat
 * anomaly keys (anomaly_alerts_enabled, anomaly_alert_min_severity), named once
 * here so the structured config and the flat settings stay in lockstep.
 */
export const ANOMALY_OVERRIDE_FLAG = 'anomaly_managers_can_override';

export interface MetricDef {
    metric: AnomalyMetric;
    /** Scopes this metric can be evaluated for. */
    scopes: readonly AnomalyScope[];
    /** Data tier stored on anomalies for this metric. */
    basis: AnomalyBasis;
    /** Hardcoded default detection config (the registry fallback). */
    defaults: MetricConfig;
}

/**
 * The metric registry. Methods follow the design's guidance: statistical for
 * noisy-but-stationary signals (commits, PRs, churn, AI signature, interactions,
 * acceptance rate); percentage_change for cost, where a directional shift
 * (runaway spend) matters regardless of variance.
 *
 * Basis: git-derived and cost metrics are `git_estimate` (the launch tier);
 * interactions and acceptance_rate are `measured` — tool metrics that only carry
 * real values once a connector is online.
 *
 * `interactions` is developer-only: the team period rollup (TeamPeriodMetrics)
 * does not expose a total-interactions sum, so it is not evaluated at team scope.
 */
export const METRIC_DEFS: Record<AnomalyMetric, MetricDef> = {
    commits: {
        metric: 'commits',
        scopes: ['developer', 'team'],
        basis: 'git_estimate',
        defaults: {method: 'statistical', threshold: 2.0, baselineWindow: 8},
    },
    prs_merged: {
        metric: 'prs_merged',
        scopes: ['developer', 'team'],
        basis: 'git_estimate',
        defaults: {method: 'statistical', threshold: 2.0, baselineWindow: 8},
    },
    churn: {
        metric: 'churn',
        scopes: ['developer', 'team'],
        basis: 'git_estimate',
        defaults: {method: 'statistical', threshold: 2.0, baselineWindow: 8},
    },
    ai_signature: {
        metric: 'ai_signature',
        scopes: ['developer', 'team'],
        basis: 'git_estimate',
        defaults: {method: 'statistical', threshold: 2.0, baselineWindow: 8},
    },
    interactions: {
        metric: 'interactions',
        scopes: ['developer'],
        basis: 'measured',
        defaults: {method: 'statistical', threshold: 2.0, baselineWindow: 8},
    },
    acceptance_rate: {
        metric: 'acceptance_rate',
        scopes: ['developer', 'team'],
        basis: 'measured',
        defaults: {method: 'statistical', threshold: 2.0, baselineWindow: 8},
    },
    cost: {
        metric: 'cost',
        scopes: ['developer', 'team'],
        basis: 'git_estimate',
        defaults: {method: 'percentage_change', threshold: 40, baselineWindow: 8, percentageBaseline: 'prior'},
    },
};

/** Default global engine knobs. minBaselinePeriods is the early-weeks guard. */
export const DEFAULT_ENGINE_PARAMS: EngineParams = {
    minBaselinePeriods: 4,
    statisticalHighZ: 2.5,
};

/** Every metric that applies to a scope, in registry order. */
export function metricsForScope(scope: AnomalyScope): MetricDef[] {
    return Object.values(METRIC_DEFS).filter((d) => d.scopes.includes(scope));
}

function nowIso(): string {
    return new Date().toISOString();
}

// --- raw settings-table access (bypasses the typed registry, see header) ------

function readJsonRow(db: Database.Database, scope: 'global' | 'team', scopeName: string, key: string): Record<string, unknown> | null {
    const row = db
        .prepare('SELECT value FROM settings WHERE scope = ? AND scope_name = ? AND key = ?')
        .get(scope, scopeName, key) as {value: string} | undefined;
    if (!row) return null;
    try {
        const parsed = JSON.parse(row.value) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

function writeJsonRow(
    db: Database.Database,
    scope: 'global' | 'team',
    scopeName: string,
    key: string,
    value: Record<string, unknown>,
): void {
    db.prepare(
        `INSERT INTO settings (scope, scope_name, key, value, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(scope, scope_name, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(scope, scopeName, key, JSON.stringify(value), nowIso());
}

// --- override coercion --------------------------------------------------------

/**
 * Extract the valid, recognised fields of a stored per-metric override. Unknown
 * keys and values that fail validation are dropped (not thrown on), so a partial
 * or hand-edited row degrades to "inherit the default for that field" rather
 * than corrupting resolution.
 */
function coerceMetricOverride(raw: unknown): Partial<MetricConfig> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const obj = raw as Record<string, unknown>;
    const out: Partial<MetricConfig> = {};
    if (obj.method === 'statistical' || obj.method === 'percentage_change') {
        out.method = obj.method;
    }
    if (typeof obj.threshold === 'number' && Number.isFinite(obj.threshold) && obj.threshold > 0) {
        out.threshold = obj.threshold;
    }
    if (
        typeof obj.baselineWindow === 'number' &&
        Number.isInteger(obj.baselineWindow) &&
        obj.baselineWindow >= 2
    ) {
        out.baselineWindow = obj.baselineWindow;
    }
    if (obj.percentageBaseline === 'prior' || obj.percentageBaseline === 'average') {
        out.percentageBaseline = obj.percentageBaseline;
    }
    return out;
}

function coerceEngineParamsOverride(raw: Record<string, unknown> | null): Partial<EngineParams> {
    if (!raw) return {};
    const out: Partial<EngineParams> = {};
    if (
        typeof raw.minBaselinePeriods === 'number' &&
        Number.isInteger(raw.minBaselinePeriods) &&
        raw.minBaselinePeriods >= 1
    ) {
        out.minBaselinePeriods = raw.minBaselinePeriods;
    }
    if (
        typeof raw.statisticalHighZ === 'number' &&
        Number.isFinite(raw.statisticalHighZ) &&
        raw.statisticalHighZ > 0
    ) {
        out.statisticalHighZ = raw.statisticalHighZ;
    }
    return out;
}

function metricOverrideFor(
    db: Database.Database,
    scope: 'global' | 'team',
    scopeName: string,
    metric: AnomalyMetric,
): Partial<MetricConfig> {
    const map = readJsonRow(db, scope, scopeName, CONFIG_KEY);
    if (!map) return {};
    return coerceMetricOverride(map[metric]);
}

/**
 * Whether per-team anomaly overrides (metric config + engine params) are
 * currently permitted — the global `anomaly_managers_can_override` flag is on.
 * This is the same gate the settings registry applies to its managers_can_*
 * keys, reused here so the structured config honors one permission model. When
 * off, a stored team row is ignored at resolution time (it cannot change the
 * effective value), matching how the flat settings store treats a disallowed
 * override.
 */
export function isTeamAnomalyOverrideAllowed(db: Database.Database): boolean {
    return isGovernedFlagOn(db, ANOMALY_OVERRIDE_FLAG);
}

// --- resolution (the public API the scan layer uses) --------------------------

/**
 * The effective detection config for a metric, optionally for a team:
 * registry default ← global override ← team override, merged field-by-field.
 * A team override only ever NARROWS to its own fields; unspecified fields fall
 * through to the global value, then the hardcoded default.
 */
export function resolveMetricConfig(
    db: Database.Database,
    metric: AnomalyMetric,
    team?: string | null,
): MetricConfig {
    const base = METRIC_DEFS[metric].defaults;
    const globalOverride = metricOverrideFor(db, 'global', '', metric);
    // A team override is honored only when the admin has enabled
    // anomaly_managers_can_override; otherwise the team layer is dropped and
    // resolution falls through to global ← default (a stored team row becomes
    // inert rather than silently taking effect).
    const teamOverride =
        team && isTeamAnomalyOverrideAllowed(db) ? metricOverrideFor(db, 'team', team, metric) : {};
    return {...base, ...globalOverride, ...teamOverride};
}

/**
 * The effective global engine params, optionally for a team:
 * defaults ← global override ← team override. Lets a team tune its own
 * minimum-baseline guard or high-Z cutoff while inheriting the global default.
 */
export function resolveEngineParams(db: Database.Database, team?: string | null): EngineParams {
    const globalOverride = coerceEngineParamsOverride(readJsonRow(db, 'global', '', ENGINE_PARAMS_KEY));
    // Gated identically to per-metric config: the team layer applies only when
    // anomaly_managers_can_override is on.
    const teamOverride =
        team && isTeamAnomalyOverrideAllowed(db)
            ? coerceEngineParamsOverride(readJsonRow(db, 'team', team, ENGINE_PARAMS_KEY))
            : {};
    return {...DEFAULT_ENGINE_PARAMS, ...globalOverride, ...teamOverride};
}

// --- setters (used by tests, the CLI, and a future 4.12 settings UI) ----------

function setMetricConfig(
    db: Database.Database,
    scope: 'global' | 'team',
    scopeName: string,
    metric: AnomalyMetric,
    partial: Partial<MetricConfig>,
): void {
    const map = readJsonRow(db, scope, scopeName, CONFIG_KEY) ?? {};
    const merged = {...coerceMetricOverride(map[metric]), ...partial};
    // percentageBaseline only applies to percentage_change. If the effective
    // method is statistical, drop a lingering percentageBaseline so a
    // statistical→percentage_change→statistical round-trip can't leave stale,
    // misleading dead data in the stored row (it would be ignored at resolution
    // but confuses anyone reading the row).
    if (merged.method !== 'percentage_change') {
        delete merged.percentageBaseline;
    }
    map[metric] = merged;
    writeJsonRow(db, scope, scopeName, CONFIG_KEY, map);
}

/** Set (merge) a global per-metric override. */
export function setGlobalMetricConfig(
    db: Database.Database,
    metric: AnomalyMetric,
    partial: Partial<MetricConfig>,
): void {
    setMetricConfig(db, 'global', '', metric, partial);
}

/** Set (merge) a per-team per-metric override. */
export function setTeamMetricConfig(
    db: Database.Database,
    team: string,
    metric: AnomalyMetric,
    partial: Partial<MetricConfig>,
): void {
    setMetricConfig(db, 'team', team, metric, partial);
}

function setEngineParams(
    db: Database.Database,
    scope: 'global' | 'team',
    scopeName: string,
    partial: Partial<EngineParams>,
): void {
    const current = coerceEngineParamsOverride(readJsonRow(db, scope, scopeName, ENGINE_PARAMS_KEY));
    writeJsonRow(db, scope, scopeName, ENGINE_PARAMS_KEY, {...current, ...partial});
}

/** Set (merge) the global engine params override. */
export function setGlobalEngineParams(db: Database.Database, partial: Partial<EngineParams>): void {
    setEngineParams(db, 'global', '', partial);
}

/** Set (merge) a per-team engine params override. */
export function setTeamEngineParams(db: Database.Database, team: string, partial: Partial<EngineParams>): void {
    setEngineParams(db, 'team', team, partial);
}

/**
 * Delete every per-team structured anomaly override (metric config + engine
 * params), across all teams. Called when an admin turns
 * anomaly_managers_can_override off, so the structured config matches the flat
 * settings' clearOverridesGovernedBy behavior: disabling the flag DISCARDS the
 * overrides it gated rather than leaving inert rows that would silently resurrect
 * on a later re-enable. Without this, the structured config and the flat keys
 * (which share the flag) would diverge on flag-off semantics.
 */
export function clearTeamAnomalyOverrides(db: Database.Database): void {
    db.prepare(
        "DELETE FROM settings WHERE scope = 'team' AND key IN (?, ?)",
    ).run(CONFIG_KEY, ENGINE_PARAMS_KEY);
}

export interface TeamAnomalyOverrides {
    /** Raw stored per-metric overrides (only the fields a team actually set). */
    metrics: Partial<Record<AnomalyMetric, Partial<MetricConfig>>>;
    /** Raw stored engine-params override (only the fields a team actually set). */
    engine: Partial<EngineParams>;
}

/**
 * The RAW stored per-team overrides (not resolved/effective values), so an admin
 * UI can see exactly what a team has set — distinct from getAnomalyConfigSnapshot,
 * which only ever returns resolved values. Unknown/invalid stored fields are
 * dropped (coerced) so the shape is always trustworthy.
 */
export function getTeamAnomalyOverrides(db: Database.Database, team: string): TeamAnomalyOverrides {
    const metricsMap = readJsonRow(db, 'team', team, CONFIG_KEY);
    const metrics: Partial<Record<AnomalyMetric, Partial<MetricConfig>>> = {};
    if (metricsMap) {
        for (const key of Object.keys(metricsMap)) {
            if (!isAnomalyMetric(key)) continue;
            const coerced = coerceMetricOverride(metricsMap[key]);
            if (Object.keys(coerced).length > 0) {
                metrics[key] = coerced;
            }
        }
    }
    return {
        metrics,
        engine: coerceEngineParamsOverride(readJsonRow(db, 'team', team, ENGINE_PARAMS_KEY)),
    };
}

// --- strict validation for the settings API (Task 4.12 / #107) ----------------
//
// The coerceMetricOverride / coerceEngineParamsOverride helpers above silently
// DROP bad fields, which is right for resolution (a hand-edited row degrades
// gracefully). An API needs the opposite: reject an explicit bad value with a
// clear message instead of swallowing it. These validators do that, returning a
// Coerced<Partial<...>> the route turns into a 400. Unknown keys are rejected so
// a typo can't be silently ignored.

export type Validated<T> = {ok: true; value: T} | {ok: false; error: string};

const METRIC_FIELDS = new Set(['method', 'threshold', 'baselineWindow', 'percentageBaseline']);

/** Validate an untrusted per-metric config patch (all fields optional). */
export function validateMetricConfigPatch(raw: unknown): Validated<Partial<MetricConfig>> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {ok: false, error: 'metric config must be an object'};
    }
    const obj = raw as Record<string, unknown>;
    const out: Partial<MetricConfig> = {};
    for (const key of Object.keys(obj)) {
        if (!METRIC_FIELDS.has(key)) {
            return {ok: false, error: `unknown metric config field: ${key}`};
        }
    }
    if ('method' in obj) {
        if (obj.method !== 'statistical' && obj.method !== 'percentage_change') {
            return {ok: false, error: "method must be 'statistical' or 'percentage_change'"};
        }
        out.method = obj.method;
    }
    if ('threshold' in obj) {
        if (typeof obj.threshold !== 'number' || !Number.isFinite(obj.threshold) || obj.threshold <= 0) {
            return {ok: false, error: 'threshold must be a number > 0'};
        }
        out.threshold = obj.threshold;
    }
    if ('baselineWindow' in obj) {
        if (
            typeof obj.baselineWindow !== 'number' ||
            !Number.isInteger(obj.baselineWindow) ||
            obj.baselineWindow < 2
        ) {
            return {ok: false, error: 'baselineWindow must be a whole number >= 2'};
        }
        out.baselineWindow = obj.baselineWindow;
    }
    if ('percentageBaseline' in obj) {
        if (obj.percentageBaseline !== 'prior' && obj.percentageBaseline !== 'average') {
            return {ok: false, error: "percentageBaseline must be 'prior' or 'average'"};
        }
        out.percentageBaseline = obj.percentageBaseline;
    }
    return {ok: true, value: out};
}

const ENGINE_FIELDS = new Set(['minBaselinePeriods', 'statisticalHighZ']);

/** Validate an untrusted engine-params patch (all fields optional). */
export function validateEngineParamsPatch(raw: unknown): Validated<Partial<EngineParams>> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {ok: false, error: 'engine params must be an object'};
    }
    const obj = raw as Record<string, unknown>;
    const out: Partial<EngineParams> = {};
    for (const key of Object.keys(obj)) {
        if (!ENGINE_FIELDS.has(key)) {
            return {ok: false, error: `unknown engine param: ${key}`};
        }
    }
    if ('minBaselinePeriods' in obj) {
        if (
            typeof obj.minBaselinePeriods !== 'number' ||
            !Number.isInteger(obj.minBaselinePeriods) ||
            obj.minBaselinePeriods < 1
        ) {
            return {ok: false, error: 'minBaselinePeriods must be a whole number >= 1'};
        }
        out.minBaselinePeriods = obj.minBaselinePeriods;
    }
    if ('statisticalHighZ' in obj) {
        if (
            typeof obj.statisticalHighZ !== 'number' ||
            !Number.isFinite(obj.statisticalHighZ) ||
            obj.statisticalHighZ <= 0
        ) {
            return {ok: false, error: 'statisticalHighZ must be a number > 0'};
        }
        out.statisticalHighZ = obj.statisticalHighZ;
    }
    return {ok: true, value: out};
}

// --- snapshot for the settings API --------------------------------------------

export interface MetricConfigSnapshot {
    metric: AnomalyMetric;
    scopes: readonly AnomalyScope[];
    basis: AnomalyBasis;
    /** The effective config for this metric (resolution applied). */
    config: MetricConfig;
}

export interface AnomalyConfigSnapshot {
    metrics: MetricConfigSnapshot[];
    engine: EngineParams;
}

/**
 * The effective anomaly configuration the settings UI renders — every metric's
 * resolved detection config plus the resolved engine params. With `team` set,
 * resolution applies the per-team layer (gated by anomaly_managers_can_override);
 * without it, the global picture. Metrics are returned in registry order.
 */
export function getAnomalyConfigSnapshot(db: Database.Database, team?: string | null): AnomalyConfigSnapshot {
    return {
        metrics: Object.values(METRIC_DEFS).map((def) => ({
            metric: def.metric,
            scopes: def.scopes,
            basis: def.basis,
            config: resolveMetricConfig(db, def.metric, team),
        })),
        engine: resolveEngineParams(db, team),
    };
}

/** The closed set of metric keys, for API validation of a patch's metric map. */
export function isAnomalyMetric(key: string): key is AnomalyMetric {
    return Object.prototype.hasOwnProperty.call(METRIC_DEFS, key);
}
