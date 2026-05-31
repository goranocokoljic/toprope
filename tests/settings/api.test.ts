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
});
