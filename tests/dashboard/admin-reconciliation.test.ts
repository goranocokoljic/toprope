import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import {makeTestDb, seedFixtures} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerMeRoutes} from '../../src/dashboard/api/me';
import {registerAdminRoutes} from '../../src/dashboard/api/admin';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';

const PASSWORD = 'correct-horse-battery';
const PERIOD = '2026-06';

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

async function login(app: FastifyInstance, email: string): Promise<string> {
    const res = await app.inject({method: 'POST', url: '/api/auth/login', payload: {email, password: PASSWORD}});
    return res.statusCode === 200 ? cookieToken(res) : '';
}

function authHeaders(token: string): Record<string, string> {
    return {cookie: `${SESSION_COOKIE}=${token}`};
}

function seedExpenseCharge(db: Database.Database, developerId: string, tool: string, cost: number): void {
    const id = randomUUID();
    db.prepare(
        `INSERT INTO expense_charges
           (id, dedup_key, developer_id, tool, plan, amount, period, charge_type,
            monthly_cost, billing_model, match_status, source_profile, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, 'recurring_monthly', ?, 'reimbursed', 'matched', 'standard', ?)`,
    ).run(id, id, developerId, tool, cost, PERIOD, cost, '2026-06-15T00:00:00.000Z');
}

function seedSubscription(db: Database.Database, developerId: string, tool: string, cost: number, model: string): void {
    db.prepare(
        `INSERT INTO subscriptions
           (id, developer_id, tool, plan, billing_model, monthly_cost, seat_assigned_at, data_source)
         VALUES (?, ?, ?, NULL, ?, ?, '2026-06-01T00:00:00.000Z', 'csv')`,
    ).run(randomUUID(), developerId, tool, model, cost);
}

describe('admin reconciliation API', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let adminToken: string;
    let devToken: string;

    beforeEach(async () => {
        db = makeTestDb();
        seedFixtures(db);
        // dev-3 (Carol) has an expense but no subscription → expense_no_subscription.
        seedExpenseCharge(db, 'dev-3', 'cursor', 20);
        // dev-3 reimbursed seat with no expense → subscription_no_expense.
        seedSubscription(db, 'dev-3', 'windsurf', 15, 'reimbursed');
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

    it('rejects every reconciliation endpoint for a developer session (403)', async () => {
        const endpoints: {method: 'GET' | 'POST'; url: string}[] = [
            {method: 'GET', url: '/api/admin/reconciliation'},
            {method: 'POST', url: '/api/admin/reconciliation/run'},
            {method: 'POST', url: '/api/admin/reconciliation/some-id/resolve'},
            {method: 'POST', url: '/api/admin/reconciliation/some-id/ignore'},
        ];
        for (const ep of endpoints) {
            const res = await app.inject({
                method: ep.method,
                url: ep.url,
                headers: authHeaders(devToken),
                payload: ep.method === 'POST' ? {} : undefined,
            });
            expect(res.statusCode, `${ep.method} ${ep.url}`).toBe(403);
        }
    });

    it('runs reconciliation and lists open results', async () => {
        const run = await app.inject({
            method: 'POST',
            url: '/api/admin/reconciliation/run',
            headers: authHeaders(adminToken),
            payload: {period: PERIOD},
        });
        expect(run.statusCode).toBe(200);
        const summary = run.json().data;
        expect(summary.period).toBe(PERIOD);
        expect(summary.byType.expense_no_subscription).toBe(1);
        expect(summary.byType.subscription_no_expense).toBe(1);

        const list = await app.inject({
            method: 'GET',
            url: '/api/admin/reconciliation',
            headers: authHeaders(adminToken),
        });
        expect(list.statusCode).toBe(200);
        const rows = list.json().data;
        expect(rows).toHaveLength(2);
        expect(rows.every((r: {status: string}) => r.status === 'open')).toBe(true);
    });

    it('defaults the run period to the latest expense period', async () => {
        const run = await app.inject({
            method: 'POST',
            url: '/api/admin/reconciliation/run',
            headers: authHeaders(adminToken),
            payload: {},
        });
        expect(run.statusCode).toBe(200);
        expect(run.json().data.period).toBe(PERIOD);
    });

    it('resolves a result with a note', async () => {
        await app.inject({
            method: 'POST',
            url: '/api/admin/reconciliation/run',
            headers: authHeaders(adminToken),
            payload: {period: PERIOD},
        });
        const list = await app.inject({
            method: 'GET',
            url: '/api/admin/reconciliation',
            headers: authHeaders(adminToken),
        });
        const id = list.json().data[0].id;

        const resolve = await app.inject({
            method: 'POST',
            url: `/api/admin/reconciliation/${id}/resolve`,
            headers: authHeaders(adminToken),
            payload: {resolution: 'registered the seat'},
        });
        expect(resolve.statusCode).toBe(200);
        expect(resolve.json().data.status).toBe('resolved');
        expect(resolve.json().data.resolution).toBe('registered the seat');

        // No longer in the open queue.
        const open = await app.inject({
            method: 'GET',
            url: '/api/admin/reconciliation?status=open',
            headers: authHeaders(adminToken),
        });
        expect(open.json().data).toHaveLength(1);
    });

    it('rejects resolving without a note (400)', async () => {
        await app.inject({
            method: 'POST',
            url: '/api/admin/reconciliation/run',
            headers: authHeaders(adminToken),
            payload: {period: PERIOD},
        });
        const list = await app.inject({
            method: 'GET',
            url: '/api/admin/reconciliation',
            headers: authHeaders(adminToken),
        });
        const id = list.json().data[0].id;
        const res = await app.inject({
            method: 'POST',
            url: `/api/admin/reconciliation/${id}/resolve`,
            headers: authHeaders(adminToken),
            payload: {resolution: '   '},
        });
        expect(res.statusCode).toBe(400);
    });

    it('ignores a result (note optional)', async () => {
        await app.inject({
            method: 'POST',
            url: '/api/admin/reconciliation/run',
            headers: authHeaders(adminToken),
            payload: {period: PERIOD},
        });
        const list = await app.inject({
            method: 'GET',
            url: '/api/admin/reconciliation',
            headers: authHeaders(adminToken),
        });
        const id = list.json().data[0].id;
        const res = await app.inject({
            method: 'POST',
            url: `/api/admin/reconciliation/${id}/ignore`,
            headers: authHeaders(adminToken),
            payload: {},
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().data.status).toBe('ignored');
    });

    it('404s resolving an unknown id', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/admin/reconciliation/does-not-exist/resolve',
            headers: authHeaders(adminToken),
            payload: {resolution: 'x'},
        });
        expect(res.statusCode).toBe(404);
    });

    it('validates status and period query params (400)', async () => {
        const badStatus = await app.inject({
            method: 'GET',
            url: '/api/admin/reconciliation?status=bogus',
            headers: authHeaders(adminToken),
        });
        expect(badStatus.statusCode).toBe(400);

        const badPeriod = await app.inject({
            method: 'GET',
            url: '/api/admin/reconciliation?period=2026-6',
            headers: authHeaders(adminToken),
        });
        expect(badPeriod.statusCode).toBe(400);
    });
});
