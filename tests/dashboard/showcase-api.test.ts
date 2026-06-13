import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import {Writable} from 'stream';
import type Database from 'better-sqlite3';
import {makeTestDb} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerShowcaseRoutes} from '../../src/dashboard/api/showcase';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';
import {setGlobalSetting, setDeveloperPreference} from '../../src/settings/store';
import {insertCapture} from '../../src/capture/store';
import {buildCapturePayload} from '../../src/capture/client';
import {generateDeveloperKey} from '../../src/capture/encryption';
import {insertRetrospective} from '../../src/coaching/retrospective/store';

const PASSWORD = 'correct-horse-battery';
const NOW = '2026-06-13T00:00:00.000Z';
const SESSION = 'sess-1';
const SECRET = 'SUPERSECRETMARKER refactor the billing code in src/billing.ts';
const REDACTED = 'How I structured a refactor conversation (details removed)';

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

function seedRetrospective(db: Database.Database, developerId: string): string {
    const retro = insertRetrospective(db, {
        developerId,
        sessionId: SESSION,
        generatedAt: NOW,
        analysisModel: 'local-test',
        analysisLocation: 'local',
        retrospectiveText: 'you used AI well here',
        highlights: null,
        analyzedCaptureCount: 1,
    });
    return retro.id;
}

describe('Showcase API (Task 5.8)', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let logs: string;
    let aliceToken: string;
    let bobToken: string;
    let adminToken: string;
    let aliceUserId: string;
    let key: Buffer;
    let aliceRetroId: string;

    async function boot(): Promise<void> {
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
        registerShowcaseRoutes(app, db);
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
        createUser(db, {email: 'bob@test.com', passwordHash: hash, role: 'developer', developerId: 'bob'});
        createUser(db, {email: 'admin@test.com', passwordHash: hash, role: 'admin'});
        aliceUserId = alice.id;

        // Org permits capture; alice opts in. Showcasing enabled, default team_only scope.
        setGlobalSetting(db, 'coaching_capture_permitted', true);
        setDeveloperPreference(db, alice.id, 'capture_opt_in', true);
        setGlobalSetting(db, 'showcase_enabled', true);

        key = generateDeveloperKey();
        seedCapture(db, 'alice', key, `prompt: ${SECRET}`);
        aliceRetroId = seedRetrospective(db, 'alice');
    });

    afterEach(async () => {
        await app.close();
        db.close();
    });

    // --- Promote (draft) ---------------------------------------------------

    it('promotes the owner’s own retrospective into a decrypted, editable draft', async () => {
        await boot();
        const res = await app.inject({
            method: 'POST',
            url: '/api/me/showcase/draft',
            headers: auth(aliceToken),
            payload: {retrospective_id: aliceRetroId, key: key.toString('base64')},
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().data.draft).toContain(SECRET);
        expect(res.json().data.captureCount).toBe(1);
        // The transient plaintext and key never reach the logs.
        expect(logs).not.toContain('SUPERSECRETMARKER');
        expect(logs).not.toContain(key.toString('base64'));
    });

    it('does NOT persist the decrypted draft anywhere (nothing auto-harvested)', async () => {
        await boot();
        await app.inject({
            method: 'POST',
            url: '/api/me/showcase/draft',
            headers: auth(aliceToken),
            payload: {retrospective_id: aliceRetroId, key: key.toString('base64')},
        });
        // Drafting produces no showcase row — only an explicit publish does.
        expect((db.prepare('SELECT COUNT(*) AS n FROM showcase_examples').get() as {n: number}).n).toBe(0);
    });

    it('promote is owner-only — another developer cannot draft from someone else’s retrospective', async () => {
        await boot();
        const res = await app.inject({
            method: 'POST',
            url: '/api/me/showcase/draft',
            headers: auth(bobToken),
            payload: {retrospective_id: aliceRetroId, key: key.toString('base64')},
        });
        expect(res.statusCode).toBe(404);
    });

    it('promote requires capture enabled (handles fresh plaintext)', async () => {
        setDeveloperPreference(db, aliceUserId, 'capture_opt_in', false);
        await boot();
        const res = await app.inject({
            method: 'POST',
            url: '/api/me/showcase/draft',
            headers: auth(aliceToken),
            payload: {retrospective_id: aliceRetroId, key: key.toString('base64')},
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('capture_not_enabled');
    });

    // --- Publish -----------------------------------------------------------

    it('publishes a redacted example to the separate shared store, leaving the private capture untouched', async () => {
        await boot();
        const captureBefore = db.prepare('SELECT ciphertext FROM prompt_captures').get() as {ciphertext: Buffer};
        const res = await app.inject({
            method: 'POST',
            url: '/api/me/showcase',
            headers: auth(aliceToken),
            payload: {
                retrospective_id: aliceRetroId,
                scope: 'team',
                title: 'A great refactor session',
                content: REDACTED,
                task_type: 'refactor',
                tool: 'claude_code',
                author_note: 'clear, incremental prompts',
                redaction_acknowledged: true,
            },
        });
        expect(res.statusCode).toBe(201);
        const ex = res.json().data;
        expect(ex.scope).toBe('team');
        expect(ex.scopeTarget).toBe('eng');
        expect(ex.content).toBe(REDACTED);
        expect(ex.status).toBe('published');

        // Lands in showcase_examples, separate from prompt_captures.
        expect((db.prepare('SELECT COUNT(*) AS n FROM showcase_examples').get() as {n: number}).n).toBe(1);
        // The published content is the owner's redaction — never the raw secret.
        const stored = db.prepare('SELECT content FROM showcase_examples').get() as {content: string};
        expect(stored.content).not.toContain('SUPERSECRETMARKER');

        // The private capture row is byte-for-byte unchanged after publishing.
        const captureAfter = db.prepare('SELECT ciphertext FROM prompt_captures').get() as {ciphertext: Buffer};
        expect(Buffer.compare(Buffer.from(captureAfter.ciphertext), Buffer.from(captureBefore.ciphertext))).toBe(0);
        expect((db.prepare('SELECT COUNT(*) AS n FROM prompt_captures').get() as {n: number}).n).toBe(1);
    });

    it('refuses to publish without an explicit redaction acknowledgement (mandatory, cannot be skipped)', async () => {
        await boot();
        const notAcked = await app.inject({
            method: 'POST',
            url: '/api/me/showcase',
            headers: auth(aliceToken),
            payload: {retrospective_id: aliceRetroId, scope: 'team', title: 'T', content: REDACTED, redaction_acknowledged: false},
        });
        expect(notAcked.statusCode).toBe(400);
        expect(notAcked.json().code).toBe('redaction_required');

        const missing = await app.inject({
            method: 'POST',
            url: '/api/me/showcase',
            headers: auth(aliceToken),
            payload: {retrospective_id: aliceRetroId, scope: 'team', title: 'T', content: REDACTED},
        });
        expect(missing.statusCode).toBe(400);

        // Neither attempt wrote anything.
        expect((db.prepare('SELECT COUNT(*) AS n FROM showcase_examples').get() as {n: number}).n).toBe(0);
    });

    it('gives no manager/admin a path to publish on a developer’s behalf', async () => {
        await boot();
        // Another developer cannot publish using someone else's retrospective (404).
        const bobPub = await app.inject({
            method: 'POST',
            url: '/api/me/showcase',
            headers: auth(bobToken),
            payload: {retrospective_id: aliceRetroId, scope: 'team', title: 'T', content: REDACTED, redaction_acknowledged: true},
        });
        expect(bobPub.statusCode).toBe(404);

        // An admin has no developer profile, so /api/me/* is 404 — structurally no manager path.
        const adminPub = await app.inject({
            method: 'POST',
            url: '/api/me/showcase',
            headers: auth(adminToken),
            payload: {retrospective_id: aliceRetroId, scope: 'team', title: 'T', content: REDACTED, redaction_acknowledged: true},
        });
        expect(adminPub.statusCode).toBe(404);
        expect((db.prepare('SELECT COUNT(*) AS n FROM showcase_examples').get() as {n: number}).n).toBe(0);
    });

    it('refuses org scope under the default team_only policy, and allows it once org_wide is permitted', async () => {
        await boot();
        const denied = await app.inject({
            method: 'POST',
            url: '/api/me/showcase',
            headers: auth(aliceToken),
            payload: {retrospective_id: aliceRetroId, scope: 'org', title: 'T', content: REDACTED, redaction_acknowledged: true},
        });
        expect(denied.statusCode).toBe(403);
        expect(denied.json().code).toBe('scope_not_permitted');

        setGlobalSetting(db, 'showcase_scope_permitted', 'org_wide');
        const allowed = await app.inject({
            method: 'POST',
            url: '/api/me/showcase',
            headers: auth(aliceToken),
            payload: {retrospective_id: aliceRetroId, scope: 'org', title: 'T', content: REDACTED, redaction_acknowledged: true},
        });
        expect(allowed.statusCode).toBe(201);
        expect(allowed.json().data.scope).toBe('org');
        expect(allowed.json().data.scopeTarget).toBeNull();
    });

    it('refuses to publish when showcasing is disabled for the team', async () => {
        setGlobalSetting(db, 'showcase_enabled', false);
        await boot();
        const res = await app.inject({
            method: 'POST',
            url: '/api/me/showcase',
            headers: auth(aliceToken),
            payload: {retrospective_id: aliceRetroId, scope: 'team', title: 'T', content: REDACTED, redaction_acknowledged: true},
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('showcase_disabled');
    });

    it('lets the owner read back their own published examples, scoped to them', async () => {
        await boot();
        const pub = await app.inject({
            method: 'POST',
            url: '/api/me/showcase',
            headers: auth(aliceToken),
            payload: {retrospective_id: aliceRetroId, scope: 'team', title: 'Mine', content: REDACTED, redaction_acknowledged: true},
        });
        const id = pub.json().data.id;

        const list = await app.inject({method: 'GET', url: '/api/me/showcase', headers: auth(aliceToken)});
        expect(list.json().data).toHaveLength(1);
        const one = await app.inject({method: 'GET', url: `/api/me/showcase/${id}`, headers: auth(aliceToken)});
        expect(one.statusCode).toBe(200);
        expect(one.json().data.title).toBe('Mine');

        // Another developer sees neither the list entry nor the example.
        expect((await app.inject({method: 'GET', url: '/api/me/showcase', headers: auth(bobToken)})).json().data).toHaveLength(0);
        expect((await app.inject({method: 'GET', url: `/api/me/showcase/${id}`, headers: auth(bobToken)})).statusCode).toBe(404);
    });

    it('rejects an unknown field in the publish body', async () => {
        await boot();
        const res = await app.inject({
            method: 'POST',
            url: '/api/me/showcase',
            headers: auth(aliceToken),
            payload: {retrospective_id: aliceRetroId, scope: 'team', title: 'T', content: REDACTED, redaction_acknowledged: true, evil: 'x'},
        });
        expect(res.statusCode).toBe(400);
    });
});
