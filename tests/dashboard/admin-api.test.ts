import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {makeTestDb, seedFixtures} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerMeRoutes} from '../../src/dashboard/api/me';
import {registerAdminRoutes} from '../../src/dashboard/api/admin';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';

const PASSWORD = 'correct-horse-battery';

async function buildApp(db: Database.Database): Promise<FastifyInstance> {
    const app = Fastify({logger: false});
    registerSessionAuth(app, db);
    registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
    registerMeRoutes(app, db);
    registerAdminRoutes(app, db);
    await app.ready();
    return app;
}

function cookieToken(res: {headers: Record<string, unknown>}): string {
    const raw = res.headers['set-cookie'];
    const header = Array.isArray(raw) ? raw[0] : (raw as string);
    const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header);
    return match ? decodeURIComponent(match[1]) : '';
}

async function login(app: FastifyInstance, email: string, password = PASSWORD): Promise<{status: number; token: string}> {
    const res = await app.inject({method: 'POST', url: '/api/auth/login', payload: {email, password}});
    return {status: res.statusCode, token: res.statusCode === 200 ? cookieToken(res) : ''};
}

function authHeaders(token: string): Record<string, string> {
    return {cookie: `${SESSION_COOKIE}=${token}`};
}

describe('admin API', () => {
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
        adminToken = (await login(app, 'admin@test.com')).token;
        devToken = (await login(app, 'alice@test.com')).token;
    });

    afterEach(async () => {
        await app.close();
        db.close();
    });

    describe('role enforcement (403 for developers)', () => {
        const endpoints: {method: 'GET' | 'POST' | 'PATCH'; url: string}[] = [
            {method: 'GET', url: '/api/admin/users'},
            {method: 'POST', url: '/api/admin/users'},
            {method: 'GET', url: '/api/admin/teams'},
            {method: 'POST', url: '/api/admin/teams'},
            {method: 'GET', url: '/api/admin/developers'},
            {method: 'PATCH', url: '/api/admin/developers/dev-1/identities'},
            {method: 'GET', url: '/api/admin/subscriptions'},
            {method: 'POST', url: '/api/admin/subscriptions'},
            {method: 'GET', url: '/api/admin/data-sources'},
        ];

        it('rejects every admin endpoint for a developer session', async () => {
            for (const ep of endpoints) {
                const res = await app.inject({
                    method: ep.method,
                    url: ep.url,
                    headers: authHeaders(devToken),
                    payload: ep.method === 'GET' ? undefined : {},
                });
                expect(res.statusCode, `${ep.method} ${ep.url}`).toBe(403);
            }
        });
    });

    describe('users', () => {
        it('creates a user with a one-time temp password and forced reset', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/users',
                headers: authHeaders(adminToken),
                payload: {email: 'New.User@test.com', role: 'developer', developer_id: 'dev-3'},
            });
            expect(res.statusCode).toBe(201);
            const data = res.json().data;
            expect(data.temp_password).toBeTruthy();
            expect(data.must_change_password).toBe(true);
            expect(data.email).toBe('new.user@test.com'); // normalized
            expect(data.developer_name).toBe('Carol Dev');
            expect(data.password_hash).toBeUndefined();
        });

        it('rejects a duplicate email with 409', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/users',
                headers: authHeaders(adminToken),
                payload: {email: 'admin@test.com', role: 'admin'},
            });
            expect(res.statusCode).toBe(409);
        });

        it('rejects linking a developer already linked to another user (409)', async () => {
            // alice@test.com is already linked to dev-1 in beforeEach.
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/users',
                headers: authHeaders(adminToken),
                payload: {email: 'second@test.com', role: 'developer', developer_id: 'dev-1'},
            });
            expect(res.statusCode).toBe(409);
        });

        it('rejects re-linking a taken developer on update, but allows the same user to keep its link', async () => {
            const hash = await hashPassword(PASSWORD);
            const u = createUser(db, {email: 'free@test.com', passwordHash: hash, role: 'developer'});
            // dev-1 is taken by alice → 409.
            const taken = await app.inject({
                method: 'PATCH',
                url: `/api/admin/users/${u.id}`,
                headers: authHeaders(adminToken),
                payload: {developer_id: 'dev-1'},
            });
            expect(taken.statusCode).toBe(409);
            // dev-3 is free → ok.
            const ok = await app.inject({
                method: 'PATCH',
                url: `/api/admin/users/${u.id}`,
                headers: authHeaders(adminToken),
                payload: {developer_id: 'dev-3'},
            });
            expect(ok.statusCode).toBe(200);
            expect(ok.json().data.developer_id).toBe('dev-3');
        });

        it('rejects an invalid role', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/users',
                headers: authHeaders(adminToken),
                payload: {email: 'x@test.com', role: 'superuser'},
            });
            expect(res.statusCode).toBe(400);
        });

        it('list never leaks password hashes', async () => {
            const res = await app.inject({method: 'GET', url: '/api/admin/users', headers: authHeaders(adminToken)});
            expect(res.statusCode).toBe(200);
            for (const u of res.json().data) {
                expect(u.password_hash).toBeUndefined();
            }
        });

        it('deactivating prevents login but preserves the linked developer and subscription', async () => {
            const hash = await hashPassword(PASSWORD);
            const victim = createUser(db, {
                email: 'victim@test.com',
                passwordHash: hash,
                role: 'developer',
                developerId: 'dev-2',
            });
            // Login works before deactivation.
            expect((await login(app, 'victim@test.com')).status).toBe(200);

            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/users/${victim.id}`,
                headers: authHeaders(adminToken),
                payload: {active: false},
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.active).toBe(false);

            // Login now fails.
            expect((await login(app, 'victim@test.com')).status).toBe(401);
            // Historical data preserved: the developer row and its subscription remain.
            expect(db.prepare('SELECT 1 FROM developers WHERE id = ?').get('dev-2')).toBeTruthy();
            expect(db.prepare('SELECT 1 FROM subscriptions WHERE id = ?').get('sub-2')).toBeTruthy();
        });

        it('reactivates a deactivated user', async () => {
            const hash = await hashPassword(PASSWORD);
            const u = createUser(db, {email: 'back@test.com', passwordHash: hash, role: 'developer'});
            await app.inject({
                method: 'PATCH',
                url: `/api/admin/users/${u.id}`,
                headers: authHeaders(adminToken),
                payload: {active: false},
            });
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/users/${u.id}`,
                headers: authHeaders(adminToken),
                payload: {active: true},
            });
            expect(res.json().data.active).toBe(true);
            expect((await login(app, 'back@test.com')).status).toBe(200);
        });

        it('reset-password returns a new temp password and forces a change', async () => {
            const users = (await app.inject({method: 'GET', url: '/api/admin/users', headers: authHeaders(adminToken)})).json().data;
            const alice = users.find((u: {email: string}) => u.email === 'alice@test.com');
            const res = await app.inject({
                method: 'POST',
                url: `/api/admin/users/${alice.id}/reset-password`,
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.temp_password).toBeTruthy();
            // Old session is invalidated and a forced reset is now required.
            const after = await app.inject({method: 'GET', url: '/api/auth/me', headers: authHeaders(devToken)});
            expect(after.statusCode).toBe(401);
        });

        it('refuses to deactivate the last active admin', async () => {
            const users = (await app.inject({method: 'GET', url: '/api/admin/users', headers: authHeaders(adminToken)})).json().data;
            const admin = users.find((u: {email: string}) => u.email === 'admin@test.com');
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/users/${admin.id}`,
                headers: authHeaders(adminToken),
                payload: {active: false},
            });
            expect(res.statusCode).toBe(409);
        });

        it('refuses to demote the last active admin', async () => {
            const users = (await app.inject({method: 'GET', url: '/api/admin/users', headers: authHeaders(adminToken)})).json().data;
            const admin = users.find((u: {email: string}) => u.email === 'admin@test.com');
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/users/${admin.id}`,
                headers: authHeaders(adminToken),
                payload: {role: 'developer'},
            });
            expect(res.statusCode).toBe(409);
        });
    });

    describe('teams', () => {
        it('creates, lists, updates, archives and restores a team', async () => {
            const create = await app.inject({
                method: 'POST',
                url: '/api/admin/teams',
                headers: authHeaders(adminToken),
                payload: {name: 'platform', department: 'eng', manager: 'm@test.com'},
            });
            expect(create.statusCode).toBe(201);
            expect(create.json().data.developer_count).toBe(0);

            const update = await app.inject({
                method: 'PATCH',
                url: '/api/admin/teams/platform',
                headers: authHeaders(adminToken),
                payload: {manager: 'newmgr@test.com'},
            });
            expect(update.json().data.manager).toBe('newmgr@test.com');
            expect(update.json().data.department).toBe('eng'); // untouched

            const archive = await app.inject({
                method: 'PATCH',
                url: '/api/admin/teams/platform',
                headers: authHeaders(adminToken),
                payload: {archived: true},
            });
            expect(archive.json().data.archived_at).toBeTruthy();

            // Admin list still includes archived teams.
            const list = (await app.inject({method: 'GET', url: '/api/admin/teams', headers: authHeaders(adminToken)})).json().data;
            expect(list.some((t: {name: string}) => t.name === 'platform')).toBe(true);

            const restore = await app.inject({
                method: 'PATCH',
                url: '/api/admin/teams/platform',
                headers: authHeaders(adminToken),
                payload: {archived: false},
            });
            expect(restore.json().data.archived_at).toBeNull();
        });

        it('rejects a duplicate team name', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/teams',
                headers: authHeaders(adminToken),
                payload: {name: 'frontend'},
            });
            expect(res.statusCode).toBe(409);
        });

        it('rejects a non-string field with 400 instead of silently dropping it', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: '/api/admin/teams/frontend',
                headers: authHeaders(adminToken),
                payload: {department: 42},
            });
            expect(res.statusCode).toBe(400);
        });

        it('404 when patching an unknown team', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: '/api/admin/teams/ghost',
                headers: authHeaders(adminToken),
                payload: {department: 'x'},
            });
            expect(res.statusCode).toBe(404);
        });

        it('reports the developer count', async () => {
            const list = (await app.inject({method: 'GET', url: '/api/admin/teams', headers: authHeaders(adminToken)})).json().data;
            const frontend = list.find((t: {name: string}) => t.name === 'frontend');
            expect(frontend.developer_count).toBe(2); // dev-1, dev-3
        });
    });

    describe('developers', () => {
        it('updates identities (external_ids + git emails)', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: '/api/admin/developers/dev-1/identities',
                headers: authHeaders(adminToken),
                payload: {
                    copilot: 'alice-gh',
                    bitbucket: 'alice-bb',
                    git_emails: ['Alice@Work.com', 'alice@personal.com', 'alice@work.com'],
                },
            });
            expect(res.statusCode).toBe(200);
            const ext = res.json().data.external_ids;
            expect(ext.copilot).toBe('alice-gh');
            expect(ext.bitbucket).toBe('alice-bb');
            // Deduped + lowercased.
            expect(ext.git_emails).toBe('alice@work.com,alice@personal.com');
        });

        it('clears a field when an empty value is sent', async () => {
            await app.inject({
                method: 'PATCH',
                url: '/api/admin/developers/dev-1/identities',
                headers: authHeaders(adminToken),
                payload: {github: 'gh-handle'},
            });
            const res = await app.inject({
                method: 'PATCH',
                url: '/api/admin/developers/dev-1/identities',
                headers: authHeaders(adminToken),
                payload: {github: ''},
            });
            expect(res.json().data.external_ids.github).toBeUndefined();
        });

        it('rejects a git identity already mapped to another developer', async () => {
            await app.inject({
                method: 'PATCH',
                url: '/api/admin/developers/dev-1/identities',
                headers: authHeaders(adminToken),
                payload: {github: 'shared-handle'},
            });
            const res = await app.inject({
                method: 'PATCH',
                url: '/api/admin/developers/dev-2/identities',
                headers: authHeaders(adminToken),
                payload: {github: 'shared-handle'},
            });
            expect(res.statusCode).toBe(409);
        });

        it('moves a developer to another team', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: '/api/admin/developers/dev-1',
                headers: authHeaders(adminToken),
                payload: {team: 'backend'},
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.team).toBe('backend');
        });

        it('rejects a move to a non-existent team', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: '/api/admin/developers/dev-1',
                headers: authHeaders(adminToken),
                payload: {team: 'nope'},
            });
            expect(res.statusCode).toBe(400);
        });
    });

    describe('subscriptions', () => {
        it('assigns a new subscription', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/subscriptions',
                headers: authHeaders(adminToken),
                payload: {developer_id: 'dev-3', tool: 'windsurf', plan: 'teams', monthly_cost: 15},
            });
            expect(res.statusCode).toBe(201);
            expect(res.json().data.tool).toBe('windsurf');
            expect(res.json().data.data_source).toBe('admin');
        });

        it('changing a plan revokes the old seat and opens a new one (lifecycle, not overwrite)', async () => {
            // dev-1 has sub-1 (copilot business, $19) from the fixtures.
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/subscriptions',
                headers: authHeaders(adminToken),
                payload: {developer_id: 'dev-1', tool: 'copilot', plan: 'enterprise', monthly_cost: 39},
            });
            expect(res.statusCode).toBe(201);

            // Old seat is revoked, exactly one active seat remains, and a
            // plan_change_event was recorded.
            const rows = db
                .prepare('SELECT plan, seat_revoked_at FROM subscriptions WHERE developer_id = ? AND tool = ?')
                .all('dev-1', 'copilot') as {plan: string; seat_revoked_at: string | null}[];
            expect(rows.length).toBe(2);
            const active = rows.filter((r) => r.seat_revoked_at === null);
            expect(active.length).toBe(1);
            expect(active[0].plan).toBe('enterprise');
            const events = db
                .prepare('SELECT 1 FROM plan_change_events WHERE developer_id = ? AND tool = ?')
                .all('dev-1', 'copilot');
            expect(events.length).toBe(1);
        });

        it('normalizes the tool key so a case variant maps to the same active seat', async () => {
            // dev-1 already has an active 'copilot' seat (sub-1). Posting 'COPILOT'
            // with the same plan/cost must resolve to that one seat, not open a
            // second — the response tool is lowercased and there is one active seat.
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/subscriptions',
                headers: authHeaders(adminToken),
                payload: {developer_id: 'dev-1', tool: 'COPILOT', plan: 'business', monthly_cost: 19},
            });
            expect(res.statusCode).toBe(201);
            expect(res.json().data.tool).toBe('copilot');
            const active = db
                .prepare(
                    'SELECT COUNT(*) AS cnt FROM subscriptions WHERE developer_id = ? AND tool = ? AND seat_revoked_at IS NULL',
                )
                .get('dev-1', 'copilot') as {cnt: number};
            expect(active.cnt).toBe(1);
        });

        it('returns the joined developer shape on assign', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/subscriptions',
                headers: authHeaders(adminToken),
                payload: {developer_id: 'dev-3', tool: 'windsurf', monthly_cost: 15},
            });
            expect(res.json().data.developer_name).toBe('Carol Dev');
            expect(res.json().data.team).toBe('frontend');
        });

        it('ends an active subscription by revoking the seat (row preserved)', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: '/api/admin/subscriptions/sub-1',
                headers: authHeaders(adminToken),
                payload: {active: false},
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.seat_revoked_at).toBeTruthy();
            // Row still exists.
            expect(db.prepare('SELECT 1 FROM subscriptions WHERE id = ?').get('sub-1')).toBeTruthy();
        });

        it('rejects a negative monthly cost', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/subscriptions',
                headers: authHeaders(adminToken),
                payload: {developer_id: 'dev-1', tool: 'cursor', monthly_cost: -5},
            });
            expect(res.statusCode).toBe(400);
        });
    });

    describe('data sources', () => {
        it('reports connector and git provider status', async () => {
            const res = await app.inject({method: 'GET', url: '/api/admin/data-sources', headers: authHeaders(adminToken)});
            expect(res.statusCode).toBe(200);
            const data = res.json().data;
            expect(Array.isArray(data.connectors)).toBe(true);
            expect(Array.isArray(data.git_providers)).toBe(true);
            // The three known connectors are always reported.
            expect(data.connectors.map((c: {connector: string}) => c.connector)).toEqual(
                expect.arrayContaining(['copilot', 'claude_code', 'windsurf']),
            );
        });
    });
});
