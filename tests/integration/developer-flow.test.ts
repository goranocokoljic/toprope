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
 * Task 2.12 — End-to-end DEVELOPER flow against the full mounted API:
 *   login → my dashboard → my tools → my activity → logout
 *
 * Exercises the /api/me/* surface the developer screens call, on one session,
 * for a developer with real multi-tool, multi-provider history.
 */
describe('Integration (2.12): developer end-to-end flow', () => {
    let db: Database.Database;
    let app: FastifyInstance;

    beforeEach(async () => {
        db = makeIntegrationDb();
        seedWmgDataset(db);
        // Amy uses Copilot + Windsurf and hosts git on Bitbucket — a good
        // multi-source developer to walk the personal screens with.
        await createAccount(db, {email: 'amy@wmg.test', role: 'developer', developerId: 'amy'});
        app = await buildFullApp(db);
    });

    afterEach(async () => {
        await app.close();
        db.close();
    });

    it('walks login → my dashboard → my tools → my activity → logout on one session', async () => {
        // 1. login as a developer
        const token = await login(app, 'amy@wmg.test');
        const headers = authHeaders(token);

        // session identity confirms the developer link
        const me = await app.inject({method: 'GET', url: '/api/auth/me', headers});
        expect(me.statusCode).toBe(200);
        expect((me.json() as {data: {role: string; developer_id: string}}).data).toMatchObject({
            role: 'developer',
            developer_id: 'amy',
        });

        // 2. my dashboard (overview)
        const overview = await app.inject({method: 'GET', url: '/api/me/overview?range=90d', headers});
        expect(overview.statusCode).toBe(200);
        const ov = (overview.json() as {data: {
            active_days: number;
            primary_tools: string[];
            estimated_monthly_cost: number;
        }}).data;
        expect(ov.active_days).toBeGreaterThan(0);
        expect(ov.primary_tools).toEqual(expect.arrayContaining(['copilot', 'windsurf']));
        // Live seats only (revoked legacy windsurf seat excluded): 19 + 15 = 34.
        expect(ov.estimated_monthly_cost).toBe(34);

        // 3. my tools — per-tool breakdown
        const tools = await app.inject({method: 'GET', url: '/api/me/tools?range=90d', headers});
        expect(tools.statusCode).toBe(200);
        const toolRows = (tools.json() as {data: {tools: Array<{tool: string; interactions: number; feature_usage: unknown[]}>}}).data.tools;
        expect(toolRows.map((t) => t.tool)).toEqual(expect.arrayContaining(['copilot', 'windsurf']));
        const copilot = toolRows.find((t) => t.tool === 'copilot')!;
        expect(copilot.interactions).toBeGreaterThan(0);
        expect(copilot.feature_usage.length).toBeGreaterThan(0);

        // 4. my activity — cross-provider git correlation
        const activity = await app.inject({method: 'GET', url: '/api/me/activity?range=90d', headers});
        expect(activity.statusCode).toBe(200);
        const act = (activity.json() as {data: {totals: {commits: number}; providers: Array<{provider: string}>}}).data;
        expect(act.totals.commits).toBeGreaterThan(0);
        expect(act.providers.map((p) => p.provider)).toContain('bitbucket');

        // 4b. timeline + journey behind the personal screens
        const timeline = await app.inject({method: 'GET', url: '/api/me/timeline?range=90d', headers});
        expect(timeline.statusCode).toBe(200);
        const journey = await app.inject({method: 'GET', url: '/api/me/journey', headers});
        expect(journey.statusCode).toBe(200);
        expect((journey.json() as {data: {tools: unknown[]}}).data.tools.length).toBeGreaterThan(0);

        // 5. logout
        const logout = await app.inject({method: 'POST', url: '/api/auth/logout', headers});
        expect(logout.statusCode).toBe(200);
        const afterLogout = await app.inject({method: 'GET', url: '/api/me/overview', headers});
        expect(afterLogout.statusCode).toBe(401);
    });

    it('lets a developer read and update their own UI preferences', async () => {
        const token = await login(app, 'amy@wmg.test');
        const headers = authHeaders(token);

        const get = await app.inject({method: 'GET', url: '/api/me/preferences', headers});
        expect(get.statusCode).toBe(200);

        const patch = await app.inject({
            method: 'PATCH',
            url: '/api/me/preferences',
            headers,
            payload: {default_time_range: '90d'},
        });
        expect(patch.statusCode).toBe(200);
    });
});
