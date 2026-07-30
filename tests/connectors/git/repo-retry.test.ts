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
    GIT_RUN_BEST_EFFORT_RETRY_SLEEP_BUDGET_MS,
    GIT_RUN_RETRY_SLEEP_BUDGET_MS,
    RETRY_HEALED_PREFIX,
    getProviderStall,
    isAdvisoryError,
    syncStateKey,
    type GitSyncProgress,
} from '../../../src/connectors/git/sync';
import {GitProviderFetchError} from '../../../src/connectors/git/providers/http-retry';
import type {
    GitCommit,
    GitFetchProgressListener,
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
        // Advisories excluded: a heal now reports itself (RETRY_HEALED_PREFIX) without going red.
        expect(result.errors.filter((e) => !isAdvisoryError(e))).toHaveLength(0);
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
        // Strictly smaller, so a best-effort fetch can never leave the commit fetch with nothing.
        expect(GIT_RUN_BEST_EFFORT_RETRY_SLEEP_BUDGET_MS).toBe(20 * 60_000);
        expect(GIT_RUN_BEST_EFFORT_RETRY_SLEEP_BUDGET_MS).toBeLessThan(
            GIT_RUN_RETRY_SLEEP_BUDGET_MS,
        );
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
                            onProgress?: GitFetchProgressListener,
                        ): Promise<GitCommit[]> => {
                            calls++;
                            // `scanned` rides on the same tick (#276): the reset must drop
                            // it too, or a 15-minute pause shows a stationary scanned count,
                            // which reads as a live walk that has stopped moving — strictly
                            // worse than the frozen `0 commits found` #276 set out to fix,
                            // because the operator has been taught to watch that number.
                            onProgress?.({done: 7, total: 7, scanned: 9});
                            if (calls === 1) throw new GitProviderFetchError('503', 503);
                            return [makeCommit('c-1')];
                        },
                    ),
            }),
        );

        const seen: Array<{done: number | null; scanned: number | null; total: number | null}> = [];
        await runSync(db, (p) => {
            if (p.repo_step === 'commits') {
                seen.push({
                    done: p.repo_step_done,
                    scanned: p.repo_step_scanned,
                    total: p.repo_step_total,
                });
            }
        });

        // The stale 7/7 from the failed attempt is superseded by a reset before the pause.
        const afterStale = seen.findIndex((s) => s.done === 7 && s.total === 7 && s.scanned === 9);
        expect(afterStale).toBeGreaterThanOrEqual(0);
        expect(seen.slice(afterStale + 1)).toContainEqual({done: 0, scanned: null, total: null});
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
        // Advisories excluded: a heal now reports itself (RETRY_HEALED_PREFIX) without going red.
        expect(result.errors.filter((e) => !isAdvisoryError(e))).toHaveLength(0);
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

    it('does not double-count across runs when a run healed and advanced the cursor', async () => {
        // The double-count vector that actually matters. Commit metrics are ADDED across runs on
        // the premise that the cursor makes each run's window disjoint. If a healed run advanced
        // the cursor to the wrong instant, run 2 re-covers the same window and permanently doubles
        // every commit metric — and comparing the cursor to `result.lastSyncTime` cannot catch
        // that, because both come from the same code. This drives a `since`-aware mock instead.
        seedAlice(db);
        const createGitProvider = await getCreateGitProvider();
        const COMMIT_AT = '2024-01-15T10:00:00Z';
        const sinceSeen: string[] = [];
        let calls = 0;
        const getCommits = vi
            .fn()
            .mockImplementation(async (_repo: string, since: string): Promise<GitCommit[]> => {
                calls++;
                if (calls === 1) throw new GitProviderFetchError('server error 503', 503);
                sinceSeen.push(since);
                // A real provider only returns commits at or after `since`.
                if (since !== '' && Date.parse(since) > Date.parse(COMMIT_AT)) return [];
                return [makeCommit('c-1', COMMIT_AT)];
            });
        createGitProvider.mockReturnValue(
            makeMockProvider({listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]), getCommits}),
        );

        const run1 = await runSync(db);
        expect(run1.errors.filter((e) => !isAdvisoryError(e))).toHaveLength(0);
        expect(dayRow(db, '2024-01-15')?.commits).toBe(1);
        const cursorAfterRun1 = readState(db, FORWARD_KEY);
        expect(cursorAfterRun1).toBe(run1.lastSyncTime);

        const run2 = await runSync(db);

        // Run 2 resumed from exactly where run 1 stopped — no re-covered span…
        expect(sinceSeen[sinceSeen.length - 1]).toBe(cursorAfterRun1);
        // …so the commit is still counted ONCE. `2` here is the permanent double-count.
        expect(dayRow(db, '2024-01-15')?.commits).toBe(1);
        expect(readState(db, FORWARD_KEY)).toBe(run2.lastSyncTime);
    });

    it('reports a healed retry as an advisory, so it is neither silent nor red', async () => {
        // Without this the recovery is invisible: no error, and the only trace is a run that took
        // up to 20 minutes longer per repo with the progress counter sitting at 0 — which reads
        // exactly like a hang. It must be an ADVISORY, or the pipeline would re-fetch the whole
        // connector every time a blip was survived.
        seedAlice(db);
        const createGitProvider = await getCreateGitProvider();
        let calls = 0;
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                getCommits: vi.fn().mockImplementation(async (): Promise<GitCommit[]> => {
                    calls++;
                    if (calls === 1) throw new GitProviderFetchError('503 from /commits', 503);
                    return [makeCommit('c-1')];
                }),
            }),
        );

        const result = await runSync(db);

        const healed = result.errors.filter((e) => e.startsWith(RETRY_HEALED_PREFIX));
        expect(healed).toHaveLength(1);
        expect(healed[0]).toContain('repo1');
        expect(healed[0]).toContain('503 from /commits');
        // Advisory, so the provider stays green and the pipeline does not retry the connector.
        expect(result.errors.every((e) => isAdvisoryError(e))).toBe(true);
        // And the data still landed.
        expect(dayRow(db, '2024-01-15')?.commits).toBe(1);
    });

    it('retries listRepos, whose failure discards the provider before any repo is attempted', async () => {
        seedAlice(db);
        const createGitProvider = await getCreateGitProvider();
        let calls = 0;
        const listRepos = vi.fn().mockImplementation(async () => {
            calls++;
            if (calls <= 2) throw new GitProviderFetchError('server error 503', 503);
            return [makeRepo('repo1')];
        });
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos,
                getCommits: vi.fn().mockResolvedValue([makeCommit('c-1')]),
            }),
        );

        const result = await runSync(db);

        expect(calls).toBe(1 + GIT_REPO_RETRY_DELAYS_MS.length);
        expect(result.errors.filter((e) => !isAdvisoryError(e))).toHaveLength(0);
        expect(dayRow(db, '2024-01-15')?.commits).toBe(1);
        expect(readState(db, FORWARD_KEY)).toBe(result.lastSyncTime);
    });

    it('retries the per-PR review fan-out — the largest request population in a run', async () => {
        seedAlice(db);
        const createGitProvider = await getCreateGitProvider();
        let commentCalls = 0;
        const getReviewComments = vi.fn().mockImplementation(async () => {
            commentCalls++;
            if (commentCalls <= 2) throw new GitProviderFetchError('server error 503', 503);
            return [];
        });
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                getCommits: vi.fn().mockResolvedValue([makeCommit('c-1')]),
                getPullRequests: vi.fn().mockResolvedValue([
                    {
                        id: 'pr-1',
                        title: 'feat',
                        author: {name: 'alice', email: 'alice@example.com', username: 'alice'},
                        state: 'merged',
                        createdAt: '2024-01-15T08:00:00Z',
                        mergedAt: '2024-01-15T09:00:00Z',
                        closedAt: '2024-01-15T09:00:00Z',
                        updatedAt: '2024-01-15T09:00:00Z',
                        reviewers: [],
                        additions: 1,
                        deletions: 0,
                    },
                ]),
                getReviewComments,
            }),
        );

        const result = await runSync(db);

        expect(commentCalls).toBe(1 + GIT_REPO_RETRY_DELAYS_MS.length);
        // It healed, so no "Failed to fetch review comments" line — which is the whole point:
        // that failure would have frozen this PR's review counts at zero forever, because the
        // fan-out is gated by prWithinFetchWindow and never revisits a PR behind the cursor.
        expect(result.errors.some((e) => /review comments/i.test(e) && !isAdvisoryError(e))).toBe(
            false,
        );
    });

    it('retries the per-PR review VERDICT fan-out and persists the healed counts', async () => {
        // The verdict half of the fan-out (`getPRReviews`) is a separate fetch from the comment
        // half, with its own reviewsOk/reviewFetchFailures bookkeeping — and it is the worse of
        // the two to leave un-retried: on failure `upsertPRRecord` PRESERVES previously-observed
        // verdict data, which for a PR first seen during the outage is zero. Once the cursor
        // advances past it, `prWithinFetchWindow` never re-fans it out, so "0 changes requested"
        // becomes permanent. Assert the healed VALUES land, not just that the calls happened.
        seedAlice(db);
        const createGitProvider = await getCreateGitProvider();
        let reviewCalls = 0;
        const getPRReviews = vi.fn().mockImplementation(async () => {
            reviewCalls++;
            if (reviewCalls <= 2) throw new GitProviderFetchError('server error 503', 503);
            return [
                {
                    id: 'rev-1',
                    prId: 'pr-1',
                    reviewer: {name: 'bob', email: 'bob@example.com', username: 'bob'},
                    state: 'changes_requested',
                    submittedAt: '2024-01-15T09:30:00Z',
                },
                {
                    id: 'rev-2',
                    prId: 'pr-1',
                    reviewer: {name: 'bob', email: 'bob@example.com', username: 'bob'},
                    state: 'approved',
                    submittedAt: '2024-01-15T09:40:00Z',
                },
            ];
        });
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                getCommits: vi.fn().mockResolvedValue([makeCommit('c-1')]),
                getPullRequests: vi.fn().mockResolvedValue([
                    {
                        id: 'pr-1',
                        title: 'feat',
                        author: {name: 'alice', email: 'alice@example.com', username: 'alice'},
                        state: 'merged',
                        createdAt: '2024-01-15T08:00:00Z',
                        mergedAt: '2024-01-15T09:00:00Z',
                        closedAt: '2024-01-15T09:00:00Z',
                        updatedAt: '2024-01-15T09:00:00Z',
                        reviewers: [],
                        additions: 1,
                        deletions: 0,
                    },
                ]),
                getPRReviews,
            }),
        );

        const result = await runSync(db);

        expect(reviewCalls).toBe(1 + GIT_REPO_RETRY_DELAYS_MS.length);
        // Healed, so the run does not go red over it.
        expect(result.errors.filter((e) => !isAdvisoryError(e))).toHaveLength(0);
        // And the verdicts the retry recovered are what got stored: two review events, one of
        // them a send-back, so `review_rounds` is 1 + 1. A run that gave up here would have
        // written 0/0 (no verdicts observed, no comments either) and frozen them there.
        const rec = db
            .prepare(
                `SELECT review_rounds, changes_requested_count FROM pr_records WHERE pr_id = 'pr-1'`,
            )
            .get() as {review_rounds: number; changes_requested_count: number} | undefined;
        expect(rec).toEqual({review_rounds: 2, changes_requested_count: 1});
    });

    it('reserves budget for the commit fetch so a best-effort retry cannot starve it', async () => {
        // The starvation shape: repo1's PR list fails and heals (spending pauses), then repo2's
        // COMMIT fetch fails transiently. If both drew from one pool, repo1 could exhaust it and
        // repo2's commit fetch would get no pause at all — losing the whole run's data to a fault
        // a five-minute wait would have healed.
        seedAlice(db);
        const createGitProvider = await getCreateGitProvider();
        let prCalls = 0;
        let commitCalls = 0;
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('r1'), makeRepo('r2')]),
                getCommits: vi.fn().mockImplementation(async (repo: string): Promise<GitCommit[]> => {
                    if (repo !== 'r2') return [makeCommit('c-r1')];
                    commitCalls++;
                    if (commitCalls <= 2) throw new GitProviderFetchError('503', 503);
                    return [makeCommit('c-r2', '2024-01-15T11:00:00Z')];
                }),
                getPullRequests: vi.fn().mockImplementation(async (repo: string) => {
                    if (repo !== 'r1') return [];
                    prCalls++;
                    if (prCalls <= 2) throw new GitProviderFetchError('503', 503);
                    return [];
                }),
            }),
        );

        const result = await runSync(db);

        // r1's PR list spent its full best-effort sequence…
        expect(prCalls).toBe(1 + GIT_REPO_RETRY_DELAYS_MS.length);
        // …and r2's commit fetch STILL got its full sequence, because the best-effort share is
        // capped below the run budget.
        expect(commitCalls).toBe(1 + GIT_REPO_RETRY_DELAYS_MS.length);
        expect(result.errors.filter((e) => !isAdvisoryError(e))).toHaveLength(0);
        expect(dayRow(db, '2024-01-15')?.commits).toBe(2);
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
        // EXACTLY the budget, not merely under it. `<=` alone would also pass if the retry never
        // fired at all (slept = 0), i.e. with the whole feature switched off.
        expect(sleptMs).toBe(GIT_RUN_RETRY_SLEEP_BUDGET_MS);
        // Unbounded, five repos would each pay the full 20 minutes.
        expect(sleptMs).toBeLessThan(5 * 20 * 60_000);
        // The boundary, per repo: the first two spend full sequences (5+15, 5+15 = 40 min), and
        // the third's first pause would exceed the budget, so it and the rest fail on attempt 1.
        const attempts = (repo: string): number =>
            getCommits.mock.calls.filter((c) => c[0] === repo).length;
        expect(attempts('r1')).toBe(1 + GIT_REPO_RETRY_DELAYS_MS.length);
        expect(attempts('r2')).toBe(1 + GIT_REPO_RETRY_DELAYS_MS.length);
        expect(attempts('r3')).toBe(1);
        expect(attempts('r4')).toBe(1);
        expect(attempts('r5')).toBe(1);
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

        // Advisories excluded: a heal now reports itself (RETRY_HEALED_PREFIX) without going red.
        expect(result.errors.filter((e) => !isAdvisoryError(e))).toHaveLength(0);
        // Exactly the two distinct commits — 3 would mean the steady repo's commit was
        // counted twice, 1 would mean the healed repo's was dropped.
        expect(dayRow(db, '2024-01-15')?.commits).toBe(2);
        expect(readState(db, FORWARD_KEY)).toBe(result.lastSyncTime);
    });

    it('shares ONE retry sleep budget across providers, not one budget each', async () => {
        // The budget was per-provider first (#272, review cycle 3), which made the documented
        // 40-minute ceiling really `40 min × providers`, and `runConnectorWithRetry` doubles
        // whatever that is again. Run length is not cosmetic: the git cron fires with no
        // in-flight guard, and two overlapping runs read the same forward cursor and fetch
        // non-disjoint windows into an ADDITIVE commit merge — a permanent double-count.
        seedAlice(db);
        const createGitProvider = await getCreateGitProvider();
        const getCommits = vi
            .fn()
            .mockRejectedValue(new GitProviderFetchError('server error 503', 503));
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        createGitProvider.mockImplementation((pc: GitProviderConfig) =>
            makeMockProvider({
                name: pc.type,
                listRepos: vi.fn().mockResolvedValue([makeRepo('r1'), makeRepo('r2')]),
                getCommits,
            }),
        );

        const pending = new GitSync({enabled: false}).syncProviders(db, [
            CONFIG,
            {type: 'gitlab', group: 'g', auth: {type: 'token', api_token: 't'}},
        ]);
        await vi.runAllTimersAsync();
        await pending;

        const sleptMs = setTimeoutSpy.mock.calls
            .map((c) => Number(c[1]))
            .filter((d) => GIT_REPO_RETRY_DELAYS_MS.includes(d))
            .reduce((a, b) => a + b, 0);
        // ONE budget for the whole run. Per-provider, this would be 2 × the budget.
        expect(sleptMs).toBe(GIT_RUN_RETRY_SLEEP_BUDGET_MS);
        expect(sleptMs).toBeLessThan(2 * GIT_RUN_RETRY_SLEEP_BUDGET_MS);
        // The first provider spent it all, so the second's repos fail on attempt 1 with no pause —
        // and are still ATTEMPTED, so coverage and the cursor hold are unchanged.
        expect(getCommits.mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    it('reports each healed fetch\'s OWN wait, not the run\'s cumulative sleep', async () => {
        // Two repos heal in one run. Reporting the shared counter made the second claim the
        // first's wait as well ("after waiting 40 min" for a fetch that waited 20) — sending an
        // operator to look for an outage that never happened.
        seedAlice(db);
        const createGitProvider = await getCreateGitProvider();
        const calls: Record<string, number> = {r1: 0, r2: 0};
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('r1'), makeRepo('r2')]),
                getCommits: vi.fn().mockImplementation(async (repo: string): Promise<GitCommit[]> => {
                    calls[repo]++;
                    // Each repo fails once, so each waits exactly the FIRST pause — 5 min.
                    if (calls[repo] === 1) throw new GitProviderFetchError('503', 503);
                    return [makeCommit(`c-${repo}`, repo === 'r1' ? '2024-01-15T10:00:00Z' : '2024-01-15T11:00:00Z')];
                }),
            }),
        );

        const result = await runSync(db);

        const healed = result.errors.filter((e) => e.startsWith(RETRY_HEALED_PREFIX));
        expect(healed).toHaveLength(2);
        const expectedMin = Math.round(GIT_REPO_RETRY_DELAYS_MS[0] / 60_000);
        // BOTH report 5 min. The run spent 10 in total, so a cumulative counter would have made
        // the second say 10 — this assertion fails if the per-call accumulator is removed.
        for (const line of healed) {
            expect(line).toContain(`after waiting ${expectedMin} min`);
        }
        expect(result.errors.filter((e) => !isAdvisoryError(e))).toHaveLength(0);
    });
});
