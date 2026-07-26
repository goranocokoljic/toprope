import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {makeTestDb, seedFixtures} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerMeRoutes} from '../../src/dashboard/api/me';
import {registerAdminRoutes} from '../../src/dashboard/api/admin';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';
import {loadServerKey} from '../../src/connectors/git/providers/secret';
import {getDecryptedConfig} from '../../src/connectors/git/providers/store';
import type {GitConnectorConfig} from '../../src/config/types';

const PASSWORD = 'correct-horse-battery';
const KEY_B64 = Buffer.alloc(32, 7).toString('base64');

// A config-file provider — carries a plaintext token that must NEVER surface in
// any response, and is read-only (no edit/delete from the UI).
const CONFIG_TOKEN = 'ghp_CONFIG_PLAINTEXT_9999';
const CONFIG_PROVIDER_ID = 'config:github:config-org';
const GIT_CONFIG: GitConnectorConfig = {
    providers: [{type: 'github', org: 'config-org', auth: {type: 'token', api_token: CONFIG_TOKEN}}],
};

async function buildApp(db: Database.Database): Promise<FastifyInstance> {
    const app = Fastify({logger: false});
    registerSessionAuth(app, db);
    registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
    registerMeRoutes(app, db);
    registerAdminRoutes(app, db, GIT_CONFIG);
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

describe('admin git-provider CRUD API (#197)', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let adminToken: string;
    let devToken: string;
    let priorKey: string | undefined;

    beforeEach(async () => {
        priorKey = process.env.TOPROPE_SECRET_KEY;
        process.env.TOPROPE_SECRET_KEY = KEY_B64;
        db = makeTestDb();
        seedFixtures(db);
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
        if (priorKey === undefined) delete process.env.TOPROPE_SECRET_KEY;
        else process.env.TOPROPE_SECRET_KEY = priorKey;
    });

    // Create a github provider and return its DTO.
    async function createGithub(token = 'ghp_dbSECRET_TOKEN_ABCD'): Promise<Record<string, unknown>> {
        const res = await app.inject({
            method: 'POST',
            url: '/api/admin/git/providers',
            headers: authHeaders(adminToken),
            payload: {type: 'github', container: 'db-org', token},
        });
        expect(res.statusCode).toBe(201);
        return res.json().data as Record<string, unknown>;
    }

    describe('role enforcement — server is the trust boundary', () => {
        const routes: {method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string}[] = [
            {method: 'GET', url: '/api/admin/git/providers'},
            {method: 'POST', url: '/api/admin/git/providers'},
            {method: 'PATCH', url: '/api/admin/git/providers/some-id'},
            {method: 'DELETE', url: '/api/admin/git/providers/some-id'},
        ];

        it('rejects every route for a developer session (403)', async () => {
            for (const r of routes) {
                const res = await app.inject({
                    method: r.method,
                    url: r.url,
                    headers: authHeaders(devToken),
                    payload: r.method === 'GET' || r.method === 'DELETE' ? undefined : {},
                });
                expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
            }
        });

        it('rejects every route with no session (401/403)', async () => {
            for (const r of routes) {
                const res = await app.inject({method: r.method, url: r.url, payload: {}});
                expect([401, 403]).toContain(res.statusCode);
            }
        });
    });

    describe('create', () => {
        it('creates a github provider (201), returns a masked DB DTO', async () => {
            const dto = await createGithub('ghp_dbSECRET_TOKEN_WXYZ');
            expect(dto.source).toBe('db');
            expect(dto.type).toBe('github');
            expect(dto.container).toBe('db-org');
            expect(dto.enabled).toBe(true);
            expect(dto.token_last4).toBe('WXYZ');
            expect(dto.token_masked).toBe('••••WXYZ');
            // No token material of any kind in the DTO.
            expect(JSON.stringify(dto)).not.toContain('ghp_dbSECRET_TOKEN_WXYZ');
        });

        it('creates a self-hosted gitlab provider round-tripping url + include_subgroups', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
                payload: {
                    type: 'gitlab',
                    auth_method: 'personal_access_token',
                    container: 'grp',
                    token: 'glpat-1234',
                    url: 'https://gitlab.internal.acme.dev',
                    include_subgroups: true,
                    repos: ['team/repo'],
                },
            });
            expect(res.statusCode).toBe(201);
            const dto = res.json().data;
            expect(dto.url).toBe('https://gitlab.internal.acme.dev');
            expect(dto.include_subgroups).toBe(true);
            expect(dto.repos_include).toBe(JSON.stringify(['team/repo']));
        });

        it('honors enabled:false on create', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
                payload: {type: 'github', container: 'off-org', token: 'ghp_x', enabled: false},
            });
            expect(res.statusCode).toBe(201);
            expect(res.json().data.enabled).toBe(false);
        });

        it('rejects an unknown provider type (400, fail-closed)', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
                payload: {type: 'svn', container: 'x', token: 't'},
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().message).toMatch(/type must be one of/);
        });

        it('rejects an unknown auth_method (400, fail-closed)', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
                payload: {type: 'bitbucket', auth_method: 'password', container: 'ws', token: 't'},
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().message).toMatch(/auth_method for bitbucket/);
        });

        it('rejects a missing token on create (400)', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
                payload: {type: 'github', container: 'x'},
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().message).toMatch(/token is required/);
        });

        it('rejects a bitbucket app_password without username (400)', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
                payload: {type: 'bitbucket', auth_method: 'app_password', container: 'ws', token: 'pw'},
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().message).toMatch(/username is required/);
        });

        it('maps a factory validation failure (bad gitlab url) to 400, not 500', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
                payload: {type: 'gitlab', auth_method: 'oauth', container: 'g', token: 't', url: 'ftp://nope'},
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().message).toMatch(/http or https/);
        });

        it('fails closed with a clear 503 (not 500) when the server key is unconfigured', async () => {
            delete process.env.TOPROPE_SECRET_KEY;
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
                payload: {type: 'github', container: 'x', token: 'ghp_x'},
            });
            expect(res.statusCode).toBe(503);
            expect(res.json().message).toMatch(/TOPROPE_SECRET_KEY is not set/);
        });
    });

    describe('list', () => {
        it('lists DB providers first, then read-only config-file providers', async () => {
            await createGithub();
            const res = await app.inject({
                method: 'GET',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            const rows = res.json().data as {source: string; id: string}[];
            expect(rows).toHaveLength(2);
            expect(rows[0].source).toBe('db');
            expect(rows[1].source).toBe('config');
            expect(rows[1].id).toBe(CONFIG_PROVIDER_ID);
        });

        it('marks the config row read-only with no token material and null lifecycle fields', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
            });
            const config = (res.json().data as Record<string, unknown>[]).find((r) => r.source === 'config');
            expect(config).toBeDefined();
            expect(config?.token_masked).toBe('••••');
            expect(config?.token_last4).toBeNull();
            expect(config?.created_at).toBeNull();
            expect(config?.enabled).toBe(true);
        });

        it('never leaks token material for DB or config providers (masked only)', async () => {
            await createGithub('ghp_dbSECRET_TOKEN_LEAK');
            const res = await app.inject({
                method: 'GET',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
            });
            const body = JSON.stringify(res.json());
            // Positive control: the scan target is real — the response is non-empty
            // and contains the containers we seeded.
            expect(body).toContain('db-org');
            expect(body).toContain('config-org');
            // The actual leak vectors: neither the DB nor the config token appears.
            expect(body).not.toContain('ghp_dbSECRET_TOKEN_LEAK');
            expect(body).not.toContain(CONFIG_TOKEN);
            // But the mask (with last4 for the DB row) is present.
            expect(body).toContain('••••LEAK');
        });
    });

    describe('update', () => {
        it('edits fields and KEEPS the stored token when omitted', async () => {
            const dto = await createGithub('ghp_KEEP_ME_1234');
            const id = dto.id as string;
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/git/providers/${id}`,
                headers: authHeaders(adminToken),
                payload: {type: 'github', container: 'renamed-org'},
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.container).toBe('renamed-org');
            // The token is unchanged — decrypt it back through the store.
            const cfg = getDecryptedConfig(db, loadServerKey({TOPROPE_SECRET_KEY: KEY_B64}), id);
            expect(cfg?.type).toBe('github');
            expect(cfg?.type === 'github' && cfg.auth.api_token).toBe('ghp_KEEP_ME_1234');
        });

        it('replaces the token when a new one is supplied', async () => {
            const dto = await createGithub('ghp_OLD_TOKEN_1111');
            const id = dto.id as string;
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/git/providers/${id}`,
                headers: authHeaders(adminToken),
                payload: {type: 'github', container: 'db-org', token: 'ghp_NEW_TOKEN_2222'},
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.token_last4).toBe('2222');
            const cfg = getDecryptedConfig(db, loadServerKey({TOPROPE_SECRET_KEY: KEY_B64}), id);
            expect(cfg?.type === 'github' && cfg.auth.api_token).toBe('ghp_NEW_TOKEN_2222');
        });

        it('rejects editing a config-file provider (409, read-only)', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/git/providers/${CONFIG_PROVIDER_ID}`,
                headers: authHeaders(adminToken),
                payload: {type: 'github', container: 'hijack'},
            });
            expect(res.statusCode).toBe(409);
            expect(res.json().message).toMatch(/read-only/);
        });

        it('returns a typed 404 for an unknown id', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: '/api/admin/git/providers/does-not-exist',
                headers: authHeaders(adminToken),
                payload: {type: 'github', container: 'x'},
            });
            expect(res.statusCode).toBe(404);
            expect(res.json().message).toMatch(/not found/);
        });

        it('rejects a malformed body on an existing provider (400, fail-closed)', async () => {
            const id = (await createGithub()).id as string;
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/git/providers/${id}`,
                headers: authHeaders(adminToken),
                payload: {type: 'mercurial', container: 'x'},
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().message).toMatch(/type must be one of/);
        });

        it('maps a factory validation failure on update to 400, not 500', async () => {
            const create = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
                payload: {type: 'gitlab', auth_method: 'oauth', container: 'grp', token: 'glpat-1'},
            });
            const id = create.json().data.id as string;
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/git/providers/${id}`,
                headers: authHeaders(adminToken),
                payload: {type: 'gitlab', auth_method: 'oauth', container: 'grp', url: 'ftp://nope'},
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().message).toMatch(/http or https/);
        });

        it('fails closed with 503 when the server key is unconfigured mid-edit', async () => {
            const id = (await createGithub()).id as string;
            delete process.env.TOPROPE_SECRET_KEY;
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/git/providers/${id}`,
                headers: authHeaders(adminToken),
                payload: {type: 'github', container: 'renamed', token: 'ghp_new_5678'},
            });
            expect(res.statusCode).toBe(503);
            expect(res.json().message).toMatch(/TOPROPE_SECRET_KEY is not set/);
        });
    });

    describe('delete', () => {
        it('deletes a DB provider and drops it from the list', async () => {
            const dto = await createGithub();
            const id = dto.id as string;
            const del = await app.inject({
                method: 'DELETE',
                url: `/api/admin/git/providers/${id}`,
                headers: authHeaders(adminToken),
            });
            expect(del.statusCode).toBe(200);
            expect(del.json().data).toEqual({id, deleted: true});
            const list = await app.inject({
                method: 'GET',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
            });
            const ids = (list.json().data as {id: string}[]).map((r) => r.id);
            expect(ids).not.toContain(id);
        });

        it('rejects deleting a config-file provider (409, read-only)', async () => {
            const res = await app.inject({
                method: 'DELETE',
                url: `/api/admin/git/providers/${CONFIG_PROVIDER_ID}`,
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(409);
            expect(res.json().message).toMatch(/read-only/);
        });

        it('returns a typed 404 deleting an unknown id', async () => {
            const res = await app.inject({
                method: 'DELETE',
                url: '/api/admin/git/providers/nope',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(404);
            expect(res.json().message).toMatch(/not found/);
        });

        // KNOWN GAP, pinned deliberately (#262 → #264). The pipeline's cursors are keyed
        // by `type:container`, not by provider id, so this delete leaves them behind and
        // a provider re-added for the same container inherits them. Purging them here in
        // isolation is unsafe: `raw_author_daily` has no container column, so the deleted
        // provider's rows cannot be retracted, and `mergeDailyAcrossRuns` ADDS the commit
        // counters — a re-import over the same window would double-count permanently.
        // #264 adds container attribution and flips this expectation; this test exists so
        // that flip is deliberate rather than silent. The UI is protected in the meantime
        // by `first_sync_pending` (see the create-route test above), which reports false
        // for such a provider and hides the window input.
        it('leaves the container pipeline cursors in place (see #264)', async () => {
            const dto = await createGithub();
            const id = dto.id as string;
            for (const key of [
                'git_last_sync:github:db-org',
                'git_earliest_sync:github:db-org',
                'git_stall:github:db-org',
            ]) {
                db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(key, 'seeded');
            }

            const del = await app.inject({
                method: 'DELETE',
                url: `/api/admin/git/providers/${id}`,
                headers: authHeaders(adminToken),
            });
            expect(del.statusCode).toBe(200);

            const remaining = (
                db
                    .prepare("SELECT key FROM sync_state WHERE key LIKE 'git_%' ORDER BY key")
                    .all() as Array<{key: string}>
            ).map((r) => r.key);
            expect(remaining).toEqual([
                'git_earliest_sync:github:db-org',
                'git_last_sync:github:db-org',
                'git_stall:github:db-org',
            ]);
        });
    });
});
