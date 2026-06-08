import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {makeTestDb} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerSurveyRoutes} from '../../src/dashboard/api/surveys';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';
import {createManualSurvey} from '../../src/surveys/dispatch';
import {markSurveySent} from '../../src/surveys/store';

const PASSWORD = 'correct-horse-battery';
const NOW = '2026-05-30T00:00:00.000Z';

async function buildApp(db: Database.Database): Promise<FastifyInstance> {
    const app = Fastify({logger: false});
    registerSessionAuth(app, db);
    registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
    // No Slack client / a capturing emailer is unnecessary here — these tests
    // exercise the HTTP surface, not delivery (covered in dispatch.test.ts).
    registerSurveyRoutes(app, db, {});
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

async function seed(db: Database.Database): Promise<void> {
    db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run('eng', NOW);
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
        'alice', 'Alice', 'alice@test.com', 'eng', NOW,
    );
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
        'bob', 'Bob', 'bob@test.com', 'eng', NOW,
    );
    const hash = await hashPassword(PASSWORD);
    createUser(db, {email: 'alice@test.com', passwordHash: hash, role: 'developer', developerId: 'alice'});
    createUser(db, {email: 'bob@test.com', passwordHash: hash, role: 'developer', developerId: 'bob'});
    createUser(db, {email: 'admin@test.com', passwordHash: hash, role: 'admin'});
}

describe('survey API', () => {
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

    it('manager creates a manual survey, then sees it in the queue', async () => {
        const admin = await login(app, 'admin@test.com');
        const create = await app.inject({
            method: 'POST',
            url: '/api/surveys',
            headers: authHeaders(admin),
            payload: {developerId: 'alice', questionText: 'How is the new setup?'},
        });
        expect(create.statusCode).toBe(201);

        const queue = await app.inject({method: 'GET', url: '/api/surveys?status=queued', headers: authHeaders(admin)});
        expect(queue.statusCode).toBe(200);
        const body = queue.json() as {data: {developer_name: string; status: string}[]};
        expect(body.data).toHaveLength(1);
        expect(body.data[0].developer_name).toBe('Alice');
        expect(body.data[0].status).toBe('queued');
    });

    it('blocks non-admins from the manager queue', async () => {
        const alice = await login(app, 'alice@test.com');
        const res = await app.inject({method: 'GET', url: '/api/surveys', headers: authHeaders(alice)});
        // The session middleware confines developer-role accounts to /api/me/*.
        expect([401, 403]).toContain(res.statusCode);
    });

    it('developer sees and answers only their own sent survey', async () => {
        const survey = createManualSurvey(db, {developerId: 'alice', questionText: 'How is it going?'});
        markSurveySent(db, survey!.id, 'email');

        const alice = await login(app, 'alice@test.com');
        const mine = await app.inject({method: 'GET', url: '/api/me/surveys', headers: authHeaders(alice)});
        expect(mine.statusCode).toBe(200);
        expect((mine.json() as {data: unknown[]}).data).toHaveLength(1);

        const respond = await app.inject({
            method: 'POST',
            url: `/api/me/surveys/${survey!.id}/respond`,
            headers: authHeaders(alice),
            payload: {text: 'switched to Cursor'},
        });
        expect(respond.statusCode).toBe(200);
    });

    it('a developer cannot answer another developer’s survey (404, no leak)', async () => {
        const survey = createManualSurvey(db, {developerId: 'alice', questionText: 'Q?'});
        markSurveySent(db, survey!.id, 'email');

        const bob = await login(app, 'bob@test.com');
        const res = await app.inject({
            method: 'POST',
            url: `/api/me/surveys/${survey!.id}/respond`,
            headers: authHeaders(bob),
            payload: {text: 'nope'},
        });
        expect(res.statusCode).toBe(404);
        // Bob's own list is empty — he never saw Alice's survey.
        const mine = await app.inject({method: 'GET', url: '/api/me/surveys', headers: authHeaders(bob)});
        expect((mine.json() as {data: unknown[]}).data).toHaveLength(0);
    });

    it('developer can decline a survey', async () => {
        const survey = createManualSurvey(db, {developerId: 'alice', questionText: 'Q?'});
        markSurveySent(db, survey!.id, 'email');
        const alice = await login(app, 'alice@test.com');
        const res = await app.inject({
            method: 'POST',
            url: `/api/me/surveys/${survey!.id}/decline`,
            headers: authHeaders(alice),
        });
        expect(res.statusCode).toBe(200);
        const mine = await app.inject({method: 'GET', url: '/api/me/surveys', headers: authHeaders(alice)});
        const data = (mine.json() as {data: {status: string}[]}).data;
        expect(data[0].status).toBe('declined');
    });

    it('rejects an over-long manager question and an over-long response', async () => {
        const admin = await login(app, 'admin@test.com');
        const tooLongQuestion = 'x'.repeat(2001);
        const badCreate = await app.inject({
            method: 'POST',
            url: '/api/surveys',
            headers: authHeaders(admin),
            payload: {developerId: 'alice', questionText: tooLongQuestion},
        });
        expect(badCreate.statusCode).toBe(400);

        const survey = createManualSurvey(db, {developerId: 'alice', questionText: 'Q?'});
        markSurveySent(db, survey!.id, 'email');
        const alice = await login(app, 'alice@test.com');
        const badRespond = await app.inject({
            method: 'POST',
            url: `/api/me/surveys/${survey!.id}/respond`,
            headers: authHeaders(alice),
            payload: {text: 'y'.repeat(4001)},
        });
        expect(badRespond.statusCode).toBe(400);
    });

    it('drops over-long manual choices instead of storing them', async () => {
        const admin = await login(app, 'admin@test.com');
        const create = await app.inject({
            method: 'POST',
            url: '/api/surveys',
            headers: authHeaders(admin),
            payload: {
                developerId: 'alice',
                questionText: 'Pick one',
                choices: [
                    {value: 'ok', label: 'Fine'},
                    {value: 'x', label: 'y'.repeat(201)}, // over the per-choice cap
                ],
            },
        });
        expect(create.statusCode).toBe(201);
        const survey = (create.json() as {data: {choices: {value: string}[]}}).data;
        expect(survey.choices.map((c) => c.value)).toEqual(['ok']);
    });

    it('manager can dismiss a queued survey', async () => {
        const survey = createManualSurvey(db, {developerId: 'alice', questionText: 'Q?'});
        const admin = await login(app, 'admin@test.com');
        const res = await app.inject({
            method: 'POST',
            url: `/api/surveys/${survey!.id}/dismiss`,
            headers: authHeaders(admin),
        });
        expect(res.statusCode).toBe(200);
        const detail = await app.inject({
            method: 'GET',
            url: `/api/surveys/${survey!.id}`,
            headers: authHeaders(admin),
        });
        expect((detail.json() as {data: {status: string}}).data.status).toBe('dismissed');
    });
});
