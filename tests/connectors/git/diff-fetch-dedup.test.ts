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
    GitProviderConfig,
    GitRepo,
} from '../../../src/connectors/git/providers/types';

// Same shape as sync.test.ts: stub the factory so `syncProviders` uses the provider we
// hand it, but keep the rest of the module (config validation) real.
vi.mock('../../../src/connectors/git/providers/factory', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/connectors/git/providers/factory')>();
    return {...actual, createGitProvider: vi.fn()};
});

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');

const AUTHOR_EMAIL = 'alice@example.com';
const COMMIT_DATE = '2024-01-15T10:00:00.000Z';
const SHAS = ['sha-aaa', 'sha-bbb', 'sha-ccc'];

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

async function getCreateGitProvider() {
    const {createGitProvider} = await import('../../../src/connectors/git/providers/factory');
    return createGitProvider as ReturnType<typeof vi.fn>;
}

/**
 * A `fetch` stub that routes by URL and counts every request per route. Unrouted URLs
 * resolve to an empty page rather than throwing, so a provider's unrelated paging (PR
 * lists) does not have to be modelled.
 */
type Route = {match: RegExp; body: unknown | ((url: string) => unknown); status?: number};

function makeCountingFetch(routes: Route[]) {
    const urls: string[] = [];
    const fetchMock = vi.fn().mockImplementation((url: string) => {
        const u = String(url);
        urls.push(u);
        const route = routes.find((r) => r.match.test(u));
        const status = route?.status ?? 200;
        const body = route
            ? typeof route.body === 'function'
              ? (route.body as (url: string) => unknown)(u)
              : route.body
            : {values: []};
        return Promise.resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: new Headers({}),
            json: () => Promise.resolve(body),
            text: () => Promise.resolve(JSON.stringify(body)),
        } as unknown as Response);
    });
    return {
        fetchMock,
        /** How many requests hit URLs matching `pattern`, counted from the request log. */
        hits: (pattern: RegExp): number => urls.filter((u) => pattern.test(u)).length,
        urls,
    };
}

function readSnapshot(db: Database.Database, devId: string) {
    return db
        .prepare(
            'SELECT lines_added, lines_removed, files_changed, commits FROM git_snapshots WHERE developer_id = ?',
        )
        .get(devId) as
        | {lines_added: number; lines_removed: number; files_changed: number; commits: number}
        | undefined;
}

// --- Provider fixtures -------------------------------------------------------------

const BITBUCKET_CONFIG: GitProviderConfig = {
    type: 'bitbucket',
    workspace: 'test-ws',
    auth: {type: 'access_token', token: 'tok'},
};

const GITHUB_CONFIG: GitProviderConfig = {
    type: 'github',
    org: 'test-org',
    auth: {type: 'token', api_token: 'tok'},
};

const GITLAB_CONFIG: GitProviderConfig = {
    type: 'gitlab',
    group: 'test-group',
    auth: {type: 'personal_access_token', token: 'tok'},
};

function bitbucketRoutes(diffstatStatus = 200) {
    return [
        {
            match: /\/repositories\/test-ws\?/,
            body: {
                values: [
                    {
                        uuid: 'u1',
                        slug: 'repo1',
                        full_name: 'test-ws/repo1',
                        mainbranch: {name: 'main'},
                        scm: 'git',
                    },
                ],
            },
        },
        {
            match: /\/repositories\/test-ws\/repo1\/commits\?/,
            body: {
                values: SHAS.map((hash) => ({
                    hash,
                    author: {raw: `Alice <${AUTHOR_EMAIL}>`, user: {nickname: 'alice-bb'}},
                    date: COMMIT_DATE,
                    message: 'feat: work',
                })),
            },
        },
        {
            match: /\/repositories\/test-ws\/repo1\/diffstat\//,
            status: diffstatStatus,
            body: {
                values: [
                    {
                        status: 'modified',
                        lines_added: 30,
                        lines_removed: 5,
                        new: {path: 'src/foo.ts'},
                        old: {path: 'src/foo.ts'},
                    },
                    {
                        status: 'added',
                        lines_added: 10,
                        lines_removed: 0,
                        new: {path: 'src/bar.ts'},
                        old: null,
                    },
                ],
            },
        },
    ];
}

function githubRoutes() {
    return [
        {
            match: /\/orgs\/test-org\/repos\?/,
            body: [
                {
                    id: 1,
                    name: 'repo1',
                    full_name: 'test-org/repo1',
                    default_branch: 'main',
                    archived: false,
                },
            ],
        },
        {
            match: /\/repos\/test-org\/repo1\/commits\?/,
            body: SHAS.map((sha) => ({sha})),
        },
        {
            // Detail endpoint — no `?`, which is what distinguishes it from the list URL.
            // Echoes the requested sha so the three commits stay distinct.
            match: /\/repos\/test-org\/repo1\/commits\/[^?]+$/,
            body: (url: string) => ({
                sha: url.split('/').pop(),
                commit: {
                    author: {name: 'Alice', email: AUTHOR_EMAIL, date: COMMIT_DATE},
                    message: 'feat: work',
                },
                author: {login: 'alice-gh'},
                stats: {additions: 40, deletions: 5, total: 45},
                files: [
                    {filename: 'src/foo.ts', additions: 30, deletions: 5, status: 'modified'},
                    {filename: 'src/bar.ts', additions: 10, deletions: 0, status: 'added'},
                ],
            }),
        },
        {match: /\/repos\/test-org\/repo1\/pulls\?/, body: []},
    ];
}

function gitlabRoutes() {
    return [
        {
            match: /\/groups\/test-group\/projects\?/,
            body: [
                {
                    id: 7,
                    name: 'Repo1',
                    path: 'repo1',
                    path_with_namespace: 'test-group/repo1',
                    default_branch: 'main',
                    archived: false,
                },
            ],
        },
        {
            match: /\/repository\/commits\?/,
            body: SHAS.map((id) => ({
                id,
                author_name: 'Alice',
                author_email: AUTHOR_EMAIL,
                authored_date: COMMIT_DATE,
                message: 'feat: work',
            })),
        },
        {
            match: /\/repository\/commits\/[^/]+\/diff\?/,
            body: [
                {
                    old_path: 'src/foo.ts',
                    new_path: 'src/foo.ts',
                    new_file: false,
                    renamed_file: false,
                    deleted_file: false,
                    diff: '@@ -1,2 +1,4 @@\n a\n+b\n+c\n-d\n',
                },
            ],
        },
        {match: /\/merge_requests\?/, body: []},
    ];
}

// --- Mock-provider helpers (for the reuse/fallback branches) -----------------------

function makeCommit(sha: string, diffs?: GitFileDiff[]): GitCommit {
    const commit: GitCommit = {
        sha,
        author: {name: 'Alice', email: AUTHOR_EMAIL, username: 'alice'},
        date: COMMIT_DATE,
        message: 'feat: work',
        additions: 40,
        deletions: 5,
        filesChanged: ['src/foo.ts', 'src/bar.ts'],
    };
    // Deliberately only assigned when supplied, so the "not supplied" case really is an
    // ABSENT property rather than an explicit `diffs: undefined`.
    if (diffs !== undefined) commit.diffs = diffs;
    return commit;
}

const FALLBACK_DIFFS: GitFileDiff[] = [
    {path: 'src/foo.ts', additions: 30, deletions: 5, status: 'modified'},
    {path: 'src/bar.ts', additions: 10, deletions: 0, status: 'added'},
];

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
        seedAlice(db);
        const {fetchMock, urls} = makeCountingFetch(githubRoutes());
        vi.stubGlobal('fetch', fetchMock);
        (await getCreateGitProvider()).mockReturnValue(new GitHubProvider(GITHUB_CONFIG));

        await new GitSync({enabled: false}).syncProviders(db, [GITHUB_CONFIG]);

        // `getCommitDiff` hits the SAME /commits/{sha} URL the detail fetch does, so the
        // count is the honest measure of the duplicate this removed.
        for (const sha of SHAS) {
            expect(urls.filter((u) => u.endsWith(`/commits/${sha}`))).toHaveLength(1);
        }
    });

    it('GitLab: fetches each commit diff exactly ONCE across a whole sync run', async () => {
        seedAlice(db);
        const {fetchMock, hits, urls} = makeCountingFetch(gitlabRoutes());
        vi.stubGlobal('fetch', fetchMock);
        (await getCreateGitProvider()).mockReturnValue(new GitLabProvider(GITLAB_CONFIG));

        await new GitSync({enabled: false}).syncProviders(db, [GITLAB_CONFIG]);

        expect(hits(/\/repository\/commits\/[^/]+\/diff\?/)).toBe(SHAS.length);
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
        // supplying none so the sync loop fetches them (the old path) — and compare.
        const run = async (supplyDiffs: boolean) => {
            const localDb = makeDb();
            const devId = seedAlice(localDb);
            const commits = SHAS.map((sha) => makeCommit(sha, supplyDiffs ? FALLBACK_DIFFS : undefined));
            (await getCreateGitProvider()).mockReturnValue(
                makeMockProvider({
                    getCommits: vi.fn().mockResolvedValue(commits),
                    getCommitDiff: vi.fn().mockResolvedValue(FALLBACK_DIFFS),
                }),
            );
            await new GitSync({enabled: false}).syncProviders(localDb, [GITHUB_CONFIG]);
            const snapshot = readSnapshot(localDb, devId);
            localDb.close();
            return snapshot;
        };

        const reused = await run(true);
        const fetched = await run(false);

        expect(reused).toEqual(fetched);
        expect(reused).toEqual({commits: 3, lines_added: 120, lines_removed: 15, files_changed: 6});
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
