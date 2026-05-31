import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type {FastifyInstance} from 'fastify';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import {makeTestDb, seedFixtures} from './fixtures';
import {registerOverviewRoutes} from '../../src/dashboard/api/overview';
import {registerTeamRoutes} from '../../src/dashboard/api/teams';
import {registerDeveloperRoutes} from '../../src/dashboard/api/developers';
import {registerWasteRoutes} from '../../src/dashboard/api/waste';
import {registerSnapshotRoutes} from '../../src/dashboard/api/snapshots';
import {registerExportRoutes} from '../../src/dashboard/api/export';

// These tests exercise the data-route handlers in isolation, without the
// session-auth gate (which has its own dedicated suite under tests/auth).
function buildTestApp(db: Database.Database): FastifyInstance {
    const app = Fastify({logger: false});
    // This suite exercises handler logic past the session-auth gate, so stand in
    // for an authenticated admin — handlers with an inline isAdmin guard (e.g.
    // /api/waste*) then run their real logic instead of short-circuiting to 403.
    // The auth gate itself has dedicated coverage under tests/auth + manager-api.
    app.addHook('onRequest', async (request) => {
        request.authUser = {
            userId: 'test-admin',
            email: 'admin@example.com',
            role: 'admin',
            developerId: null,
            mustChangePassword: false,
            sessionId: 'test-session',
        };
    });
    app.get('/health', async () => ({status: 'ok'}));
    registerOverviewRoutes(app, db);
    registerTeamRoutes(app, db);
    registerDeveloperRoutes(app, db);
    registerWasteRoutes(app, db);
    registerSnapshotRoutes(app, db);
    registerExportRoutes(app, db);
    return app;
}

describe('API Endpoints', () => {
    let db: Database.Database;
    let app: FastifyInstance;

    beforeEach(async () => {
        db = makeTestDb();
        seedFixtures(db);
        app = buildTestApp(db);
        await app.ready();
    });

    afterEach(async () => {
        await app.close();
        db.close();
    });

    describe('GET /health', () => {
        it('returns ok', async () => {
            const res = await app.inject({method: 'GET', url: '/health'});
            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({status: 'ok'});
        });
    });

    describe('GET /api/overview', () => {
        it('returns org-wide summary', async () => {
            const res = await app.inject({method: 'GET', url: '/api/overview'});
            expect(res.statusCode).toBe(200);
            const body = res.json<{data: Record<string, unknown>}>();
            expect(body.data.total_developers).toBe(3);
            expect(body.data.active_developers).toBeGreaterThanOrEqual(0);
            expect(body.data.total_subscriptions).toBe(2);
            expect(body.data.total_monthly_cost).toBe(39);
            expect(Array.isArray(body.data.active_tools)).toBe(true);
            expect(body.data.active_waste_alert_count).toBe(2);
            expect(body.data.total_monthly_waste).toBe(39);
        });

        it('data_quality_distribution has all keys', async () => {
            const res = await app.inject({method: 'GET', url: '/api/overview'});
            const body = res.json<{data: {data_quality_distribution: Record<string, number>}}>();
            const dist = body.data.data_quality_distribution;
            expect(dist).toHaveProperty('high');
            expect(dist).toHaveProperty('medium');
            expect(dist).toHaveProperty('low');
            expect(dist).toHaveProperty('none');
        });

        it('empty database returns zero totals', async () => {
            const emptyDb = makeTestDb();
            const emptyApp = buildTestApp(emptyDb);
            await emptyApp.ready();
            const res = await emptyApp.inject({method: 'GET', url: '/api/overview'});
            expect(res.statusCode).toBe(200);
            const body = res.json<{data: {total_developers: number; active_waste_alert_count: number}}>();
            expect(body.data.total_developers).toBe(0);
            expect(body.data.active_waste_alert_count).toBe(0);
            await emptyApp.close();
            emptyDb.close();
        });
    });

    describe('GET /api/teams', () => {
        it('returns all teams with summary', async () => {
            const res = await app.inject({method: 'GET', url: '/api/teams'});
            expect(res.statusCode).toBe(200);
            const body = res.json<{data: unknown[]; pagination: {total: number}}>();
            expect(body.pagination.total).toBe(2);
            expect(body.data).toHaveLength(2);
        });

        it('pagination works', async () => {
            const res = await app.inject({method: 'GET', url: '/api/teams?page=1&limit=1'});
            const body = res.json<{data: unknown[]; pagination: {page: number; limit: number; total: number}}>();
            expect(body.data).toHaveLength(1);
            expect(body.pagination.page).toBe(1);
            expect(body.pagination.limit).toBe(1);
            expect(body.pagination.total).toBe(2);
        });

        it('each team has required fields', async () => {
            const res = await app.inject({method: 'GET', url: '/api/teams'});
            const body = res.json<{data: Array<{name: string; developer_count: number; utilization_rate: number}>}>();
            for (const team of body.data) {
                expect(team).toHaveProperty('name');
                expect(team).toHaveProperty('developer_count');
                expect(team).toHaveProperty('utilization_rate');
                expect(team).toHaveProperty('total_monthly_cost');
                expect(team).toHaveProperty('tool_mix');
            }
        });
    });

    describe('GET /api/teams/:team', () => {
        it('returns team detail with developers', async () => {
            const res = await app.inject({method: 'GET', url: '/api/teams/frontend'});
            expect(res.statusCode).toBe(200);
            const body = res.json<{data: {name: string; developers: unknown[]}}>();
            expect(body.data.name).toBe('frontend');
            expect(body.data.developers).toHaveLength(2);
        });

        it('returns 404 for unknown team', async () => {
            const res = await app.inject({method: 'GET', url: '/api/teams/unknown-team'});
            expect(res.statusCode).toBe(404);
        });

        it('developer detail includes activity_summary', async () => {
            const res = await app.inject({method: 'GET', url: '/api/teams/frontend'});
            const body = res.json<{data: {developers: Array<{activity_summary: Record<string, number>}>}}>();
            const dev = body.data.developers[0];
            expect(dev.activity_summary).toHaveProperty('active_days_30d');
            expect(dev.activity_summary).toHaveProperty('total_interactions_30d');
        });

        it('includes a per-tool breakdown with adoption and cost', async () => {
            const res = await app.inject({method: 'GET', url: '/api/teams/frontend'});
            const body = res.json<{
                data: {tool_breakdown: Array<{tool: string; developers: number; monthly_cost: number}>};
            }>();
            // frontend: dev-1 holds the copilot seat ($19) and is active on it; dev-3 has neither.
            const copilot = body.data.tool_breakdown.find((t) => t.tool === 'copilot');
            expect(copilot).toBeDefined();
            expect(copilot?.developers).toBe(1);
            expect(copilot?.monthly_cost).toBe(19);
        });
    });

    describe('GET /api/developers/:id', () => {
        it('returns developer detail', async () => {
            const res = await app.inject({method: 'GET', url: '/api/developers/dev-1'});
            expect(res.statusCode).toBe(200);
            const body = res.json<{data: {id: string; name: string; tool_snapshots: unknown[]; subscriptions: unknown[]}}>();
            expect(body.data.id).toBe('dev-1');
            expect(body.data.name).toBe('Alice Dev');
            expect(Array.isArray(body.data.tool_snapshots)).toBe(true);
            expect(Array.isArray(body.data.subscriptions)).toBe(true);
        });

        it('returns 404 for unknown developer', async () => {
            const res = await app.inject({method: 'GET', url: '/api/developers/no-such-dev'});
            expect(res.statusCode).toBe(404);
        });

        it('includes activity_summary', async () => {
            const res = await app.inject({method: 'GET', url: '/api/developers/dev-1'});
            const body = res.json<{data: {activity_summary: Record<string, unknown>}}>();
            expect(body.data.activity_summary).toHaveProperty('active_tools');
            expect(body.data.activity_summary).toHaveProperty('active_days_30d');
            expect(body.data.activity_summary).toHaveProperty('total_interactions_30d');
            expect(body.data.activity_summary).toHaveProperty('total_commits_30d');
        });
    });

    describe('GET /api/developers/:id/timeline', () => {
        it('returns timeline data points', async () => {
            const res = await app.inject({method: 'GET', url: '/api/developers/dev-1/timeline'});
            expect(res.statusCode).toBe(200);
            const body = res.json<{data: unknown[]}>();
            expect(Array.isArray(body.data)).toBe(true);
        });

        it('each point has tool_activity and git_activity', async () => {
            const res = await app.inject({method: 'GET', url: '/api/developers/dev-1/timeline'});
            const body = res.json<{data: Array<{date: string; tool_activity: unknown; git_activity: unknown}>}>();
            if (body.data.length > 0) {
                const point = body.data[0];
                expect(point).toHaveProperty('date');
                expect(point).toHaveProperty('tool_activity');
                expect(point).toHaveProperty('git_activity');
            }
        });

        it('returns 404 for unknown developer', async () => {
            const res = await app.inject({method: 'GET', url: '/api/developers/no-such/timeline'});
            expect(res.statusCode).toBe(404);
        });
    });

    describe('GET /api/waste', () => {
        it('returns active waste alerts', async () => {
            const res = await app.inject({method: 'GET', url: '/api/waste'});
            expect(res.statusCode).toBe(200);
            const body = res.json<{data: unknown[]; pagination: {total: number}}>();
            expect(body.pagination.total).toBe(2);
        });

        it('supports team filtering', async () => {
            const res = await app.inject({method: 'GET', url: '/api/waste?team=frontend'});
            const body = res.json<{data: Array<{team: string}>; pagination: {total: number}}>();
            expect(body.pagination.total).toBe(1);
            expect(body.data[0].team).toBe('frontend');
        });

        it('supports pagination', async () => {
            const res = await app.inject({method: 'GET', url: '/api/waste?page=1&limit=1'});
            const body = res.json<{data: unknown[]; pagination: {total: number}}>();
            expect(body.data).toHaveLength(1);
            expect(body.pagination.total).toBe(2);
        });

        it('details field is parsed as object', async () => {
            const res = await app.inject({method: 'GET', url: '/api/waste'});
            const body = res.json<{data: Array<{details: Record<string, unknown>}>}>();
            expect(typeof body.data[0].details).toBe('object');
        });
    });

    describe('GET /api/waste/summary', () => {
        it('returns waste aggregated by team', async () => {
            const res = await app.inject({method: 'GET', url: '/api/waste/summary'});
            expect(res.statusCode).toBe(200);
            const body = res.json<{data: Array<{team: string; total_monthly_waste: number}>}>();
            expect(Array.isArray(body.data)).toBe(true);
            expect(body.data.length).toBeGreaterThan(0);
            const teams = body.data.map((d) => d.team);
            expect(teams).toContain('frontend');
            expect(teams).toContain('backend');
        });

        it('empty database returns empty array', async () => {
            const emptyDb = makeTestDb();
            const emptyApp = buildTestApp(emptyDb);
            await emptyApp.ready();
            const res = await emptyApp.inject({method: 'GET', url: '/api/waste/summary'});
            expect(res.statusCode).toBe(200);
            const body = res.json<{data: unknown[]}>();
            expect(body.data).toHaveLength(0);
            await emptyApp.close();
            emptyDb.close();
        });
    });

    describe('GET /api/snapshots', () => {
        it('returns snapshots with pagination', async () => {
            const res = await app.inject({method: 'GET', url: '/api/snapshots'});
            expect(res.statusCode).toBe(200);
            const body = res.json<{data: unknown[]; pagination: {total: number}}>();
            expect(Array.isArray(body.data)).toBe(true);
            expect(body.pagination.total).toBeGreaterThan(0);
        });

        it('supports date filtering', async () => {
            const today = new Date().toISOString().slice(0, 10);
            const res = await app.inject({method: 'GET', url: `/api/snapshots?date=${today}`});
            expect(res.statusCode).toBe(200);
            const body = res.json<{data: Array<{date: string}>}>();
            for (const row of body.data) {
                expect(row.date).toBe(today);
            }
        });

        it('supports team filtering', async () => {
            const res = await app.inject({method: 'GET', url: '/api/snapshots?team=frontend'});
            const body = res.json<{data: Array<{team: string}>}>();
            for (const row of body.data) {
                expect(row.team).toBe('frontend');
            }
        });

        it('returns empty for non-existent date', async () => {
            const res = await app.inject({method: 'GET', url: '/api/snapshots?date=1990-01-01'});
            const body = res.json<{data: unknown[]; pagination: {total: number}}>();
            expect(body.data).toHaveLength(0);
            expect(body.pagination.total).toBe(0);
        });
    });

    describe('GET /api/export', () => {
        it('returns JSON by default', async () => {
            const res = await app.inject({method: 'GET', url: '/api/export'});
            expect(res.statusCode).toBe(200);
            const body = res.json<{data: unknown[]; total: number}>();
            expect(Array.isArray(body.data)).toBe(true);
        });

        it('returns CSV when format=csv', async () => {
            const res = await app.inject({method: 'GET', url: '/api/export?format=csv'});
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('text/csv');
            expect(res.headers['content-disposition']).toContain('attachment');
            const text = res.payload;
            expect(text).toContain('developer_id');
        });

        it('CSV has correct header row', async () => {
            const res = await app.inject({method: 'GET', url: '/api/export?format=csv'});
            const lines = res.payload.split(/\r?\n/);
            const header = lines[0];
            expect(header).toContain('developer_id');
            expect(header).toContain('tool');
            expect(header).toContain('date');
        });

        it('supports date range filtering', async () => {
            const today = new Date().toISOString().slice(0, 10);
            const res = await app.inject({
                method: 'GET',
                url: `/api/export?from=${today}&to=${today}`,
            });
            expect(res.statusCode).toBe(200);
        });

        it('supports team filtering', async () => {
            const res = await app.inject({method: 'GET', url: '/api/export?team=backend'});
            const body = res.json<{data: Array<{team: string}>}>();
            for (const row of body.data) {
                expect(row.team).toBe('backend');
            }
        });
    });
});
