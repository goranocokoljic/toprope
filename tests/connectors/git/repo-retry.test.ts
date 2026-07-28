/**
 * #272 Layer 2 — retry the failed REPO, not just the failed request.
 *
 * A repo whose commit fetch throws leaves the provider's `[since, until]` window
 * incompletely covered, which (correctly, per #231) holds the provider's cursor and
 * discards ALL of the run's partial data — commit counts are additive across runs, so
 * persisting a half-covered window would double-count on the re-fetch. An initial
 * full-history sync makes thousands of requests over hours, so one blip anywhere used to
 * cost the whole run: exactly what happened to `bitbucket/wireless_media` on both of its
 * first two runs (2026-07-28).
 *
 * The all-or-nothing rule is NOT weakened here. These tests pin both halves of that: a
 * transient fault that heals within the in-run budget lands the data exactly once, and a
 * fault that does not heal behaves precisely as it did before.
 *
 * Fake timers throughout — the real pauses are 5 and 15 minutes.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper} from '../../../src/registry/developers';
import {
    GitSync,
    GIT_REPO_RETRY_DELAYS_MS,
    GIT_RUN_RETRY_SLEEP_BUDGET_MS,
    getProviderStall,
    syncStateKey,
    type GitSyncProgress,
} from '../../../src/connectors/git/sync';
import {GitProviderFetchError} from '../../../src/connectors/git/providers/http-retry';
import type {
    GitCommit,
    GitProvider,
    GitProviderConfig,
    GitRepo,
} from '../../../src/connectors/git/providers/types';

vi.mock('../../../src/connectors/git/providers/factory', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/connectors/git/providers/factory')>();
    return {...actual, createGitProvider: vi.fn()};
});

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');

const CONFIG: GitProviderConfig = {
    type: 'github',
    org: 'test-org',
    auth: {type: 'token', api_token: 'test-token'},
};
const FORWARD_KEY = syncStateKey('github', 'test-org');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function seedAlice(db: Database.Database): string {
    addTeam(db, 'eng');
    const dev = addDeveloper(db, 'alice', 'eng', 'alice@example.com', 'Alice');
    db.prepare(`UPDATE developers SET external_ids = '{"github":"alice"}' WHERE id = ?`).run(dev.id);
    return dev.id;
}

function makeRepo(name: string): GitRepo {
    return {
        id: name,
        name,
        fullName: `test-org/${name}`,
        defaultBranch: 'main',
        isArchived: false,
    };
}

function makeCommit(sha: string, date = '2024-01-15T10:00:00Z'): GitCommit {
    return {
        sha,
        author: {name: 'alice', email: 'alice@example.com', username: 'alice'},
        date,
        message: 'feat: add feature',
        additions: 50,
        deletions: 10,
        filesChanged: ['src/foo.ts'],
        diffs: [{path: 'src/foo.ts', additions: 50, deletions: 10, status: 'modified'}],
    };
}

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
    };
}

async function getCreateGitProvider(): Promise<ReturnType<typeof vi.fn>> {
    const {createGitProvider} = await import('../../../src/connectors/git/providers/factory');
    return createGitProvider as ReturnType<typeof vi.fn>;
}

/** Runs a sync to completion while draining the in-run retry pauses on the fake clock. */
async function runSync(
    db: Database.Database,
    onProgress?: (p: GitSyncProgress) => void,
): Promise<Awaited<ReturnType<GitSync['syncProviders']>>> {
    const pending = new GitSync({enabled: false}).syncProviders(db, [CONFIG], onProgress);
    await vi.runAllTimersAsync();
    return pending;
}

function readState(db: Database.Database, key: string): string | undefined {
    return (db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
        | {value: string}
        | undefined)?.value;
}

function dayRow(db: Database.Database, date: string): {commits: number} | undefined {
    return db.prepare('SELECT commits FROM git_snapshots WHERE date = ?').get(date) as
        | {commits: number}
        | undefined;
}

describe('in-run repo retry (#272)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        vi.resetAllMocks();
        vi.useFakeTimers();
    });

    afterEach(() => {
        db.close();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('retries a repo whose commit fetch fails transiently, and the run completes', async () => {
        seedAlice(db);
        const createGitProvider = await getCreateGitProvider();
        let calls = 0;
        const getCommits = vi.fn().mockImplementation(async (): Promise<GitCommit[]> => {
            calls++;
            // Two 503s — the request-level budget in http-retry.ts is already spent by the
            // time this surfaces, which is precisely when the old code gave up on the run.
            if (calls <= 2) {
                throw new GitProviderFetchError('Bitbucket API server error 503: /diffstat/x', 503);
            }
            return [makeCommit('c-1')];
        });
        createGitProvider.mockReturnValue(
            makeMockProvider({listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]), getCommits}),
        );

        const result = await runSync(db);

        // Attempt + both retries, i.e. the whole budget was available and used.
        expect(calls).toBe(1 + GIT_REPO_RETRY_DELAYS_MS.length);
        // The heal is invisible to the run's outcome: no error, data written…
        expect(result.errors).toHaveLength(0);
        expect(result.snapshotsWritten).toBeGreaterThan(0);
        // …the commit landed EXACTLY once. Note what this does and does not prove: the failing
        // attempts THROW, so they never yield a partial list, and assign-vs-append at the call
        // site is not distinguishable here. What it does catch is the accumulation that matters
        // in practice — a retry that re-pages the same window feeding `allCommits` twice, which
        // the additive commit merge would then persist as a double-count. The two-repo case
        // below is the sharper version.
        expect(dayRow(db, '2024-01-15')?.commits).toBe(1);
        // …and the cursor advanced, so the next run does not re-cover this window.
        expect(readState(db, FORWARD_KEY)).toBe(result.lastSyncTime);
    });

    it('pins the retry schedule as minutes, in order', () => {
        // LITERALS, not the constant compared to itself. Every call-count assertion below is
        // expressed as `1 + GIT_REPO_RETRY_DELAYS_MS.length`, so without this the schedule could
        // be reduced to `[1_000, 2_000]` — reinstating a fuse far shorter than the outages #272
        // exists to survive — and the whole suite would stay green.
        expect(GIT_REPO_RETRY_DELAYS_MS).toEqual([5 * 60_000, 15 * 60_000]);
        expect(GIT_RUN_RETRY_SLEEP_BUDGET_MS).toBe(40 * 60_000);
    });

    it('waits the documented 5-then-15-minute pauses, in that order', async () => {
        seedAlice(db);
        const createGitProvider = await getCreateGitProvider();
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        let calls = 0;
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                getCommits: vi.fn().mockImplementation(async (): Promise<GitCommit[]> => {
                    calls++;
                    if (calls <= 2) throw new GitProviderFetchError('server error 503', 503);
                    return [makeCommit('c-1')];
                }),
            }),
        );

        await runSync(db);

        // Ordered, so swapping the constant to [15min, 5min] fails — `toContain` alone pinned
        // neither the order nor which attempt got which pause.
        const repoPauses = setTimeoutSpy.mock.calls
            .map((c) => Number(c[1]))
            .filter((d) => GIT_REPO_RETRY_DELAYS_MS.includes(d));
        expect(repoPauses).toEqual([5 * 60_000, 15 * 60_000]);
    });

    it('does not retry a fault it did not produce — the predicate fails closed', async () => {
        // isRetryableGitFetchError only trusts a GitProviderFetchError. That is deliberate, and
        // it makes the whole feature depend on the real providers emitting that class out of
        // getCommits (pinned per-provider in the provider suites). This is the other half: a
        // plain Error, however 503-looking its message, buys no 20-minute pause.
        seedAlice(db);
        const createGitProvider = await getCreateGitProvider();
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        const getCommits = vi
            .fn()
            .mockRejectedValue(new Error('Bitbucket API server error 503: /diffstat/x'));
        createGitProvider.mockReturnValue(
            makeMockProvider({listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]), getCommits}),
        );

        const result = await runSync(db);

        expect(getCommits).toHaveBeenCalledTimes(1);
        expect(
            setTimeoutSpy.mock.calls.some((c) =>
                GIT_REPO_RETRY_DELAYS_MS.includes(Number(c[1])),
            ),
        ).toBe(false);
        expect(result.errors.some((e) => /Failed to fetch commits/.test(e))).toBe(true);
        expect(readState(db, FORWARD_KEY)).toBeUndefined();
    });

    it('re-enters the commits step before each pause so the counter is not frozen', async () => {
        // A finished-looking "commit 40/40" left on the label through a 15-minute wait is
        // exactly the "reads as hung" symptom #270 exists to remove.
        seedAlice(db);
        const createGitProvider = await getCreateGitProvider();
        let calls = 0;
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                getCommits: vi
                    .fn()
                    .mockImplementation(
                        async (
                            _repo: string,
                            _since: string,
                            _until: string,
                            onProgress?: (p: {done: number; total: number | null}) => void,
                        ): Promise<GitCommit[]> => {
                            calls++;
                            onProgress?.({done: 7, total: 7});
                            if (calls === 1) throw new GitProviderFetchError('503', 503);
                            return [makeCommit('c-1')];
                        },
                    ),
            }),
        );

        const seen: Array<{done: number | null; total: number | null}> = [];
        await runSync(db, (p) => {
            if (p.repo_step === 'commits') {
                seen.push({done: p.repo_step_done, total: p.repo_step_total});
            }
        });

        // The stale 7/7 from the failed attempt is superseded by a reset before the pause.
        const afterStale = seen.findIndex((s) => s.done === 7 && s.total === 7);
        expect(afterStale).toBeGreaterThanOrEqual(0);
        expect(seen.slice(afterStale + 1)).toContainEqual({done: 0, total: null});
    });

    it('a persistently failing repo behaves exactly as before: cursor held, partials dropped, error recorded', async () => {
        seedAlice(db);
        const createGitProvider = await getCreateGitProvider();
        const getCommits = vi.fn().mockImplementation(async (repo: string): Promise<GitCommit[]> => {
            if (repo === 'bad-repo') {
                throw new GitProviderFetchError('GitHub API server error 503: /commits', 503);
            }
            return [makeCommit('c-good')];
        });
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('bad-repo'), makeRepo('good-repo')]),
                getCommits,
            }),
        );

        const result = await runSync(db);

        // The budget was spent on the bad repo (3 attempts) and the good repo ran once.
        expect(getCommits.mock.calls.filter((c) => c[0] === 'bad-repo')).toHaveLength(
            1 + GIT_REPO_RETRY_DELAYS_MS.length,
        );
        // Then: identical to pre-#272 behavior.
        expect(result.errors.some((e) => /bad-repo.*Failed to fetch commits/.test(e))).toBe(true);
        expect(result.snapshotsWritten).toBe(0);
        expect(dayRow(db, '2024-01-15')).toBeUndefined();
        expect(readState(db, FORWARD_KEY)).toBeUndefined();
        // …including the stall counter that drives doctor's "not advancing" alert (#235).
        expect(getProviderStall(db, 'github', 'test-org')?.runs).toBe(1);
    });

    it('reports the LAST fault of an exhausted sequence, not the first', async () => {
        seedAlice(db);
        const createGitProvider = await getCreateGitProvider();
        let calls = 0;
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                getCommits: vi.fn().mockImplementation(async (): Promise<GitCommit[]> => {
                    calls++;
                    throw new GitProviderFetchError(`attempt ${calls} failed`, 503);
                }),
            }),
        );

        const result = await runSync(db);

        // The fault that actually ended the repo is the one an operator needs.
        expect(result.errors.some((e) => e.includes('attempt 3 failed'))).toBe(true);
        expect(result.errors.some((e) => e.includes('attempt 1 failed'))).toBe(false);
    });

    it('does NOT pause and retry a deterministic 4xx', async () => {
        // Retrying a bad credential costs 20 minutes PER REPO — one wrong token would turn
        // a nightly sync into a run that never finishes.
        seedAlice(db);
        const createGitProvider = await getCreateGitProvider();
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        const getCommits = vi
            .fn()
            .mockRejectedValue(new GitProviderFetchError('GitHub API error 401: /commits', 401));
        createGitProvider.mockReturnValue(
            makeMockProvider({listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]), getCommits}),
        );

        const result = await runSync(db);

        expect(getCommits).toHaveBeenCalledTimes(1);
        expect(setTimeoutSpy.mock.calls.map((c) => c[1])).not.toContain(
            GIT_REPO_RETRY_DELAYS_MS[0],
        );
        expect(result.errors.some((e) => /Failed to fetch commits.*401/.test(e))).toBe(true);
        expect(readState(db, FORWARD_KEY)).toBeUndefined();
    });

    it('a failed repo still reaches the N/M progress counter', async () => {
        seedAlice(db);
        const createGitProvider = await getCreateGitProvider();
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('bad-repo'), makeRepo('good-repo')]),
                getCommits: vi.fn().mockImplementation(async (repo: string): Promise<GitCommit[]> => {
                    if (repo === 'bad-repo') throw new GitProviderFetchError('503', 503);
                    return [makeCommit('c-good')];
                }),
            }),
        );

        let last: GitSyncProgress | null = null;
        await runSync(db, (p) => {
            last = {...p};
        });

        expect(last).not.toBeNull();
        expect(last!.repos_processed).toBe(2);
        expect(last!.repos_total).toBe(2);
    });

    it('retries the PR list fetch on the same terms as the commit fetch', async () => {
        // Retrying ONLY commits would have made the PR path worse than before #272. The two used
        // to fail together (one 6-second budget blown meant the other's was too), so an
        // incomplete commit fetch held the cursor and the failed PR window was re-covered next
        // run as a side effect. Harden commits alone and that coupling breaks: commits heal, the
        // cursor advances past a PR window whose fetch failed, and since getPullRequests is
        // bounded below by the advanced cursor a PR never touched again is never re-listed —
        // which max()-merged PR fields cannot self-heal from.
        seedAlice(db);
        const createGitProvider = await getCreateGitProvider();
        let prCalls = 0;
        const getPullRequests = vi.fn().mockImplementation(async () => {
            prCalls++;
            if (prCalls <= 2) throw new GitProviderFetchError('server error 503', 503);
            return [];
        });
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                getCommits: vi.fn().mockResolvedValue([makeCommit('c-1')]),
                getPullRequests,
            }),
        );

        const result = await runSync(db);

        expect(prCalls).toBe(1 + GIT_REPO_RETRY_DELAYS_MS.length);
        expect(result.errors).toHaveLength(0);
    });

    it('a PR fetch that stays broken is still best-effort — it does not hold the cursor', async () => {
        // The retry narrows the window in which the best-effort answer is reached; it must not
        // change what that answer IS. Holding the cursor for a PR failure would force an additive
        // commit re-fetch, which #231 weighed and rejected.
        seedAlice(db);
        const createGitProvider = await getCreateGitProvider();
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                getCommits: vi.fn().mockResolvedValue([makeCommit('c-1')]),
                getPullRequests: vi
                    .fn()
                    .mockRejectedValue(new GitProviderFetchError('server error 503', 503)),
            }),
        );

        const result = await runSync(db);

        expect(result.errors.some((e) => /Failed to fetch PRs/.test(e))).toBe(true);
        // Commits still landed and the cursor still advanced — unchanged from before #272.
        expect(dayRow(db, '2024-01-15')?.commits).toBe(1);
        expect(readState(db, FORWARD_KEY)).toBe(result.lastSyncTime);
    });

    it('bounds total retry sleep per run, so a provider-wide outage is not 20min x N repos', async () => {
        // A 5xx usually means the provider is unhealthy, not that one repo is cursed — so the
        // per-repo budget multiplies. At 30 repos that is 10 hours of pure sleeping, the
        // pipeline's connector retry doubles it, and the daily cron starts the next run on top
        // of the previous one — all to reach the same held cursor.
        seedAlice(db);
        const createGitProvider = await getCreateGitProvider();
        const repos = ['r1', 'r2', 'r3', 'r4', 'r5'].map(makeRepo);
        const getCommits = vi
            .fn()
            .mockRejectedValue(new GitProviderFetchError('server error 503', 503));
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        createGitProvider.mockReturnValue(
            makeMockProvider({listRepos: vi.fn().mockResolvedValue(repos), getCommits}),
        );

        const result = await runSync(db);

        const sleptMs = setTimeoutSpy.mock.calls
            .map((c) => Number(c[1]))
            .filter((d) => GIT_REPO_RETRY_DELAYS_MS.includes(d))
            .reduce((a, b) => a + b, 0);
        expect(sleptMs).toBeLessThanOrEqual(GIT_RUN_RETRY_SLEEP_BUDGET_MS);
        // Unbounded, five repos would each pay the full 20 minutes.
        expect(sleptMs).toBeLessThan(5 * 20 * 60_000);
        // Every repo is still ATTEMPTED — the budget caps the pauses, not the coverage…
        expect(new Set(getCommits.mock.calls.map((c) => c[0])).size).toBe(repos.length);
        // …and every one still reports its error and holds the cursor, exactly as before.
        expect(repos.every((r) => result.errors.some((e) => e.includes(r.name)))).toBe(true);
        expect(readState(db, FORWARD_KEY)).toBeUndefined();
    });

    it('does not double-count when the SECOND of two repos heals on retry', async () => {
        // The retry re-runs only the failing repo; the already-collected repo's commits must
        // not be re-accumulated, and the healed repo's must land once.
        seedAlice(db);
        const createGitProvider = await getCreateGitProvider();
        let flakyCalls = 0;
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('steady'), makeRepo('flaky')]),
                getCommits: vi.fn().mockImplementation(async (repo: string): Promise<GitCommit[]> => {
                    if (repo === 'steady') return [makeCommit('c-steady')];
                    flakyCalls++;
                    if (flakyCalls === 1) throw new GitProviderFetchError('503', 503);
                    return [makeCommit('c-flaky', '2024-01-15T11:00:00Z')];
                }),
            }),
        );

        const result = await runSync(db);

        expect(result.errors).toHaveLength(0);
        // Exactly the two distinct commits — 3 would mean the steady repo's commit was
        // counted twice, 1 would mean the healed repo's was dropped.
        expect(dayRow(db, '2024-01-15')?.commits).toBe(2);
        expect(readState(db, FORWARD_KEY)).toBe(result.lastSyncTime);
    });
});
