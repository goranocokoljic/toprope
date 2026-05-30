import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {makeTestDb, seedFixtures} from '../dashboard/fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerMeRoutes} from '../../src/dashboard/api/me';
import {registerOverviewRoutes} from '../../src/dashboard/api/overview';
import {registerDeveloperRoutes} from '../../src/dashboard/api/developers';
import {createUser, deactivateUser} from '../../src/auth/users';
import {createSession} from '../../src/auth/sessions';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';
import type {RateLimitOptions} from '../../src/auth/rate-limit';

const PASSWORD = 'correct-horse-battery';

async function buildAuthApp(
    db: Database.Database,
    loginRateLimit?: RateLimitOptions,
): Promise<FastifyInstance> {
    const app = Fastify({logger: false});
    registerSessionAuth(app, db);
    app.get('/health', async () => ({status: 'ok'}));
    registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false, loginRateLimit});
    registerMeRoutes(app, db);
    registerOverviewRoutes(app, db);
    registerDeveloperRoutes(app, db);
    await app.ready();
    return app;
}

// Pull the session token out of a Set-Cookie response header.
function cookieToken(res: {headers: Record<string, unknown>}): string {
    const raw = res.headers['set-cookie'];
    const header = Array.isArray(raw) ? raw[0] : (raw as string);
    const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header);
    return match ? decodeURIComponent(match[1]) : '';
}

async function seedUsers(db: Database.Database): Promise<void> {
    const hash = await hashPassword(PASSWORD);
    createUser(db, {email: 'admin@test.com', passwordHash: hash, role: 'admin'});
    createUser(db, {
        email: 'alice@test.com',
        passwordHash: hash,
        role: 'developer',
        developerId: 'dev-1',
    });
    createUser(db, {
        email: 'bob@test.com',
        passwordHash: hash,
        role: 'developer',
        developerId: 'dev-2',
    });
}

async function login(app: FastifyInstance, email: string): Promise<string> {
    const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {email, password: PASSWORD},
    });
    expect(res.statusCode).toBe(200);
    return cookieToken(res);
}

function authHeaders(token: string): Record<string, string> {
    return {cookie: `${SESSION_COOKIE}=${token}`};
}

describe('auth integration', () => {
    let db: Database.Database;
    let app: FastifyInstance;

    beforeEach(async () => {
        db = makeTestDb();
        seedFixtures(db);
        await seedUsers(db);
        app = await buildAuthApp(db);
    });

    afterEach(async () => {
        await app.close();
        db.close();
    });

    describe('login', () => {
        it('rejects wrong credentials with a generic 401 (no enumeration)', async () => {
            const wrongPw = await app.inject({
                method: 'POST',
                url: '/api/auth/login',
                payload: {email: 'admin@test.com', password: 'nope'},
            });
            const unknownUser = await app.inject({
                method: 'POST',
                url: '/api/auth/login',
                payload: {email: 'ghost@test.com', password: 'nope'},
            });
            expect(wrongPw.statusCode).toBe(401);
            expect(unknownUser.statusCode).toBe(401);
            // Identical generic message whether or not the email exists, so the
            // response can't be used to tell which accounts are real.
            expect(wrongPw.json().message).toBe(unknownUser.json().message);
            expect(wrongPw.json().message).not.toMatch(/not found|incorrect password|no such/i);
        });

        it('accepts correct credentials and sets an HttpOnly session cookie', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/auth/login',
                payload: {email: 'admin@test.com', password: PASSWORD},
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.role).toBe('admin');
            const setCookie = res.headers['set-cookie'] as string;
            expect(setCookie).toContain(`${SESSION_COOKIE}=`);
            expect(setCookie).toContain('HttpOnly');
            expect(setCookie).toContain('SameSite=Lax');
        });
    });

    describe('protection', () => {
        it('rejects unauthenticated API requests with 401', async () => {
            const res = await app.inject({method: 'GET', url: '/api/overview'});
            expect(res.statusCode).toBe(401);
        });

        it('health stays public', async () => {
            const res = await app.inject({method: 'GET', url: '/health'});
            expect(res.statusCode).toBe(200);
        });
    });

    describe('role enforcement', () => {
        it('admin can reach admin-only endpoints', async () => {
            const token = await login(app, 'admin@test.com');
            const res = await app.inject({
                method: 'GET',
                url: '/api/overview',
                headers: authHeaders(token),
            });
            expect(res.statusCode).toBe(200);
        });

        it('developer is denied admin-only endpoints with 403', async () => {
            const token = await login(app, 'alice@test.com');
            const overview = await app.inject({
                method: 'GET',
                url: '/api/overview',
                headers: authHeaders(token),
            });
            expect(overview.statusCode).toBe(403);
        });
    });

    describe('cross-developer access prevention', () => {
        it('a developer sees only their own data on /api/me/profile', async () => {
            const token = await login(app, 'alice@test.com');
            const res = await app.inject({
                method: 'GET',
                url: '/api/me/profile',
                headers: authHeaders(token),
            });
            expect(res.statusCode).toBe(200);
            // alice → dev-1, never dev-2
            expect(res.json().data.id).toBe('dev-1');
            expect(res.json().data.name).toBe('Alice Dev');
        });

        it('a developer cannot read another developer by passing their id', async () => {
            const token = await login(app, 'alice@test.com');
            // alice (dev-1) tries to read bob (dev-2) via the admin route param.
            const res = await app.inject({
                method: 'GET',
                url: '/api/developers/dev-2',
                headers: authHeaders(token),
            });
            // Blocked outright — the admin route is not reachable by developers.
            expect(res.statusCode).toBe(403);
        });

        it('each developer session resolves to its own linked developer', async () => {
            const aliceToken = await login(app, 'alice@test.com');
            const bobToken = await login(app, 'bob@test.com');

            const alice = await app.inject({
                method: 'GET',
                url: '/api/me/profile',
                headers: authHeaders(aliceToken),
            });
            const bob = await app.inject({
                method: 'GET',
                url: '/api/me/profile',
                headers: authHeaders(bobToken),
            });
            expect(alice.json().data.id).toBe('dev-1');
            expect(bob.json().data.id).toBe('dev-2');
        });
    });

    describe('first-login password change', () => {
        beforeEach(async () => {
            const hash = await hashPassword(PASSWORD);
            createUser(db, {
                email: 'newadmin@test.com',
                passwordHash: hash,
                role: 'admin',
                mustChangePassword: true,
            });
        });

        it('forces a password change before any other action', async () => {
            const token = await login(app, 'newadmin@test.com');
            const blocked = await app.inject({
                method: 'GET',
                url: '/api/overview',
                headers: authHeaders(token),
            });
            expect(blocked.statusCode).toBe(403);
            expect(blocked.json().code).toBe('password_change_required');
        });

        it('allows access after the password is changed', async () => {
            const token = await login(app, 'newadmin@test.com');
            const change = await app.inject({
                method: 'POST',
                url: '/api/auth/change-password',
                headers: authHeaders(token),
                payload: {current_password: PASSWORD, new_password: 'brand-new-pass-1'},
            });
            expect(change.statusCode).toBe(200);
            const newToken = cookieToken(change);
            const after = await app.inject({
                method: 'GET',
                url: '/api/overview',
                headers: authHeaders(newToken),
            });
            expect(after.statusCode).toBe(200);
        });
    });

    describe('change-password', () => {
        it('rejects a wrong current password', async () => {
            const token = await login(app, 'admin@test.com');
            const res = await app.inject({
                method: 'POST',
                url: '/api/auth/change-password',
                headers: authHeaders(token),
                payload: {current_password: 'wrong', new_password: 'a-good-new-one'},
            });
            expect(res.statusCode).toBe(401);
        });

        it('rejects a weak new password', async () => {
            const token = await login(app, 'admin@test.com');
            const res = await app.inject({
                method: 'POST',
                url: '/api/auth/change-password',
                headers: authHeaders(token),
                payload: {current_password: PASSWORD, new_password: 'short'},
            });
            expect(res.statusCode).toBe(400);
        });

        it('rotates sessions: the old token stops working after a change', async () => {
            const token = await login(app, 'admin@test.com');
            await app.inject({
                method: 'POST',
                url: '/api/auth/change-password',
                headers: authHeaders(token),
                payload: {current_password: PASSWORD, new_password: 'a-good-new-one'},
            });
            const res = await app.inject({
                method: 'GET',
                url: '/api/overview',
                headers: authHeaders(token),
            });
            expect(res.statusCode).toBe(401);
        });
    });

    describe('deactivation', () => {
        it('revokes a live session when the user is deactivated', async () => {
            const token = await login(app, 'alice@test.com');
            // Confirm the session works first.
            const before = await app.inject({
                method: 'GET',
                url: '/api/me/profile',
                headers: authHeaders(token),
            });
            expect(before.statusCode).toBe(200);

            const user = db
                .prepare('SELECT id FROM users WHERE email = ?')
                .get('alice@test.com') as {id: string};
            deactivateUser(db, user.id);

            const after = await app.inject({
                method: 'GET',
                url: '/api/me/profile',
                headers: authHeaders(token),
            });
            expect(after.statusCode).toBe(401);
        });
    });

    describe('developer with no linked profile', () => {
        it('returns 404 (no leak) when the session has no developer_id', async () => {
            const hash = await hashPassword(PASSWORD);
            // A developer-role account whose developer link is null — e.g. after
            // the linked developer was removed (FK SET NULL).
            createUser(db, {
                email: 'unlinked@test.com',
                passwordHash: hash,
                role: 'developer',
                developerId: null,
            });
            const token = await login(app, 'unlinked@test.com');
            const res = await app.inject({
                method: 'GET',
                url: '/api/me/profile',
                headers: authHeaders(token),
            });
            expect(res.statusCode).toBe(404);
        });
    });

    describe('input limits and rate limiting', () => {
        it('rejects oversized credentials with 400', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/auth/login',
                payload: {email: 'a'.repeat(400) + '@test.com', password: PASSWORD},
            });
            expect(res.statusCode).toBe(400);
        });

        it('throttles repeated failed logins with 429', async () => {
            const limitedApp = await buildAuthApp(db, {maxAttempts: 3, windowMs: 60_000});
            try {
                for (let i = 0; i < 3; i++) {
                    const fail = await limitedApp.inject({
                        method: 'POST',
                        url: '/api/auth/login',
                        payload: {email: 'admin@test.com', password: 'wrong'},
                    });
                    expect(fail.statusCode).toBe(401);
                }
                const blocked = await limitedApp.inject({
                    method: 'POST',
                    url: '/api/auth/login',
                    payload: {email: 'admin@test.com', password: PASSWORD},
                });
                expect(blocked.statusCode).toBe(429);
            } finally {
                await limitedApp.close();
            }
        });

        it('a successful login resets the failure counter', async () => {
            const limitedApp = await buildAuthApp(db, {maxAttempts: 3, windowMs: 60_000});
            try {
                for (let i = 0; i < 2; i++) {
                    await limitedApp.inject({
                        method: 'POST',
                        url: '/api/auth/login',
                        payload: {email: 'admin@test.com', password: 'wrong'},
                    });
                }
                const ok = await limitedApp.inject({
                    method: 'POST',
                    url: '/api/auth/login',
                    payload: {email: 'admin@test.com', password: PASSWORD},
                });
                expect(ok.statusCode).toBe(200);
                // Counter reset → another wrong attempt is still allowed (401, not 429).
                const fail = await limitedApp.inject({
                    method: 'POST',
                    url: '/api/auth/login',
                    payload: {email: 'admin@test.com', password: 'wrong'},
                });
                expect(fail.statusCode).toBe(401);
            } finally {
                await limitedApp.close();
            }
        });
    });

    describe('logout and expiry', () => {
        it('invalidates the session on logout', async () => {
            const token = await login(app, 'admin@test.com');
            const logout = await app.inject({
                method: 'POST',
                url: '/api/auth/logout',
                headers: authHeaders(token),
            });
            expect(logout.statusCode).toBe(200);
            const after = await app.inject({
                method: 'GET',
                url: '/api/overview',
                headers: authHeaders(token),
            });
            expect(after.statusCode).toBe(401);
        });

        it('rejects an expired session', async () => {
            const user = createUser(db, {
                email: 'expired@test.com',
                passwordHash: await hashPassword(PASSWORD),
                role: 'admin',
            });
            const expired = createSession(db, user.id, -1);
            const res = await app.inject({
                method: 'GET',
                url: '/api/overview',
                headers: authHeaders(expired.id),
            });
            expect(res.statusCode).toBe(401);
        });
    });

    describe('GET /api/auth/me', () => {
        it('returns the current session identity', async () => {
            const token = await login(app, 'alice@test.com');
            const res = await app.inject({
                method: 'GET',
                url: '/api/auth/me',
                headers: authHeaders(token),
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data).toMatchObject({
                email: 'alice@test.com',
                role: 'developer',
                developer_id: 'dev-1',
                must_change_password: false,
            });
        });
    });
});
