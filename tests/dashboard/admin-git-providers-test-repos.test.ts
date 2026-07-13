import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
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
import type {GitConnectorConfig} from '../../src/config/types';
import type {GitProvider, GitRepo} from '../../src/connectors/git/providers/types';

// Stub createGitProvider so no test hits the network, but keep
// validateGitProviderConfig real so the store/codec that seed + decrypt DB
// providers keep working. This is the "mocked provider" the issue asks for.
vi.mock('../../src/connectors/git/providers/factory', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/connectors/git/providers/factory')>();
    return {...actual, createGitProvider: vi.fn()};
});

const PASSWORD = 'correct-horse-battery';
const KEY_B64 = Buffer.alloc(32, 7).toString('base64');

// A config-file provider — read-only, but can still be tested/listed. Its token
// must NEVER surface in any response.
const CONFIG_TOKEN = 'ghp_CONFIG_PLAINTEXT_9999';
const CONFIG_PROVIDER_ID = 'config:github:config-org';
const GIT_CONFIG: GitConnectorConfig = {
    providers: [{type: 'github', org: 'config-org', auth: {type: 'token', api_token: CONFIG_TOKEN}}],
};

// A fully-shaped fake GitProvider; only checkAccess/listRepos matter here.
function makeMockProvider(overrides: Partial<GitProvider> = {}): GitProvider {
    return {
        name: 'github',
        listRepos: vi.fn().mockResolvedValue([]),
        getCommits: vi.fn().mockResolvedValue([]),
        getPullRequests: vi.fn().mockResolvedValue([]),
        getReviewComments: vi.fn().mockResolvedValue([]),
        getPRReviews: vi.fn().mockResolvedValue([]),
        getCommitDiff: vi.fn().mockResolvedValue([]),
        checkAccess: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    } as GitProvider;
}

function makeRepo(name: string, isArchived: boolean, defaultBranch = 'main'): GitRepo {
    // displayName deliberately differs from the canonical name so the projection
    // test can prove which field feeds which column (#213).
    return {
        id: name,
        name,
        fullName: `db-org/${name}`,
        displayName: `Display ${name}`,
        defaultBranch,
        isArchived,
    };
}

async function getCreateGitProvider() {
    const {createGitProvider} = await import('../../src/connectors/git/providers/factory');
    return createGitProvider as ReturnType<typeof vi.fn>;
}

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

describe('admin git-provider test + repos API (#198)', () => {
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
        // A benign default so any path that reaches the factory has a provider.
        const createGitProvider = await getCreateGitProvider();
        createGitProvider.mockReset();
        createGitProvider.mockReturnValue(makeMockProvider());
    });

    afterEach(async () => {
        await app.close();
        db.close();
        if (priorKey === undefined) delete process.env.TOPROPE_SECRET_KEY;
        else process.env.TOPROPE_SECRET_KEY = priorKey;
    });

    // Create a DB github provider and return its id.
    async function createGithub(token = 'ghp_dbSECRET_TOKEN_ABCD'): Promise<string> {
        const res = await app.inject({
            method: 'POST',
            url: '/api/admin/git/providers',
            headers: authHeaders(adminToken),
            payload: {type: 'github', container: 'db-org', token},
        });
        expect(res.statusCode).toBe(201);
        return res.json().data.id as string;
    }

    async function countProviders(): Promise<number> {
        const res = await app.inject({
            method: 'GET',
            url: '/api/admin/git/providers',
            headers: authHeaders(adminToken),
        });
        return (res.json().data as unknown[]).length;
    }

    describe('role enforcement — server is the trust boundary', () => {
        const routes: {method: 'GET' | 'POST'; url: string}[] = [
            {method: 'POST', url: '/api/admin/git/providers/some-id/test'},
            {method: 'POST', url: '/api/admin/git/providers/test'},
            {method: 'GET', url: '/api/admin/git/providers/some-id/repos'},
        ];

        it('rejects every route for a developer session (403)', async () => {
            for (const r of routes) {
                const res = await app.inject({
                    method: r.method,
                    url: r.url,
                    headers: authHeaders(devToken),
                    payload: r.method === 'GET' ? undefined : {},
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

    describe('POST /:id/test — saved provider probe', () => {
        it('returns {ok:true} on a successful checkAccess, decrypting the stored token', async () => {
            const id = await createGithub('ghp_dbSECRET_TOKEN_ABCD');
            const provider = makeMockProvider({checkAccess: vi.fn().mockResolvedValue(undefined)});
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(provider);

            const res = await app.inject({
                method: 'POST',
                url: `/api/admin/git/providers/${id}/test`,
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({ok: true});
            expect(provider.checkAccess).toHaveBeenCalledTimes(1);
            // The stored token was decrypted and handed to the factory.
            expect(createGitProvider).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'github',
                    org: 'db-org',
                    auth: expect.objectContaining({api_token: 'ghp_dbSECRET_TOKEN_ABCD'}),
                }),
            );
        });

        it('returns a clean {ok:false, error, hint} on bad credentials — not a 500', async () => {
            const id = await createGithub();
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    checkAccess: vi.fn().mockRejectedValue(new Error('GitHub API error 401: https://api.github.com/orgs/db-org/repos')),
                }),
            );

            const res = await app.inject({
                method: 'POST',
                url: `/api/admin/git/providers/${id}/test`,
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.ok).toBe(false);
            expect(body.error).toMatch(/401/);
            // Hint reuses doctor's remediation copy (single source), keyed on 401.
            expect(body.hint).toMatch(/credentials invalid or expired/);
        });

        it('probes a read-only config-file provider by its synthetic id', async () => {
            const provider = makeMockProvider({checkAccess: vi.fn().mockResolvedValue(undefined)});
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(provider);

            const res = await app.inject({
                method: 'POST',
                url: `/api/admin/git/providers/${CONFIG_PROVIDER_ID}/test`,
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({ok: true});
            // The config provider's inline token reached the factory (no DB, no key needed).
            expect(createGitProvider).toHaveBeenCalledWith(
                expect.objectContaining({auth: expect.objectContaining({api_token: CONFIG_TOKEN})}),
            );
        });

        it('returns a typed 404 for an unknown id', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers/does-not-exist/test',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(404);
            expect(res.json().message).toMatch(/not found/);
        });

        it('fails closed with 503 (not 500) when the server key is unconfigured', async () => {
            const id = await createGithub();
            delete process.env.TOPROPE_SECRET_KEY;
            const res = await app.inject({
                method: 'POST',
                url: `/api/admin/git/providers/${id}/test`,
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(503);
            expect(res.json().message).toMatch(/TOPROPE_SECRET_KEY is not set/);
        });
    });

    describe('POST /test — draft (unsaved) provider probe', () => {
        it('returns {ok:true} for a valid draft and persists NOTHING', async () => {
            const provider = makeMockProvider({checkAccess: vi.fn().mockResolvedValue(undefined)});
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(provider);

            const before = await countProviders();
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers/test',
                headers: authHeaders(adminToken),
                payload: {type: 'github', container: 'draft-org', token: 'ghp_DRAFT_TOKEN_5555'},
            });
            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({ok: true});
            // The submitted token was probed inline...
            expect(createGitProvider).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'github',
                    org: 'draft-org',
                    auth: expect.objectContaining({api_token: 'ghp_DRAFT_TOKEN_5555'}),
                }),
            );
            // ...but nothing was written (provider count unchanged, config-only).
            expect(await countProviders()).toBe(before);
            // The response never echoes the submitted token.
            expect(JSON.stringify(res.json())).not.toContain('ghp_DRAFT_TOKEN_5555');
        });

        it('validates a draft gitlab shape and probes with the submitted token', async () => {
            const provider = makeMockProvider({checkAccess: vi.fn().mockResolvedValue(undefined)});
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(provider);

            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers/test',
                headers: authHeaders(adminToken),
                payload: {
                    type: 'gitlab',
                    auth_method: 'personal_access_token',
                    container: 'grp',
                    token: 'glpat-draft',
                    url: 'https://gitlab.internal.acme.dev',
                },
            });
            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({ok: true});
            expect(createGitProvider).toHaveBeenCalledWith(
                expect.objectContaining({type: 'gitlab', group: 'grp', url: 'https://gitlab.internal.acme.dev'}),
            );
        });

        it('returns {ok:false, error, hint} on a draft auth failure — not a 500', async () => {
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    checkAccess: vi.fn().mockRejectedValue(new Error('GitHub API error 401: bad token')),
                }),
            );
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers/test',
                headers: authHeaders(adminToken),
                payload: {type: 'github', container: 'draft-org', token: 'ghp_bad'},
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().ok).toBe(false);
            expect(res.json().hint).toMatch(/credentials invalid or expired/);
        });

        it('rejects a draft with no token (400 — cannot probe without a credential)', async () => {
            const before = await countProviders();
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers/test',
                headers: authHeaders(adminToken),
                payload: {type: 'github', container: 'draft-org'},
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().message).toMatch(/token is required/);
            // No probe attempted, nothing persisted.
            const createGitProvider = await getCreateGitProvider();
            expect(createGitProvider).not.toHaveBeenCalled();
            expect(await countProviders()).toBe(before);
        });

        it('rejects a draft with an unknown provider type (400, fail-closed)', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers/test',
                headers: authHeaders(adminToken),
                payload: {type: 'svn', container: 'x', token: 't'},
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().message).toMatch(/type must be one of/);
        });

        it('rejects a non-object body (400)', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers/test',
                headers: authHeaders(adminToken),
                payload: [],
            });
            expect(res.statusCode).toBe(400);
        });
    });

    describe('GET /:id/repos — repository listing', () => {
        it('returns {slug, name, archived, defaultBranch} incl. an archived repo — slug is the canonical id, name the display name (#213)', async () => {
            const id = await createGithub();
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([
                        makeRepo('active-svc', false, 'main'),
                        makeRepo('legacy-svc', true, 'master'),
                    ]),
                }),
            );

            const res = await app.inject({
                method: 'GET',
                url: `/api/admin/git/providers/${id}/repos`,
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            const repos = res.json().data as {
                slug: string;
                name: string;
                archived: boolean;
                defaultBranch: string;
            }[];
            expect(repos).toEqual([
                {slug: 'active-svc', name: 'Display active-svc', archived: false, defaultBranch: 'main'},
                {slug: 'legacy-svc', name: 'Display legacy-svc', archived: true, defaultBranch: 'master'},
            ]);
            // The archived flag is surfaced so the UI can exclude archived by default.
            expect(repos.find((r) => r.slug === 'legacy-svc')?.archived).toBe(true);
        });

        it('returns an empty list when the provider has no repos', async () => {
            const id = await createGithub();
            const res = await app.inject({
                method: 'GET',
                url: `/api/admin/git/providers/${id}/repos`,
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data).toEqual([]);
        });

        it('returns a clean 502 {ok:false, error, hint} on a listing failure — not a 500', async () => {
            const id = await createGithub();
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockRejectedValue(new Error('GitHub API forbidden (403): scopes')),
                }),
            );
            const res = await app.inject({
                method: 'GET',
                url: `/api/admin/git/providers/${id}/repos`,
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(502);
            const body = res.json();
            expect(body.ok).toBe(false);
            expect(body.error).toMatch(/403/);
            expect(body.hint).toMatch(/read scopes/);
        });

        it('returns a typed 404 for an unknown id', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/admin/git/providers/nope/repos',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(404);
            expect(res.json().message).toMatch(/not found/);
        });

        it('fails closed with 503 when the server key is unconfigured', async () => {
            const id = await createGithub();
            delete process.env.TOPROPE_SECRET_KEY;
            const res = await app.inject({
                method: 'GET',
                url: `/api/admin/git/providers/${id}/repos`,
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(503);
            expect(res.json().message).toMatch(/TOPROPE_SECRET_KEY is not set/);
        });
    });
});
