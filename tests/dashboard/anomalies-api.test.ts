import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {makeTestDb} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerAnomalyRoutes} from '../../src/dashboard/api/anomalies';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';
import {upsertAnomaly, type UpsertAnomalyInput} from '../../src/anomaly/store';

const PASSWORD = 'correct-horse-battery';
const NOW = '2026-05-30T00:00:00.000Z';

async function buildApp(db: Database.Database): Promise<FastifyInstance> {
    const app = Fastify({logger: false});
    registerSessionAuth(app, db);
    registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
    registerAnomalyRoutes(app, db);
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

const teamAnomaly = (overrides: Partial<UpsertAnomalyInput> = {}): UpsertAnomalyInput => ({
    scope: 'team',
    scopeId: 'frontend',
    metric: 'commits',
    period: '2026-05-04',
    method: 'statistical',
    observedValue: 4,
    expectedValue: 10,
    deviation: -3.1,
    severity: 'high',
    basis: 'git_estimate',
    ...overrides,
});

async function seed(db: Database.Database): Promise<void> {
    db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run('frontend', NOW);
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
        'alice', 'Alice', 'alice@test.com', 'frontend', NOW,
    );
    const hash = await hashPassword(PASSWORD);
    createUser(db, {email: 'alice@test.com', passwordHash: hash, role: 'developer', developerId: 'alice'});
    createUser(db, {email: 'admin@test.com', passwordHash: hash, role: 'admin'});
}

describe('anomalies API', () => {
    let db: Database.Database;
    let app: FastifyInstance;

    beforeEach(async () => {
        db = makeTestDb();
        await seed(db);
        app = await buildApp(db);
    });
    afterEach(async () => {
        await app.close();
        db.close();
    });

    it('lists open team anomalies with honest labels + description', async () => {
        upsertAnomaly(db, teamAnomaly());
        const admin = await login(app, 'admin@test.com');
        const res = await app.inject({method: 'GET', url: '/api/anomalies', headers: authHeaders(admin)});
        expect(res.statusCode).toBe(200);
        const body = res.json() as {data: Record<string, unknown>[]};
        expect(body.data).toHaveLength(1);
        expect(body.data[0]).toMatchObject({
            team: 'frontend',
            metric: 'commits',
            metric_label: 'commit activity',
            severity: 'high',
            basis: 'git_estimate',
            basis_label: 'git-based estimate',
            direction: 'decrease',
            change_pct: -60,
            description: 'Commit activity dropped 60%',
            status: 'open',
        });
    });

    it('never lists developer-scope anomalies (individual data)', async () => {
        upsertAnomaly(db, teamAnomaly({scope: 'developer', scopeId: 'alice'}));
        upsertAnomaly(db, teamAnomaly({metric: 'cost', method: 'percentage_change'}));
        const admin = await login(app, 'admin@test.com');
        const res = await app.inject({method: 'GET', url: '/api/anomalies', headers: authHeaders(admin)});
        const body = res.json() as {data: {scope: string; metric: string}[]};
        expect(body.data).toHaveLength(1);
        expect(body.data[0].metric).toBe('cost');
        expect(body.data.every((a) => a.scope === 'team')).toBe(true);
    });

    it('acknowledge removes the anomaly from the open list', async () => {
        upsertAnomaly(db, teamAnomaly());
        const admin = await login(app, 'admin@test.com');
        const open = await app.inject({method: 'GET', url: '/api/anomalies', headers: authHeaders(admin)});
        const anomalyId = (open.json() as {data: {id: string}[]}).data[0].id;

        const ack = await app.inject({
            method: 'POST',
            url: `/api/anomalies/${anomalyId}/acknowledge`,
            headers: authHeaders(admin),
        });
        expect(ack.statusCode).toBe(200);
        expect((ack.json() as {data: {status: string}}).data.status).toBe('acknowledged');

        const stillOpen = await app.inject({method: 'GET', url: '/api/anomalies', headers: authHeaders(admin)});
        expect((stillOpen.json() as {data: unknown[]}).data).toHaveLength(0);

        const acknowledged = await app.inject({
            method: 'GET',
            url: '/api/anomalies?status=acknowledged',
            headers: authHeaders(admin),
        });
        expect((acknowledged.json() as {data: unknown[]}).data).toHaveLength(1);
    });

    it('resolve removes the anomaly from the open list', async () => {
        upsertAnomaly(db, teamAnomaly());
        const admin = await login(app, 'admin@test.com');
        const open = await app.inject({method: 'GET', url: '/api/anomalies', headers: authHeaders(admin)});
        const anomalyId = (open.json() as {data: {id: string}[]}).data[0].id;

        const resolve = await app.inject({
            method: 'POST',
            url: `/api/anomalies/${anomalyId}/resolve`,
            headers: authHeaders(admin),
        });
        expect(resolve.statusCode).toBe(200);
        expect((resolve.json() as {data: {status: string}}).data.status).toBe('resolved');

        const stillOpen = await app.inject({method: 'GET', url: '/api/anomalies', headers: authHeaders(admin)});
        expect((stillOpen.json() as {data: unknown[]}).data).toHaveLength(0);
    });

    it('404s acknowledging a developer-scope anomaly (not a manager surface)', async () => {
        upsertAnomaly(db, teamAnomaly({scope: 'developer', scopeId: 'alice'}));
        const devAnomalyId = db.prepare("SELECT id FROM anomalies WHERE scope = 'developer'").get() as {id: string};
        const admin = await login(app, 'admin@test.com');
        const res = await app.inject({
            method: 'POST',
            url: `/api/anomalies/${devAnomalyId.id}/acknowledge`,
            headers: authHeaders(admin),
        });
        expect(res.statusCode).toBe(404);
    });

    it('404s an unknown id', async () => {
        const admin = await login(app, 'admin@test.com');
        const res = await app.inject({
            method: 'POST',
            url: '/api/anomalies/nope/resolve',
            headers: authHeaders(admin),
        });
        expect(res.statusCode).toBe(404);
    });

    it('rejects an unknown status filter', async () => {
        const admin = await login(app, 'admin@test.com');
        const res = await app.inject({method: 'GET', url: '/api/anomalies?status=bogus', headers: authHeaders(admin)});
        expect(res.statusCode).toBe(400);
    });

    it('blocks non-admins from the manager anomalies surface', async () => {
        upsertAnomaly(db, teamAnomaly());
        const dev = await login(app, 'alice@test.com');
        const res = await app.inject({method: 'GET', url: '/api/anomalies', headers: authHeaders(dev)});
        expect(res.statusCode).toBe(403);
    });
});
