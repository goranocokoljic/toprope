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
import {runWasteDetection} from '../../src/expenses/waste-detector';
import {evaluatePlanRoi} from '../../src/expenses/plan-roi';

/**
 * Task 2.12 — Multi-source rendering, time-range selector, and waste/Plan ROI
 * verification against the realistic WMG dataset (3 connectors + 3 git
 * providers + subscriptions + a plan upgrade).
 */
describe('Integration (2.12): multi-source data, time-range, waste', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let managerHeaders: Record<string, string>;
    let amyHeaders: Record<string, string>;

    beforeEach(async () => {
        db = makeIntegrationDb();
        seedWmgDataset(db);
        await createAccount(db, {email: 'manager@wmg.test', role: 'admin'});
        await createAccount(db, {email: 'amy@wmg.test', role: 'developer', developerId: 'amy'});
        app = await buildFullApp(db);
        managerHeaders = authHeaders(await login(app, 'manager@wmg.test'));
        amyHeaders = authHeaders(await login(app, 'amy@wmg.test'));
    });

    afterEach(async () => {
        await app.close();
        db.close();
    });

    // ── multi-source rendering ────────────────────────────────────────────────
    it('renders every connector and git provider in the coverage view', async () => {
        const res = await app.inject({method: 'GET', url: '/api/coverage', headers: managerHeaders});
        expect(res.statusCode).toBe(200);
        const {data} = res.json() as {data: {
            data_quality: {high: number; medium: number; low: number; none: number};
            connectors: Array<{connector: string; connected: boolean}>;
            git_providers: Array<{provider: string; connected: boolean; developer_count: number}>;
        }};

        const connected = (name: string): boolean =>
            data.connectors.find((c) => c.connector === name)?.connected ?? false;
        expect(connected('copilot')).toBe(true);
        expect(connected('claude_code')).toBe(true);
        expect(connected('windsurf')).toBe(true);

        for (const provider of ['bitbucket', 'github', 'gitlab']) {
            const row = data.git_providers.find((g) => g.provider === provider)!;
            expect(row.connected, provider).toBe(true);
            expect(row.developer_count, provider).toBeGreaterThan(0);
        }
    });

    it('unifies a developer\'s git activity across providers', async () => {
        // Dan is on GitHub; Amy on Bitbucket; Eve on GitLab — the org spans all 3.
        const res = await app.inject({method: 'GET', url: '/api/me/activity?range=lifetime', headers: amyHeaders});
        const {data} = res.json() as {data: {totals: {commits: number}; providers: Array<{provider: string}>}};
        expect(data.totals.commits).toBeGreaterThan(0);
        expect(data.providers.map((p) => p.provider)).toContain('bitbucket');
    });

    // ── time-range selector across all charts ─────────────────────────────────
    describe('time-range selector across all charts', () => {
        const RANGES = ['30d', '90d', 'year', 'lifetime'];
        const CUSTOM = 'custom&from=2026-01-01&to=2026-12-31';

        const managerCharts = ['/api/overview/trend', '/api/teams/frontend/trend'];
        const developerCharts = ['/api/me/overview', '/api/me/tools', '/api/me/timeline', '/api/me/activity'];

        it('accepts every preset and custom range on every manager chart', async () => {
            for (const chart of managerCharts) {
                for (const range of RANGES) {
                    const res = await app.inject({method: 'GET', url: `${chart}?range=${range}`, headers: managerHeaders});
                    expect(res.statusCode, `${chart} range=${range}`).toBe(200);
                }
                const custom = await app.inject({method: 'GET', url: `${chart}?range=${CUSTOM}`, headers: managerHeaders});
                expect(custom.statusCode, `${chart} custom`).toBe(200);
            }
        });

        it('accepts every preset and custom range on every developer chart', async () => {
            for (const chart of developerCharts) {
                for (const range of RANGES) {
                    const res = await app.inject({method: 'GET', url: `${chart}?range=${range}`, headers: amyHeaders});
                    expect(res.statusCode, `${chart} range=${range}`).toBe(200);
                }
                const custom = await app.inject({method: 'GET', url: `${chart}?range=${CUSTOM}`, headers: amyHeaders});
                expect(custom.statusCode, `${chart} custom`).toBe(200);
            }
        });

        it('rejects an inverted custom range with 400 consistently across charts', async () => {
            const inverted = 'custom&from=2026-12-31&to=2026-01-01';
            for (const chart of [...managerCharts]) {
                const res = await app.inject({method: 'GET', url: `${chart}?range=${inverted}`, headers: managerHeaders});
                expect(res.statusCode, chart).toBe(400);
            }
            for (const chart of developerCharts) {
                const res = await app.inject({method: 'GET', url: `${chart}?range=${inverted}`, headers: amyHeaders});
                expect(res.statusCode, chart).toBe(400);
            }
        });

        it('narrows the window: a 30-day range returns no more points than lifetime', async () => {
            const lifetime = await app.inject({method: 'GET', url: '/api/overview/trend?range=lifetime', headers: managerHeaders});
            const last30 = await app.inject({method: 'GET', url: '/api/overview/trend?range=30d', headers: managerHeaders});
            const lifePoints = (lifetime.json() as {data: {points: unknown[]}}).data.points.length;
            const last30Points = (last30.json() as {data: {points: unknown[]}}).data.points.length;
            expect(last30Points).toBeLessThanOrEqual(lifePoints);
            expect(last30Points).toBeGreaterThan(0);
        });
    });

    // ── waste detection incl. Plan ROI ────────────────────────────────────────
    describe('waste detection (incl. Plan ROI)', () => {
        it('flags the idle established seat as an unused_seat alert', async () => {
            runWasteDetection(db, {inactivity_threshold_days: 14});
            const res = await app.inject({method: 'GET', url: '/api/waste', headers: managerHeaders});
            const alerts = (res.json() as {data: Array<{alert_type: string; developer_id: string; tool: string}>}).data;
            const frank = alerts.find((a) => a.developer_id === 'frank');
            expect(frank).toBeDefined();
            expect(frank!.alert_type).toBe('unused_seat');
            expect(frank!.tool).toBe('copilot');
        });

        it('raises a plan_roi alert for a disproportionate cost increase', async () => {
            // Cara upgraded Claude Code Pro→Max (20→100, a 5x cost jump) ~40 days
            // ago while usage stayed flat — cost rose far faster than usage, which
            // the ROI evaluator flags after the settling period.
            const result = evaluatePlanRoi(db);
            expect(result.flagged).toBeGreaterThanOrEqual(1);

            const res = await app.inject({method: 'GET', url: '/api/waste', headers: managerHeaders});
            const alerts = (res.json() as {data: Array<{alert_type: string; developer_id: string}>}).data;
            const roi = alerts.find((a) => a.alert_type === 'plan_roi');
            expect(roi).toBeDefined();
            expect(roi!.developer_id).toBe('cara');
        });

        it('lets a manager resolve a waste alert through the full request path', async () => {
            runWasteDetection(db, {inactivity_threshold_days: 14});
            const before = (await app.inject({method: 'GET', url: '/api/waste', headers: managerHeaders})).json() as {data: Array<{id: string}>};
            const id = before.data[0].id;

            const resolve = await app.inject({
                method: 'POST',
                url: `/api/waste/${id}/resolve`,
                headers: managerHeaders,
                payload: {reason: 'justified'},
            });
            expect(resolve.statusCode).toBe(200);

            const resolved = await app.inject({method: 'GET', url: '/api/waste/resolved', headers: managerHeaders});
            expect((resolved.json() as {data: Array<{id: string}>}).data.some((a) => a.id === id)).toBe(true);
        });
    });
});
