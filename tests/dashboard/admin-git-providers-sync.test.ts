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
import type {GitProvider, GitRepo, GitCommit, GitFileDiff} from '../../src/connectors/git/providers/types';
import type {GitSyncProgress} from '../../src/connectors/git/sync';
import {declareEarliestSyncedFloor} from '../../src/connectors/git/sync';

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

/**
 * How many times a test reached this file's DEFAULT `getCommitDiff` — the fallback branch no
 * in-tree provider takes (#271/#280). Asserted zero by the `afterEach` below, mirroring the
 * guard in `tests/connectors/git/sync.test.ts`. Without it, deleting `diffs` from `makeCommit`
 * slides these route tests back onto the fallback in total silence: they assert developer
 * counts and advisory classification, not `files_changed`, so a snapshot built from empty diffs
 * is invisible to every assertion in the file.
 */
let unaskedFallbackFetches = 0;

beforeEach(() => {
    unaskedFallbackFetches = 0;
});

afterEach(() => {
    expect(
        unaskedFallbackFetches,
        'this test fell onto the getCommitDiff fallback: its commits carry no `diffs`, so it is ' +
            'measuring a branch no in-tree provider reaches (#271/#280). Build commits with ' +
            '`makeCommit`, which supplies them.',
    ).toBe(0);
});

function makeMockProvider(overrides: Partial<GitProvider> = {}): GitProvider {
    return {
        name: 'github',
        listRepos: vi.fn().mockResolvedValue([]),
        getCommits: vi.fn().mockResolvedValue([]),
        getPullRequests: vi.fn().mockResolvedValue([]),
        getReviewComments: vi.fn().mockResolvedValue([]),
        getPRReviews: vi.fn().mockResolvedValue([]),
        getCommitDiff: vi.fn().mockImplementation(async (): Promise<GitFileDiff[]> => {
            unaskedFallbackFetches += 1;
            return [];
        }),
        checkAccess: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    } as GitProvider;
}

function makeRepo(name: string): GitRepo {
    return {id: name, name, fullName: `db-org/${name}`, defaultBranch: 'main', isArchived: false};
}

function makeCommit(username: string): GitCommit {
    return {
        sha: `sha-${username}`,
        author: {name: username, email: `${username}@example.com`, username},
        date: '2024-01-15T10:00:00Z',
        message: 'feat: add feature',
        additions: 50,
        deletions: 10,
        // The reuse path (#271) — what every in-tree provider does, so it is what the route's
        // tests must drive. Before #280 these ran against the `getCommitDiff` fallback.
        diffs: [{path: 'src/foo.ts', additions: 50, deletions: 10, status: 'modified'}],
    };
}

async function getCreateGitProvider() {
    const {createGitProvider} = await import('../../src/connectors/git/providers/factory');
    return createGitProvider as ReturnType<typeof vi.fn>;
}

async function buildApp(
    db: Database.Database,
    gitConfig: GitConnectorConfig = GIT_CONFIG,
): Promise<FastifyInstance> {
    const app = Fastify({logger: false});
    registerSessionAuth(app, db);
    registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
    registerMeRoutes(app, db);
    registerAdminRoutes(app, db, gitConfig);
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
    first_sync_pending: boolean;
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

    // Trigger with an explicit JSON body (the first-sync window flow, #228).
    async function triggerSyncBody(
        id: string,
        payload: Record<string, unknown>,
        token = adminToken,
    ): ReturnType<FastifyInstance['inject']> {
        return app.inject({
            method: 'POST',
            url: `/api/admin/git/providers/${id}/sync`,
            headers: authHeaders(token),
            payload,
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

    // Mock getCommits so a run resolves fast AND the [since, until] window it computed
    // is observable. Returns [] so no snapshot bookkeeping runs. Shared by every
    // window-related block below — one arming helper, not one per describe.
    async function armGetCommits(): Promise<ReturnType<typeof vi.fn>> {
        const getCommits = vi.fn().mockResolvedValue([]);
        const createGitProvider = await getCreateGitProvider();
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                getCommits,
            }),
        );
        return getCommits;
    }

    // Raw sync_state read — the pipeline's own cursor/watermark storage.
    function readState(key: string): string | undefined {
        return (db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
            | {value: string}
            | undefined)?.value;
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

        it('settles status=ok when the only "error" is the auto-create SUMMARY advisory (TST-2)', async () => {
            // The sibling exemption above (UNMATCHED_AUTHORS_PREFIX) has had a test since
            // #253; AUTO_CREATE_SUMMARY_PREFIX had none. Without this, dropping or
            // mistyping the second filter clause in `genuineErrors` makes EVERY
            // auto-create-enabled sync persist last_sync_status='error' with a SUCCESS
            // message ("auto-created 1 developers…") as the failure text — green work
            // reported red, and nothing would fail.
            await app.close();
            app = await buildApp(db, {
                ...GIT_CONFIG,
                auto_create_developers: true,
                auto_create_team: 'discovered',
            });
            adminToken = await login(app, 'admin@test.com');

            const id = await createGithub();
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('myrepo')]),
                    // `carol` has no developer record, is not a bot, and carries a provider
                    // login — so auto-create onboards her and emits its summary advisory.
                    getCommits: vi.fn().mockResolvedValue([makeCommit('carol')]),
                }),
            );

            expect((await triggerSync(id)).statusCode).toBe(202);

            const row = await waitForSyncStatus(id, 'ok');
            // The positive control: auto-create really did run this sync, so the advisory
            // it emits really was on `result.errors` and really was classified.
            const created = db.prepare(`SELECT id FROM developers WHERE name = 'carol'`).get() as
                | {id: string}
                | undefined;
            expect(created).toBeDefined();
            // …and the advisory did not turn the provider red.
            expect(row.last_sync_error).toBeNull();
            expect(row.last_sync_at).not.toBeNull();
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

        it('serves the within-repo step indicator over HTTP under its wire field names (#270)', async () => {
            // The server and client `GitSyncProgress` are two independent declarations
            // with no compile-time link, and the API passes the object straight through.
            // Without an assertion at THIS boundary, renaming a server field leaves both
            // sides compiling, the client reading undefined, and the label silently
            // reverting to the pre-#270 frozen line — with a green suite. So read the
            // fields back through the real endpoint rather than trusting a frontend
            // fixture (graduated KB rule: assert server DTO mapping through the API).
            const id = await createGithub();
            let release!: () => void;
            const gate = new Promise<void>((r) => {
                release = r;
            });
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    // Park the run mid-fan-out with a partially-advanced counter, which
                    // is exactly the state the UI polls during a long first sync.
                    getCommits: vi
                        .fn()
                        .mockImplementation(
                            async (
                                _repo: string,
                                _since: string,
                                _until: string,
                                onProgress?: (p: {done: number; total: number | null}) => void,
                            ) => {
                                onProgress?.({done: 40, total: null});
                                onProgress?.({done: 12, total: 40});
                                await gate;
                                return [];
                            },
                        ),
                }),
            );

            expect((await triggerSync(id)).statusCode).toBe(202);

            const deadline = Date.now() + 2000;
            let progress: GitSyncProgress | null | undefined;
            while (Date.now() < deadline) {
                progress = (await readProvider(id))?.active_sync?.progress;
                if (progress?.repo_step === 'commits' && progress.repo_step_total === 40) break;
                await new Promise((r) => setTimeout(r, 10));
            }
            // Exact snake_case keys and values, as the client will read them.
            expect(progress).toMatchObject({
                stage: 'fetching',
                current_repo: 'repo1',
                repo_step: 'commits',
                repo_step_done: 12,
                // Null here (this parks mid-fan-out, past listing), but the KEY must exist
                // under this exact wire name (#276): `toMatchObject` treats a missing
                // property as a mismatch against an expected `null`, so a server-side
                // rename of `repo_step_scanned` fails here rather than silently reaching
                // the client as undefined and suppressing the suffix.
                repo_step_scanned: null,
                repo_step_total: 40,
            });
            // Positive control that the run-level counter really is the frozen one this
            // indicator exists to supplement — it is still 0 while the repo is in flight.
            expect(progress?.commits_fetched).toBe(0);

            release();
            expect((await waitForSyncStatus(id, 'ok')).active_sync).toBeNull();
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

    describe('POST /:id/sync — first-sync history window (#228)', () => {
        it('forwards a valid months window to the first sync (since ≈ now − months)', async () => {
            const id = await createGithub();
            const getCommits = await armGetCommits();

            const before = Date.now();
            const res = await triggerSyncBody(id, {months: 3});
            expect(res.statusCode).toBe(202);
            await waitForSyncStatus(id, 'ok');

            const since = getCommits.mock.calls[0][1] as string;
            expect(since).not.toBe('');
            const expected = new Date(before);
            expected.setUTCMonth(expected.getUTCMonth() - 3);
            expect(Math.abs(Date.parse(since) - expected.getTime())).toBeLessThan(60_000);
        });

        it('defaults to a 6-month window when the body omits months', async () => {
            const id = await createGithub();
            const getCommits = await armGetCommits();

            const before = Date.now();
            // No payload at all — the default must still clamp (not walk all history).
            const res = await triggerSync(id);
            expect(res.statusCode).toBe(202);
            await waitForSyncStatus(id, 'ok');

            const since = getCommits.mock.calls[0][1] as string;
            expect(since).not.toBe('');
            const expected = new Date(before);
            expected.setUTCMonth(expected.getUTCMonth() - 6);
            expect(Math.abs(Date.parse(since) - expected.getTime())).toBeLessThan(60_000);
        });

        it('rejects an out-of-range or non-integer months with 400 and starts no run', async () => {
            const id = await createGithub();
            const getCommits = await armGetCommits();

            for (const bad of [0, -1, 1000, 3.5, 'six', true]) {
                const res = await triggerSyncBody(id, {months: bad});
                expect(res.statusCode).toBe(400);
                expect(res.json().message).toMatch(/months must be an integer/);
            }
            // A rejected request must never have kicked off the pipeline.
            expect(getCommits).not.toHaveBeenCalled();
            expect((await readProvider(id))?.last_sync_status).toBeNull();
        });

        it('treats an explicit null months as the default, not a 400', async () => {
            const id = await createGithub();
            const getCommits = await armGetCommits();

            // Explicit null → absent → default window (still a first sync, so clamps).
            const before = Date.now();
            const res = await triggerSyncBody(id, {months: null as unknown as number});
            expect(res.statusCode).toBe(202);
            await waitForSyncStatus(id, 'ok');
            const since = getCommits.mock.calls[0][1] as string;
            expect(since).not.toBe('');
            const expected = new Date(before);
            expected.setUTCMonth(expected.getUTCMonth() - 6);
            expect(Math.abs(Date.parse(since) - expected.getTime())).toBeLessThan(60_000);
        });

        it('treats a NON-object body (array) as the default, not a 400 (the !body branch)', async () => {
            // asObject() returns null for a non-object JSON body → default window,
            // NOT a 400. `{months: null}` above hits the `body.months == null` path;
            // this hits the distinct `!body` path.
            const id = await createGithub();
            const getCommits = await armGetCommits();

            const before = Date.now();
            const res = await app.inject({
                method: 'POST',
                url: `/api/admin/git/providers/${id}/sync`,
                headers: authHeaders(adminToken),
                payload: [1, 2, 3],
            });
            expect(res.statusCode).toBe(202);
            await waitForSyncStatus(id, 'ok');
            const since = getCommits.mock.calls[0][1] as string;
            expect(since).not.toBe('');
            const expected = new Date(before);
            expected.setUTCMonth(expected.getUTCMonth() - 6);
            expect(Math.abs(Date.parse(since) - expected.getTime())).toBeLessThan(60_000);
        });
    });

    // #228 SO-1 fix — first_sync_pending is derived from the pipeline cursor, not
    // from last_sync_at (which only the sync-now route writes and so goes stale
    // after a scheduled/CLI first sync).
    describe('first_sync_pending signal (#228)', () => {
        it('is true for a never-synced provider and false once a cursor exists, even with last_sync_at still null', async () => {
            const id = await createGithub();
            // Brand new: no cursor → first sync pending.
            expect((await readProvider(id))?.first_sync_pending).toBe(true);

            // Simulate a scheduled/CLI sync: the pipeline writes the cursor
            // (git_last_sync:github:db-org) but NOT last_sync_at.
            db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
                'git_last_sync:github:db-org',
                '2026-01-01T00:00:00.000Z',
            );

            const row = await readProvider(id);
            expect(row?.first_sync_pending).toBe(false);
            // The divergence the fix targets: last_sync_at is still null yet the
            // window is no longer offered.
            expect(row?.last_sync_at).toBeNull();
        });
    });

    // #262 / #264 — delete + re-add of the SAME container. Cursors are keyed by
    // `type:container`, not provider id, so before #264 the "new" provider inherited the
    // deleted one's forward cursor and the pipeline silently discarded the admin's
    // first-sync window. #263 fixed the UI-facing half (the create route derives
    // `first_sync_pending` from the stored cursor set rather than a hardcoded true); #264
    // removed the state itself, by attributing imported data per container so a delete can
    // retract it and purge the cursors together.
    describe('delete + re-add of the same container (#262 / #264)', () => {
        const FORWARD_KEY = 'git_last_sync:github:db-org';
        const EARLIEST_KEY = 'git_earliest_sync:github:db-org';

        // Create the db-org provider and return the CREATE response DTO (not just the
        // id) — first_sync_pending on that response is half of what this issue fixes.
        async function createGithubDto(): Promise<ProviderListRow> {
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
                payload: {type: 'github', container: 'db-org', token: 'ghp_dbSECRET_TOKEN_ABCD'},
            });
            expect(res.statusCode).toBe(201);
            return res.json().data as ProviderListRow;
        }

        async function deleteProviderRoute(id: string): Promise<number> {
            const res = await app.inject({
                method: 'DELETE',
                url: `/api/admin/git/providers/${id}`,
                headers: authHeaders(adminToken),
            });
            return res.statusCode;
        }

        it('POST derives first_sync_pending from the stored cursor set, not a hardcoded true', async () => {
            // A cursor for this container already exists (e.g. it survived an older
            // provider on a build without the delete fix). The pipeline will IGNORE any
            // window, so the create response must not offer one.
            db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
                FORWARD_KEY,
                '2026-07-20T00:00:00.000Z',
            );
            expect((await createGithubDto()).first_sync_pending).toBe(false);
        });

        it('POST still reports first_sync_pending=true for a container with no cursor', async () => {
            expect((await createGithubDto()).first_sync_pending).toBe(true);
        });

        // FLIPPED by #264 (was pinned as a known gap): the delete now retracts the
        // container's data, which is what makes purging its cursors safe. So a re-added
        // provider inherits NOTHING — its first-sync window is honored end to end and the
        // #262 failure mode is unreachable rather than merely reported.
        it('re-added provider inherits no cursor: the window is honored and the watermark is the window start', async () => {
            const first = await createGithubDto();
            // What the first provider's sync left behind: a forward cursor a few days back
            // and a watermark claiming ~6 months of history is imported.
            db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
                FORWARD_KEY,
                '2026-07-20T00:00:00.000Z',
            );
            db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
                EARLIEST_KEY,
                '2026-01-20T00:00:00.000Z',
            );

            expect(await deleteProviderRoute(first.id)).toBe(200);
            // Both cursors are gone with the data they licensed.
            expect(readState(FORWARD_KEY)).toBeUndefined();
            expect(readState(EARLIEST_KEY)).toBeUndefined();

            // Re-add the same workspace: genuinely a first sync again.
            const second = await createGithubDto();
            expect(second.first_sync_pending).toBe(true);

            const getCommits = await armGetCommits();
            const before = Date.now();
            expect((await triggerSyncBody(second.id, {months: 6})).statusCode).toBe(202);
            await waitForSyncStatus(second.id, 'ok');

            // The fetch starts at now − 6 months, NOT at the (purged) inherited cursor.
            const since = getCommits.mock.calls[0][1] as string;
            const expected = new Date(before);
            expected.setUTCMonth(expected.getUTCMonth() - 6);
            expect(Math.abs(Date.parse(since) - expected.getTime())).toBeLessThan(60_000);
            // And the recorded earliest watermark equals that window start exactly (#262 AC3).
            expect(readState(EARLIEST_KEY)).toBe(since);
        });

        // The double-count regression this whole thread is about (#262 AC / #264 AC8): the
        // counters after delete + re-add + sync must equal a single clean import, not the
        // sum of two.
        it('delete + re-add + sync yields exactly the counters of a single clean import', async () => {
            // A run that imports one commit for alice (mapped to dev-1 in beforeEach).
            async function armOneCommit(): Promise<void> {
                const createGitProvider = await getCreateGitProvider();
                createGitProvider.mockReturnValue(
                    makeMockProvider({
                        listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                        getCommits: vi.fn().mockResolvedValue([makeCommit('alice')]),
                    }),
                );
            }
            function counters(): {raw: number; commits: number; snapshotCommits: number} {
                const raw = db
                    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(commits), 0) AS c FROM raw_author_daily')
                    .get() as {n: number; c: number};
                // Scoped to the imported commit's own UTC day: the shared fixtures seed
                // unrelated git_snapshots rows for dev-1, and folding those in would make
                // the comparison insensitive to a double-count on THIS day.
                const snap = db
                    .prepare(
                        `SELECT COALESCE(SUM(commits), 0) AS c FROM git_snapshots
                          WHERE developer_id = 'dev-1' AND date = '2024-01-15'`,
                    )
                    .get() as {c: number};
                return {raw: raw.n, commits: raw.c, snapshotCommits: snap.c};
            }

            // Import #1.
            const first = await createGithubDto();
            await armOneCommit();
            expect((await triggerSyncBody(first.id, {months: 6})).statusCode).toBe(202);
            await waitForSyncStatus(first.id, 'ok');
            const clean = counters();
            expect(clean.commits).toBe(1);
            expect(clean.snapshotCommits).toBe(1);

            // Delete: the container's data is retracted, so nothing is left to double.
            expect(await deleteProviderRoute(first.id)).toBe(200);
            expect(counters()).toEqual({raw: 0, commits: 0, snapshotCommits: 0});

            // Re-add and re-import the same window.
            const second = await createGithubDto();
            await armOneCommit();
            expect((await triggerSyncBody(second.id, {months: 6})).statusCode).toBe(202);
            await waitForSyncStatus(second.id, 'ok');

            // Identical to the single clean import — commits were NOT added twice.
            expect(counters()).toEqual(clean);
        });

        // An in-flight run applies its cursor/watermark writes at the END of the run, so a
        // delete accepted mid-run leaves it writing state for a row that no longer exists.
        it('rejects a delete while a sync is in flight (409), leaving the provider intact', async () => {
            const provider = await createGithubDto();
            // Hold the run open so it is still in flight when the delete arrives.
            let release: (() => void) | undefined;
            const held = new Promise<GitCommit[]>((resolve) => {
                release = (): void => resolve([]);
            });
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    getCommits: vi.fn().mockReturnValue(held),
                }),
            );
            expect((await triggerSyncBody(provider.id, {months: 6})).statusCode).toBe(202);

            expect(await deleteProviderRoute(provider.id)).toBe(409);
            // Still there — a racy 200 would have purged cursors the settling run rewrites.
            expect((await readProvider(provider.id))?.id).toBe(provider.id);

            release?.();
            await waitForSyncStatus(provider.id, 'ok');
            // And once the run settles the delete succeeds.
            expect(await deleteProviderRoute(provider.id)).toBe(200);
        });
    });

    describe('POST /:id/sync-older-history — backward extension (#229)', () => {
        const FORWARD_KEY = 'git_last_sync:github:db-org';
        const EARLIEST_KEY = 'git_earliest_sync:github:db-org';

        async function triggerOlder(
            id: string,
            payload: Record<string, unknown>,
            token = adminToken,
        ): ReturnType<FastifyInstance['inject']> {
            return app.inject({
                method: 'POST',
                url: `/api/admin/git/providers/${id}/sync-older-history`,
                headers: authHeaders(token),
                payload,
            });
        }

        it('fetches [now − months, watermark], lowers the watermark, leaves the forward cursor untouched', async () => {
            const id = await createGithub();
            // A synced provider: a forward cursor AND the floor its first sync recorded.
            // Backfill must read neither cursor nor move it — it walks below the floor.
            // (Both keys, because since #233 a cursor with NO floor is the LEGACY state
            // and is refused outright rather than backfilled — see the 409 test below.)
            db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
                FORWARD_KEY,
                '2026-06-01T00:00:00.000Z',
            );
            const recordedFloor = '2025-09-15T12:00:00.000Z';
            db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
                EARLIEST_KEY,
                recordedFloor,
            );
            const getCommits = await armGetCommits();

            const before = Date.now();
            const res = await triggerOlder(id, {months: 12});
            expect(res.statusCode).toBe(202);
            await waitForSyncStatus(id, 'ok');

            const since = getCommits.mock.calls[0][1] as string;
            const until = getCommits.mock.calls[0][2] as string;
            // since ≈ now − 12mo (the requested target).
            const expSince = new Date(before);
            expSince.setUTCMonth(expSince.getUTCMonth() - 12);
            expect(Math.abs(Date.parse(since) - expSince.getTime())).toBeLessThan(60_000);
            // until = the recorded floor, exactly — the slice is disjoint by construction.
            expect(until).toBe(recordedFloor);

            // Watermark lowered to exactly `since`; forward cursor untouched.
            expect(readState(EARLIEST_KEY)).toBe(since);
            expect(readState(FORWARD_KEY)).toBe('2026-06-01T00:00:00.000Z');
        });

        it('rejects an overlapping window (nothing older to sync) with 409 and starts no run', async () => {
            const id = await createGithub();
            const getCommits = await armGetCommits();
            // Default watermark = now − 6mo; months=3 targets now − 3mo, which is
            // NEWER than the watermark → nothing to extend backward.
            const res = await triggerOlder(id, {months: 3});
            expect(res.statusCode).toBe(409);
            expect(res.json().message).toMatch(/already synced/i);
            expect(getCommits).not.toHaveBeenCalled();
            expect((await readProvider(id))?.last_sync_status).toBeNull();
        });

        it('is idempotent: re-issuing the same window after a successful run no-ops (409)', async () => {
            const id = await createGithub();
            await armGetCommits();
            expect((await triggerOlder(id, {months: 12})).statusCode).toBe(202);
            await waitForSyncStatus(id, 'ok');
            // Watermark is now ≈ now − 12mo; the same absolute request can't reach
            // further back, so it is a no-op reject — never a re-fetch/double-count.
            const again = await triggerOlder(id, {months: 12});
            expect(again.statusCode).toBe(409);
        });

        it('rejects an out-of-range or non-integer months with 400 and starts no run', async () => {
            const id = await createGithub();
            const getCommits = await armGetCommits();
            for (const bad of [0, -1, 1000, 3.5, 'six', true]) {
                const res = await triggerOlder(id, {months: bad});
                expect(res.statusCode).toBe(400);
                expect(res.json().message).toMatch(/months must be an integer/);
            }
            expect(getCommits).not.toHaveBeenCalled();
            expect((await readProvider(id))?.last_sync_status).toBeNull();
        });

        it('rejects a disabled provider (409, not a silent no-op)', async () => {
            const id = await createGithub();
            db.prepare('UPDATE git_providers SET enabled = 0 WHERE id = ?').run(id);
            const res = await triggerOlder(id, {months: 12});
            expect(res.statusCode).toBe(409);
            expect(res.json().message).toMatch(/disabled/);
        });

        // #233: a LEGACY provider (first synced before #229 recorded the floor) has no
        // watermark and no recoverable one. The route must refuse rather than fall back
        // to the old `now − 6mo` guess, which is too RECENT and silently double-counts.
        it('fails closed with 409 for a legacy provider whose floor is unknown, and starts no run', async () => {
            const id = await createGithub();
            const getCommits = await armGetCommits();
            // Legacy = what a pre-#229 first sync left: a forward cursor, no floor.
            db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
                FORWARD_KEY,
                '2026-06-01T00:00:00.000Z',
            );

            // months=60 targets 5y back — far older than the old lazy guess, so this
            // request WOULD have been accepted (and double-counted) before #233.
            const res = await triggerOlder(id, {months: 60});

            expect(res.statusCode).toBe(409);
            expect(res.json().message).toMatch(/set-history-floor/);
            // No fetch, no watermark write — a refusal, not a partial run.
            expect(getCommits).not.toHaveBeenCalled();
            expect(readState(EARLIEST_KEY)).toBeUndefined();
            expect((await readProvider(id))?.last_sync_status).toBeNull();
        });

        it('accepts the backfill once an admin declares the legacy floor', async () => {
            const id = await createGithub();
            const getCommits = await armGetCommits();
            db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
                FORWARD_KEY,
                '2026-06-01T00:00:00.000Z',
            );
            expect((await triggerOlder(id, {months: 60})).statusCode).toBe(409);

            // The recovery path: the admin asserts the real floor.
            const declaredFloor = '2025-01-01T00:00:00.000Z';
            const before = Date.now();
            expect(
                declareEarliestSyncedFloor(
                    db,
                    'github',
                    'db-org',
                    declaredFloor,
                    new Date().toISOString(),
                ),
            ).toEqual({ok: true});

            const res = await triggerOlder(id, {months: 60});
            expect(res.statusCode).toBe(202);
            await waitForSyncStatus(id, 'ok');
            // The declared floor became the slice's upper bound — the backfill extends
            // strictly BELOW what the admin said was already imported…
            expect(getCommits.mock.calls[0][2]).toBe(declaredFloor);
            // …from the requested 60-month target…
            const expSince = new Date(before);
            expSince.setUTCMonth(expSince.getUTCMonth() - 60);
            const since = getCommits.mock.calls[0][1] as string;
            expect(Math.abs(Date.parse(since) - expSince.getTime())).toBeLessThan(60_000);
            // …and the run lowered the floor to it, closing the recovery loop: the
            // forward cursor that made the provider legacy is untouched throughout.
            expect(readState(EARLIEST_KEY)).toBe(since);
            expect(readState(FORWARD_KEY)).toBe('2026-06-01T00:00:00.000Z');
        });

        it('rejects a read-only config-file provider id (409)', async () => {
            const res = await triggerOlder(CONFIG_PROVIDER_ID, {months: 12});
            expect(res.statusCode).toBe(409);
            expect(res.json().message).toMatch(/read-only/);
        });

        it('returns a typed 404 for an unknown id', async () => {
            const res = await triggerOlder('does-not-exist', {months: 12});
            expect(res.statusCode).toBe(404);
            expect(res.json().message).toMatch(/not found/);
        });

        it('rejects a developer session (403)', async () => {
            const res = await triggerOlder('some-id', {months: 12}, devToken);
            expect(res.statusCode).toBe(403);
        });

        it('fails closed with 503 (not 500) when the server key is unconfigured', async () => {
            const id = await createGithub();
            delete process.env.TOPROPE_SECRET_KEY;
            const res = await triggerOlder(id, {months: 12});
            expect(res.statusCode).toBe(503);
            expect(res.json().message).toMatch(/TOPROPE_SECRET_KEY is not set/);
            // No run started — status untouched.
            expect((await readProvider(id))?.last_sync_status).toBeNull();
        });

        // The route's own in-flight guard (shared activeSyncs registry) serializes the
        // read-watermark → lower-watermark sequence so two backfills can't race on the
        // same edge and both write. Distinct from the overlap guard (which needs a
        // settled run) — this must reject while a run is still executing.
        it('rejects a second backfill while one is in flight (409, starts no second run)', async () => {
            const id = await createGithub();
            // Gate listRepos so the first backfill stays in flight until released.
            let release!: () => void;
            const gate = new Promise<void>((r) => {
                release = r;
            });
            const getCommits = vi.fn().mockResolvedValue([]);
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockImplementation(async () => {
                        await gate;
                        return [makeRepo('repo1')];
                    }),
                    getCommits,
                }),
            );

            const first = await triggerOlder(id, {months: 12});
            expect(first.statusCode).toBe(202);

            // Second trigger while the first is still running → rejected, no new run.
            const second = await triggerOlder(id, {months: 24});
            expect(second.statusCode).toBe(409);
            expect(second.json().message).toMatch(/in progress/);
            expect(getCommits).not.toHaveBeenCalled();

            release();
            await waitForSyncStatus(id, 'ok');
        });
    });
});
