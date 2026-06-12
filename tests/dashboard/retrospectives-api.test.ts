import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import {Writable} from 'stream';
import type Database from 'better-sqlite3';
import {makeTestDb} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerRetrospectiveRoutes} from '../../src/dashboard/api/retrospectives';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';
import {setGlobalSetting, setDeveloperPreference} from '../../src/settings/store';
import {insertCapture} from '../../src/capture/store';
import {buildCapturePayload} from '../../src/capture/client';
import {generateDeveloperKey} from '../../src/capture/encryption';
import {LocalHeuristicAnalyzer, type AnalysisResult, type RetrospectiveAnalyzer, type SessionAnalysisInput} from '../../src/coaching/retrospective/analyzer';
import type {RetrospectiveAnalyzers} from '../../src/coaching/retrospective/generator';

const PASSWORD = 'correct-horse-battery';
const NOW = '2026-06-15T00:00:00.000Z';
const SESSION = 'sess-1';
const SECRET = 'SUPERSECRETMARKER refactor the billing code in src/billing.ts';

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

function seedCapture(db: Database.Database, developerId: string, key: Buffer, plaintext: string): void {
    const payload = buildCapturePayload(
        {key, keyId: 'k1', mechanism: 'local_agent'},
        {sessionId: SESSION, plaintext, capturedAt: NOW, tool: 'claude_code', promptCount: 1},
    );
    insertCapture(db, {
        developerId,
        sessionId: payload.session_id,
        capturedAt: payload.captured_at,
        tool: payload.tool ?? null,
        ciphertext: Buffer.from(payload.ciphertext, 'base64'),
        encryptionMeta: payload.encryption_meta as unknown as Record<string, unknown>,
        mechanism: 'local_agent',
        promptCount: 1,
    });
}

function fakeCloud(): RetrospectiveAnalyzer {
    return {
        location: 'cloud',
        model: 'cloud-test-model',
        analyze(_input: SessionAnalysisInput): AnalysisResult {
            return {retrospectiveText: 'cloud narrative', highlights: {worked: ['w'], improve: ['i']}};
        },
        followUp(): string {
            return 'cloud follow-up answer';
        },
    };
}

describe('Retrospective API (Task 5.7)', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let logs: string;
    let aliceToken: string;
    let bobToken: string;
    let adminToken: string;
    let aliceUserId: string;
    let key: Buffer;

    async function boot(analyzers?: RetrospectiveAnalyzers): Promise<void> {
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
        registerRetrospectiveRoutes(app, db, analyzers);
        await app.ready();

        const loginA = await app.inject({method: 'POST', url: '/api/auth/login', payload: {email: 'alice@test.com', password: PASSWORD}});
        aliceToken = cookieToken(loginA);
        const loginB = await app.inject({method: 'POST', url: '/api/auth/login', payload: {email: 'bob@test.com', password: PASSWORD}});
        bobToken = cookieToken(loginB);
        const loginAdmin = await app.inject({method: 'POST', url: '/api/auth/login', payload: {email: 'admin@test.com', password: PASSWORD}});
        adminToken = cookieToken(loginAdmin);
    }

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

        // Org permits capture; both developers opt in. Cloud analysis stays off by default.
        setGlobalSetting(db, 'coaching_capture_permitted', true);
        setDeveloperPreference(db, alice.id, 'capture_opt_in', true);
        setDeveloperPreference(db, bob.id, 'capture_opt_in', true);

        key = generateDeveloperKey();
        seedCapture(db, 'alice', key, `prompt: ${SECRET}`);
    });

    afterEach(async () => {
        await app.close();
        db.close();
    });

    it('generates a retrospective from a captured session (local default) and reads it back', async () => {
        await boot();
        const res = await app.inject({
            method: 'POST',
            url: '/api/me/retrospectives',
            headers: auth(aliceToken),
            payload: {session_id: SESSION, key: key.toString('base64')},
        });
        expect(res.statusCode).toBe(201);
        const retro = res.json().data;
        expect(retro.analysisLocation).toBe('local');
        expect(retro.retrospectiveText.length).toBeGreaterThan(0);

        const list = await app.inject({method: 'GET', url: '/api/me/retrospectives', headers: auth(aliceToken)});
        expect(list.json().data).toHaveLength(1);

        const one = await app.inject({method: 'GET', url: `/api/me/retrospectives/${retro.id}`, headers: auth(aliceToken)});
        expect(one.statusCode).toBe(200);
        expect(one.json().data.analysisLocation).toBe('local');
    });

    it('never writes the plaintext or the key to the server logs (verified)', async () => {
        await boot();
        const res = await app.inject({
            method: 'POST',
            url: '/api/me/retrospectives',
            headers: auth(aliceToken),
            payload: {session_id: SESSION, key: key.toString('base64')},
        });
        expect(res.statusCode).toBe(201);
        expect(logs).not.toContain('SUPERSECRETMARKER');
        expect(logs).not.toContain(key.toString('base64'));
    });

    it('is inert (403) when capture is not enabled for the developer', async () => {
        setDeveloperPreference(db, aliceUserId, 'capture_opt_in', false);
        await boot();
        const res = await app.inject({
            method: 'POST',
            url: '/api/me/retrospectives',
            headers: auth(aliceToken),
            payload: {session_id: SESSION, key: key.toString('base64')},
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('capture_not_enabled');
    });

    it('refuses cloud analysis when the org has not permitted it (opt-in #2 gate)', async () => {
        // Developer opts into cloud, but the org permission is still off.
        setDeveloperPreference(db, aliceUserId, 'cloud_analysis_opt_in', true);
        await boot({local: new LocalHeuristicAnalyzer(), cloud: fakeCloud()});
        const res = await app.inject({
            method: 'POST',
            url: '/api/me/retrospectives',
            headers: auth(aliceToken),
            payload: {session_id: SESSION, key: key.toString('base64'), analysis_location: 'cloud'},
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('cloud_not_allowed');
    });

    it('runs cloud analysis only when org permits AND developer opted in', async () => {
        setGlobalSetting(db, 'coaching_cloud_analysis_permitted', true);
        setDeveloperPreference(db, aliceUserId, 'cloud_analysis_opt_in', true);
        await boot({local: new LocalHeuristicAnalyzer(), cloud: fakeCloud()});
        const res = await app.inject({
            method: 'POST',
            url: '/api/me/retrospectives',
            headers: auth(aliceToken),
            payload: {session_id: SESSION, key: key.toString('base64'), analysis_location: 'cloud'},
        });
        expect(res.statusCode).toBe(201);
        expect(res.json().data.analysisLocation).toBe('cloud');
        expect(res.json().data.analysisModel).toBe('cloud-test-model');
    });

    it('keeps retrospectives private — another developer cannot read one', async () => {
        await boot();
        const gen = await app.inject({
            method: 'POST',
            url: '/api/me/retrospectives',
            headers: auth(aliceToken),
            payload: {session_id: SESSION, key: key.toString('base64')},
        });
        const id = gen.json().data.id;
        const bobRead = await app.inject({method: 'GET', url: `/api/me/retrospectives/${id}`, headers: auth(bobToken)});
        expect(bobRead.statusCode).toBe(404);
        expect(await (await app.inject({method: 'GET', url: '/api/me/retrospectives', headers: auth(bobToken)})).json().data).toHaveLength(0);
    });

    it('gives no manager/admin a path to any retrospective', async () => {
        await boot();
        // An admin has no linked developer profile, so /api/me/* yields 404 — there is
        // structurally no manager route over retrospectives.
        const adminList = await app.inject({method: 'GET', url: '/api/me/retrospectives', headers: auth(adminToken)});
        expect(adminList.statusCode).toBe(404);
    });

    it('answers a conversational follow-up, privately, on the developer’s own retrospective', async () => {
        await boot();
        const gen = await app.inject({
            method: 'POST',
            url: '/api/me/retrospectives',
            headers: auth(aliceToken),
            payload: {session_id: SESSION, key: key.toString('base64')},
        });
        const id = gen.json().data.id;
        const followup = await app.inject({
            method: 'POST',
            url: `/api/me/retrospectives/${id}/followup`,
            headers: auth(aliceToken),
            payload: {question: 'why was this flagged?', key: key.toString('base64')},
        });
        expect(followup.statusCode).toBe(200);
        expect(typeof followup.json().data.answer).toBe('string');
        expect(followup.json().data.analysisLocation).toBe('local');

        // Another developer cannot follow up on it (404, owner-scoped).
        const bobFollow = await app.inject({
            method: 'POST',
            url: `/api/me/retrospectives/${id}/followup`,
            headers: auth(bobToken),
            payload: {question: 'why?', key: key.toString('base64')},
        });
        expect(bobFollow.statusCode).toBe(404);
    });

    it('deletes the developer’s own retrospective', async () => {
        await boot();
        const gen = await app.inject({
            method: 'POST',
            url: '/api/me/retrospectives',
            headers: auth(aliceToken),
            payload: {session_id: SESSION, key: key.toString('base64')},
        });
        const id = gen.json().data.id;
        const del = await app.inject({method: 'DELETE', url: `/api/me/retrospectives/${id}`, headers: auth(aliceToken)});
        expect(del.statusCode).toBe(200);
        const after = await app.inject({method: 'GET', url: `/api/me/retrospectives/${id}`, headers: auth(aliceToken)});
        expect(after.statusCode).toBe(404);
    });

    it('rejects a key that is not a 32-byte base64 value', async () => {
        await boot();
        const res = await app.inject({
            method: 'POST',
            url: '/api/me/retrospectives',
            headers: auth(aliceToken),
            payload: {session_id: SESSION, key: Buffer.from('too-short').toString('base64')},
        });
        expect(res.statusCode).toBe(400);
    });

    it('returns 422 when the supplied key cannot decrypt the session', async () => {
        await boot();
        const wrong = generateDeveloperKey();
        const res = await app.inject({
            method: 'POST',
            url: '/api/me/retrospectives',
            headers: auth(aliceToken),
            payload: {session_id: SESSION, key: wrong.toString('base64')},
        });
        expect(res.statusCode).toBe(422);
        expect(res.json().code).toBe('decrypt_failed');
    });

    it('returns 404 when the session has no captures', async () => {
        await boot();
        const res = await app.inject({
            method: 'POST',
            url: '/api/me/retrospectives',
            headers: auth(aliceToken),
            payload: {session_id: 'no-such-session', key: key.toString('base64')},
        });
        expect(res.statusCode).toBe(404);
        expect(res.json().code).toBe('no_captures');
    });
});
