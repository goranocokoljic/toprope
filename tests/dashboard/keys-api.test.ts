import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import {Writable} from 'stream';
import type Database from 'better-sqlite3';
import {makeTestDb} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerMeRoutes} from '../../src/dashboard/api/me';
import {registerKeyRoutes} from '../../src/dashboard/api/keys';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';
import {setGlobalSetting} from '../../src/settings/store';
import {resolveDeveloperPreferences} from '../../src/settings/store';
import {generateDeveloperKey} from '../../src/capture/encryption';
import {wrapCaptureKey, unwrapCaptureKey, keysEqual, type RecoveryMeta} from '../../src/capture/key-recovery';

const PASSWORD = 'correct-horse-battery';
const NOW = '2026-06-15T00:00:00.000Z';
const RECOVERY_SECRET = 'my recovery phrase that the server never sees';

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

/** Build a recovery_path setup body by wrapping a fresh key client-side. */
function recoveryPathBody(key = generateDeveloperKey()): {body: Record<string, unknown>; key: Buffer; meta: RecoveryMeta} {
    const {recovery_blob, meta} = wrapCaptureKey(key, RECOVERY_SECRET);
    return {
        key,
        meta,
        body: {
            key_id: 'k1',
            recovery_choice: 'recovery_path',
            recovery_blob: recovery_blob.toString('base64'),
            recovery_meta: meta,
        },
    };
}

describe('Capture key API (Task 5.5)', () => {
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

        setGlobalSetting(db, 'coaching_capture_permitted', true);

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
        registerKeyRoutes(app, db);
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

    it('requires authentication for key setup', async () => {
        const res = await app.inject({method: 'POST', url: '/api/me/capture-key', payload: {key_id: 'k1', recovery_choice: 'no_recovery', acknowledge_unrecoverable: true}});
        expect(res.statusCode).toBe(401);
    });

    it('is forbidden (403) when the org does not permit capture', async () => {
        setGlobalSetting(db, 'coaching_capture_permitted', false);
        const res = await app.inject({method: 'POST', url: '/api/me/capture-key', headers: auth(aliceToken), payload: {key_id: 'k1', recovery_choice: 'no_recovery', acknowledge_unrecoverable: true}});
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('capture_not_permitted');
    });

    it('developer chooses no_recovery — requires informed consent and stores NO recovery material', async () => {
        // Without the acknowledgement it is refused (consent is mandatory).
        const noConsent = await app.inject({method: 'POST', url: '/api/me/capture-key', headers: auth(aliceToken), payload: {key_id: 'k1', recovery_choice: 'no_recovery'}});
        expect(noConsent.statusCode).toBe(400);
        expect(db.prepare('SELECT COUNT(*) c FROM capture_keys').get()).toMatchObject({c: 0});

        // With the explicit acknowledgement it succeeds and stores nothing recoverable.
        const ok = await app.inject({method: 'POST', url: '/api/me/capture-key', headers: auth(aliceToken), payload: {key_id: 'k1', recovery_choice: 'no_recovery', acknowledge_unrecoverable: true}});
        expect(ok.statusCode).toBe(201);
        expect(ok.json().data.recoveryChoice).toBe('no_recovery');
        expect(ok.json().data.hasRecoveryBlob).toBe(false);

        const row = db.prepare('SELECT recovery_blob FROM capture_keys WHERE developer_id = ?').get('alice') as {recovery_blob: Buffer | null};
        expect(row.recovery_blob).toBeNull();

        // The chosen posture is mirrored into the resolved developer preference.
        const prefs = resolveDeveloperPreferences(db, aliceUserId, 'eng');
        expect(prefs.capture_recovery_choice.value).toBe('no_recovery');
    });

    it('no_recovery: key loss is unrecoverable — initiate returns 409 with no recovery material', async () => {
        await app.inject({method: 'POST', url: '/api/me/capture-key', headers: auth(aliceToken), payload: {key_id: 'k1', recovery_choice: 'no_recovery', acknowledge_unrecoverable: true}});
        const res = await app.inject({method: 'POST', url: '/api/me/capture-key/recovery/initiate', headers: auth(aliceToken)});
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('no_recovery_path');
        // No misleading log entry was written.
        expect(db.prepare('SELECT COUNT(*) c FROM key_recovery_log').get()).toMatchObject({c: 0});
    });

    it('recovery_path: recovery works with the developer\'s recovery secret end-to-end', async () => {
        const {body, key} = recoveryPathBody();
        const setup = await app.inject({method: 'POST', url: '/api/me/capture-key', headers: auth(aliceToken), payload: body});
        expect(setup.statusCode).toBe(201);
        expect(setup.json().data.hasRecoveryBlob).toBe(true);

        // Initiate recovery → server hands back the opaque blob + meta.
        const initiate = await app.inject({method: 'POST', url: '/api/me/capture-key/recovery/initiate', headers: auth(aliceToken)});
        expect(initiate.statusCode).toBe(200);
        const blob = Buffer.from(initiate.json().data.recovery_blob as string, 'base64');
        const meta = initiate.json().data.recovery_meta as RecoveryMeta;

        // The CLIENT unwraps with the recovery secret and gets the original key back.
        const recovered = unwrapCaptureKey(blob, meta, RECOVERY_SECRET);
        expect(keysEqual(recovered, key)).toBe(true);

        // A wrong secret cannot unwrap it.
        expect(() => unwrapCaptureKey(blob, meta, 'wrong phrase')).toThrow();
    });

    it('EVERY recovery event is logged AND visible to the developer', async () => {
        const {body} = recoveryPathBody();
        await app.inject({method: 'POST', url: '/api/me/capture-key', headers: auth(aliceToken), payload: body});

        // Initiate, then report a completed unwrap.
        await app.inject({method: 'POST', url: '/api/me/capture-key/recovery/initiate', headers: auth(aliceToken)});
        await app.inject({method: 'POST', url: '/api/me/capture-key/recovery/complete', headers: auth(aliceToken), payload: {outcome: 'completed'}});

        const log = await app.inject({method: 'GET', url: '/api/me/capture-key/recovery-log', headers: auth(aliceToken)});
        const events = (log.json().data as Array<{event: string}>).map((e) => e.event);
        expect(events).toContain('recovery_initiated');
        expect(events).toContain('recovery_completed');

        // The very act of handing out recovery material left a developer-visible trace —
        // there is no way to recover silently.
        const visible = db.prepare('SELECT COUNT(*) c FROM key_recovery_log WHERE developer_id = ? AND visible_to_developer = 1').get('alice') as {c: number};
        const total = db.prepare('SELECT COUNT(*) c FROM key_recovery_log WHERE developer_id = ?').get('alice') as {c: number};
        expect(visible.c).toBe(total.c);
        expect(total.c).toBe(2);
    });

    it('a failed unwrap is also audited (recovery_failed)', async () => {
        const {body} = recoveryPathBody();
        await app.inject({method: 'POST', url: '/api/me/capture-key', headers: auth(aliceToken), payload: body});
        await app.inject({method: 'POST', url: '/api/me/capture-key/recovery/complete', headers: auth(aliceToken), payload: {outcome: 'failed'}});
        const log = await app.inject({method: 'GET', url: '/api/me/capture-key/recovery-log', headers: auth(aliceToken)});
        expect((log.json().data as Array<{event: string}>)[0].event).toBe('recovery_failed');
    });

    it('the server stores NO key/secret material — it cannot decrypt captures on its own, and logs never leak it', async () => {
        const {body, key} = recoveryPathBody();
        await app.inject({method: 'POST', url: '/api/me/capture-key', headers: auth(aliceToken), payload: body});

        // No column in capture_keys holds the plaintext capture key.
        const row = db.prepare('SELECT * FROM capture_keys WHERE developer_id = ?').get('alice') as Record<string, unknown>;
        const serialized = JSON.stringify(row) + (row.recovery_blob as Buffer).toString('latin1');
        expect(serialized).not.toContain(key.toString('latin1'));
        // And the recovery secret never reached the server logs.
        expect(logs).not.toContain(RECOVERY_SECRET);
    });

    it('rejects any body carrying raw key / recovery-secret material', async () => {
        const {body} = recoveryPathBody();
        for (const field of ['key', 'capture_key', 'recovery_secret', 'secret', 'wrapping_key', 'password']) {
            const res = await app.inject({method: 'POST', url: '/api/me/capture-key', headers: auth(aliceToken), payload: {...body, [field]: 'deadbeef'}});
            expect(res.statusCode).toBe(400);
        }
        expect(db.prepare('SELECT COUNT(*) c FROM capture_keys').get()).toMatchObject({c: 0});
    });

    it('rejects recovery_meta with an unexpected field (allowlist) and a no_recovery body smuggling a blob', async () => {
        const {body} = recoveryPathBody();
        const badMeta = {...body, recovery_meta: {...(body.recovery_meta as Record<string, unknown>), sneaky: 'x'}};
        const r1 = await app.inject({method: 'POST', url: '/api/me/capture-key', headers: auth(aliceToken), payload: badMeta});
        expect(r1.statusCode).toBe(400);

        const r2 = await app.inject({method: 'POST', url: '/api/me/capture-key', headers: auth(aliceToken), payload: {key_id: 'k1', recovery_choice: 'no_recovery', acknowledge_unrecoverable: true, recovery_blob: 'AAAA'}});
        expect(r2.statusCode).toBe(400);
    });

    it('scopes everything to the developer — no cross-developer key or recovery-log access', async () => {
        const {body} = recoveryPathBody();
        await app.inject({method: 'POST', url: '/api/me/capture-key', headers: auth(aliceToken), payload: body});
        await app.inject({method: 'POST', url: '/api/me/capture-key/recovery/initiate', headers: auth(aliceToken)});

        // bob has no key and sees an empty recovery log; he cannot initiate against alice's.
        const bobKey = await app.inject({method: 'GET', url: '/api/me/capture-key', headers: auth(bobToken)});
        expect(bobKey.statusCode).toBe(404);
        const bobLog = await app.inject({method: 'GET', url: '/api/me/capture-key/recovery-log', headers: auth(bobToken)});
        expect(bobLog.json().data).toHaveLength(0);
        const bobInitiate = await app.inject({method: 'POST', url: '/api/me/capture-key/recovery/initiate', headers: auth(bobToken)});
        expect(bobInitiate.statusCode).toBe(404);

        // alice still sees her own.
        const aliceLog = await app.inject({method: 'GET', url: '/api/me/capture-key/recovery-log', headers: auth(aliceToken)});
        expect(aliceLog.json().data).toHaveLength(1);
    });

    it('rejects a bad recovery-complete outcome', async () => {
        const res = await app.inject({method: 'POST', url: '/api/me/capture-key/recovery/complete', headers: auth(aliceToken), payload: {outcome: 'maybe'}});
        expect(res.statusCode).toBe(400);
    });
});
