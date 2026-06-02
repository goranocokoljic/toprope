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
    type WmgDataset,
} from './harness';
import {runWasteDetection} from '../../src/expenses/waste-detector';

/**
 * Task 2.12 — End-to-end MANAGER flow against the full mounted API:
 *   login → overview → teams → team detail → waste → logout
 *
 * Drives the same endpoints the manager screens call, in order, on a single
 * session cookie, against the realistic multi-source WMG dataset.
 */
describe('Integration (2.12): manager end-to-end flow', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let data: WmgDataset;

    beforeEach(async () => {
        db = makeIntegrationDb();
        data = seedWmgDataset(db);
        // Manager screens are served to the admin role (no separate manager role
        // in Phase 2 — see auth/middleware.ts).
        await createAccount(db, {email: 'manager@wmg.test', role: 'admin'});
        // Generate the unused-seat alert from Frank's idle established seat.
        runWasteDetection(db, {inactivity_threshold_days: 14});
        app = await buildFullApp(db);
    });

    afterEach(async () => {
        await app.close();
        db.close();
    });

    it('walks login → overview → teams → team detail → waste → logout on one session', async () => {
        // 1. login
        const token = await login(app, 'manager@wmg.test');
        const headers = authHeaders(token);

        // 2. organization overview
        const overview = await app.inject({method: 'GET', url: '/api/overview', headers});
        expect(overview.statusCode).toBe(200);
        const ov = (overview.json() as {data: {
            total_developers: number;
            active_developers: number;
            active_tools: string[];
            total_monthly_cost: number;
            active_waste_alert_count: number;
        }}).data;
        expect(ov.total_developers).toBe(6);
        expect(ov.active_developers).toBeGreaterThan(0);
        // All three connectors show up as active tools.
        expect(ov.active_tools).toEqual(expect.arrayContaining(['copilot', 'claude_code', 'windsurf']));
        expect(ov.total_monthly_cost).toBeGreaterThan(0);
        expect(ov.active_waste_alert_count).toBeGreaterThanOrEqual(1);

        // 2b. the overview trend chart (default range)
        const trend = await app.inject({method: 'GET', url: '/api/overview/trend?range=90d', headers});
        expect(trend.statusCode).toBe(200);
        expect((trend.json() as {data: {points: unknown[]}}).data.points.length).toBeGreaterThan(0);

        // 2c. tool distribution + coverage indicators on the overview screen
        const distribution = await app.inject({method: 'GET', url: '/api/tools/distribution', headers});
        expect(distribution.statusCode).toBe(200);
        const dist = (distribution.json() as {data: {tools: Array<{tool: string}>; total_seats: number}}).data;
        expect(dist.total_seats).toBeGreaterThan(0);
        expect(dist.tools.map((t) => t.tool)).toEqual(expect.arrayContaining(['copilot', 'claude_code', 'windsurf']));

        const coverage = await app.inject({method: 'GET', url: '/api/coverage', headers});
        expect(coverage.statusCode).toBe(200);
        const cov = (coverage.json() as {data: {
            connectors: Array<{connector: string; connected: boolean}>;
            git_providers: Array<{provider: string; connected: boolean}>;
        }}).data;
        // Bitbucket + GitHub + GitLab all report as connected from real snapshots.
        const connectedProviders = cov.git_providers.filter((p) => p.connected).map((p) => p.provider);
        expect(connectedProviders).toEqual(expect.arrayContaining(['bitbucket', 'github', 'gitlab']));

        // 3. teams list
        const teams = await app.inject({method: 'GET', url: '/api/teams', headers});
        expect(teams.statusCode).toBe(200);
        const teamRows = (teams.json() as {data: Array<{name: string}>}).data;
        expect(teamRows.map((t) => t.name)).toEqual(expect.arrayContaining(data.teams));

        // 4. team detail (+ its trend and provider label)
        const detail = await app.inject({method: 'GET', url: '/api/teams/frontend', headers});
        expect(detail.statusCode).toBe(200);
        expect((detail.json() as {data: {active_count: number}}).data.active_count).toBeGreaterThan(0);

        const teamTrend = await app.inject({method: 'GET', url: '/api/teams/frontend/trend?range=30d', headers});
        expect(teamTrend.statusCode).toBe(200);

        const teamProviders = await app.inject({method: 'GET', url: '/api/teams/frontend/providers', headers});
        expect(teamProviders.statusCode).toBe(200);
        const providers = (teamProviders.json() as {data: {providers: Array<{provider: string}>}}).data.providers;
        expect(providers.map((p) => p.provider)).toContain('bitbucket');

        // 5. waste detection screen
        const waste = await app.inject({method: 'GET', url: '/api/waste', headers});
        expect(waste.statusCode).toBe(200);
        const alerts = (waste.json() as {data: Array<{alert_type: string; developer_id: string}>}).data;
        expect(alerts.length).toBeGreaterThanOrEqual(1);
        expect(alerts.some((a) => a.alert_type === 'unused_seat' && a.developer_id === 'frank')).toBe(true);

        const wasteSummary = await app.inject({method: 'GET', url: '/api/waste/summary', headers});
        expect(wasteSummary.statusCode).toBe(200);

        // 6. logout — the session cookie is invalidated
        const logout = await app.inject({method: 'POST', url: '/api/auth/logout', headers});
        expect(logout.statusCode).toBe(200);

        const afterLogout = await app.inject({method: 'GET', url: '/api/overview', headers});
        expect(afterLogout.statusCode).toBe(401);
    });

    it('drills from a team into a developer detail record', async () => {
        const token = await login(app, 'manager@wmg.test');
        const headers = authHeaders(token);

        const detail = await app.inject({method: 'GET', url: '/api/developers/amy', headers});
        expect(detail.statusCode).toBe(200);

        const timeline = await app.inject({method: 'GET', url: '/api/developers/amy/timeline', headers});
        expect(timeline.statusCode).toBe(200);

        // Unknown developer is a clean 404, not a 500.
        const missing = await app.inject({method: 'GET', url: '/api/developers/nobody', headers});
        expect(missing.statusCode).toBe(404);
    });

    it('exports a cross-tool snapshot extract for the manager', async () => {
        const token = await login(app, 'manager@wmg.test');
        const headers = authHeaders(token);

        const snapshots = await app.inject({method: 'GET', url: '/api/snapshots?limit=50', headers});
        expect(snapshots.statusCode).toBe(200);

        const csv = await app.inject({method: 'GET', url: '/api/export?format=csv', headers});
        expect(csv.statusCode).toBe(200);
        expect(csv.headers['content-type']).toContain('csv');
    });
});
