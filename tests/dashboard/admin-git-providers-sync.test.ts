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
import type {GitProvider, GitRepo, GitCommit} from '../../src/connectors/git/providers/types';
import type {GitSyncProgress} from '../../src/connectors/git/sync';

// Stub createGitProvider so no test hits the network, but keep the rest of the
// factory (validateGitProviderConfig) real so the store/codec seeding + decrypt
// path stays exercised. This is the "mocked provider" the issue asks for.
vi.mock('../../src/connectors/git/providers/factory', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/connectors/git/providers/factory')>();
    return {...actual, createGitProvider: vi.fn()};
});

const PASSWORD = 'correct-horse-battery';
const KEY_B64 = Buffer.alloc(32, 7).toString('base64');

// A config-file provider — read-only, cannot be sync-now'd individually.
const CONFIG_PROVIDER_ID = 'config:github:config-org';
const GIT_CONFIG: GitConnectorConfig = {
    enabled: true,
    providers: [{type: 'github', org: 'config-org', auth: {type: 'token', api_token: 'ghp_CONFIG_9999'}}],
};

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

function makeRepo(name: string): GitRepo {
    return {
        id: name,
        name,
        fullName: `db-org/${name}`,
        displayName: name,
        defaultBranch: 'main',
        isArchived: false,
    };
}

function makeCommit(username: string): GitCommit {
    return {
        sha: `sha-${username}`,
        author: {name: username, email: `${username}@example.com`, username},
        date: '2024-01-15T10:00:00Z',
        message: 'feat: add feature',
        additions: 50,
        deletions: 10,
        filesChanged: ['src/foo.ts'],
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

interface ProviderListRow {
    id: string;
    last_sync_status: string | null;
    last_sync_at: string | null;
    last_sync_error: string | null;
    active_sync: {started_at: string; progress: GitSyncProgress | null} | null;
}

describe('admin git-provider sync-now API (#199)', () => {
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
        // Map a github login "alice" → dev-1 so a synced commit produces a snapshot.
        db.prepare(`UPDATE developers SET external_ids = '{"github":"alice"}' WHERE id = 'dev-1'`).run();
        const hash = await hashPassword(PASSWORD);
        createUser(db, {email: 'admin@test.com', passwordHash: hash, role: 'admin'});
        createUser(db, {email: 'alice@test.com', passwordHash: hash, role: 'developer', developerId: 'dev-1'});
        app = await buildApp(db);
        adminToken = await login(app, 'admin@test.com');
        devToken = await login(app, 'alice@test.com');
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

    // Create a DB github provider (container db-org) and return its id.
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

    async function triggerSync(id: string, token = adminToken): ReturnType<FastifyInstance['inject']> {
        return app.inject({
            method: 'POST',
            url: `/api/admin/git/providers/${id}/sync`,
            headers: authHeaders(token),
        });
    }

    async function readProvider(id: string): Promise<ProviderListRow | undefined> {
        const res = await app.inject({
            method: 'GET',
            url: '/api/admin/git/providers',
            headers: authHeaders(adminToken),
        });
        return (res.json().data as ProviderListRow[]).find((p) => p.id === id);
    }

    // Poll the (durable) provider row until its last_sync_status settles to the
    // expected terminal value — the same surface the UI polls. The sync is
    // fire-and-forget, so the 202 lands before the run finishes.
    async function waitForSyncStatus(id: string, expected: 'ok' | 'error', timeoutMs = 2000): Promise<ProviderListRow> {
        const deadline = Date.now() + timeoutMs;
        let last: ProviderListRow | undefined;
        while (Date.now() < deadline) {
            last = await readProvider(id);
            if (last?.last_sync_status === expected) return last;
            await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error(`timed out waiting for status=${expected}; last=${JSON.stringify(last)}`);
    }

    describe('role enforcement — server is the trust boundary', () => {
        it('rejects a developer session (403)', async () => {
            const res = await triggerSync('some-id', devToken);
            expect(res.statusCode).toBe(403);
        });

        it('rejects an unauthenticated request (401/403)', async () => {
            const res = await app.inject({method: 'POST', url: '/api/admin/git/providers/some-id/sync'});
            expect([401, 403]).toContain(res.statusCode);
        });
    });

    describe('POST /:id/sync — trigger + status', () => {
        it('returns a 202 running handle then persists status=ok and writes snapshots', async () => {
            const id = await createGithub();
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('myrepo')]),
                    getCommits: vi.fn().mockResolvedValue([makeCommit('alice')]),
                    getCommitDiff: vi.fn().mockResolvedValue([
                        {path: 'src/foo.ts', additions: 30, deletions: 5, status: 'modified'},
                    ]),
                }),
            );

            const res = await triggerSync(id);
            expect(res.statusCode).toBe(202);
            const handle = res.json().data;
            expect(handle).toEqual({
                provider_id: id,
                status: 'running',
                started_at: expect.any(String),
            });
            // The handle never echoes token material.
            expect(JSON.stringify(res.json())).not.toContain('ghp_dbSECRET_TOKEN_ABCD');

            const row = await waitForSyncStatus(id, 'ok');
            expect(row.last_sync_at).not.toBeNull();
            expect(row.last_sync_error).toBeNull();

            // A snapshot for the synced commit's day was written (integration).
            const snap = db
                .prepare(`SELECT developer_id FROM git_snapshots WHERE date = '2024-01-15'`)
                .get() as {developer_id: string} | undefined;
            expect(snap?.developer_id).toBe('dev-1');
        });

        it('settles status=ok when the only "errors" are unmatched authors (bots), snapshots still written', async () => {
            // Regression (SO-1): a healthy sync in a real repo almost always has
            // some unmatched authors (CI bots, external contributors). runSync
            // reports that as an advisory in `errors`; it must NOT flip a provider
            // that synced fine to a red error state.
            const id = await createGithub();
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('myrepo')]),
                    // alice is mapped → dev-1; dependabot[bot] has no developer record.
                    getCommits: vi
                        .fn()
                        .mockResolvedValue([makeCommit('alice'), makeCommit('dependabot[bot]')]),
                    getCommitDiff: vi.fn().mockResolvedValue([
                        {path: 'src/foo.ts', additions: 30, deletions: 5, status: 'modified'},
                    ]),
                }),
            );

            const res = await triggerSync(id);
            expect(res.statusCode).toBe(202);

            const row = await waitForSyncStatus(id, 'ok');
            // The unmatched-authors advisory is not surfaced as a failure.
            expect(row.last_sync_error).toBeNull();
            expect(row.last_sync_at).not.toBeNull();
            // The mapped author's snapshot was still written.
            const snap = db
                .prepare(`SELECT developer_id FROM git_snapshots WHERE date = '2024-01-15'`)
                .get() as {developer_id: string} | undefined;
            expect(snap?.developer_id).toBe('dev-1');
        });

        it('persists status=error with the failure message when the provider fails', async () => {
            const id = await createGithub();
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockRejectedValue(new Error('GitHub API error 401: bad token')),
                }),
            );

            const res = await triggerSync(id);
            expect(res.statusCode).toBe(202);

            const row = await waitForSyncStatus(id, 'error');
            // The message is surfaced to the UI, not swallowed.
            expect(row.last_sync_error).toMatch(/401/);
            expect(row.last_sync_at).not.toBeNull();

            // An ERROR outcome must also clear the in-flight registry (#209):
            // the row goes idle and a fresh trigger is accepted, not 409'd.
            expect(row.active_sync).toBeNull();
            const retry = await triggerSync(id);
            expect(retry.statusCode).toBe(202);
            await waitForSyncStatus(id, 'error');
        });

        it('rejects a duplicate trigger while a run is in flight (409, overlap guard)', async () => {
            const id = await createGithub();
            // Gate listRepos so the first run stays in flight until we release it.
            let release!: () => void;
            const gate = new Promise<void>((r) => {
                release = r;
            });
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockImplementation(async () => {
                        await gate;
                        return [];
                    }),
                }),
            );

            const first = await triggerSync(id);
            expect(first.statusCode).toBe(202);

            // Second trigger while the first is still running → rejected.
            const second = await triggerSync(id);
            expect(second.statusCode).toBe(409);
            expect(second.json().message).toMatch(/already in progress/);

            // Release the first run and let it settle so a later trigger works.
            release();
            await waitForSyncStatus(id, 'ok');

            // Once settled, a fresh trigger is accepted again (guard cleared).
            const third = await triggerSync(id);
            expect(third.statusCode).toBe(202);
            await waitForSyncStatus(id, 'ok');
        });

        it('exposes active_sync on the list while a run is in flight and clears it after (#209)', async () => {
            const id = await createGithub();
            // Idle rows carry active_sync: null (the UI's "nothing running" signal).
            expect((await readProvider(id))?.active_sync).toBeNull();

            // Gate listRepos so the run parks in the listing stage.
            let release!: () => void;
            const gate = new Promise<void>((r) => {
                release = r;
            });
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockImplementation(async () => {
                        await gate;
                        return [];
                    }),
                }),
            );

            const res = await triggerSync(id);
            expect(res.statusCode).toBe(202);

            const running = await readProvider(id);
            expect(running?.active_sync).not.toBeNull();
            expect(running?.active_sync?.started_at).toEqual(expect.any(String));
            // The listing stage was emitted before the (gated) listRepos call.
            expect(running?.active_sync?.progress?.stage).toBe('listing_repos');

            // The list payload never carries token material, including while the
            // in-flight progress snapshot is being served.
            const listRes = await app.inject({
                method: 'GET',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
            });
            expect(listRes.body).not.toContain('ghp_dbSECRET_TOKEN_ABCD');

            release();
            await waitForSyncStatus(id, 'ok');
            // Settled: the in-flight entry is cleared again.
            expect((await readProvider(id))?.active_sync).toBeNull();
        });

        it('streams cumulative progress counters as repos are fetched (#209)', async () => {
            const id = await createGithub();
            // Two repos; the second repo's commit fetch is gated so the run parks
            // mid-fetch with repo1 fully processed.
            let release!: () => void;
            const gate = new Promise<void>((r) => {
                release = r;
            });
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1'), makeRepo('repo2')]),
                    getCommits: vi.fn().mockImplementation(async (repo: string) => {
                        if (repo === 'repo2') {
                            await gate;
                            return [];
                        }
                        return [makeCommit('alice')];
                    }),
                    getCommitDiff: vi.fn().mockResolvedValue([
                        {path: 'src/foo.ts', additions: 30, deletions: 5, status: 'modified'},
                    ]),
                }),
            );

            expect((await triggerSync(id)).statusCode).toBe(202);

            // Poll the same surface the UI polls until repo1 has completed.
            const deadline = Date.now() + 2000;
            let progress: GitSyncProgress | null | undefined;
            while (Date.now() < deadline) {
                progress = (await readProvider(id))?.active_sync?.progress;
                if (progress?.repos_processed === 1) break;
                await new Promise((r) => setTimeout(r, 10));
            }
            expect(progress).toMatchObject({
                stage: 'fetching',
                repos_total: 2,
                repos_processed: 1,
                current_repo: 'repo2',
                commits_fetched: 1,
            });

            // The richest snapshot (populated repo name + counters) is on the
            // wire right now — it must carry no token material either.
            const midRes = await app.inject({
                method: 'GET',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
            });
            expect(midRes.body).not.toContain('ghp_dbSECRET_TOKEN_ABCD');

            release();
            const row = await waitForSyncStatus(id, 'ok');
            expect(row.active_sync).toBeNull();
        });

        it('returns a typed 404 for an unknown id', async () => {
            const res = await triggerSync('does-not-exist');
            expect(res.statusCode).toBe(404);
            expect(res.json().message).toMatch(/not found/);
        });

        it('returns a typed 409 for a disabled provider (not a silent no-op)', async () => {
            const id = await createGithub();
            // Disable the provider directly.
            db.prepare('UPDATE git_providers SET enabled = 0 WHERE id = ?').run(id);

            const res = await triggerSync(id);
            expect(res.statusCode).toBe(409);
            expect(res.json().message).toMatch(/disabled/);
            // Nothing ran — status stays untouched.
            expect((await readProvider(id))?.last_sync_status).toBeNull();
        });

        it('rejects a read-only config-file provider id (409)', async () => {
            const res = await triggerSync(CONFIG_PROVIDER_ID);
            expect(res.statusCode).toBe(409);
            expect(res.json().message).toMatch(/read-only/);
        });

        it('fails closed with 503 (not 500) when the server key is unconfigured', async () => {
            const id = await createGithub();
            delete process.env.TOPROPE_SECRET_KEY;
            const res = await triggerSync(id);
            expect(res.statusCode).toBe(503);
            expect(res.json().message).toMatch(/TOPROPE_SECRET_KEY is not set/);
            // No run started — no in-flight leak, status untouched.
            expect((await readProvider(id))?.last_sync_status).toBeNull();
        });
    });
});
