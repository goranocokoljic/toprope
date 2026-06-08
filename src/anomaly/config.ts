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
 * structured per-metric config here. The admin-gating of who may set these is a
 * Task 4.12 (Settings Extensions) concern; this module owns only the storage and
 * resolution. The same global→team precedence is reproduced here.
 */

import type Database from 'better-sqlite3';
import type {AnomalyBasis, AnomalyMetric, AnomalyScope} from './types';
import type {EngineParams, MetricConfig} from './engine';

const CONFIG_KEY = 'anomaly_config';
const ENGINE_PARAMS_KEY = 'anomaly_engine_params';

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
    const teamOverride = team ? metricOverrideFor(db, 'team', team, metric) : {};
    return {...base, ...globalOverride, ...teamOverride};
}

/**
 * The effective global engine params, optionally for a team:
 * defaults ← global override ← team override. Lets a team tune its own
 * minimum-baseline guard or high-Z cutoff while inheriting the global default.
 */
export function resolveEngineParams(db: Database.Database, team?: string | null): EngineParams {
    const globalOverride = coerceEngineParamsOverride(readJsonRow(db, 'global', '', ENGINE_PARAMS_KEY));
    const teamOverride = team
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
    map[metric] = {...(coerceMetricOverride(map[metric])), ...partial};
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
