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
        // …the commit landed EXACTLY once (a re-paged window must not accumulate on top of
        // the failed attempt's partial list)…
        expect(dayRow(db, '2024-01-15')?.commits).toBe(1);
        // …and the cursor advanced, so the next run does not re-cover this window.
        expect(readState(db, FORWARD_KEY)).toBe(result.lastSyncTime);
    });

    it('waits the documented 5-then-15-minute pauses between attempts', async () => {
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

        const delays = setTimeoutSpy.mock.calls.map((c) => c[1]);
        // Minutes, not seconds: on a multi-hour run these pauses are free, and a real
        // provider blip routinely outlasts anything shorter.
        expect(delays).toContain(GIT_REPO_RETRY_DELAYS_MS[0]);
        expect(delays).toContain(GIT_REPO_RETRY_DELAYS_MS[1]);
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
