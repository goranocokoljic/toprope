import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {
    makeIntegrationDb,
    buildFullApp,
    createAccount,
    login,
    authHeaders,
    seedWmgDataset,
} from './harness';

/**
 * Task 2.12 — Cross-role isolation (SECURITY-CRITICAL).
 *
 * Verifies the two privacy guarantees the product rests on:
 *   1. A developer cannot reach any manager/admin screen or endpoint (403).
 *   2. A developer cannot read another developer's data — every /api/me/*
 *      response is scoped to the session's own developer, no matter what id is
 *      passed.
 * Plus: unauthenticated requests are rejected (401) everywhere under /api
 * except the public login route.
 */
describe('Integration (2.12): cross-role isolation', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let amyToken: string;
    let benToken: string;
    let managerToken: string;

    // Every manager/admin endpoint a developer must NOT reach.
    const MANAGER_GET = [
        '/api/overview',
        '/api/overview/trend?range=30d',
        '/api/teams',
        '/api/teams/frontend',
        '/api/teams/frontend/trend?range=30d',
        '/api/teams/frontend/providers',
        '/api/developers/amy',
        '/api/developers/amy/timeline',
        '/api/waste',
        '/api/waste/summary',
        '/api/waste/resolved',
        '/api/tools/distribution',
        '/api/coverage',
        '/api/snapshots',
        '/api/export',
        '/api/settings/global',
        '/api/settings/team/frontend',
        '/api/leaderboard/frontend',
        '/api/admin/users',
        '/api/admin/teams',
        '/api/admin/developers',
        '/api/admin/subscriptions',
        '/api/admin/data-sources',
    ];

    beforeEach(async () => {
        db = makeIntegrationDb();
        seedWmgDataset(db);
        await createAccount(db, {email: 'amy@wmg.test', role: 'developer', developerId: 'amy'});
        await createAccount(db, {email: 'ben@wmg.test', role: 'developer', developerId: 'ben'});
        await createAccount(db, {email: 'manager@wmg.test', role: 'admin'});
        app = await buildFullApp(db);
        amyToken = await login(app, 'amy@wmg.test');
        benToken = await login(app, 'ben@wmg.test');
        managerToken = await login(app, 'manager@wmg.test');
    });

    afterEach(async () => {
        await app.close();
        db.close();
    });

    // NOTE: isolation is enforced by a single central guard — the onRequest hook
    // in src/auth/middleware.ts confines developers to /api/me + /api/auth and
    // 403s any other /api/* path BEFORE the route handler runs. So these lists do
    // not need to be exhaustive for correctness (a new admin route is auto-covered
    // by the same guard); they are a broad, representative regression net that
    // would also catch a future move to per-route guards leaving a route exposed.
    it('rejects every manager/admin endpoint for a developer session with 403', async () => {
        for (const url of MANAGER_GET) {
            const res = await app.inject({method: 'GET', url, headers: authHeaders(amyToken)});
            expect(res.statusCode, `GET ${url}`).toBe(403);
        }
    });

    it('rejects admin/manager write endpoints for a developer session with 403', async () => {
        const writes: Array<{method: 'POST' | 'PATCH'; url: string}> = [
            {method: 'POST', url: '/api/admin/users'},
            {method: 'PATCH', url: '/api/admin/users/some-id'},
            {method: 'POST', url: '/api/admin/users/some-id/reset-password'},
            {method: 'POST', url: '/api/admin/teams'},
            {method: 'PATCH', url: '/api/admin/teams/frontend'},
            {method: 'POST', url: '/api/admin/subscriptions'},
            {method: 'PATCH', url: '/api/admin/subscriptions/some-id'},
            {method: 'PATCH', url: '/api/admin/developers/amy'},
            {method: 'PATCH', url: '/api/admin/developers/amy/identities'},
            {method: 'PATCH', url: '/api/settings/global'},
            {method: 'PATCH', url: '/api/settings/team/frontend'},
            {method: 'POST', url: '/api/waste/some-id/resolve'},
        ];
        for (const {method, url} of writes) {
            const res = await app.inject({method, url, headers: authHeaders(amyToken), payload: {}});
            expect(res.statusCode, `${method} ${url}`).toBe(403);
        }
    });

    it('grants the same manager endpoints to an admin session (the guard is role-based, not blanket)', async () => {
        // Sanity counter-check: the 403s above are about ROLE, not broken routes.
        const sample = ['/api/overview', '/api/teams', '/api/waste', '/api/admin/users'];
        for (const url of sample) {
            const res = await app.inject({method: 'GET', url, headers: authHeaders(managerToken)});
            expect(res.statusCode, `admin GET ${url}`).toBe(200);
        }
    });

    it('scopes /api/me/* to the session developer regardless of any id passed', async () => {
        // Use /api/me/tools, where Amy (copilot + windsurf) and Ben (copilot
        // only) genuinely differ — so the assertions can prove the spoofed
        // response is *Amy's*, not merely "some 200".
        const toolsOf = (body: unknown): string[] =>
            ((body as {data: {tools: Array<{tool: string}>}}).data.tools.map((t) => t.tool)).sort();

        const plain = await app.inject({method: 'GET', url: '/api/me/tools?range=lifetime', headers: authHeaders(amyToken)});
        const spoofed = await app.inject({
            method: 'GET',
            url: '/api/me/tools?range=lifetime&developer_id=ben&developerId=ben&id=ben',
            headers: authHeaders(amyToken),
        });
        const benOwn = await app.inject({method: 'GET', url: '/api/me/tools?range=lifetime', headers: authHeaders(benToken)});
        expect(plain.statusCode).toBe(200);
        expect(spoofed.statusCode).toBe(200);

        // 1. The spoof parameters had no effect — identical to Amy's plain call.
        expect(spoofed.json()).toEqual(plain.json());
        // 2. The two developers' tool sets actually differ, so this is a real
        //    discriminator: Amy has windsurf, Ben does not.
        expect(toolsOf(plain.json())).toEqual(['copilot', 'windsurf']);
        expect(toolsOf(benOwn.json())).toEqual(['copilot']);
        // 3. Amy's spoofed-with-Ben's-id result is still Amy's, never Ben's.
        expect(toolsOf(spoofed.json())).toEqual(toolsOf(plain.json()));
        expect(toolsOf(spoofed.json())).not.toEqual(toolsOf(benOwn.json()));
    });

    it("never leaks one developer's tooling cost to another", async () => {
        // Amy has two live seats (copilot + windsurf = 34); Ben has one (copilot = 19).
        const amy = await app.inject({method: 'GET', url: '/api/me/overview?range=lifetime', headers: authHeaders(amyToken)});
        const ben = await app.inject({method: 'GET', url: '/api/me/overview?range=lifetime', headers: authHeaders(benToken)});
        expect((amy.json() as {data: {estimated_monthly_cost: number}}).data.estimated_monthly_cost).toBe(34);
        expect((ben.json() as {data: {estimated_monthly_cost: number}}).data.estimated_monthly_cost).toBe(19);
    });

    it('rejects unauthenticated access to protected endpoints with 401', async () => {
        const protectedUrls = [...MANAGER_GET, '/api/me/overview', '/api/me/tools', '/api/me/activity', '/api/auth/me'];
        for (const url of protectedUrls) {
            const res = await app.inject({method: 'GET', url});
            expect(res.statusCode, `unauth GET ${url}`).toBe(401);
        }
    });

    it('keeps the leaderboard capability probe unreachable for developers', async () => {
        // /api/leaderboard/* sits outside the developer-allowed prefixes, so the
        // central middleware guard 403s it before the availability handler runs.
        // (The handler itself would return 200 {available:false} if reached — the
        // developer simply never reaches it, so the feature's existence does not
        // leak via this probe.) If a future per-team manager role relaxes that
        // confinement, this is the line that must be revisited alongside the
        // leaderboard's own gate.
        const res = await app.inject({method: 'GET', url: '/api/leaderboard/availability', headers: authHeaders(amyToken)});
        expect(res.statusCode).toBe(403);
    });

    it('leaves /health and login public', async () => {
        const health = await app.inject({method: 'GET', url: '/health'});
        expect(health.statusCode).toBe(200);
        const badLogin = await app.inject({method: 'POST', url: '/api/auth/login', payload: {email: 'x@y.z', password: 'nope'}});
        expect(badLogin.statusCode).toBe(401); // reachable without a session, just wrong creds
    });
});
