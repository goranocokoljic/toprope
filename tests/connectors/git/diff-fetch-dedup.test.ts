/**
 * #271 — one diff request per commit per sync run.
 *
 * Every provider already fetches each commit's diff inside `getCommits` to compute the
 * commit's additions/deletions; the sync loop used to fetch it AGAIN per commit via
 * `getCommitDiff`, doubling the per-commit request volume of the slowest phase of a sync.
 * Providers now carry that diff out on `GitCommit.diffs` and the sync loop reuses it.
 *
 * These tests drive the REAL provider classes through the REAL sync pipeline over a
 * counting `fetch` stub, so they measure request volume the way the API actually sees it —
 * a mock provider could not catch a regression that re-introduces the second fetch.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper} from '../../../src/registry/developers';
import {GitSync} from '../../../src/connectors/git/sync';
import {BitbucketProvider} from '../../../src/connectors/git/providers/bitbucket';
import {GitHubProvider} from '../../../src/connectors/git/providers/github';
import {GitLabProvider} from '../../../src/connectors/git/providers/gitlab';
import type {
    GitCommit,
    GitFileDiff,
    GitProvider,
    GitRepo,
} from '../../../src/connectors/git/providers/types';
// The per-provider fetch stub and route tables live in ONE place (#280) — they encode each
// provider's URL and payload shape, and a private copy here would be a second source of truth
// that drifts silently (an unrouted URL degrades to "no commits", not to a failure).
import {
    AUTHOR_EMAIL,
    BITBUCKET_CONFIG,
    COMMIT_DATE,
    GITHUB_CONFIG,
    GITLAB_CONFIG,
    SHAS,
    bitbucketRoutes,
    githubRoutes,
    gitlabRoutes,
    makeCountingFetch,
} from './providers/provider-fetch-fixtures';

// Same shape as sync.test.ts: stub the factory so `syncProviders` uses the provider we
// hand it, but keep the rest of the module (config validation) real.
vi.mock('../../../src/connectors/git/providers/factory', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/connectors/git/providers/factory')>();
    return {...actual, createGitProvider: vi.fn()};
});

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

/** A developer resolvable by commit email on ANY provider (`email:` lookup key). */
function seedAlice(db: Database.Database): string {
    addTeam(db, 'eng');
    return addDeveloper(db, 'alice', 'eng', AUTHOR_EMAIL, 'Alice').id;
}

async function getCreateGitProvider(): Promise<ReturnType<typeof vi.fn>> {
    const {createGitProvider} = await import('../../../src/connectors/git/providers/factory');
    return createGitProvider as ReturnType<typeof vi.fn>;
}

interface SnapshotCounts {
    lines_added: number;
    lines_removed: number;
    files_changed: number;
    commits: number;
}

function readSnapshot(db: Database.Database, devId: string): SnapshotCounts | undefined {
    return db
        .prepare(
            'SELECT lines_added, lines_removed, files_changed, commits FROM git_snapshots WHERE developer_id = ?',
        )
        .get(devId) as SnapshotCounts | undefined;
}

/**
 * The WHOLE projected row minus the two identity columns (`id` is a random UUID and
 * `developer_id` differs per database). `SELECT *` deliberately, not a column list: the
 * columns most sensitive to a corrupted reuse are `code_churn_rate` and
 * `ai_signature_score` (the only readers of `GitFileDiff.status` and of the per-file
 * additions distribution), and a future diff-derived column should join the comparison
 * without anyone remembering to add it here.
 */
function readFullSnapshot(db: Database.Database, devId: string): Record<string, unknown> {
    const row = db
        .prepare('SELECT * FROM git_snapshots WHERE developer_id = ?')
        .get(devId) as Record<string, unknown>;
    const rest = {...row};
    // `git_snapshots` carries no timestamp column, so these two are the only per-run
    // nondeterminism and everything left is safely comparable across databases.
    delete rest.id;
    delete rest.developer_id;
    return rest;
}

// --- Mock-provider helpers (for the reuse/fallback branches) -----------------------

function makeCommit(
    sha: string,
    diffs?: GitFileDiff[],
    totals: {additions: number; deletions: number} = {additions: 40, deletions: 5},
): GitCommit {
    const commit: GitCommit = {
        sha,
        author: {name: 'Alice', email: AUTHOR_EMAIL, username: 'alice'},
        date: COMMIT_DATE,
        message: 'feat: work',
        additions: totals.additions,
        deletions: totals.deletions,
    };
    // Deliberately only assigned when supplied, so the "not supplied" case really is an
    // ABSENT property rather than an explicit `diffs: undefined`. Copied per commit because
    // that is what a real provider does (each internal `getCommitDiff` call returns a fresh
    // array) — NOT because it helps catch an in-place mutation of the reused array; it does
    // the opposite, since a per-commit copy gets namespaced exactly once either way. The
    // read-only contract is pinned directly instead, by the test that re-checks the array
    // the provider handed over after the sync returns.
    if (diffs !== undefined) commit.diffs = diffs.map((d) => ({...d}));
    return commit;
}

const FALLBACK_DIFFS: GitFileDiff[] = [
    {path: 'src/foo.ts', additions: 30, deletions: 5, status: 'modified'},
    {path: 'src/bar.ts', additions: 10, deletions: 0, status: 'added'},
];

/**
 * A diff shaped so that the snapshot columns computed FROM the file-level entries carry
 * real signal — `code_churn_rate` (keyed on `path` + `additions`/`deletions`) and
 * `ai_signature_score`, whose "bulk new boilerplate files" and "uniform file sizes"
 * signals are the only readers of `status` and of the per-file additions distribution.
 * With the thin 2-file fixture both columns sit at 0, so a reuse that dropped `status`
 * or collapsed the per-file shape would be invisible to a snapshot comparison.
 */
const RICH_DIFFS: GitFileDiff[] = Array.from({length: 5}, (_, i) => ({
    path: `src/gen${i}.ts`,
    additions: 60,
    deletions: 2,
    status: 'added',
}));
const RICH_TOTALS = {additions: 300, deletions: 10};

function makeRepo(name: string): GitRepo {
    return {id: name, name, fullName: `test-org/${name}`, defaultBranch: 'main', isArchived: false};
}

function makeMockProvider(overrides: Partial<GitProvider> = {}): GitProvider {
    return {
        name: 'github',
        listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
        getCommits: vi.fn().mockResolvedValue([]),
        getPullRequests: vi.fn().mockResolvedValue([]),
        getReviewComments: vi.fn().mockResolvedValue([]),
        getPRReviews: vi.fn().mockResolvedValue([]),
        getCommitDiff: vi.fn().mockResolvedValue([]),
        checkAccess: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

describe('#271 one diff request per commit per sync run', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        vi.resetAllMocks();
    });

    afterEach(() => {
        db.close();
        vi.restoreAllMocks();
        // `restoreAllMocks` does NOT undo `stubGlobal`, and `unstubGlobals` is not set in
        // vitest.config.ts — without this the last counting `fetch` leaks into the next test.
        vi.unstubAllGlobals();
    });

    // --- AC1: request volume, measured against the real providers ------------------

    it('Bitbucket: fetches each commit diffstat exactly ONCE across a whole sync run', async () => {
        seedAlice(db);
        const {fetchMock, hits, urls} = makeCountingFetch(bitbucketRoutes());
        vi.stubGlobal('fetch', fetchMock);
        (await getCreateGitProvider()).mockReturnValue(new BitbucketProvider(BITBUCKET_CONFIG));

        await new GitSync({enabled: false}).syncProviders(db, [BITBUCKET_CONFIG]);

        // One diffstat request per commit — three commits, three requests. Before #271
        // this was six (provider fan-out + sync-loop fan-out).
        expect(hits(/\/diffstat\//)).toBe(SHAS.length);
        // …and specifically ONE per distinct sha, not three for one sha.
        for (const sha of SHAS) {
            expect(urls.filter((u) => u.includes(`/diffstat/${sha}`))).toHaveLength(1);
        }
    });

    it('GitHub: fetches each commit detail exactly ONCE across a whole sync run', async () => {
        const devId = seedAlice(db);
        const {fetchMock, urls} = makeCountingFetch(githubRoutes());
        vi.stubGlobal('fetch', fetchMock);
        (await getCreateGitProvider()).mockReturnValue(new GitHubProvider(GITHUB_CONFIG));

        await new GitSync({enabled: false}).syncProviders(db, [GITHUB_CONFIG]);

        // `getCommitDiff` hits the SAME /commits/{sha} URL the detail fetch does, so the
        // count is the honest measure of the duplicate this removed.
        for (const sha of SHAS) {
            expect(urls.filter((u) => u.endsWith(`/commits/${sha}`))).toHaveLength(1);
        }
        // Positive control: the ONE request was actually USED. Without this, a reuse that
        // yielded nothing would satisfy the count above trivially. 3 × (40 added / 5
        // removed / 2 files) from the detail fixture.
        expect(readSnapshot(db, devId)).toEqual({
            commits: 3,
            lines_added: 120,
            lines_removed: 15,
            files_changed: 6,
        });
    });

    it('GitLab: fetches each commit diff exactly ONCE across a whole sync run', async () => {
        const devId = seedAlice(db);
        const {fetchMock, hits, urls} = makeCountingFetch(gitlabRoutes());
        vi.stubGlobal('fetch', fetchMock);
        (await getCreateGitProvider()).mockReturnValue(new GitLabProvider(GITLAB_CONFIG));

        await new GitSync({enabled: false}).syncProviders(db, [GITLAB_CONFIG]);

        expect(hits(/\/repository\/commits\/[^/]+\/diff\?/)).toBe(SHAS.length);
        // Positive control, as above — and here it also proves the hunk parser's output
        // survived the reuse (2 added / 1 removed per commit, over one file).
        expect(readSnapshot(db, devId)).toEqual({
            commits: 3,
            lines_added: 6,
            lines_removed: 3,
            files_changed: 3,
        });
        for (const sha of SHAS) {
            expect(urls.filter((u) => u.includes(`/commits/${sha}/diff`))).toHaveLength(1);
        }
    });

    // --- AC2: the numbers written are unchanged ------------------------------------

    it('Bitbucket: writes the same churn the double-fetch produced', async () => {
        // 3 commits × (30+10 added, 5+0 removed) over 2 files each. Pinned as concrete
        // numbers rather than "greater than 0" so a reuse that dropped a diff, or reused
        // one commit's diff for another, fails here.
        const devId = seedAlice(db);
        const {fetchMock} = makeCountingFetch(bitbucketRoutes());
        vi.stubGlobal('fetch', fetchMock);
        (await getCreateGitProvider()).mockReturnValue(new BitbucketProvider(BITBUCKET_CONFIG));

        await new GitSync({enabled: false}).syncProviders(db, [BITBUCKET_CONFIG]);

        expect(readSnapshot(db, devId)).toEqual({
            commits: 3,
            lines_added: 120,
            lines_removed: 15,
            files_changed: 6,
        });
    });

    it('reused diffs and fallback-fetched diffs write byte-identical snapshots', async () => {
        // The strongest form of "unchanged for the same input data": run the same commit
        // set twice — once with the provider supplying diffs (the new path), once
        // supplying none so the sync loop fetches them (the old path) — and compare the
        // WHOLE projected row, not just the line counts. `lines_added`/`lines_removed`
        // come from the commit's own totals and would survive almost any corruption of
        // the reused array; `code_churn_rate` and `ai_signature_score` are the columns
        // actually computed from the file-level entries, so they are what makes this
        // comparison able to fail. RICH_DIFFS exists to keep them non-zero.
        const run = async (supplyDiffs: boolean): Promise<Record<string, unknown>> => {
            const localDb = makeDb();
            const devId = seedAlice(localDb);
            const commits = SHAS.map((sha) =>
                makeCommit(sha, supplyDiffs ? RICH_DIFFS : undefined, RICH_TOTALS),
            );
            (await getCreateGitProvider()).mockReturnValue(
                makeMockProvider({
                    getCommits: vi.fn().mockResolvedValue(commits),
                    getCommitDiff: vi.fn().mockResolvedValue(RICH_DIFFS),
                }),
            );
            await new GitSync({enabled: false}).syncProviders(localDb, [GITHUB_CONFIG]);
            const snapshot = readFullSnapshot(localDb, devId);
            localDb.close();
            return snapshot;
        };

        const reused = await run(true);
        const fetched = await run(false);

        expect(reused).toEqual(fetched);
        // Positive controls — without these, two all-zero rows would compare equal and
        // this test would pass while proving nothing.
        expect(reused).toMatchObject({
            commits: 3,
            lines_added: 900,
            lines_removed: 30,
            files_changed: 15,
        });
        expect(reused.code_churn_rate as number).toBeGreaterThan(0);
        expect(reused.ai_signature_score as number).toBeGreaterThan(0);
    });

    it('namespaces reused diff paths by repo, so two repos’ same-named file are not re-churn', async () => {
        // Path namespacing is what stops two repos' `src/index.ts` colliding in the churn
        // window. It lives in the sync loop, so the REUSE path must still go through it —
        // and churn_rate is the only metric that can see the difference (files_changed
        // sums, it does not dedupe).
        const devId = seedAlice(db);
        const oneFile: GitFileDiff[] = [
            {path: 'src/index.ts', additions: 10, deletions: 0, status: 'modified'},
        ];
        (await getCreateGitProvider()).mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a'), makeRepo('repo-b')]),
                getCommits: vi
                    .fn()
                    .mockImplementation(async (repo: string) => [makeCommit(`sha-${repo}`, oneFile)]),
                getCommitDiff: vi.fn(),
            }),
        );

        await new GitSync({enabled: false}).syncProviders(db, [GITHUB_CONFIG]);

        const row = db
            .prepare('SELECT code_churn_rate, commits FROM git_snapshots WHERE developer_id = ?')
            .get(devId) as {code_churn_rate: number; commits: number};
        expect(row.commits).toBe(2);
        // Namespaced → `repo-a/src/index.ts` and `repo-b/src/index.ts` are distinct files.
        expect(row.code_churn_rate).toBe(0);
    });

    it('positive control: two commits on the SAME file in one repo do register as re-churn', async () => {
        // Without this, the churn_rate === 0 assertion above could pass simply because the
        // fixture never produces churn at all.
        const devId = seedAlice(db);
        const oneFile: GitFileDiff[] = [
            {path: 'src/index.ts', additions: 10, deletions: 0, status: 'modified'},
        ];
        (await getCreateGitProvider()).mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a')]),
                getCommits: vi
                    .fn()
                    .mockResolvedValue([makeCommit('sha-1', oneFile), makeCommit('sha-2', oneFile)]),
                getCommitDiff: vi.fn(),
            }),
        );

        await new GitSync({enabled: false}).syncProviders(db, [GITHUB_CONFIG]);

        const row = db
            .prepare('SELECT code_churn_rate FROM git_snapshots WHERE developer_id = ?')
            .get(devId) as {code_churn_rate: number};
        expect(row.code_churn_rate).toBeGreaterThan(0);
    });

    // --- The undefined-vs-[] distinction and the fallback --------------------------

    it('does NOT re-fetch a commit whose diffs are an empty array (a genuine no-file commit)', async () => {
        // `[]` means "fetched, touched nothing" — a merge commit whose diffstat 404s. If
        // the loop treated it as falsy it would re-request exactly those commits, which is
        // the duplicate #271 removes.
        seedAlice(db);
        const getCommitDiff = vi.fn().mockResolvedValue(FALLBACK_DIFFS);
        (await getCreateGitProvider()).mockReturnValue(
            makeMockProvider({
                getCommits: vi.fn().mockResolvedValue([makeCommit('merge-sha', [])]),
                getCommitDiff,
            }),
        );

        await new GitSync({enabled: false}).syncProviders(db, [GITHUB_CONFIG]);

        expect(getCommitDiff).not.toHaveBeenCalled();
    });

    it('falls back to getCommitDiff for a provider that supplies no diffs, and still gets churn', async () => {
        const devId = seedAlice(db);
        const getCommitDiff = vi.fn().mockResolvedValue(FALLBACK_DIFFS);
        (await getCreateGitProvider()).mockReturnValue(
            makeMockProvider({
                getCommits: vi.fn().mockResolvedValue([makeCommit('sha-1')]),
                getCommitDiff,
            }),
        );

        await new GitSync({enabled: false}).syncProviders(db, [GITHUB_CONFIG]);

        expect(getCommitDiff).toHaveBeenCalledTimes(1);
        expect(getCommitDiff).toHaveBeenCalledWith('repo1', 'sha-1');
        expect(readSnapshot(db, devId)).toMatchObject({lines_added: 40, files_changed: 2});
    });

    it('falls back when a provider supplies a non-array, instead of reading it as "no detail"', async () => {
        // This is what makes the guard a SHAPE test rather than `!== undefined`. Without
        // this case the hardening is invisible to CI: absent / `[]` / populated all behave
        // identically under `!== undefined`, so a future "simplification" back to it — or
        // worse, to a truthiness check, which would re-introduce the `[]` re-fetch — would
        // pass every other test in this file.
        const devId = seedAlice(db);
        const getCommitDiff = vi.fn().mockResolvedValue(FALLBACK_DIFFS);
        const bogus = makeCommit('sha-bogus');
        // Only reachable by a provider lying about its own type — which is exactly what an
        // adapter over a live API response can do.
        (bogus as {diffs?: unknown}).diffs = null;
        (await getCreateGitProvider()).mockReturnValue(
            makeMockProvider({
                getCommits: vi.fn().mockResolvedValue([bogus]),
                getCommitDiff,
            }),
        );

        await new GitSync({enabled: false}).syncProviders(db, [GITHUB_CONFIG]);

        expect(getCommitDiff).toHaveBeenCalledWith('repo1', 'sha-bogus');
        // …and the fetched churn landed, rather than a zero-file commit.
        expect(readSnapshot(db, devId)).toMatchObject({commits: 1, files_changed: 2});
    });

    it('does not mutate the array the provider handed over (the read-only contract)', async () => {
        // `GitCommit.diffs` is documented read-only because it is the provider's own array,
        // passed by reference. The namespacing map at the reuse site must therefore produce
        // new objects — an in-place `d.path = ...` would corrupt provider state, and on a
        // real provider that shares one array across a page it would double-prefix.
        seedAlice(db);
        const supplied: GitFileDiff[] = [
            {path: 'src/index.ts', additions: 10, deletions: 1, status: 'modified'},
        ];
        const commit = makeCommit('sha-1');
        commit.diffs = supplied; // assigned directly, NOT through makeCommit's per-commit copy
        (await getCreateGitProvider()).mockReturnValue(
            makeMockProvider({
                getCommits: vi.fn().mockResolvedValue([commit]),
                getCommitDiff: vi.fn(),
            }),
        );

        await new GitSync({enabled: false}).syncProviders(db, [GITHUB_CONFIG]);

        // Unchanged — in particular NOT prefixed with the repo name.
        expect(supplied).toEqual([
            {path: 'src/index.ts', additions: 10, deletions: 1, status: 'modified'},
        ]);
    });

    it('decides per commit, not per batch, when a batch mixes supplied and missing diffs', async () => {
        // The guard reads `rawCommits[i].diffs`. A refactor that hoisted it to the batch
        // (`rawCommits.every(c => c.diffs === undefined)`) would pass every other test here,
        // because every other fixture is uniform.
        const devId = seedAlice(db);
        const getCommitDiff = vi.fn().mockResolvedValue(FALLBACK_DIFFS);
        (await getCreateGitProvider()).mockReturnValue(
            makeMockProvider({
                getCommits: vi
                    .fn()
                    .mockResolvedValue([makeCommit('has-diffs', FALLBACK_DIFFS), makeCommit('no-diffs')]),
                getCommitDiff,
            }),
        );

        await new GitSync({enabled: false}).syncProviders(db, [GITHUB_CONFIG]);

        // Exactly one fetch, for exactly the commit that supplied nothing.
        expect(getCommitDiff.mock.calls).toEqual([['repo1', 'no-diffs']]);
        // …and both commits contributed their two files, so neither path dropped one.
        expect(readSnapshot(db, devId)).toMatchObject({commits: 2, files_changed: 4});
    });

    // --- The reuse path is the one production takes: keep it on the progress contract ---

    it('still ticks the diffs progress step per commit on the reuse path', async () => {
        // Every pre-existing sync test builds commits WITHOUT `diffs`, so the whole legacy
        // suite — including the `diffs` step-sequence assertions — exercises only the
        // fallback branch. This pins the same contract for the branch a real provider
        // actually takes: seeded at 0/N, one tick per commit, ending at N/N.
        seedAlice(db);
        (await getCreateGitProvider()).mockReturnValue(
            makeMockProvider({
                getCommits: vi
                    .fn()
                    .mockResolvedValue([
                        makeCommit('s1', FALLBACK_DIFFS),
                        makeCommit('s2', FALLBACK_DIFFS),
                    ]),
                getCommitDiff: vi.fn(),
            }),
        );

        const steps: Array<[string | null, number, number | null]> = [];
        await new GitSync({enabled: false}).syncProviders(db, [GITHUB_CONFIG], (p) =>
            steps.push([p.repo_step, p.repo_step_done, p.repo_step_total]),
        );

        expect(steps.filter(([step]) => step === 'diffs')).toEqual([
            ['diffs', 0, 2],
            ['diffs', 1, 2],
            ['diffs', 2, 2],
        ]);
    });

    it('degrades one commit to empty diffs when the fallback fetch throws, without failing the repo', async () => {
        // The pre-existing failure semantics of the sync loop's diff fetch: a throw costs
        // that commit its file-level diff, it does not abort the repo or hold the cursor.
        const devId = seedAlice(db);
        (await getCreateGitProvider()).mockReturnValue(
            makeMockProvider({
                getCommits: vi
                    .fn()
                    .mockResolvedValue([makeCommit('sha-ok'), makeCommit('sha-bad')]),
                getCommitDiff: vi
                    .fn()
                    .mockImplementation(async (_repo: string, sha: string) => {
                        if (sha === 'sha-bad') throw new Error('GitHub API error 500');
                        return FALLBACK_DIFFS;
                    }),
            }),
        );

        const result = await new GitSync({enabled: false}).syncProviders(db, [GITHUB_CONFIG]);

        // No repo-level error, and both commits still counted. `lines_added` comes from
        // the commit's own totals (2 × 40) so it survives the failure; `files_changed` is
        // built from the file-level diffs, so only the commit that resolved contributes —
        // that asymmetry is the pre-existing degradation, unchanged by #271.
        expect(result.errors.filter((e) => e.includes('Failed to fetch'))).toEqual([]);
        expect(readSnapshot(db, devId)).toMatchObject({
            commits: 2,
            lines_added: 80,
            files_changed: 2,
        });
    });

    it('Bitbucket: a 404 diffstat costs exactly one request and yields a zero-stat commit', async () => {
        // The provider swallows the 404 and returns `diffs: []`; the sync loop must accept
        // that as an answer rather than re-asking the endpoint that just 404'd.
        const devId = seedAlice(db);
        const {fetchMock, hits} = makeCountingFetch(bitbucketRoutes(404));
        vi.stubGlobal('fetch', fetchMock);
        (await getCreateGitProvider()).mockReturnValue(new BitbucketProvider(BITBUCKET_CONFIG));

        await new GitSync({enabled: false}).syncProviders(db, [BITBUCKET_CONFIG]);

        expect(hits(/\/diffstat\//)).toBe(SHAS.length);
        expect(readSnapshot(db, devId)).toMatchObject({
            commits: 3,
            lines_added: 0,
            lines_removed: 0,
            files_changed: 0,
        });
    });
});
