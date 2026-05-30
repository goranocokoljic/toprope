import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import type Database from 'better-sqlite3';
import {GLOBAL_SETTINGS, coercePreferenceValue, coerceSettingValue, getPreferenceDef, getSettingDef} from '../../settings/registry';
import {
    getAllGlobalSettings,
    getTeamOverrides,
    getUserPreferences,
    isTeamOverrideAllowed,
    resolveAllForTeam,
    setGlobalSetting,
    setTeamSetting,
    setUserPreference,
} from '../../settings/store';

/**
 * Settings & preferences endpoints (Task 2.16 / #51).
 *
 * Permission model:
 *  - /api/settings/global   admin only (the site admin owns global config and
 *                           the managers_can_* flags that gate team overrides).
 *  - /api/settings/team/:t  admin only at the role level today; a per-key team
 *                           override is additionally gated by its governing
 *                           managers_can_* flag, so when overrides are
 *                           disallowed the PATCH is rejected with a clear
 *                           message regardless of caller. (Manager-role callers
 *                           drop in here once a manager role + team linkage
 *                           exist; the flag gate is already in place.)
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
        const updates: {key: string; value: boolean | number}[] = [];
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
        // controls whose governing flag is off.
        const overridable: Record<string, boolean> = {};
        for (const key of Object.keys(GLOBAL_SETTINGS)) {
            overridable[key] = isTeamOverrideAllowed(db, key);
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
            const updates: {key: string; value: boolean | number}[] = [];
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
