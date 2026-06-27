import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {makeTestDb, seedFixtures} from '../dashboard/fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerMeRoutes} from '../../src/dashboard/api/me';
import {registerSettingsRoutes} from '../../src/dashboard/api/settings';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';

const PASSWORD = 'correct-horse-battery';

async function buildApp(db: Database.Database): Promise<FastifyInstance> {
    const app = Fastify({logger: false});
    registerSessionAuth(app, db);
    registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
    registerMeRoutes(app, db);
    registerSettingsRoutes(app, db);
    await app.ready();
    return app;
}

function cookieToken(res: {headers: Record<string, unknown>}): string {
    const raw = res.headers['set-cookie'];
    const header = Array.isArray(raw) ? raw[0] : (raw as string);
    const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header);
    return match ? decodeURIComponent(match[1]) : '';
}

async function login(app: FastifyInstance, email: string): Promise<string> {
    const res = await app.inject({method: 'POST', url: '/api/auth/login', payload: {email, password: PASSWORD}});
    expect(res.statusCode).toBe(200);
    return cookieToken(res);
}

function authHeaders(token: string): Record<string, string> {
    return {cookie: `${SESSION_COOKIE}=${token}`};
}

describe('settings API', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let adminToken: string;
    let devToken: string;

    beforeEach(async () => {
        db = makeTestDb();
        seedFixtures(db);
        const hash = await hashPassword(PASSWORD);
        createUser(db, {email: 'admin@test.com', passwordHash: hash, role: 'admin'});
        createUser(db, {email: 'alice@test.com', passwordHash: hash, role: 'developer', developerId: 'dev-1'});
        app = await buildApp(db);
        adminToken = await login(app, 'admin@test.com');
        devToken = await login(app, 'alice@test.com');
    });

    afterEach(async () => {
        await app.close();
        db.close();
    });

    describe('global settings', () => {
        it('admin can read global settings with defaults', async () => {
            const res = await app.inject({method: 'GET', url: '/api/settings/global', headers: authHeaders(adminToken)});
            expect(res.statusCode).toBe(200);
            expect(res.json().data).toMatchObject({
                leaderboard_enabled: false,
                roi_threshold: 3.0,
                roi_settling_days: 30,
            });
        });

        it('admin can patch and the value persists', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: '/api/settings/global',
                headers: authHeaders(adminToken),
                payload: {roi_threshold: 4.5, leaderboard_enabled: true},
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.roi_threshold).toBe(4.5);

            const reread = await app.inject({method: 'GET', url: '/api/settings/global', headers: authHeaders(adminToken)});
            expect(reread.json().data.roi_threshold).toBe(4.5);
            expect(reread.json().data.leaderboard_enabled).toBe(true);
        });

        it('rejects an unknown key', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: '/api/settings/global',
                headers: authHeaders(adminToken),
                payload: {bogus_key: 1},
            });
            expect(res.statusCode).toBe(400);
        });

        it('rejects a wrong-typed value and writes nothing (atomic)', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: '/api/settings/global',
                headers: authHeaders(adminToken),
                payload: {roi_threshold: 'not-a-number', leaderboard_enabled: true},
            });
            expect(res.statusCode).toBe(400);
            // leaderboard_enabled must NOT have been applied.
            const reread = await app.inject({method: 'GET', url: '/api/settings/global', headers: authHeaders(adminToken)});
            expect(reread.json().data.leaderboard_enabled).toBe(false);
        });

        it('rejects out-of-range numbers', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: '/api/settings/global',
                headers: authHeaders(adminToken),
                payload: {roi_settling_days: 9999},
            });
            expect(res.statusCode).toBe(400);
        });

        it('rejects a fractional value for an integer-only setting', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: '/api/settings/global',
                headers: authHeaders(adminToken),
                payload: {roi_settling_days: 14.7},
            });
            expect(res.statusCode).toBe(400);

            // Nothing was written — the default still stands.
            const reread = await app.inject({method: 'GET', url: '/api/settings/global', headers: authHeaders(adminToken)});
            expect(reread.json().data.roi_settling_days).toBe(30);
        });

        it('non-admin cannot read or change global settings', async () => {
            const get = await app.inject({method: 'GET', url: '/api/settings/global', headers: authHeaders(devToken)});
            const patch = await app.inject({
                method: 'PATCH',
                url: '/api/settings/global',
                headers: authHeaders(devToken),
                payload: {roi_threshold: 1},
            });
            // The session middleware confines developers to /api/me and /api/auth.
            expect(get.statusCode).toBe(403);
            expect(patch.statusCode).toBe(403);
        });
    });

    // Task 6.4 / #173: the two new Phase 6 policy switches flow through the same
    // admin-gated global/team routes; assert they persist, validate, and stay
    // admin-only (non-admins cannot change org policy).
    describe('Phase 6 settings extensions (Task 6.4)', () => {
        it('exposes the new keys with their defaults (opt-out master switch, managers_admins)', async () => {
            const res = await app.inject({method: 'GET', url: '/api/settings/global', headers: authHeaders(adminToken)});
            expect(res.statusCode).toBe(200);
            expect(res.json().data).toMatchObject({
                bestpractices_enabled: true,
                curator_permission: 'managers_admins',
            });
        });

        it('admin can patch both new keys and they persist', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: '/api/settings/global',
                headers: authHeaders(adminToken),
                payload: {bestpractices_enabled: false, curator_permission: 'any_member'},
            });
            expect(res.statusCode).toBe(200);
            const reread = await app.inject({method: 'GET', url: '/api/settings/global', headers: authHeaders(adminToken)});
            expect(reread.json().data.bestpractices_enabled).toBe(false);
            expect(reread.json().data.curator_permission).toBe('any_member');
        });

        it('rejects a curator_permission value outside the allowed enum set', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: '/api/settings/global',
                headers: authHeaders(adminToken),
                payload: {curator_permission: 'everyone'},
            });
            expect(res.statusCode).toBe(400);
        });

        it('a non-admin developer cannot change either org-policy key', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: '/api/settings/global',
                headers: authHeaders(devToken),
                payload: {bestpractices_enabled: false},
            });
            expect(res.statusCode).toBe(403);
            // …and the policy is untouched.
            const reread = await app.inject({method: 'GET', url: '/api/settings/global', headers: authHeaders(adminToken)});
            expect(reread.json().data.bestpractices_enabled).toBe(true);
        });

        it('a per-team override of bestpractices_enabled is gated by coaching_managers_can_override', async () => {
            // Flag off → the team PATCH is rejected as a governed override.
            const blocked = await app.inject({
                method: 'PATCH',
                url: '/api/settings/team/frontend',
                headers: authHeaders(adminToken),
                payload: {bestpractices_enabled: false},
            });
            expect(blocked.statusCode).toBe(403);

            // Enable the governing flag, then the same override is accepted and resolves.
            await app.inject({
                method: 'PATCH',
                url: '/api/settings/global',
                headers: authHeaders(adminToken),
                payload: {coaching_managers_can_override: true},
            });
            const ok = await app.inject({
                method: 'PATCH',
                url: '/api/settings/team/frontend',
                headers: authHeaders(adminToken),
                payload: {bestpractices_enabled: false},
            });
            expect(ok.statusCode).toBe(200);
            expect(ok.json().data.effective.bestpractices_enabled).toBe(false);
        });
    });

    describe('team settings', () => {
        it('rejects a team override when the governing flag is off', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: '/api/settings/team/frontend',
                headers: authHeaders(adminToken),
                payload: {roi_threshold: 7},
            });
            expect(res.statusCode).toBe(403);
            expect(res.json().message).toMatch(/roi_managers_can_override/);
        });

        it('accepts a team override once the flag is enabled and resolves to it', async () => {
            await app.inject({
                method: 'PATCH',
                url: '/api/settings/global',
                headers: authHeaders(adminToken),
                payload: {roi_managers_can_override: true},
            });
            const patch = await app.inject({
                method: 'PATCH',
                url: '/api/settings/team/frontend',
                headers: authHeaders(adminToken),
                payload: {roi_threshold: 7},
            });
            expect(patch.statusCode).toBe(200);
            expect(patch.json().data.effective.roi_threshold).toBe(7);
            expect(patch.json().data.overrides.roi_threshold).toBe(7);

            const get = await app.inject({
                method: 'GET',
                url: '/api/settings/team/frontend',
                headers: authHeaders(adminToken),
            });
            expect(get.json().data.effective.roi_threshold).toBe(7);
            expect(get.json().data.overridable.roi_threshold).toBe(true);
        });

        it('disabling the governing flag discards the team override it gated', async () => {
            // Enable the flag, write a team override, confirm it resolves.
            await app.inject({
                method: 'PATCH',
                url: '/api/settings/global',
                headers: authHeaders(adminToken),
                payload: {roi_managers_can_override: true},
            });
            await app.inject({
                method: 'PATCH',
                url: '/api/settings/team/frontend',
                headers: authHeaders(adminToken),
                payload: {roi_threshold: 7},
            });

            // Turn the flag back off — the override row should be cleared, not dormant.
            await app.inject({
                method: 'PATCH',
                url: '/api/settings/global',
                headers: authHeaders(adminToken),
                payload: {roi_managers_can_override: false},
            });

            // Re-enable: resolution falls back to the global default, not the old override.
            await app.inject({
                method: 'PATCH',
                url: '/api/settings/global',
                headers: authHeaders(adminToken),
                payload: {roi_managers_can_override: true},
            });
            const get = await app.inject({
                method: 'GET',
                url: '/api/settings/team/frontend',
                headers: authHeaders(adminToken),
            });
            expect(get.json().data.overrides.roi_threshold).toBeUndefined();
            expect(get.json().data.effective.roi_threshold).toBe(3.0);
        });

        it('rejects overriding a non-overridable key', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: '/api/settings/team/frontend',
                headers: authHeaders(adminToken),
                payload: {roi_managers_can_override: true},
            });
            expect(res.statusCode).toBe(403);
        });

        it('404 for an unknown team', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/settings/team/nope',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(404);
        });

        it('developer cannot reach team settings', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/settings/team/frontend',
                headers: authHeaders(devToken),
            });
            expect(res.statusCode).toBe(403);
        });
    });

    describe('user preferences', () => {
        it('developer can read and update their own preferences', async () => {
            const get = await app.inject({method: 'GET', url: '/api/me/preferences', headers: authHeaders(devToken)});
            expect(get.statusCode).toBe(200);
            expect(get.json().data).toEqual({default_time_range: '30d', dark_mode: false});

            const patch = await app.inject({
                method: 'PATCH',
                url: '/api/me/preferences',
                headers: authHeaders(devToken),
                payload: {dark_mode: true, default_time_range: '90d'},
            });
            expect(patch.statusCode).toBe(200);
            expect(patch.json().data).toEqual({default_time_range: '90d', dark_mode: true});
        });

        it('rejects an invalid time range', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: '/api/me/preferences',
                headers: authHeaders(devToken),
                payload: {default_time_range: '1y'},
            });
            expect(res.statusCode).toBe(400);
        });

        it('preferences are isolated per user', async () => {
            await app.inject({
                method: 'PATCH',
                url: '/api/me/preferences',
                headers: authHeaders(devToken),
                payload: {dark_mode: true},
            });
            const adminPrefs = await app.inject({
                method: 'GET',
                url: '/api/me/preferences',
                headers: authHeaders(adminToken),
            });
            expect(adminPrefs.json().data.dark_mode).toBe(false);
        });
    });

    // Task 4.12: the enum setting flows through the same flat global/team routes.
    describe('enum setting (anomaly_alert_min_severity)', () => {
        it('admin can patch the enum and it persists; bad value is rejected', async () => {
            const ok = await app.inject({
                method: 'PATCH',
                url: '/api/settings/global',
                headers: authHeaders(adminToken),
                payload: {anomaly_alert_min_severity: 'high'},
            });
            expect(ok.statusCode).toBe(200);
            expect(ok.json().data.anomaly_alert_min_severity).toBe('high');

            const bad = await app.inject({
                method: 'PATCH',
                url: '/api/settings/global',
                headers: authHeaders(adminToken),
                payload: {anomaly_alert_min_severity: 'catastrophic'},
            });
            expect(bad.statusCode).toBe(400);
        });
    });

    // Task 4.12: the structured anomaly config gets its own admin-gated routes.
    describe('anomaly detection config API', () => {
        it('admin reads the effective global config; non-admin is forbidden', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/settings/anomaly',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.engine).toEqual({minBaselinePeriods: 4, statisticalHighZ: 2.5});
            expect(res.json().data.metrics.length).toBeGreaterThan(0);

            const dev = await app.inject({
                method: 'GET',
                url: '/api/settings/anomaly',
                headers: authHeaders(devToken),
            });
            expect(dev.statusCode).toBe(403);
        });

        it('admin patches global metric config + engine params; persists', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: '/api/settings/anomaly',
                headers: authHeaders(adminToken),
                payload: {metrics: {commits: {threshold: 3.5}}, engine: {minBaselinePeriods: 6}},
            });
            expect(res.statusCode).toBe(200);
            const commits = res.json().data.metrics.find((m: {metric: string}) => m.metric === 'commits');
            expect(commits.config.threshold).toBe(3.5);
            expect(res.json().data.engine.minBaselinePeriods).toBe(6);

            const reread = await app.inject({
                method: 'GET',
                url: '/api/settings/anomaly',
                headers: authHeaders(adminToken),
            });
            const c2 = reread.json().data.metrics.find((m: {metric: string}) => m.metric === 'commits');
            expect(c2.config.threshold).toBe(3.5);
        });

        it('rejects an unknown metric, unknown field, and out-of-range value', async () => {
            const unknownMetric = await app.inject({
                method: 'PATCH',
                url: '/api/settings/anomaly',
                headers: authHeaders(adminToken),
                payload: {metrics: {nope: {threshold: 3}}},
            });
            expect(unknownMetric.statusCode).toBe(400);

            const unknownField = await app.inject({
                method: 'PATCH',
                url: '/api/settings/anomaly',
                headers: authHeaders(adminToken),
                payload: {metrics: {commits: {bogus: 1}}},
            });
            expect(unknownField.statusCode).toBe(400);

            const badThreshold = await app.inject({
                method: 'PATCH',
                url: '/api/settings/anomaly',
                headers: authHeaders(adminToken),
                payload: {metrics: {commits: {threshold: 0}}},
            });
            expect(badThreshold.statusCode).toBe(400);
        });

        it('per-team anomaly PATCH is gated by anomaly_managers_can_override', async () => {
            // Flag off → 403.
            const blocked = await app.inject({
                method: 'PATCH',
                url: '/api/settings/anomaly/team/frontend',
                headers: authHeaders(adminToken),
                payload: {metrics: {commits: {threshold: 9}}},
            });
            expect(blocked.statusCode).toBe(403);
            expect(blocked.json().message).toMatch(/anomaly_managers_can_override/);

            // Enable the flag, then the override is accepted and resolves for the team.
            await app.inject({
                method: 'PATCH',
                url: '/api/settings/global',
                headers: authHeaders(adminToken),
                payload: {anomaly_managers_can_override: true},
            });
            const ok = await app.inject({
                method: 'PATCH',
                url: '/api/settings/anomaly/team/frontend',
                headers: authHeaders(adminToken),
                payload: {metrics: {commits: {threshold: 9}}},
            });
            expect(ok.statusCode).toBe(200);
            const commits = ok.json().data.metrics.find((m: {metric: string}) => m.metric === 'commits');
            expect(commits.config.threshold).toBe(9);
            expect(ok.json().data.overridable).toBe(true);
        });

        it('404 for an unknown team', async () => {
            await app.inject({
                method: 'PATCH',
                url: '/api/settings/global',
                headers: authHeaders(adminToken),
                payload: {anomaly_managers_can_override: true},
            });
            const res = await app.inject({
                method: 'GET',
                url: '/api/settings/anomaly/team/ghost-team',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(404);
        });

        it('team GET surfaces raw stored overrides distinct from resolved values', async () => {
            await app.inject({
                method: 'PATCH',
                url: '/api/settings/global',
                headers: authHeaders(adminToken),
                payload: {anomaly_managers_can_override: true},
            });
            await app.inject({
                method: 'PATCH',
                url: '/api/settings/anomaly/team/frontend',
                headers: authHeaders(adminToken),
                payload: {metrics: {commits: {threshold: 9}}},
            });
            const res = await app.inject({
                method: 'GET',
                url: '/api/settings/anomaly/team/frontend',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            // Raw override shows only what the team set; resolved shows the effective value.
            expect(res.json().data.overrides.metrics.commits).toEqual({threshold: 9});
            const commits = res.json().data.metrics.find((m: {metric: string}) => m.metric === 'commits');
            expect(commits.config.threshold).toBe(9);
        });

        it('disabling anomaly_managers_can_override discards structured team overrides (no resurrection)', async () => {
            // Enable, write a team override, confirm it resolves.
            await app.inject({
                method: 'PATCH',
                url: '/api/settings/global',
                headers: authHeaders(adminToken),
                payload: {anomaly_managers_can_override: true},
            });
            await app.inject({
                method: 'PATCH',
                url: '/api/settings/anomaly/team/frontend',
                headers: authHeaders(adminToken),
                payload: {metrics: {commits: {threshold: 9}}, engine: {minBaselinePeriods: 10}},
            });

            // Admin turns the flag off → the structured team rows are discarded.
            await app.inject({
                method: 'PATCH',
                url: '/api/settings/global',
                headers: authHeaders(adminToken),
                payload: {anomaly_managers_can_override: false},
            });

            // Re-enable: resolution falls back to defaults, the old override is gone.
            await app.inject({
                method: 'PATCH',
                url: '/api/settings/global',
                headers: authHeaders(adminToken),
                payload: {anomaly_managers_can_override: true},
            });
            const res = await app.inject({
                method: 'GET',
                url: '/api/settings/anomaly/team/frontend',
                headers: authHeaders(adminToken),
            });
            const commits = res.json().data.metrics.find((m: {metric: string}) => m.metric === 'commits');
            expect(commits.config.threshold).toBe(2.0);
            expect(res.json().data.engine.minBaselinePeriods).toBe(4);
            expect(res.json().data.overrides).toEqual({metrics: {}, engine: {}});
        });
    });

    // Task 5.10 / #131: org coaching policy + developer coaching preferences.
    describe('coaching settings & preferences', () => {
        it('exposes org coaching settings with privacy-safe defaults', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/settings/global',
                headers: authHeaders(adminToken),
            });
            expect(res.json().data).toMatchObject({
                coaching_pillar1_enabled: true,
                coaching_pillar2_enabled: true,
                coaching_capture_permitted: false,
                coaching_cloud_analysis_permitted: false,
                showcase_scope_permitted: 'team_only',
                nudge_default_frequency: 'normal',
            });
        });

        it('a developer cannot change org coaching policy', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: '/api/settings/global',
                headers: authHeaders(devToken),
                payload: {coaching_capture_permitted: true},
            });
            expect(res.statusCode).toBe(403);
            // The global value is untouched.
            const reread = await app.inject({
                method: 'GET',
                url: '/api/settings/global',
                headers: authHeaders(adminToken),
            });
            expect(reread.json().data.coaching_capture_permitted).toBe(false);
        });

        it('a developer reads and writes only their OWN coaching preferences', async () => {
            const get = await app.inject({
                method: 'GET',
                url: '/api/me/coaching-preferences',
                headers: authHeaders(devToken),
            });
            expect(get.statusCode).toBe(200);
            expect(get.json().data.nudges_enabled.value).toBe(true);

            const patch = await app.inject({
                method: 'PATCH',
                url: '/api/me/coaching-preferences',
                headers: authHeaders(devToken),
                payload: {nudges_enabled: false, nudge_frequency: 'high'},
            });
            expect(patch.statusCode).toBe(200);
            expect(patch.json().data.nudges_enabled.stored).toBe(false);
            expect(patch.json().data.nudge_frequency.stored).toBe('high');
        });

        it('a developer opt-in the org forbids is stored but reported blocked', async () => {
            const patch = await app.inject({
                method: 'PATCH',
                url: '/api/me/coaching-preferences',
                headers: authHeaders(devToken),
                payload: {cloud_analysis_opt_in: true},
            });
            expect(patch.statusCode).toBe(200);
            const cloud = patch.json().data.cloud_analysis_opt_in;
            expect(cloud.value).toBe(false); // org forbids → not honored
            expect(cloud.blocked).toBe(true);
            expect(cloud.reason).toMatch(/cloud/i);

            // Admin permits cloud analysis → the developer's stored opt-in takes effect.
            await app.inject({
                method: 'PATCH',
                url: '/api/settings/global',
                headers: authHeaders(adminToken),
                payload: {coaching_cloud_analysis_permitted: true},
            });
            const reread = await app.inject({
                method: 'GET',
                url: '/api/me/coaching-preferences',
                headers: authHeaders(devToken),
            });
            expect(reread.json().data.cloud_analysis_opt_in.value).toBe(true);
            expect(reread.json().data.cloud_analysis_opt_in.blocked).toBe(false);
        });

        it('honors a developer opt-in via the PER-TEAM org boundary, not just the global one', async () => {
            // dev-1 (alice) is seeded on team `frontend` (fixtures). This exercises the
            // full HTTP join developer → team → resolution: the developer's opt-in is
            // forbidden globally but PERMITTED for their team via a per-team override, so
            // resolution must honor the team boundary — proving the route resolves against
            // the developer's actual team, not the global default.
            const dev = await app.inject({
                method: 'PATCH',
                url: '/api/me/coaching-preferences',
                headers: authHeaders(devToken),
                payload: {cloud_analysis_opt_in: true},
            });
            expect(dev.statusCode).toBe(200);
            // Global forbids cloud analysis → blocked while only the global default applies.
            expect(dev.json().data.cloud_analysis_opt_in.value).toBe(false);
            expect(dev.json().data.cloud_analysis_opt_in.blocked).toBe(true);

            // Admin enables per-team overrides, then permits cloud analysis for `frontend`
            // ONLY — the global default stays false.
            await app.inject({
                method: 'PATCH',
                url: '/api/settings/global',
                headers: authHeaders(adminToken),
                payload: {coaching_managers_can_override: true},
            });
            const teamPatch = await app.inject({
                method: 'PATCH',
                url: '/api/settings/team/frontend',
                headers: authHeaders(adminToken),
                payload: {coaching_cloud_analysis_permitted: true},
            });
            expect(teamPatch.statusCode).toBe(200);

            // The developer (on frontend) now resolves to honored — proving resolution
            // used the TEAM boundary, since the global permission is still false.
            const reread = await app.inject({
                method: 'GET',
                url: '/api/me/coaching-preferences',
                headers: authHeaders(devToken),
            });
            expect(reread.json().data.cloud_analysis_opt_in.value).toBe(true);
            expect(reread.json().data.cloud_analysis_opt_in.blocked).toBe(false);

            // Confirm the global default genuinely remained false (not silently flipped),
            // so the honored value above can only have come from the team override.
            const global = await app.inject({
                method: 'GET',
                url: '/api/settings/global',
                headers: authHeaders(adminToken),
            });
            expect(global.json().data.coaching_cloud_analysis_permitted).toBe(false);
        });

        it('a blocked capture enum resolves to its neutral value, never the developer\'s stored choice', async () => {
            // With capture forbidden org-wide (default), a stored mechanism/recovery choice
            // must not leak through as the effective value — it collapses to the neutral
            // default so no consumer acts on a real capture mechanism while capture is off.
            const patch = await app.inject({
                method: 'PATCH',
                url: '/api/me/coaching-preferences',
                headers: authHeaders(devToken),
                payload: {capture_mechanism: 'editor_extension', capture_recovery_choice: 'recovery_path'},
            });
            expect(patch.statusCode).toBe(200);
            const mech = patch.json().data.capture_mechanism;
            const rec = patch.json().data.capture_recovery_choice;
            // Stored carries the developer's choice; the effective value is the safe default.
            expect(mech.stored).toBe('editor_extension');
            expect(mech.blocked).toBe(true);
            expect(mech.value).toBe('local_agent');
            expect(rec.stored).toBe('recovery_path');
            expect(rec.blocked).toBe(true);
            expect(rec.value).toBe('no_recovery');
        });

        it('rejects an unknown coaching preference key', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: '/api/me/coaching-preferences',
                headers: authHeaders(devToken),
                payload: {not_a_pref: true},
            });
            expect(res.statusCode).toBe(400);
        });

        it('an admin without a developer profile gets 404 on coaching preferences', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/me/coaching-preferences',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(404);
        });

        it('disabling pillar 2 org-wide hides the developer PR-coaching surface', async () => {
            // Enabled by default → the surface reports enabled.
            const before = await app.inject({
                method: 'GET',
                url: '/api/me/pr-coaching',
                headers: authHeaders(devToken),
            });
            expect(before.json().data.enabled).toBe(true);

            await app.inject({
                method: 'PATCH',
                url: '/api/settings/global',
                headers: authHeaders(adminToken),
                payload: {coaching_pillar2_enabled: false},
            });

            const after = await app.inject({
                method: 'GET',
                url: '/api/me/pr-coaching',
                headers: authHeaders(devToken),
            });
            expect(after.json().data.enabled).toBe(false);
            expect(after.json().data.all_pr).toBeUndefined();
        });
    });
});
