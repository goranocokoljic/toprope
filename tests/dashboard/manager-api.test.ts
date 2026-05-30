import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {makeTestDb} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerMeRoutes} from '../../src/dashboard/api/me';
import {registerTrendRoutes} from '../../src/dashboard/api/trends';
import {registerToolsRoutes} from '../../src/dashboard/api/tools';
import {registerCoverageRoutes} from '../../src/dashboard/api/coverage';
import {registerProviderRoutes} from '../../src/dashboard/api/providers';
import {registerWasteRoutes} from '../../src/dashboard/api/waste';
import {runWasteDetection} from '../../src/expenses/waste-detector';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';

const PASSWORD = 'correct-horse-battery';
const NOW = '2026-05-30T00:00:00.000Z';

async function buildApp(db: Database.Database): Promise<FastifyInstance> {
    const app = Fastify({logger: false});
    registerSessionAuth(app, db);
    registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
    registerMeRoutes(app, db);
    registerTrendRoutes(app, db);
    registerToolsRoutes(app, db);
    registerCoverageRoutes(app, db);
    registerProviderRoutes(app, db);
    registerWasteRoutes(app, db);
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

function seedTeam(db: Database.Database, name: string): void {
    db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run(
        name,
        NOW,
    );
}

function seedDeveloper(db: Database.Database, id: string, team: string): void {
    db.prepare(
        'INSERT INTO developers (id, external_ids, name, email, team, created_at) VALUES (?, NULL, ?, ?, ?, ?)',
    ).run(id, id, `${id}@example.com`, team, NOW);
}

function seedToolSnapshot(
    db: Database.Database,
    opts: {
        developer: string;
        date: string;
        tool?: string;
        isActive?: boolean;
        interactions?: number;
        acceptances?: number;
        quality?: string;
    },
): void {
    const tool = opts.tool ?? 'copilot';
    db.prepare(
        `INSERT INTO tool_snapshots
           (id, developer_id, date, tool, data_source, data_quality, is_active,
            interaction_count, acceptance_count)
         VALUES (?, ?, ?, ?, 'api', ?, ?, ?, ?)`,
    ).run(
        `${opts.developer}-${opts.date}-${tool}`,
        opts.developer,
        opts.date,
        tool,
        opts.quality ?? 'high',
        opts.isActive === false ? 0 : 1,
        opts.interactions ?? 0,
        opts.acceptances ?? 0,
    );
}

function seedGitSnapshot(db: Database.Database, developer: string, date: string, dataSource: string): void {
    db.prepare(
        `INSERT INTO git_snapshots (id, developer_id, date, commits, data_source)
         VALUES (?, ?, ?, 1, ?)`,
    ).run(`${developer}-${date}-${dataSource}`, developer, date, dataSource);
}

function seedSubscription(
    db: Database.Database,
    opts: {id: string; developer: string; tool: string; cost: number; revoked?: boolean},
): void {
    db.prepare(
        `INSERT INTO subscriptions
           (id, developer_id, tool, plan, billing_model, monthly_cost, seat_assigned_at,
            seat_revoked_at, data_source)
         VALUES (?, ?, ?, 'pro', 'company_managed', ?, ?, ?, 'expense_import')`,
    ).run(opts.id, opts.developer, opts.tool, opts.cost, NOW, opts.revoked ? NOW : null);
}

function seedSyncLog(
    db: Database.Database,
    opts: {connector: string; status: string; started: string; finished?: string},
): void {
    db.prepare(
        `INSERT INTO sync_logs (id, connector, started_at, finished_at, status)
         VALUES (?, ?, ?, ?, ?)`,
    ).run(`log-${opts.connector}`, opts.connector, opts.started, opts.finished ?? null, opts.status);
}

describe('Manager API (Task 2.3)', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let adminToken: string;
    let devToken: string;

    beforeEach(async () => {
        db = makeTestDb();
        const hash = await hashPassword(PASSWORD);
        createUser(db, {email: 'admin@test.com', passwordHash: hash, role: 'admin'});
        createUser(db, {email: 'dev@test.com', passwordHash: hash, role: 'developer'});
        app = await buildApp(db);
        adminToken = await login(app, 'admin@test.com');
        devToken = await login(app, 'dev@test.com');
    });

    afterEach(async () => {
        await app.close();
        db.close();
    });

    // ── trends ──────────────────────────────────────────────────────────────
    describe('trend endpoints', () => {
        beforeEach(() => {
            seedTeam(db, 'eng');
            seedTeam(db, 'other');
            seedDeveloper(db, 'dev1', 'eng');
            seedDeveloper(db, 'dev2', 'other');
            seedToolSnapshot(db, {developer: 'dev1', date: '2026-05-10', interactions: 10, acceptances: 6});
            seedToolSnapshot(db, {developer: 'dev2', date: '2026-05-10', interactions: 5, acceptances: 4});
            seedToolSnapshot(db, {developer: 'dev1', date: '2026-05-11', interactions: 4, acceptances: 2});
        });

        it('returns an org trend series for a custom range', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/overview/trend?range=custom&from=2026-05-01&to=2026-05-31',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            const {data} = res.json() as {data: {range: string; points: Array<Record<string, number | string>>}};
            expect(data.range).toBe('custom');
            expect(data.points).toHaveLength(2);
            const may10 = data.points.find((p) => p.date === '2026-05-10')!;
            expect(may10.active_developers).toBe(2);
            expect(may10.interactions).toBe(15);
            expect(may10.acceptances).toBe(10);
        });

        it('scopes a team trend to that team only', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/teams/eng/trend?range=custom&from=2026-05-01&to=2026-05-31',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            const {data} = res.json() as {data: {team: string; points: Array<Record<string, number | string>>}};
            expect(data.team).toBe('eng');
            const may10 = data.points.find((p) => p.date === '2026-05-10')!;
            expect(may10.active_developers).toBe(1);
            expect(may10.interactions).toBe(10);
        });

        it('supports lifetime range from the earliest record', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/overview/trend?range=lifetime',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            expect((res.json() as {data: {from: string}}).data.from).toBe('2026-05-10');
        });

        it('returns empty points for a range with no data', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/overview/trend?range=custom&from=2020-01-01&to=2020-12-31',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            expect((res.json() as {data: {points: unknown[]}}).data.points).toEqual([]);
        });

        it('rejects an invalid custom range with 400', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/overview/trend?range=custom&from=2026-05-31&to=2026-05-01',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(400);
        });

        it('returns 404 for an unknown team', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/teams/nope/trend?range=30d',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(404);
        });

        it('returns 403 for developer-role sessions', async () => {
            const org = await app.inject({method: 'GET', url: '/api/overview/trend?range=30d', headers: authHeaders(devToken)});
            const team = await app.inject({method: 'GET', url: '/api/teams/eng/trend?range=30d', headers: authHeaders(devToken)});
            expect(org.statusCode).toBe(403);
            expect(team.statusCode).toBe(403);
        });
    });

    // ── tool distribution ───────────────────────────────────────────────────
    describe('tool distribution', () => {
        it('aggregates active seats and cost per tool', async () => {
            seedTeam(db, 'eng');
            seedDeveloper(db, 'dev1', 'eng');
            seedDeveloper(db, 'dev2', 'eng');
            seedDeveloper(db, 'dev3', 'eng');
            seedSubscription(db, {id: 's1', developer: 'dev1', tool: 'copilot', cost: 19});
            seedSubscription(db, {id: 's2', developer: 'dev2', tool: 'copilot', cost: 19});
            seedSubscription(db, {id: 's3', developer: 'dev3', tool: 'copilot', cost: 19, revoked: true});
            seedSubscription(db, {id: 's4', developer: 'dev1', tool: 'windsurf', cost: 15});

            const res = await app.inject({
                method: 'GET',
                url: '/api/tools/distribution',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            const {data} = res.json() as {
                data: {tools: Array<{tool: string; seats: number; monthly_cost: number}>; total_seats: number; total_monthly_cost: number};
            };
            const copilot = data.tools.find((t) => t.tool === 'copilot')!;
            expect(copilot.seats).toBe(2); // revoked seat excluded
            expect(copilot.monthly_cost).toBe(38);
            expect(data.total_seats).toBe(3);
            expect(data.total_monthly_cost).toBe(53);
        });

        it('returns an empty distribution with no subscriptions', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/tools/distribution',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({data: {tools: [], total_seats: 0, total_monthly_cost: 0}});
        });

        it('returns 403 for developer-role sessions', async () => {
            const res = await app.inject({method: 'GET', url: '/api/tools/distribution', headers: authHeaders(devToken)});
            expect(res.statusCode).toBe(403);
        });
    });

    // ── coverage ────────────────────────────────────────────────────────────
    describe('coverage', () => {
        it('reports per-developer data quality, connectors, and git providers', async () => {
            seedTeam(db, 'eng');
            seedDeveloper(db, 'high1', 'eng');
            seedDeveloper(db, 'med1', 'eng');
            seedDeveloper(db, 'low1', 'eng');
            seedDeveloper(db, 'none1', 'eng');
            seedToolSnapshot(db, {developer: 'high1', date: '2026-05-10', quality: 'high'});
            seedGitSnapshot(db, 'med1', '2026-05-10', 'github');
            seedSubscription(db, {id: 'sub-low', developer: 'low1', tool: 'copilot', cost: 19});

            seedSyncLog(db, {connector: 'copilot', status: 'success', started: NOW, finished: NOW});
            seedSyncLog(db, {connector: 'windsurf', status: 'error', started: NOW});

            const res = await app.inject({method: 'GET', url: '/api/coverage', headers: authHeaders(adminToken)});
            expect(res.statusCode).toBe(200);
            const {data} = res.json() as {
                data: {
                    data_quality: {high: number; medium: number; low: number; none: number};
                    connectors: Array<{connector: string; connected: boolean; status: string | null}>;
                    git_providers: Array<{provider: string; connected: boolean; developer_count: number}>;
                };
            };

            expect(data.data_quality).toEqual({high: 1, medium: 1, low: 1, none: 1});

            const copilot = data.connectors.find((c) => c.connector === 'copilot')!;
            const claude = data.connectors.find((c) => c.connector === 'claude_code')!;
            const windsurf = data.connectors.find((c) => c.connector === 'windsurf')!;
            expect(copilot.connected).toBe(true);
            expect(copilot.status).toBe('success');
            expect(claude.connected).toBe(false);
            expect(windsurf.status).toBe('error');

            const github = data.git_providers.find((g) => g.provider === 'github')!;
            const gitlab = data.git_providers.find((g) => g.provider === 'gitlab')!;
            expect(github.developer_count).toBe(1);
            expect(github.connected).toBe(true);
            expect(gitlab.developer_count).toBe(0);
            expect(gitlab.connected).toBe(false);
        });

        it('reports zeros on an empty database', async () => {
            const res = await app.inject({method: 'GET', url: '/api/coverage', headers: authHeaders(adminToken)});
            expect(res.statusCode).toBe(200);
            const {data} = res.json() as {data: {data_quality: Record<string, number>}};
            expect(data.data_quality).toEqual({high: 0, medium: 0, low: 0, none: 0});
        });

        it('returns 403 for developer-role sessions', async () => {
            const res = await app.inject({method: 'GET', url: '/api/coverage', headers: authHeaders(devToken)});
            expect(res.statusCode).toBe(403);
        });
    });

    // ── team providers ──────────────────────────────────────────────────────
    describe('team providers', () => {
        beforeEach(() => {
            seedTeam(db, 'eng');
            seedTeam(db, 'empty');
            seedTeam(db, 'other');
            seedDeveloper(db, 'e1', 'eng');
            seedDeveloper(db, 'e2', 'eng');
            seedDeveloper(db, 'e3', 'eng');
            seedDeveloper(db, 'o1', 'other');
            seedGitSnapshot(db, 'e1', '2026-05-10', 'github');
            seedGitSnapshot(db, 'e2', '2026-05-10', 'github');
            seedGitSnapshot(db, 'e3', '2026-05-10', 'bitbucket');
            seedGitSnapshot(db, 'o1', '2026-05-10', 'gitlab');
        });

        it("lists the team's providers with developer counts", async () => {
            const res = await app.inject({method: 'GET', url: '/api/teams/eng/providers', headers: authHeaders(adminToken)});
            expect(res.statusCode).toBe(200);
            const {data} = res.json() as {data: {team: string; providers: Array<{provider: string; developer_count: number}>}};
            expect(data.team).toBe('eng');
            expect(data.providers).toHaveLength(2);
            expect(data.providers.find((p) => p.provider === 'github')!.developer_count).toBe(2);
            expect(data.providers.find((p) => p.provider === 'bitbucket')!.developer_count).toBe(1);
        });

        it('returns an empty provider list for a team with no git activity', async () => {
            const res = await app.inject({method: 'GET', url: '/api/teams/empty/providers', headers: authHeaders(adminToken)});
            expect(res.statusCode).toBe(200);
            expect((res.json() as {data: {providers: unknown[]}}).data.providers).toEqual([]);
        });

        it('returns 404 for an unknown team', async () => {
            const res = await app.inject({method: 'GET', url: '/api/teams/nope/providers', headers: authHeaders(adminToken)});
            expect(res.statusCode).toBe(404);
        });

        it('returns 403 for developer-role sessions', async () => {
            const res = await app.inject({method: 'GET', url: '/api/teams/eng/providers', headers: authHeaders(devToken)});
            expect(res.statusCode).toBe(403);
        });
    });

    // ── waste resolution ────────────────────────────────────────────────────
    describe('waste resolution', () => {
        function seedAlert(): string {
            seedTeam(db, 'eng');
            seedDeveloper(db, 'dev1', 'eng');
            seedSubscription(db, {id: 's1', developer: 'dev1', tool: 'copilot', cost: 19});
            // No recent tool activity → unused_seat alert.
            runWasteDetection(db, {inactivity_threshold_days: 14});
            return (db.prepare('SELECT id FROM waste_alerts LIMIT 1').get() as {id: string}).id;
        }

        it('resolves an alert, removing it from active and listing it in resolved', async () => {
            const id = seedAlert();

            const before = await app.inject({method: 'GET', url: '/api/waste', headers: authHeaders(adminToken)});
            expect((before.json() as {data: unknown[]}).data).toHaveLength(1);

            const resolve = await app.inject({
                method: 'POST',
                url: `/api/waste/${id}/resolve`,
                headers: authHeaders(adminToken),
                payload: {reason: 'justified'},
            });
            expect(resolve.statusCode).toBe(200);
            expect((resolve.json() as {data: {resolution: string}}).data.resolution).toBe('justified');

            const after = await app.inject({method: 'GET', url: '/api/waste', headers: authHeaders(adminToken)});
            expect((after.json() as {data: unknown[]}).data).toHaveLength(0);

            const resolved = await app.inject({method: 'GET', url: '/api/waste/resolved', headers: authHeaders(adminToken)});
            const list = (resolved.json() as {data: Array<{id: string; resolution: string}>}).data;
            expect(list).toHaveLength(1);
            expect(list[0].id).toBe(id);
            expect(list[0].resolution).toBe('justified');
        });

        it('rejects an invalid resolution reason with 400', async () => {
            const id = seedAlert();
            const res = await app.inject({
                method: 'POST',
                url: `/api/waste/${id}/resolve`,
                headers: authHeaders(adminToken),
                payload: {reason: 'because'},
            });
            expect(res.statusCode).toBe(400);
        });

        it('returns 404 for an unknown alert id', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/waste/missing/resolve',
                headers: authHeaders(adminToken),
                payload: {reason: 'dismissed'},
            });
            expect(res.statusCode).toBe(404);
        });

        it('returns 409 when the alert is already resolved', async () => {
            const id = seedAlert();
            await app.inject({method: 'POST', url: `/api/waste/${id}/resolve`, headers: authHeaders(adminToken), payload: {reason: 'dismissed'}});
            const again = await app.inject({
                method: 'POST',
                url: `/api/waste/${id}/resolve`,
                headers: authHeaders(adminToken),
                payload: {reason: 'dismissed'},
            });
            expect(again.statusCode).toBe(409);
        });

        it('returns an empty resolved list when nothing is resolved', async () => {
            const res = await app.inject({method: 'GET', url: '/api/waste/resolved', headers: authHeaders(adminToken)});
            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({data: []});
        });

        it('returns 403 for developer-role sessions', async () => {
            const id = seedAlert();
            const resolved = await app.inject({method: 'GET', url: '/api/waste/resolved', headers: authHeaders(devToken)});
            const resolve = await app.inject({
                method: 'POST',
                url: `/api/waste/${id}/resolve`,
                headers: authHeaders(devToken),
                payload: {reason: 'dismissed'},
            });
            expect(resolved.statusCode).toBe(403);
            expect(resolve.statusCode).toBe(403);
        });
    });
});
