import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import {Writable} from 'stream';
import type Database from 'better-sqlite3';
import {makeTestDb} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerMeRoutes} from '../../src/dashboard/api/me';
import {registerCaptureRoutes} from '../../src/dashboard/api/captures';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';
import {setGlobalSetting, setDeveloperPreference} from '../../src/settings/store';
import {buildCapturePayload, type CaptureWirePayload} from '../../src/capture/client';
import {generateDeveloperKey} from '../../src/capture/encryption';

const PASSWORD = 'correct-horse-battery';
const NOW = '2026-06-15T00:00:00.000Z';
const SECRET_PLAINTEXT = 'prompt: SUPERSECRETMARKER refactor the billing code';

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

function makePayload(mechanism: 'local_agent' | 'editor_extension', plaintext = SECRET_PLAINTEXT): CaptureWirePayload {
    return buildCapturePayload(
        {key: generateDeveloperKey(), keyId: 'k1', mechanism},
        {sessionId: 'sess-1', plaintext, tool: 'claude_code', promptCount: 1, capturedAt: NOW},
    );
}

describe('Capture API (Task 5.4)', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let logs: string;
    let aliceToken: string;
    let bobToken: string;
    let aliceUserId: string;

    beforeEach(async () => {
        db = makeTestDb();
        const hash = await hashPassword(PASSWORD);

        db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run('eng', NOW);
        seedDeveloper(db, 'alice', 'eng');
        seedDeveloper(db, 'bob', 'eng');

        const alice = createUser(db, {email: 'alice@test.com', passwordHash: hash, role: 'developer', developerId: 'alice'});
        createUser(db, {email: 'bob@test.com', passwordHash: hash, role: 'developer', developerId: 'bob'});
        aliceUserId = alice.id;

        // Org permits capture; both developers opt in.
        setGlobalSetting(db, 'coaching_capture_permitted', true);
        setDeveloperPreference(db, alice.id, 'capture_opt_in', true);
        const bob = db.prepare('SELECT id FROM users WHERE email = ?').get('bob@test.com') as {id: string};
        setDeveloperPreference(db, bob.id, 'capture_opt_in', true);

        // Capture all server log output so we can assert plaintext never appears in it.
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
        registerMeRoutes(app, db);
        registerCaptureRoutes(app, db);
        await app.ready();

        const loginA = await app.inject({method: 'POST', url: '/api/auth/login', payload: {email: 'alice@test.com', password: PASSWORD}});
        aliceToken = cookieToken(loginA);
        const loginB = await app.inject({method: 'POST', url: '/api/auth/login', payload: {email: 'bob@test.com', password: PASSWORD}});
        bobToken = cookieToken(loginB);
    });

    afterEach(async () => {
        await app.close();
        db.close();
    });

    it('requires authentication to ingest', async () => {
        const res = await app.inject({method: 'POST', url: '/api/me/captures', payload: makePayload('local_agent')});
        expect(res.statusCode).toBe(401);
    });

    it('ingests a client-encrypted capture and stores ONLY ciphertext — never plaintext, in DB or logs', async () => {
        const payload = makePayload('local_agent');
        const res = await app.inject({method: 'POST', url: '/api/me/captures', headers: auth(aliceToken), payload});
        expect(res.statusCode).toBe(201);

        // The stored row must not contain the plaintext anywhere.
        const row = db.prepare('SELECT * FROM prompt_captures WHERE developer_id = ?').get('alice') as Record<string, unknown>;
        const serializedRow = JSON.stringify(row) + String((row.ciphertext as Buffer).toString('latin1'));
        expect(serializedRow).not.toContain('SUPERSECRETMARKER');
        // The ciphertext round-trips to exactly what the client sent.
        expect((row.ciphertext as Buffer).toString('base64')).toBe(payload.ciphertext);
        // And the server logs never carried the plaintext either.
        expect(logs).not.toContain('SUPERSECRETMARKER');
    });

    it('is INERT (403) when the developer has not opted in (gate enforced live)', async () => {
        setDeveloperPreference(db, aliceUserId, 'capture_opt_in', false);
        const res = await app.inject({method: 'POST', url: '/api/me/captures', headers: auth(aliceToken), payload: makePayload('local_agent')});
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('capture_not_enabled');
        // Nothing was stored.
        expect(db.prepare('SELECT COUNT(*) c FROM prompt_captures').get()).toMatchObject({c: 0});
    });

    it('is INERT (403) when the org revokes capture permission, even though the developer opted in', async () => {
        setGlobalSetting(db, 'coaching_capture_permitted', false);
        const res = await app.inject({method: 'POST', url: '/api/me/captures', headers: auth(aliceToken), payload: makePayload('local_agent')});
        expect(res.statusCode).toBe(403);
    });

    it('accepts BOTH mechanisms and records the mechanism per capture', async () => {
        for (const mechanism of ['local_agent', 'editor_extension'] as const) {
            const res = await app.inject({method: 'POST', url: '/api/me/captures', headers: auth(aliceToken), payload: makePayload(mechanism)});
            expect(res.statusCode).toBe(201);
            expect(res.json().data.mechanism).toBe(mechanism);
        }
        const list = await app.inject({method: 'GET', url: '/api/me/captures', headers: auth(aliceToken)});
        const mechanisms = (list.json().data as Array<{mechanism: string}>).map((c) => c.mechanism).sort();
        expect(mechanisms).toEqual(['editor_extension', 'local_agent']);
    });

    it('rejects a payload that carries plaintext fields (encryption must be client-side)', async () => {
        const payload = {...makePayload('local_agent'), prompts: SECRET_PLAINTEXT};
        const res = await app.inject({method: 'POST', url: '/api/me/captures', headers: auth(aliceToken), payload});
        expect(res.statusCode).toBe(400);
        expect(db.prepare('SELECT COUNT(*) c FROM prompt_captures').get()).toMatchObject({c: 0});
    });

    it('rejects encryption_meta that smuggles a raw key', async () => {
        const payload = makePayload('local_agent');
        const withKey = {...payload, encryption_meta: {...payload.encryption_meta, key: 'deadbeef'}};
        const res = await app.inject({method: 'POST', url: '/api/me/captures', headers: auth(aliceToken), payload: withKey});
        expect(res.statusCode).toBe(400);
    });

    it('rejects malformed bodies (missing ciphertext, bad mechanism)', async () => {
        const base = makePayload('local_agent');
        const noCipher = {...base, ciphertext: undefined};
        const badMech = {...base, mechanism: 'telepathy'};
        for (const payload of [noCipher, badMech]) {
            const res = await app.inject({method: 'POST', url: '/api/me/captures', headers: auth(aliceToken), payload});
            expect(res.statusCode).toBe(400);
        }
    });

    it('scopes captures to the developer — one developer can never read another\'s', async () => {
        const created = await app.inject({method: 'POST', url: '/api/me/captures', headers: auth(aliceToken), payload: makePayload('local_agent')});
        const id = created.json().data.id as string;

        // bob lists his own (empty) and cannot fetch alice's capture by id.
        const bobList = await app.inject({method: 'GET', url: '/api/me/captures', headers: auth(bobToken)});
        expect(bobList.json().data).toHaveLength(0);
        const bobFetch = await app.inject({method: 'GET', url: `/api/me/captures/${id}`, headers: auth(bobToken)});
        expect(bobFetch.statusCode).toBe(404);

        // alice can fetch her own, with ciphertext.
        const aliceFetch = await app.inject({method: 'GET', url: `/api/me/captures/${id}`, headers: auth(aliceToken)});
        expect(aliceFetch.statusCode).toBe(200);
        expect(aliceFetch.json().data.ciphertext).toBeTruthy();
    });

    it('lets a developer delete their own capture but not another\'s', async () => {
        const created = await app.inject({method: 'POST', url: '/api/me/captures', headers: auth(aliceToken), payload: makePayload('local_agent')});
        const id = created.json().data.id as string;

        const bobDelete = await app.inject({method: 'DELETE', url: `/api/me/captures/${id}`, headers: auth(bobToken)});
        expect(bobDelete.statusCode).toBe(404);
        const aliceDelete = await app.inject({method: 'DELETE', url: `/api/me/captures/${id}`, headers: auth(aliceToken)});
        expect(aliceDelete.statusCode).toBe(200);
        expect(db.prepare('SELECT COUNT(*) c FROM prompt_captures').get()).toMatchObject({c: 0});
    });
});
