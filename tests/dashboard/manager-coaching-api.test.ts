import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {makeTestDb} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerMeRoutes} from '../../src/dashboard/api/me';
import {registerManagerCoachingRoutes} from '../../src/dashboard/api/manager-coaching';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';
import {setGlobalSetting, setDeveloperPreference} from '../../src/settings/store';
import {insertLoopEvent, insertNudgeEvent} from '../../src/coaching/realtime/store';

const PASSWORD = 'correct-horse-battery';
const NOW = '2026-06-15T00:00:00.000Z';
const IN_WINDOW = '2026-06-10T12:00:00.000Z';

async function buildApp(db: Database.Database): Promise<FastifyInstance> {
    const app = Fastify({logger: false});
    registerSessionAuth(app, db);
    registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
    registerMeRoutes(app, db);
    registerManagerCoachingRoutes(app, db);
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

function auth(token: string): Record<string, string> {
    return {cookie: `${SESSION_COOKIE}=${token}`};
}

function seedTeam(db: Database.Database, name: string): void {
    db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run(name, NOW);
}

function seedDeveloper(db: Database.Database, id: string, team: string): void {
    db.prepare(
        'INSERT INTO developers (id, external_ids, name, email, team, created_at) VALUES (?, NULL, ?, ?, ?, ?)',
    ).run(id, id, `${id}@example.com`, team, NOW);
}

describe('Manager coaching panel API (Task 5.11)', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let devToken: string;
    let adminToken: string;

    beforeEach(async () => {
        db = makeTestDb();
        const hash = await hashPassword(PASSWORD);

        seedTeam(db, 'eng');
        seedDeveloper(db, 'alice', 'eng');
        seedDeveloper(db, 'bob', 'eng');
        seedDeveloper(db, 'carol', 'eng');

        // alice is a developer-role account linked to her developer profile.
        createUser(db, {email: 'alice@test.com', passwordHash: hash, role: 'developer', developerId: 'alice'});
        createUser(db, {email: 'admin@test.com', passwordHash: hash, role: 'admin'});

        app = await buildApp(db);
        devToken = await login(app, 'alice@test.com');
        adminToken = await login(app, 'admin@test.com');
    });

    afterEach(async () => {
        await app.close();
        db.close();
    });

    it('requires authentication', async () => {
        for (const url of ['/api/coaching/manager/org', '/api/coaching/manager/team/eng']) {
            const res = await app.inject({method: 'GET', url});
            expect(res.statusCode, url).toBe(401);
        }
    });

    it('confines the developer role — the manager panel is 403 for a developer', async () => {
        for (const url of ['/api/coaching/manager/org', '/api/coaching/manager/team/eng']) {
            const res = await app.inject({method: 'GET', url, headers: auth(devToken)});
            expect(res.statusCode, url).toBe(403);
        }
    });

    it('serves the admin the org + team panel', async () => {
        for (const url of ['/api/coaching/manager/org', '/api/coaching/manager/team/eng']) {
            const res = await app.inject({method: 'GET', url, headers: auth(adminToken)});
            expect(res.statusCode, url).toBe(200);
            const data = res.json().data;
            expect(data).toHaveProperty('pr_review');
            expect(data).toHaveProperty('available');
            expect(data).toHaveProperty('loop_nudge');
            expect(data).toHaveProperty('opportunities');
        }
    });

    it('404s an unknown team rather than leaking an empty panel', async () => {
        const res = await app.inject({method: 'GET', url: '/api/coaching/manager/team/nope', headers: auth(adminToken)});
        expect(res.statusCode).toBe(404);
    });

    it('NO route accepts a developer id — there is no individual drill-down', async () => {
        // Plausible "drill-down" shapes a manager might try. All must miss (404),
        // proving there is no manager path to one developer's coaching.
        for (const url of [
            '/api/coaching/manager/developer/alice',
            '/api/coaching/manager/org/alice',
            '/api/coaching/manager/team/eng/alice',
            '/api/coaching/manager/team/eng/developer/alice',
        ]) {
            const res = await app.inject({method: 'GET', url, headers: auth(adminToken)});
            expect(res.statusCode, url).toBe(404);
        }
    });

    it('aggregates capture-derived loop/nudge data from OPTED-IN developers only, and never leaks an id', async () => {
        setGlobalSetting(db, 'coaching_capture_permitted', true);
        const hash = await hashPassword(PASSWORD);
        // Link bob & carol to opted-in accounts; alice is NOT opted in.
        const bob = createUser(db, {email: 'bob@test.com', passwordHash: hash, role: 'developer', developerId: 'bob'});
        const carol = createUser(db, {email: 'carol@test.com', passwordHash: hash, role: 'developer', developerId: 'carol'});
        setDeveloperPreference(db, bob.id, 'capture_opt_in', true);
        setDeveloperPreference(db, carol.id, 'capture_opt_in', true);
        // alice's account exists but never opted in.

        for (const id of ['alice', 'bob', 'carol']) {
            insertLoopEvent(db, id, {sessionId: 's', detectedAt: IN_WINDOW, similarPromptCount: 3});
            insertNudgeEvent(db, id, {sessionId: 's', nudgeType: 'missing_context', deliveredAt: IN_WINDOW});
        }

        const res = await app.inject({method: 'GET', url: '/api/coaching/manager/team/eng', headers: auth(adminToken)});
        expect(res.statusCode).toBe(200);
        const data = res.json().data;
        expect(data.loop_nudge.enabled).toBe(true);
        // Only bob + carol opted in → 2 eligible → below the floor of 3 → the cells
        // AND the exact eligibility count are suppressed (null), so a manager can't
        // read off which individual opted in within this small scope.
        expect(data.loop_nudge.opted_in_developers).toBeNull();
        expect(data.loop_nudge.loops.suppressed).toBe(true);
        // The privacy regression guard: no developer id anywhere in the payload.
        for (const id of ['alice', 'bob', 'carol']) {
            expect(res.payload.includes(id)).toBe(false);
        }
    });
});
