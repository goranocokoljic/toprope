import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import {Writable} from 'stream';
import type Database from 'better-sqlite3';
import {makeTestDb} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerImprovementReviewRoutes} from '../../src/dashboard/api/improvement-reviews';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';
import {setGlobalSetting, setDeveloperPreference} from '../../src/settings/store';
import {insertCapture} from '../../src/capture/store';
import {buildCapturePayload} from '../../src/capture/client';
import {generateDeveloperKey} from '../../src/capture/encryption';
import {
    LocalHeuristicImprovementAnalyzer,
    type ImprovementAnalyzer,
    type ImprovementResult,
    type SessionAnalysisInput,
} from '../../src/coaching/improvement/analyzer';
import type {ImprovementAnalyzers} from '../../src/coaching/improvement/generator';

const PASSWORD = 'correct-horse-battery';
const NOW = '2026-06-15T00:00:00.000Z';
const SESSION = 'sess-1';
// Two brief prompts and no error/code/path → guarantees specific, grounded suggestions.
const CONTENT = 'prompt: SUPERSECRETMARKER fix\nprompt: now\nprompt: please refactor the whole module entirely';

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

function fakeCloud(): ImprovementAnalyzer {
    return {
        location: 'cloud',
        model: 'cloud-test-model',
        analyze(_input: SessionAnalysisInput): ImprovementResult {
            return {reviewText: 'cloud review', suggestions: [{category: 'specificity', suggestion: 'cloud says: be specific in 3 prompts'}]};
        },
    };
}

describe('Improvement review API (Task 6.5)', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let logs: string;
    let aliceToken: string;
    let bobToken: string;
    let adminToken: string;
    let aliceUserId: string;
    let key: Buffer;

    async function boot(analyzers?: ImprovementAnalyzers): Promise<void> {
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
        registerImprovementReviewRoutes(app, db, analyzers);
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
        seedCapture(db, 'alice', key, CONTENT);
    });

    afterEach(async () => {
        await app.close();
        db.close();
    });

    function generate(token: string, extra: Record<string, unknown> = {}): ReturnType<FastifyInstance['inject']> {
        return app.inject({
            method: 'POST',
            url: '/api/me/improvement-reviews',
            headers: auth(token),
            payload: {session_id: SESSION, key: key.toString('base64'), ...extra},
        });
    }

    it('runs on the developer’s own conversation (local default) and reads it back, with specific output', async () => {
        await boot();
        const res = await generate(aliceToken);
        expect(res.statusCode).toBe(201);
        const review = res.json().data;
        expect(review.analysisLocation).toBe('local');
        expect(review.reviewText.length).toBeGreaterThan(0);
        expect(review.suggestions.length).toBeGreaterThan(0);
        // Specific, not generic: a suggestion names the actual brief/total prompt counts.
        const allText = review.suggestions.map((s: {suggestion: string}) => s.suggestion).join(' ');
        expect(allText).toContain('2 of your 3');

        const list = await app.inject({method: 'GET', url: '/api/me/improvement-reviews', headers: auth(aliceToken)});
        expect(list.json().data).toHaveLength(1);
        const one = await app.inject({method: 'GET', url: `/api/me/improvement-reviews/${review.id}`, headers: auth(aliceToken)});
        expect(one.statusCode).toBe(200);
        expect(one.json().data.analysisLocation).toBe('local');
    });

    it('self-scoping: a developer cannot run it on a session that is not theirs', async () => {
        await boot();
        // Bob has no captures for SESSION (it belongs to alice). The owner-scoped
        // decrypt finds nothing → 404 no_captures, so bob can never analyse alice's session.
        const res = await generate(bobToken);
        expect(res.statusCode).toBe(404);
        expect(res.json().code).toBe('no_captures');
    });

    it('never writes the plaintext or the key to the server logs (verified)', async () => {
        await boot();
        const res = await generate(aliceToken);
        expect(res.statusCode).toBe(201);
        expect(logs).not.toContain('SUPERSECRETMARKER');
        expect(logs).not.toContain(key.toString('base64'));
    });

    it('is inert (403) when capture is not enabled for the developer', async () => {
        setDeveloperPreference(db, aliceUserId, 'capture_opt_in', false);
        await boot();
        const res = await generate(aliceToken);
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('capture_not_enabled');
    });

    it('refuses cloud analysis when the org has not permitted it (Phase 5 opt-in gate)', async () => {
        setDeveloperPreference(db, aliceUserId, 'cloud_analysis_opt_in', true); // dev opts in, org still off
        await boot({local: new LocalHeuristicImprovementAnalyzer(), cloud: fakeCloud()});
        const res = await generate(aliceToken, {analysis_location: 'cloud'});
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('cloud_not_allowed');
    });

    it('runs cloud analysis only when the org permits AND the developer opted in', async () => {
        setGlobalSetting(db, 'coaching_cloud_analysis_permitted', true);
        setDeveloperPreference(db, aliceUserId, 'cloud_analysis_opt_in', true);
        await boot({local: new LocalHeuristicImprovementAnalyzer(), cloud: fakeCloud()});
        const res = await generate(aliceToken, {analysis_location: 'cloud'});
        expect(res.statusCode).toBe(201);
        expect(res.json().data.analysisLocation).toBe('cloud');
        expect(res.json().data.analysisModel).toBe('cloud-test-model');
    });

    it('returns 503 when cloud is permitted+opted-in but no cloud model is configured', async () => {
        setGlobalSetting(db, 'coaching_cloud_analysis_permitted', true);
        setDeveloperPreference(db, aliceUserId, 'cloud_analysis_opt_in', true);
        await boot(); // default wiring: local only, no cloud analyser
        const res = await generate(aliceToken, {analysis_location: 'cloud'});
        expect(res.statusCode).toBe(503);
        expect(res.json().code).toBe('cloud_not_configured');
    });

    it('keeps reviews private — another developer cannot read one', async () => {
        await boot();
        const id = (await generate(aliceToken)).json().data.id;
        const bobRead = await app.inject({method: 'GET', url: `/api/me/improvement-reviews/${id}`, headers: auth(bobToken)});
        expect(bobRead.statusCode).toBe(404);
        const bobList = await app.inject({method: 'GET', url: '/api/me/improvement-reviews', headers: auth(bobToken)});
        expect(bobList.json().data).toHaveLength(0);
    });

    it('gives no manager/admin a path to any review', async () => {
        await boot();
        // An admin has no linked developer profile, so /api/me/* yields 404 — there is
        // structurally no manager route over improvement reviews.
        const adminList = await app.inject({method: 'GET', url: '/api/me/improvement-reviews', headers: auth(adminToken)});
        expect(adminList.statusCode).toBe(404);
        await generate(aliceToken);
        const adminTry = await app.inject({method: 'POST', url: '/api/me/improvement-reviews', headers: auth(adminToken), payload: {session_id: SESSION, key: key.toString('base64')}});
        expect(adminTry.statusCode).toBe(404);
    });

    it('exposes NO publish path — the surface is exactly run/list/read/delete (separate from the showcase)', async () => {
        await boot();
        const id = (await generate(aliceToken)).json().data.id;
        // No publish/share/promote endpoint exists on this surface; the verbs a publish
        // flow would use return 404 (route not found) on this resource.
        for (const url of [
            `/api/me/improvement-reviews/${id}/publish`,
            `/api/me/improvement-reviews/${id}/share`,
            `/api/me/improvement-reviews/${id}/promote`,
        ]) {
            const res = await app.inject({method: 'POST', url, headers: auth(aliceToken), payload: {}});
            expect(res.statusCode).toBe(404);
        }
        // The stored review carries no published/visibility/shared field that a leak could ride.
        const review = (await app.inject({method: 'GET', url: `/api/me/improvement-reviews/${id}`, headers: auth(aliceToken)})).json().data;
        for (const k of Object.keys(review)) {
            expect(k).not.toMatch(/publish|shared|visib|manager|public/i);
        }
        // Nothing this tool wrote landed in the showcase shared store.
        const showcaseCount = db.prepare('SELECT COUNT(*) AS n FROM showcase_examples').get() as {n: number};
        expect(showcaseCount.n).toBe(0);
    });

    it('deletes the developer’s own review', async () => {
        await boot();
        const id = (await generate(aliceToken)).json().data.id;
        const del = await app.inject({method: 'DELETE', url: `/api/me/improvement-reviews/${id}`, headers: auth(aliceToken)});
        expect(del.statusCode).toBe(200);
        const after = await app.inject({method: 'GET', url: `/api/me/improvement-reviews/${id}`, headers: auth(aliceToken)});
        expect(after.statusCode).toBe(404);
    });

    it('another developer cannot delete the review', async () => {
        await boot();
        const id = (await generate(aliceToken)).json().data.id;
        const del = await app.inject({method: 'DELETE', url: `/api/me/improvement-reviews/${id}`, headers: auth(bobToken)});
        expect(del.statusCode).toBe(404);
        // Still there for the owner.
        expect((await app.inject({method: 'GET', url: `/api/me/improvement-reviews/${id}`, headers: auth(aliceToken)})).statusCode).toBe(200);
    });

    it('rejects an unknown body field (bounded shape)', async () => {
        await boot();
        const res = await app.inject({
            method: 'POST',
            url: '/api/me/improvement-reviews',
            headers: auth(aliceToken),
            payload: {session_id: SESSION, key: key.toString('base64'), publish: true},
        });
        expect(res.statusCode).toBe(400);
    });

    it('rejects an invalid analysis_location value', async () => {
        await boot();
        const res = await generate(aliceToken, {analysis_location: 'somewhere'});
        expect(res.statusCode).toBe(400);
    });

    it('rejects a key that is not a 32-byte base64 value', async () => {
        await boot();
        const res = await app.inject({
            method: 'POST',
            url: '/api/me/improvement-reviews',
            headers: auth(aliceToken),
            payload: {session_id: SESSION, key: Buffer.from('too-short').toString('base64')},
        });
        expect(res.statusCode).toBe(400);
    });

    it('returns 422 when the supplied key cannot decrypt the conversation', async () => {
        await boot();
        const wrong = generateDeveloperKey();
        const res = await generate(aliceToken, {key: wrong.toString('base64')});
        expect(res.statusCode).toBe(422);
        expect(res.json().code).toBe('decrypt_failed');
    });

    it('returns 404 when the session has no captures', async () => {
        await boot();
        const res = await app.inject({
            method: 'POST',
            url: '/api/me/improvement-reviews',
            headers: auth(aliceToken),
            payload: {session_id: 'no-such-session', key: key.toString('base64')},
        });
        expect(res.statusCode).toBe(404);
        expect(res.json().code).toBe('no_captures');
    });
});
