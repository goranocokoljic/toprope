import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import type Database from 'better-sqlite3';
import {GLOBAL_SETTINGS, coercePreferenceValue, coerceSettingValue, getPreferenceDef, getSettingDef, type SettingValue} from '../../settings/registry';
import {
    clearOverridesGovernedBy,
    getAllGlobalSettings,
    getTeamOverrides,
    getUserPreferences,
    isTeamOverrideAllowed,
    resolveAllForTeam,
    setGlobalSetting,
    setTeamSetting,
    setUserPreference,
} from '../../settings/store';
import {
    ANOMALY_OVERRIDE_FLAG,
    clearTeamAnomalyOverrides,
    getAnomalyConfigSnapshot,
    getTeamAnomalyOverrides,
    isAnomalyMetric,
    isTeamAnomalyOverrideAllowed,
    setGlobalEngineParams,
    setGlobalMetricConfig,
    setTeamEngineParams,
    setTeamMetricConfig,
    validateEngineParamsPatch,
    validateMetricConfigPatch,
    type Validated,
} from '../../anomaly/config';
import type {EngineParams, MetricConfig} from '../../anomaly/engine';
import type {AnomalyMetric} from '../../anomaly/types';

/**
 * Settings & preferences endpoints (Task 2.16 / #51).
 *
 * Permission model. The PRIMARY gate is the session middleware
 * (src/auth/middleware.ts), which confines the only non-admin role
 * (`developer`) to /api/me and /api/auth — so every request that reaches a
 * /api/settings/* route is already an admin. The per-route `isAdmin` checks
 * below are deliberate defense-in-depth: a backstop if the middleware's path
 * allowlist ever changes, and the seam where a future manager role would be
 * authorized. They are redundant with the middleware today, not the live
 * enforcement.
 *  - /api/settings/global   admin only (the site admin owns global config and
 *                           the managers_can_* flags that gate team overrides).
 *  - /api/settings/team/:t  admin only; a per-key team override is additionally
 *                           gated by its governing managers_can_* flag, so when
 *                           overrides are disallowed the PATCH is rejected with
 *                           a clear message. Disabling a flag also discards the
 *                           overrides it gated (see clearOverridesGovernedBy).
 *  - /api/me/preferences    any authenticated user, scoped to their own row.
 */

function isAdmin(request: FastifyRequest): boolean {
    return request.authUser?.role === 'admin';
}

function forbidden(reply: FastifyReply, message: string): void {
    reply.status(403).send({error: 'Forbidden', message});
}

function badRequest(reply: FastifyReply, message: string): void {
    reply.status(400).send({error: 'Bad Request', message});
}

// A PATCH body must be a plain object of key → value.
function asPatchBody(body: unknown): Record<string, unknown> | null {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return null;
    }
    return body as Record<string, unknown>;
}

interface AnomalyPatch {
    metrics: Partial<Record<AnomalyMetric, Partial<MetricConfig>>>;
    engine?: Partial<EngineParams>;
}

/**
 * Validate an anomaly-config PATCH body of shape
 * `{ metrics?: { <metric>: <partial> }, engine?: <partial> }`. Everything is
 * validated before anything is written (all-or-nothing): an unknown metric key,
 * an unrecognized field, or an out-of-range value rejects the whole request.
 * Returns the validated config keyed by metric, ready to write field-by-field.
 */
function parseAnomalyPatch(body: unknown): Validated<AnomalyPatch> {
    const obj = asPatchBody(body);
    if (!obj) {
        return {ok: false, error: 'Request body must be an object'};
    }
    for (const key of Object.keys(obj)) {
        if (key !== 'metrics' && key !== 'engine') {
            return {ok: false, error: `Unknown anomaly config field: ${key}`};
        }
    }
    const out: AnomalyPatch = {metrics: {}};

    if ('metrics' in obj) {
        const metrics = obj.metrics;
        if (typeof metrics !== 'object' || metrics === null || Array.isArray(metrics)) {
            return {ok: false, error: 'metrics must be an object of metric → config'};
        }
        for (const [metric, raw] of Object.entries(metrics as Record<string, unknown>)) {
            if (!isAnomalyMetric(metric)) {
                return {ok: false, error: `Unknown anomaly metric: ${metric}`};
            }
            const result = validateMetricConfigPatch(raw);
            if (!result.ok) {
                return {ok: false, error: `${metric}: ${result.error}`};
            }
            out.metrics[metric] = result.value;
        }
    }

    if ('engine' in obj) {
        const result = validateEngineParamsPatch(obj.engine);
        if (!result.ok) {
            return {ok: false, error: result.error};
        }
        out.engine = result.value;
    }

    return {ok: true, value: out};
}

/** Iterate the validated metric entries with their narrowed AnomalyMetric key. */
function metricEntries(
    patch: AnomalyPatch,
): [AnomalyMetric, Partial<MetricConfig>][] {
    return Object.entries(patch.metrics) as [AnomalyMetric, Partial<MetricConfig>][];
}

export function registerSettingsRoutes(app: FastifyInstance, db: Database.Database): void {
    // --- Global settings (admin only) -------------------------------------
    app.get('/api/settings/global', async (request, reply) => {
        if (!isAdmin(request)) {
            return forbidden(reply, 'Admin privileges required');
        }
        return {data: getAllGlobalSettings(db)};
    });

    app.patch<{Body: unknown}>('/api/settings/global', async (request, reply) => {
        if (!isAdmin(request)) {
            return forbidden(reply, 'Admin privileges required');
        }
        const body = asPatchBody(request.body);
        if (!body) {
            return badRequest(reply, 'Request body must be an object of settings to update');
        }

        // Validate everything before writing anything (atomic update).
        const updates: {key: string; value: SettingValue}[] = [];
        for (const [key, raw] of Object.entries(body)) {
            const def = getSettingDef(key);
            if (!def) {
                return badRequest(reply, `Unknown setting: ${key}`);
            }
            const result = coerceSettingValue(def, raw);
            if (!result.ok) {
                return badRequest(reply, result.error);
            }
            updates.push({key, value: result.value});
        }

        db.transaction(() => {
            for (const u of updates) {
                setGlobalSetting(db, u.key, u.value);
                // Turning a managers_can_* flag off discards the team overrides
                // it gated, so a later re-enable can't silently resurrect them.
                if (u.value === false) {
                    clearOverridesGovernedBy(db, u.key);
                    // The structured anomaly config lives outside the registry but
                    // shares this same flag, so clear its team rows too — keeping
                    // flag-off semantics identical across both override mechanisms.
                    if (u.key === ANOMALY_OVERRIDE_FLAG) {
                        clearTeamAnomalyOverrides(db);
                    }
                }
            }
        })();

        return {data: getAllGlobalSettings(db)};
    });

    // --- Team settings ----------------------------------------------------
    app.get<{Params: {team: string}}>('/api/settings/team/:team', async (request, reply) => {
        if (!isAdmin(request)) {
            return forbidden(reply, 'Admin privileges required');
        }
        const {team} = request.params;
        const exists = db.prepare('SELECT 1 FROM teams WHERE name = ?').get(team);
        if (!exists) {
            return reply.status(404).send({error: 'Not Found', message: `Team '${team}' not found`});
        }

        // Report effective (resolved) values, the raw stored overrides, and
        // which keys may currently be overridden — so the UI can disable the
        // controls whose governing flag is off. Only team-overridable keys get
        // an entry; the managers_can_* flags themselves are global-only.
        const overridable: Record<string, boolean> = {};
        for (const [key, def] of Object.entries(GLOBAL_SETTINGS)) {
            if (def.teamOverridable) {
                overridable[key] = isTeamOverrideAllowed(db, key);
            }
        }

        return {
            data: {
                team,
                effective: resolveAllForTeam(db, team),
                overrides: getTeamOverrides(db, team),
                overridable,
            },
        };
    });

    app.patch<{Params: {team: string}; Body: unknown}>(
        '/api/settings/team/:team',
        async (request, reply) => {
            if (!isAdmin(request)) {
                return forbidden(reply, 'Admin privileges required');
            }
            const {team} = request.params;
            const exists = db.prepare('SELECT 1 FROM teams WHERE name = ?').get(team);
            if (!exists) {
                return reply.status(404).send({error: 'Not Found', message: `Team '${team}' not found`});
            }

            const body = asPatchBody(request.body);
            if (!body) {
                return badRequest(reply, 'Request body must be an object of settings to update');
            }

            // All-or-nothing: every key is validated and authorized before any
            // write. If any key is unknown, non-overridable, governed by an
            // off flag, or invalid, the whole PATCH is rejected and nothing is
            // persisted — a partial multi-key update never happens.
            const updates: {key: string; value: SettingValue}[] = [];
            for (const [key, raw] of Object.entries(body)) {
                const def = getSettingDef(key);
                if (!def) {
                    return badRequest(reply, `Unknown setting: ${key}`);
                }
                if (!def.teamOverridable) {
                    return forbidden(reply, `'${key}' cannot be overridden per team`);
                }
                // The override is only permitted when the governing
                // managers_can_* flag is enabled by the site admin.
                if (!isTeamOverrideAllowed(db, key)) {
                    return forbidden(
                        reply,
                        `Per-team override of '${key}' is disabled. An admin must enable ` +
                            `'${def.overrideGovernedBy}' before teams can override it.`,
                    );
                }
                const result = coerceSettingValue(def, raw);
                if (!result.ok) {
                    return badRequest(reply, result.error);
                }
                updates.push({key, value: result.value});
            }

            db.transaction(() => {
                for (const u of updates) {
                    setTeamSetting(db, team, u.key, u.value);
                }
            })();

            return {
                data: {
                    team,
                    effective: resolveAllForTeam(db, team),
                    overrides: getTeamOverrides(db, team),
                },
            };
        },
    );

    // --- Anomaly detection config (admin only) ----------------------------
    //
    // The per-metric detection config and global engine params are STRUCTURED
    // (a per-metric map + a knobs object), so they don't fit the flat key/value
    // settings table the routes above serve. They live in their own settings rows
    // (src/anomaly/config.ts) and get their own GET/PATCH here. The permission
    // model is the same: admin-only, and a per-team override is additionally gated
    // by the global anomaly_managers_can_override flag.
    app.get('/api/settings/anomaly', async (request, reply) => {
        if (!isAdmin(request)) {
            return forbidden(reply, 'Admin privileges required');
        }
        return {data: getAnomalyConfigSnapshot(db)};
    });

    app.patch<{Body: unknown}>('/api/settings/anomaly', async (request, reply) => {
        if (!isAdmin(request)) {
            return forbidden(reply, 'Admin privileges required');
        }
        const parsed = parseAnomalyPatch(request.body);
        if (!parsed.ok) {
            return badRequest(reply, parsed.error);
        }
        db.transaction(() => {
            for (const [metric, partial] of metricEntries(parsed.value)) {
                setGlobalMetricConfig(db, metric, partial);
            }
            if (parsed.value.engine) {
                setGlobalEngineParams(db, parsed.value.engine);
            }
        })();
        return {data: getAnomalyConfigSnapshot(db)};
    });

    app.get<{Params: {team: string}}>('/api/settings/anomaly/team/:team', async (request, reply) => {
        if (!isAdmin(request)) {
            return forbidden(reply, 'Admin privileges required');
        }
        const {team} = request.params;
        const exists = db.prepare('SELECT 1 FROM teams WHERE name = ?').get(team);
        if (!exists) {
            return reply.status(404).send({error: 'Not Found', message: `Team '${team}' not found`});
        }
        return {
            data: {
                team,
                ...getAnomalyConfigSnapshot(db, team),
                // The raw stored team overrides (not the resolved values above), so
                // the admin UI can see exactly what a team has set vs. inherited.
                overrides: getTeamAnomalyOverrides(db, team),
                // Whether per-team anomaly overrides are currently permitted, so
                // the UI can disable the controls when the flag is off.
                overridable: isTeamAnomalyOverrideAllowed(db),
            },
        };
    });

    app.patch<{Params: {team: string}; Body: unknown}>(
        '/api/settings/anomaly/team/:team',
        async (request, reply) => {
            if (!isAdmin(request)) {
                return forbidden(reply, 'Admin privileges required');
            }
            const {team} = request.params;
            const exists = db.prepare('SELECT 1 FROM teams WHERE name = ?').get(team);
            if (!exists) {
                return reply.status(404).send({error: 'Not Found', message: `Team '${team}' not found`});
            }
            // Per-team anomaly overrides require the admin-controlled flag, exactly
            // like the flat managers_can_* gate above.
            if (!isTeamAnomalyOverrideAllowed(db)) {
                return forbidden(
                    reply,
                    "Per-team anomaly overrides are disabled. An admin must enable " +
                        "'anomaly_managers_can_override' before teams can override anomaly config.",
                );
            }
            const parsed = parseAnomalyPatch(request.body);
            if (!parsed.ok) {
                return badRequest(reply, parsed.error);
            }
            db.transaction(() => {
                for (const [metric, partial] of metricEntries(parsed.value)) {
                    setTeamMetricConfig(db, team, metric, partial);
                }
                if (parsed.value.engine) {
                    setTeamEngineParams(db, team, parsed.value.engine);
                }
            })();
            return {
                data: {
                    team,
                    ...getAnomalyConfigSnapshot(db, team),
                    overrides: getTeamAnomalyOverrides(db, team),
                    overridable: isTeamAnomalyOverrideAllowed(db),
                },
            };
        },
    );

    // --- Per-user preferences (own row) -----------------------------------
    app.get('/api/me/preferences', async (request, reply) => {
        const userId = request.authUser?.userId;
        if (!userId) {
            return reply.status(401).send({error: 'Unauthorized', message: 'Authentication required'});
        }
        return {data: getUserPreferences(db, userId)};
    });

    app.patch<{Body: unknown}>('/api/me/preferences', async (request, reply) => {
        const userId = request.authUser?.userId;
        if (!userId) {
            return reply.status(401).send({error: 'Unauthorized', message: 'Authentication required'});
        }
        const body = asPatchBody(request.body);
        if (!body) {
            return badRequest(reply, 'Request body must be an object of preferences to update');
        }

        const updates: {key: string; value: boolean | string}[] = [];
        for (const [key, raw] of Object.entries(body)) {
            const def = getPreferenceDef(key);
            if (!def) {
                return badRequest(reply, `Unknown preference: ${key}`);
            }
            const result = coercePreferenceValue(def, raw);
            if (!result.ok) {
                return badRequest(reply, result.error);
            }
            updates.push({key, value: result.value});
        }

        db.transaction(() => {
            for (const u of updates) {
                setUserPreference(db, userId, u.key, u.value);
            }
        })();

        return {data: getUserPreferences(db, userId)};
    });
}
