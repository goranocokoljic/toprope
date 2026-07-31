/**
 * #283 — the RUN's wall clock, seen from the sync pipeline.
 *
 * `GIT_RUN_RETRY_SLEEP_BUDGET_MS` (#272) bounds only the repo-level retry PAUSES. Nothing
 * bounded the request layer's own sleeping in aggregate — each request carries its own budget,
 * up to ~10 minutes once a `Retry-After` acts as a floor, and the per-commit fan-out is an
 * O(commits) population of such requests — so run length was a function of the provider's
 * behaviour with no ceiling at all. That matters because `sync-pipeline` re-runs a failed
 * connector, and two overlapping git runs read the same forward cursor into an ADDITIVE commit
 * merge: a permanent double-count.
 *
 * These tests pin the sync-level half: the run stops, says so legibly, holds the cursor, drops
 * its partial data — and, because #273's diffstat memo survives the drop, the NEXT run gets
 * further rather than failing identically forever. The request-level half (an expired deadline
 * refusing a request or a pause) is pinned in `providers/request-policy.test.ts`, and the
 * decisions themselves in `providers/http-retry.test.ts`.
 *
 * Fake timers throughout, and the clock is driven by `vi.setSystemTime` from inside the mock
 * provider — that is how a run "takes" four hours here.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper} from '../../../src/registry/developers';
import {
    GIT_RUN_WALL_CLOCK_BUDGET_MS,
    GitSync,
    RUN_DEADLINE_PREFIX,
    isAdvisoryError,
    runDeadlineLine,
    syncStateKey,
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

function seedAlice(db: Database.Database): void {
    addTeam(db, 'eng');
    const dev = addDeveloper(db, 'alice', 'eng', 'alice@example.com', 'Alice');
    db.prepare(`UPDATE developers SET external_ids = '{"github":"alice"}' WHERE id = ?`).run(dev.id);
}

function makeRepo(name: string): GitRepo {
    return {id: name, name, fullName: `test-org/${name}`, defaultBranch: 'main', isArchived: false};
}

function makeCommit(sha: string): GitCommit {
    return {
        sha,
        author: {name: 'alice', email: 'alice@example.com', username: 'alice'},
        date: '2024-01-15T10:00:00Z',
        message: 'feat: add feature',
        additions: 50,
        deletions: 10,
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

async function runSync(
    db: Database.Database,
    configs: GitProviderConfig[] = [CONFIG],
): Promise<Awaited<ReturnType<GitSync['syncProviders']>>> {
    const pending = new GitSync({enabled: false}).syncProviders(db, configs);
    await vi.runAllTimersAsync();
    return pending;
}

/** Push the fake clock past the run's whole wall-clock budget. */
function burnTheBudget(): void {
    vi.setSystemTime(new Date(Date.now() + GIT_RUN_WALL_CLOCK_BUDGET_MS + 1));
}

function readState(db: Database.Database, key: string): string | undefined {
    return (db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
        | {value: string}
        | undefined)?.value;
}

function snapshotCount(db: Database.Database): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM git_snapshots').get() as {n: number}).n;
}

describe('run wall-clock budget (#283)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        vi.resetAllMocks();
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-31T03:30:00.000Z'));
    });

    afterEach(() => {
        db.close();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('pins the budget as a literal', () => {
        // Not derived from the source. Four hours is chosen against what runs ON TOP of it —
        // `runConnectorWithRetry` grants a failed connector one full second attempt, so the
        // real ceiling is ~8 hours + the 5-minute retry pause, which must stay inside a daily
        // cadence. A future edit to 40 hours would keep every other assertion here green.
        expect(GIT_RUN_WALL_CLOCK_BUDGET_MS).toBe(4 * 60 * 60_000);
    });

    it('stops the repo loop, names how far it got, and holds the cursor', async () => {
        seedAlice(db);
        const createGitProvider = await getCreateGitProvider();
        const getCommits = vi.fn().mockImplementation(async (repo: string) => {
            // Repo 1 is a long one: it returns real data but eats the whole budget.
            if (repo === 'repo1') {
                burnTheBudget();
                return [makeCommit('c-1')];
            }
            return [makeCommit(`c-${repo}`)];
        });
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos: vi
                    .fn()
                    .mockResolvedValue([makeRepo('repo1'), makeRepo('repo2'), makeRepo('repo3')]),
                getCommits,
            }),
        );

        const result = await runSync(db);

        // Repo 1 ran; repos 2 and 3 were never attempted.
        expect(getCommits.mock.calls.map((c) => c[0])).toEqual(['repo1']);
        // ONE legible line naming how far the run got, not one failure per skipped repo.
        expect(result.errors).toContain(runDeadlineLine('github', 1, 3));
        expect(result.errors.filter((e) => e.startsWith(RUN_DEADLINE_PREFIX))).toHaveLength(1);
        // The window was not covered, so #231 applies in full: cursor held, partials dropped.
        expect(readState(db, FORWARD_KEY)).toBeUndefined();
        expect(snapshotCount(db)).toBe(0);
    });

    it('reports the stop as a FAILURE, not an advisory', async () => {
        // Load-bearing for recovery: `sync-pipeline` and `sync-log` both classify a run by
        // whether any error is non-advisory. Marking this advisory would log the run green AND
        // suppress the retry — while the cursor sat held and the data stayed months behind,
        // which is exactly the "a completion signal is not a currency claim" failure.
        expect(isAdvisoryError(runDeadlineLine('github', 1, 3))).toBe(false);
        expect(runDeadlineLine('github', 1, 3).startsWith(RUN_DEADLINE_PREFIX)).toBe(true);
        // It says how far it got — the number that separates "provider is slow" from "the
        // window is simply too wide for one run".
        expect(runDeadlineLine('github', 1, 3)).toContain('1 of 3');
    });

    it('skips a LATER provider without blaming it for a listRepos failure', async () => {
        seedAlice(db);
        const gitlabConfig: GitProviderConfig = {
            type: 'gitlab',
            group: 'test-group',
            auth: {type: 'personal_access_token', token: 'glpat'},
        };
        const createGitProvider = await getCreateGitProvider();
        const gitlabListRepos = vi.fn().mockResolvedValue([makeRepo('gl-repo')]);
        createGitProvider
            .mockReturnValueOnce(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    getCommits: vi.fn().mockImplementation(async () => {
                        burnTheBudget();
                        return [makeCommit('c-1')];
                    }),
                }),
            )
            .mockReturnValueOnce(
                makeMockProvider({name: 'gitlab', listRepos: gitlabListRepos}),
            );

        const result = await runSync(db, [CONFIG, gitlabConfig]);

        // The second provider issued NOTHING — not even the repo listing, whose failure would
        // have been recorded as "[gitlab] Failed to list repos", sending an operator to check a
        // perfectly healthy provider's credentials.
        expect(gitlabListRepos).not.toHaveBeenCalled();
        expect(result.errors).toContain(runDeadlineLine('gitlab', 0, 0));
        expect(result.errors.some((e) => e.includes('Failed to list repos'))).toBe(false);
        // Completeness is per PROVIDER, and the deadline does not change that: github covered
        // every one of its repos before the clock ran out, so its cursor advances and its data
        // is kept. Only gitlab — whose window was not touched at all — is held. Blanket-holding
        // both would re-fetch github's whole window into an ADDITIVE commit merge next run.
        expect(readState(db, FORWARD_KEY)).toBe(result.lastSyncTime);
        expect(readState(db, syncStateKey('gitlab', 'test-group'))).toBeUndefined();
    });

    it('refuses a repo-retry pause the remaining budget cannot absorb, and says why', async () => {
        seedAlice(db);
        const createGitProvider = await getCreateGitProvider();
        let calls = 0;
        const getCommits = vi.fn().mockImplementation(async (): Promise<GitCommit[]> => {
            calls++;
            // Burn most of the clock on the first attempt, then fail with a fault that WOULD
            // normally buy a 5-minute in-run pause.
            if (calls === 1) {
                vi.setSystemTime(new Date(Date.now() + GIT_RUN_WALL_CLOCK_BUDGET_MS - 60_000));
                throw new GitProviderFetchError('GitHub API server error 503: /commits', 503);
            }
            return [makeCommit('c-1')];
        });
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                getCommits,
            }),
        );

        const result = await runSync(db);

        // One attempt only: 60 s of budget cannot absorb a 5-minute pause, and the pause is
        // REFUSED rather than truncated — sleeping 60 of the 300 seconds would spend the run's
        // last minute and still not have waited out the outage.
        expect(calls).toBe(1);
        const failure = result.errors.find((e) => e.includes('server error 503'));
        // The bare fault message reads as "one 503 and it gave up", which sends the operator to
        // the provider instead of to the run's length.
        expect(failure).toContain("wall-clock budget could not absorb the pause");
        expect(readState(db, FORWARD_KEY)).toBeUndefined();
    });

    it('lets a run that stays inside its budget finish normally', async () => {
        // Positive control for the whole file: without it every assertion above would pass
        // against a deadline that fired on every run.
        seedAlice(db);
        const createGitProvider = await getCreateGitProvider();
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1'), makeRepo('repo2')]),
                getCommits: vi.fn().mockImplementation(async (repo: string) => {
                    // A minute per repo — real work, well inside four hours.
                    vi.setSystemTime(new Date(Date.now() + 60_000));
                    return [makeCommit(`c-${repo}`)];
                }),
            }),
        );

        const result = await runSync(db);

        expect(result.errors.filter((e) => !isAdvisoryError(e))).toHaveLength(0);
        expect(result.errors.some((e) => e.startsWith(RUN_DEADLINE_PREFIX))).toBe(false);
        expect(snapshotCount(db)).toBeGreaterThan(0);
        expect(readState(db, FORWARD_KEY)).toBe(result.lastSyncTime);
    });
});
