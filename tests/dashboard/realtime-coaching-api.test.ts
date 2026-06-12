import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import {Writable} from 'stream';
import type Database from 'better-sqlite3';
import {makeTestDb} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerRealtimeCoachingRoutes} from '../../src/dashboard/api/realtime-coaching';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';
import {setDeveloperPreference} from '../../src/settings/store';

const PASSWORD = 'correct-horse-battery';
const NOW = '2026-06-15T00:00:00.000Z';

function seedDeveloper(db: Database.Database, id: string, team: string): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, `${id} Dev`, `${id}@test.com`, team, NOW);
}

function cookieToken(res: {headers: Record<string, unknown>}): string {
    const raw = res.headers['set-cookie'];
    const header = Array.isArray(raw) ? raw[0] : (raw as string);
    const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header);
    return match ? decodeURIComponent(match[1]) : '';
}

function auth(token: string): Record<string, string> {
    return {cookie: `${SESSION_COOKIE}=${token}`};
}

describe('Realtime coaching API (Task 5.6)', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let logs: string;
    let aliceToken: string;
    let bobToken: string;
    let adminToken: string;
    let aliceUserId: string;

    beforeEach(async () => {
        db = makeTestDb();
        const hash = await hashPassword(PASSWORD);

        db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run('eng', NOW);
        seedDeveloper(db, 'alice', 'eng');
        seedDeveloper(db, 'bob', 'eng');

        const alice = createUser(db, {email: 'alice@test.com', passwordHash: hash, role: 'developer', developerId: 'alice'});
        const bob = createUser(db, {email: 'bob@test.com', passwordHash: hash, role: 'developer', developerId: 'bob'});
        createUser(db, {email: 'admin@test.com', passwordHash: hash, role: 'admin'});
        aliceUserId = alice.id;

        // Nudges default ON for developers; make it explicit and ensure bob too.
        setDeveloperPreference(db, alice.id, 'nudges_enabled', true);
        setDeveloperPreference(db, bob.id, 'nudges_enabled', true);

        logs = '';
        const stream = new Writable({
            write(chunk, _enc, cb): void {
                logs += chunk.toString();
                cb();
            },
        });
        app = Fastify({logger: {level: 'trace', stream}});
        registerSessionAuth(app, db);
        registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
        registerRealtimeCoachingRoutes(app, db);
        await app.ready();

        const loginA = await app.inject({method: 'POST', url: '/api/auth/login', payload: {email: 'alice@test.com', password: PASSWORD}});
        aliceToken = cookieToken(loginA);
        const loginB = await app.inject({method: 'POST', url: '/api/auth/login', payload: {email: 'bob@test.com', password: PASSWORD}});
        bobToken = cookieToken(loginB);
        const loginAdmin = await app.inject({method: 'POST', url: '/api/auth/login', payload: {email: 'admin@test.com', password: PASSWORD}});
        adminToken = cookieToken(loginAdmin);
    });

    afterEach(async () => {
        await app.close();
        db.close();
    });

    it('records loop + nudge metadata and reads it back for the owner', async () => {
        const loop = await app.inject({
            method: 'POST',
            url: '/api/me/coaching/loop-events',
            headers: auth(aliceToken),
            payload: {session_id: 's1', detected_at: NOW, similar_prompt_count: 3},
        });
        expect(loop.statusCode).toBe(201);
        expect(loop.json().data.similarPromptCount).toBe(3);

        const nudge = await app.inject({
            method: 'POST',
            url: '/api/me/coaching/nudge-events',
            headers: auth(aliceToken),
            payload: {session_id: 's1', nudge_type: 'repeated_prompt', delivered_at: NOW},
        });
        expect(nudge.statusCode).toBe(201);

        const list = await app.inject({method: 'GET', url: '/api/me/coaching/nudge-events', headers: auth(aliceToken)});
        expect(list.json().data).toHaveLength(1);
        expect(list.json().data[0].dismissed).toBe(false);
    });

    it('rejects a body carrying prompt content (metadata only) and stores nothing', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/me/coaching/loop-events',
            headers: auth(aliceToken),
            payload: {session_id: 's1', similar_prompt_count: 3, prompt: 'SUPERSECRETMARKER do the thing'},
        });
        expect(res.statusCode).toBe(400);
        expect(db.prepare('SELECT COUNT(*) c FROM loop_events').get()).toMatchObject({c: 0});
        expect(logs).not.toContain('SUPERSECRETMARKER');
    });

    it('rejects ANY unexpected field via allowlist (not just known content names)', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/me/coaching/loop-events',
            headers: auth(aliceToken),
            // `transcript` is not on a guessed content denylist, but the allowlist refuses it.
            payload: {session_id: 's1', similar_prompt_count: 3, transcript: 'SUPERSECRETMARKER ...'},
        });
        expect(res.statusCode).toBe(400);
        expect(db.prepare('SELECT COUNT(*) c FROM loop_events').get()).toMatchObject({c: 0});
        expect(logs).not.toContain('SUPERSECRETMARKER');
    });

    it('rejects a similar_prompt_count below the loop floor (< 2), matching the detector', async () => {
        for (const count of [0, 1]) {
            const res = await app.inject({
                method: 'POST',
                url: '/api/me/coaching/loop-events',
                headers: auth(aliceToken),
                payload: {session_id: 's1', similar_prompt_count: count},
            });
            expect(res.statusCode).toBe(400);
        }
        expect(db.prepare('SELECT COUNT(*) c FROM loop_events').get()).toMatchObject({c: 0});
    });

    it('rejects an out-of-set nudge_type', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/me/coaching/nudge-events',
            headers: auth(aliceToken),
            payload: {session_id: 's1', nudge_type: 'totally_made_up', delivered_at: NOW},
        });
        expect(res.statusCode).toBe(400);
    });

    it('is INERT (403) when the developer disabled nudges (settings respected live)', async () => {
        setDeveloperPreference(db, aliceUserId, 'nudges_enabled', false);
        const res = await app.inject({
            method: 'POST',
            url: '/api/me/coaching/nudge-events',
            headers: auth(aliceToken),
            payload: {session_id: 's1', nudge_type: 'short_prompt', delivered_at: NOW},
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('nudges_not_enabled');
        expect(db.prepare('SELECT COUNT(*) c FROM nudge_events').get()).toMatchObject({c: 0});
    });

    it('dismissal is owner-scoped and never blocks: another developer cannot dismiss your nudge', async () => {
        const created = await app.inject({
            method: 'POST',
            url: '/api/me/coaching/nudge-events',
            headers: auth(aliceToken),
            payload: {session_id: 's1', nudge_type: 'missing_error', delivered_at: NOW},
        });
        const id = created.json().data.id as string;

        // Bob cannot dismiss Alice's nudge — 404, no cross-developer mutation.
        const asBob = await app.inject({method: 'POST', url: `/api/me/coaching/nudge-events/${id}/dismiss`, headers: auth(bobToken)});
        expect(asBob.statusCode).toBe(404);

        // Alice dismisses her own.
        const asAlice = await app.inject({method: 'POST', url: `/api/me/coaching/nudge-events/${id}/dismiss`, headers: auth(aliceToken)});
        expect(asAlice.statusCode).toBe(200);
        const list = await app.inject({method: 'GET', url: '/api/me/coaching/nudge-events', headers: auth(aliceToken)});
        expect(list.json().data[0].dismissed).toBe(true);
    });

    it('a developer only sees their own events (no cross-developer leakage)', async () => {
        await app.inject({
            method: 'POST',
            url: '/api/me/coaching/loop-events',
            headers: auth(aliceToken),
            payload: {session_id: 's1', similar_prompt_count: 4},
        });
        const bobList = await app.inject({method: 'GET', url: '/api/me/coaching/loop-events', headers: auth(bobToken)});
        expect(bobList.json().data).toHaveLength(0);
    });

    it('no manager/admin path: an admin has no developer profile, so /api/me coaching is 404', async () => {
        const list = await app.inject({method: 'GET', url: '/api/me/coaching/loop-events', headers: auth(adminToken)});
        // Admin reaches /api/me but has no linked developer → 404 (never another dev's data).
        expect(list.statusCode).toBe(404);
    });

    it('exposes the developer’s resolved realtime settings', async () => {
        const res = await app.inject({method: 'GET', url: '/api/me/coaching/realtime-settings', headers: auth(aliceToken)});
        expect(res.statusCode).toBe(200);
        expect(res.json().data).toMatchObject({enabled: true, frequency: 'normal', dismissible: true});
    });
});
