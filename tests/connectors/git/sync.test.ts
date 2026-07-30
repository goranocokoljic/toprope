import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper} from '../../../src/registry/developers';
import {
    GitSync,
    firstSyncSince,
    subtractUtcMonths,
    earliestSyncStateKey,
    syncStateKey,
    declareEarliestSyncedFloor,
    getEarliestSyncedWatermark,
    EARLIEST_SYNC_EPOCH,
    FIRST_SYNC_WINDOW_MIN_MONTHS,
    FIRST_SYNC_WINDOW_MAX_MONTHS,
    FIRST_SYNC_WINDOW_DEFAULT_MONTHS,
    catchUpUntil,
    prWithinFetchWindow,
    getProviderStall,
    loadGitSyncHealth,
    GIT_STALL_ALERT_RUNS,
    GIT_CATCHUP_WINDOW_MAX_DAYS,
    UNMATCHED_AUTHORS_PREFIX,
    PROVIDER_DELETED_MID_RUN_PREFIX,
    COMMITS_DROPPED_PREFIX,
    DIFFS_NOT_SUPPLIED_PREFIX,
    isAdvisoryError,
    type GitSyncProgress,
    type GitSyncRepoStep,
    type GitSyncStage,
} from '../../../src/connectors/git/sync';
import {projectSnapshots, replayDeveloper} from '../../../src/connectors/git/projection';
import type {SyncResult} from '../../../src/connectors/types';
import {createProvider} from '../../../src/connectors/git/providers/store';
import {validateGitProviderConfig} from '../../../src/connectors/git/providers/factory';
import {loadServerKey} from '../../../src/connectors/git/providers/secret';
import type {GitConnectorConfig} from '../../../src/config/types';
import type {GitProvider, GitProviderConfig, GitRepo, GitCommit, GitFetchProgress, GitPR, GitReviewComment, GitFileDiff} from '../../../src/connectors/git/providers/types';
import {NO_AUTHOR_DATE_DROP_REASON} from '../../../src/connectors/git/providers/types';

// Stub createGitProvider (so no network) but keep validateGitProviderConfig real,
// so the store/codec that seed DB providers in the integration tests below work.
vi.mock('../../../src/connectors/git/providers/factory', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/connectors/git/providers/factory')>();
    return {...actual, createGitProvider: vi.fn()};
});

// A valid base64-encoded 32-byte key so loadServerKey() succeeds for DB providers.
const TEST_SECRET_KEY = Buffer.alloc(32, 9).toString('base64');

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');

/**
 * The SECOND argument every sync-path `createGitProvider` call carries since #273: the
 * persistent per-commit diffstat cache, scoped to this provider's `(type, container)`.
 *
 * Matched by SHAPE rather than with `expect.anything()`, because "the pipeline still hands the
 * provider a cache" is itself worth pinning — a regression that dropped it would silently
 * disable the ratchet while every other assertion in this file kept passing.
 */
const DIFFSTAT_CACHE_ARG = expect.objectContaining({
    load: expect.any(Function),
    put: expect.any(Function),
});

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function makeGithubConfig(overrides: Partial<GitConnectorConfig> = {}): GitConnectorConfig {
    return {
        enabled: true,
        providers: [
            {
                type: 'github',
                org: 'test-org',
                auth: {type: 'token', api_token: 'test-token'},
            },
        ],
        ...overrides,
    };
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

/**
 * A commit as a PROVIDER returns it.
 *
 * `diffs` is populated by DEFAULT since #280, because that is what every in-tree provider does
 * since #271: the sync loop reuses `GitCommit.diffs` and never calls `getCommitDiff`. Before
 * #280 this helper set no `diffs`, so every test in this file — churn math, merge semantics,
 * projection and retraction, cursor hold/advance, path namespacing, unmatched-author advisories,
 * per-provider scoping — ran against a fallback branch that no real provider reaches.
 *
 * Pass `NO_PROVIDER_DIFFS` for a deliberately diff-less commit. That branch IS real (the field
 * is optional by design — see `GitCommit.diffs`) and is still covered, but it now has to be
 * asked for rather than being what a test gets by accident.
 *
 * The `null` sentinel is deliberately NOT the `diffs?: GitFileDiff[]` shape its sibling
 * `diff-fetch-dedup.test.ts`'s `makeCommit` uses. There the default is "no diffs", so absence can
 * BE the default; here the default is "diffs supplied", so opting out needs a value that is
 * distinguishable from "argument omitted". Same intent, opposite defaults.
 */
function makeProviderCommit(
    username: string,
    date = '2024-01-15T10:00:00Z',
    sha?: string,
    diffs: GitFileDiff[] | null = makeProviderDiffs(),
): GitCommit {
    const commit: GitCommit = {
        sha: sha ?? `sha-${Date.now()}-${Math.random()}`,
        author: {name: username, email: `${username}@example.com`, username},
        date,
        message: 'feat: add feature',
        additions: 50,
        deletions: 10,
    };
    // Assigned only when supplied, so "not supplied" is an ABSENT property rather than an
    // explicit `diffs: undefined` — the two are indistinguishable to the sync loop's
    // `Array.isArray` check, but only the former is what a diff-less provider actually returns.
    if (diffs !== null) commit.diffs = diffs;
    return commit;
}

/** Read at the call sites as "this provider supplies no diffs" — see {@link makeProviderCommit}. */
const NO_PROVIDER_DIFFS = null;

/**
 * The file-level diff a provider hands back on `GitCommit.diffs`. Paths are the provider's
 * OWN — never repo-namespaced — because that is the contract the sync loop namespaces on top
 * of. A fresh array per call, as a real provider returns.
 */
function makeProviderDiffs(): GitFileDiff[] {
    return [
        {path: 'src/foo.ts', additions: 30, deletions: 5, status: 'modified'},
        {path: 'src/bar.ts', additions: 20, deletions: 5, status: 'modified'},
    ];
}

function makeProviderPR(username: string): GitPR {
    return {
        id: '1',
        title: 'feat: add feature',
        author: {name: username, email: `${username}@example.com`, username},
        state: 'merged',
        createdAt: '2024-01-15T08:00:00Z',
        mergedAt: '2024-01-16T10:00:00Z',
        closedAt: '2024-01-16T10:00:00Z',
        updatedAt: '2024-01-16T10:00:00Z',
        reviewers: [],
        additions: 50,
        deletions: 10,
    };
}

function makeProviderReviewComment(username: string, prId = '1'): GitReviewComment {
    return {
        author: {name: username, email: `${username}@example.com`, username},
        body: 'looks good',
        createdAt: '2024-01-15T10:00:00Z',
        prId,
    };
}

/**
 * How many times the current test reached {@link makeMockProvider}'s DEFAULT `getCommitDiff` —
 * i.e. fell onto the `getCommitDiff` fallback without asking to (#280). Asserted zero by the
 * file-level `afterEach` below.
 *
 * This is what makes "the mainstream suite exercises the reuse path" an INVARIANT rather than a
 * statement about the tree on the day #280 landed. Before it, three fixtures in this file had
 * silently slid onto the fallback and nothing failed, because a fixture that loses its `diffs`
 * keeps producing rows — just rows with no file-level detail. A test that genuinely means to
 * exercise the fallback overrides `getCommitDiff` with its own stub, which by construction never
 * touches this counter; so the invariant is precisely "no fixture reaches the fallback by
 * accident", with no opt-in flag to remember.
 */
let unaskedFallbackFetches = 0;

beforeEach(() => {
    unaskedFallbackFetches = 0;
});

afterEach(() => {
    expect(
        unaskedFallbackFetches,
        'this test fell onto the getCommitDiff fallback: its commits carry no `diffs`, so it is ' +
            'measuring a branch no in-tree provider reaches (#271/#280). Build them with ' +
            '`makeProviderCommit` (which supplies `diffs`), or — if the fallback IS the subject ' +
            '— pass `NO_PROVIDER_DIFFS` and override `getCommitDiff` with your own stub.',
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
        // Present because `GitProvider` requires it, NOT because the sync loop calls it: since
        // #271 the loop reuses `GitCommit.diffs`, and since #280 the commits this file builds
        // carry them. Reaching THIS implementation is therefore a fixture bug, which is what the
        // counter above turns into a failing test.
        getCommitDiff: vi.fn().mockImplementation(async (): Promise<GitFileDiff[]> => {
            unaskedFallbackFetches += 1;
            return [];
        }),
        checkAccess: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function seedDev(db: Database.Database, login: string, email?: string): string {
    try {
        addTeam(db, 'eng');
    } catch {
        // team may already exist
    }
    const dev = addDeveloper(db, login, 'eng', email ?? `${login}@example.com`, login);
    db.prepare(`UPDATE developers SET external_ids = '{"github":"${login}"}' WHERE id = ?`).run(dev.id);
    return dev.id;
}

function countSnapshots(db: Database.Database): number {
    const row = db.prepare('SELECT COUNT(*) as n FROM git_snapshots').get() as {n: number};
    return row.n;
}

async function getCreateGitProvider() {
    const {createGitProvider} = await import('../../../src/connectors/git/providers/factory');
    return createGitProvider as ReturnType<typeof vi.fn>;
}

describe('GitSync', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        vi.resetAllMocks();
    });

    afterEach(() => {
        db.close();
        vi.restoreAllMocks();
    });

    it('returns error when no providers configured', async () => {
        const syncer = new GitSync({enabled: true});
        const result = await syncer.sync(db);

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toMatch(/No git providers configured/);
        expect(result.snapshotsWritten).toBe(0);
    });

    it('falls back to legacy org+token config when no providers array', async () => {
        const createGitProvider = await getCreateGitProvider();
        const provider = makeMockProvider({
            listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
        });
        createGitProvider.mockReturnValue(provider);

        const syncer = new GitSync({enabled: true, org: 'myorg', api_token: 'mytoken'});
        const result = await syncer.sync(db);

        expect(createGitProvider).toHaveBeenCalledWith(
            expect.objectContaining({type: 'github', org: 'myorg'}),
            DIFFSTAT_CACHE_ARG,
        );
        expect(result.errors).toHaveLength(0);
    });

    it('returns error when legacy config missing org or token', async () => {
        const syncer = new GitSync({enabled: true, org: '', api_token: ''});
        const result = await syncer.sync(db);

        expect(result.errors[0]).toMatch(/No git providers configured/);
    });

    it('writes git_snapshots for known developer', async () => {
        const devLogin = 'alice';
        seedDev(db, devLogin);

        const createGitProvider = await getCreateGitProvider();
        const commit = makeProviderCommit(devLogin);
        const provider = makeMockProvider({
            listRepos: vi.fn().mockResolvedValue([makeRepo('myrepo')]),
            getCommits: vi.fn().mockResolvedValue([commit]),
        });
        createGitProvider.mockReturnValue(provider);

        const syncer = new GitSync(makeGithubConfig());
        const result = await syncer.sync(db);

        expect(result.errors.filter((e) => !e.includes('Unmatched'))).toHaveLength(0);
        expect(result.snapshotsWritten).toBeGreaterThan(0);
        expect(countSnapshots(db)).toBeGreaterThan(0);
    });

    /**
     * #266 AC3, the WRITE direction. `(type, container)` is the attribution key of every imported
     * row and of the three `git_*` cursors, so the pipeline must persist the CANONICAL container —
     * not whatever the YAML happened to spell. Without this, a regression to `container: config.org`
     * (the shape still used to build the API request path) would file a whole span under a second
     * bucket that `git_snapshots` then sums, and no other test in the repo would notice: every
     * other fixture here already uses a lowercase, unpadded container.
     */
    it('persists the NORMALIZED container in raw_author_daily, pr_records and the cursors (#266)', async () => {
        const devLogin = 'alice';
        seedDev(db, devLogin);

        const createGitProvider = await getCreateGitProvider();
        const provider = makeMockProvider({
            listRepos: vi.fn().mockResolvedValue([makeRepo('myrepo')]),
            getCommits: vi.fn().mockResolvedValue([makeProviderCommit(devLogin)]),
            getPullRequests: vi.fn().mockResolvedValue([makeProviderPR(devLogin)]),
        });
        createGitProvider.mockReturnValue(provider);

        // Padded AND mixed-case, i.e. the spellings #266 exists to collapse.
        const syncer = new GitSync(
            makeGithubConfig({
                providers: [
                    {
                        type: 'github',
                        org: '  Test_Org ',
                        auth: {type: 'token', api_token: 'test-token'},
                    },
                ],
            }),
        );
        await syncer.sync(db);

        const containers = (columns: string): string[] =>
            (db.prepare(columns).all() as {container: string}[]).map((r) => r.container);
        expect(containers('SELECT DISTINCT container FROM raw_author_daily')).toEqual(['test_org']);
        expect(containers('SELECT DISTINCT container FROM pr_records')).toEqual(['test_org']);

        // The cursors key off the same value — a mismatch here is what re-arms the #262
        // double-count (a cursor with no data behind it, or data with no cursor).
        const keys = (
            db
                .prepare("SELECT key FROM sync_state WHERE key LIKE 'git_%' ORDER BY key")
                .all() as {key: string}[]
        ).map((r) => r.key);
        expect(keys.length).toBeGreaterThan(0);
        for (const key of keys) {
            expect(key).toContain(':test_org');
            expect(key).not.toContain('Test_Org');
        }

        // The factory is handed the config AS CONFIGURED — normalization for the request path
        // happens one layer down, in each provider client's constructor, so `doctor` can still
        // report the spelling the operator wrote. That the client normalizes it is asserted in
        // tests/connectors/git/providers/{github,bitbucket,gitlab}.test.ts; what matters here is
        // that the ATTRIBUTION side (asserted above) does not depend on the YAML being tidy.
        expect(createGitProvider).toHaveBeenCalledWith(
            expect.objectContaining({type: 'github', org: '  Test_Org '}),
            DIFFSTAT_CACHE_ARG,
        );
    });

    it('skips commits from unknown developers (no matching record)', async () => {
        const createGitProvider = await getCreateGitProvider();
        const commit = makeProviderCommit('unknown-user');
        const provider = makeMockProvider({
            listRepos: vi.fn().mockResolvedValue([makeRepo('myrepo')]),
            getCommits: vi.fn().mockResolvedValue([commit]),
        });
        createGitProvider.mockReturnValue(provider);

        const syncer = new GitSync(makeGithubConfig());
        const result = await syncer.sync(db);

        expect(countSnapshots(db)).toBe(0);
        // Should flag the unmatched author
        expect(result.errors.some((e) => e.includes('Unmatched authors'))).toBe(true);
    });

    it('handles empty repo gracefully (no errors, no snapshots)', async () => {
        const createGitProvider = await getCreateGitProvider();
        const provider = makeMockProvider({
            listRepos: vi.fn().mockResolvedValue([makeRepo('empty-repo')]),
        });
        createGitProvider.mockReturnValue(provider);

        const syncer = new GitSync(makeGithubConfig());
        const result = await syncer.sync(db);

        expect(result.errors).toHaveLength(0);
        expect(countSnapshots(db)).toBe(0);
    });

    it('respects include repo list', async () => {
        const createGitProvider = await getCreateGitProvider();
        const provider = makeMockProvider({
            listRepos: vi.fn().mockResolvedValue([makeRepo('included'), makeRepo('excluded')]),
            getCommits: vi.fn().mockResolvedValue([]),
        });
        createGitProvider.mockReturnValue(provider);

        const syncer = new GitSync({
            enabled: true,
            providers: [{type: 'github', org: 'test', auth: {type: 'token', api_token: 'token'}, repos: ['included']}],
        });
        await syncer.sync(db);

        const getCommits = provider.getCommits as ReturnType<typeof vi.fn>;
        const calledRepos = getCommits.mock.calls.map((c: unknown[]) => c[0]);
        expect(calledRepos).toContain('included');
        expect(calledRepos).not.toContain('excluded');
    });

    it('respects exclude_repos list', async () => {
        const createGitProvider = await getCreateGitProvider();
        const provider = makeMockProvider({
            listRepos: vi.fn().mockResolvedValue([makeRepo('keep'), makeRepo('skip')]),
            getCommits: vi.fn().mockResolvedValue([]),
        });
        createGitProvider.mockReturnValue(provider);

        const syncer = new GitSync({
            enabled: true,
            providers: [{type: 'github', org: 'test', auth: {type: 'token', api_token: 'token'}, exclude_repos: ['skip']}],
        });
        await syncer.sync(db);

        const getCommits = provider.getCommits as ReturnType<typeof vi.fn>;
        const calledRepos = getCommits.mock.calls.map((c: unknown[]) => c[0]);
        expect(calledRepos).toContain('keep');
        expect(calledRepos).not.toContain('skip');
    });

    it('advances per-provider sync state after successful sync', async () => {
        const createGitProvider = await getCreateGitProvider();
        const provider = makeMockProvider({
            listRepos: vi.fn().mockResolvedValue([]),
        });
        createGitProvider.mockReturnValue(provider);

        const syncer = new GitSync(makeGithubConfig());
        expect(syncer.getLastSyncTime(db)).toBeNull();

        await syncer.sync(db);

        expect(syncer.getLastSyncTime(db)).not.toBeNull();
    });

    it('filters to a single provider when --provider flag used', async () => {
        const createGitProvider = await getCreateGitProvider();
        const githubProvider = makeMockProvider({name: 'github', listRepos: vi.fn().mockResolvedValue([])});
        const bitbucketProvider = makeMockProvider({name: 'bitbucket', listRepos: vi.fn().mockResolvedValue([])});
        createGitProvider
            .mockReturnValueOnce(githubProvider)
            .mockReturnValueOnce(bitbucketProvider);

        const syncer = new GitSync({
            enabled: true,
            providers: [
                {type: 'github', org: 'test', auth: {type: 'token', api_token: 'token'}},
                {type: 'bitbucket', workspace: 'ws', auth: {type: 'app_password', username: 'u', app_password: 'p'}},
            ],
        });

        await syncer.sync(db, 'github');

        // Only the github provider's listRepos should be called
        expect(githubProvider.listRepos).toHaveBeenCalledOnce();
        expect(bitbucketProvider.listRepos).not.toHaveBeenCalled();
    });

    it('SUMS two same-type provider instances\' disjoint PRs on one day rather than max()-ing them (SEC-1)', async () => {
        // `providerType` is the FAMILY ('github'), not the instance, so two configured
        // GitHub orgs sharing an author produce the same raw_author_key AND the same date.
        // Handing both to the store separately would combine them with the ACROSS-RUNS
        // rule, which max()es prs_opened/prs_merged/review_comments_given — correct for one
        // PR re-delivered twice, wrong here: org A's and org B's PRs are different PRs.
        // The undercount would be permanent, since the cursor advances past the window.
        const devLogin = 'alice';
        seedDev(db, devLogin);

        const orgA = makeMockProvider({
            name: 'github',
            listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a')]),
            getCommits: vi.fn().mockResolvedValue([makeProviderCommit(devLogin, '2024-01-15T10:00:00Z', 'sha-a')]),
            getPullRequests: vi.fn().mockResolvedValue([{...makeProviderPR(devLogin), id: 'pr-a'}]),
        });
        const orgB = makeMockProvider({
            name: 'github',
            listRepos: vi.fn().mockResolvedValue([makeRepo('repo-b')]),
            getCommits: vi.fn().mockResolvedValue([makeProviderCommit(devLogin, '2024-01-15T11:00:00Z', 'sha-b')]),
            getPullRequests: vi.fn().mockResolvedValue([{...makeProviderPR(devLogin), id: 'pr-b'}]),
        });
        const createGitProvider = await getCreateGitProvider();
        createGitProvider.mockReturnValueOnce(orgA).mockReturnValueOnce(orgB);

        await new GitSync({
            enabled: true,
            providers: [
                {type: 'github', org: 'org-a', auth: {type: 'token', api_token: 'token'}},
                {type: 'github', org: 'org-b', auth: {type: 'token', api_token: 'token'}},
            ],
        }).sync(db);

        const read = (date: string): {commits: number; prs_merged: number} | undefined =>
            db.prepare(`SELECT commits, prs_merged FROM git_snapshots WHERE date = ?`).get(date) as
                | {commits: number; prs_merged: number}
                | undefined;

        // One commit from each org, on the commit day…
        expect(read('2024-01-15')?.commits).toBe(2);
        // …and one MERGED PR from each, on the merge day. max() would have kept 1.
        expect(read('2024-01-16')?.prs_merged).toBe(2);

        // #264: and the two orgs are now INDEPENDENTLY attributed under the raw key, one row
        // per (container, author, day) — which is what lets a per-provider delete retract
        // exactly one org's contribution. Before this, both summed into a single row that no
        // delete could ever split.
        const rawRows = db
            .prepare(
                `SELECT container, commits FROM raw_author_daily
                  WHERE date = '2024-01-15' ORDER BY container`,
            )
            .all() as {container: string; commits: number}[];
        expect(rawRows).toEqual([
            {container: 'org-a', commits: 1},
            {container: 'org-b', commits: 1},
        ]);
        // Same for the per-PR facts: two rows, each stamped with its own container.
        expect(
            db
                .prepare('SELECT container, pr_id FROM pr_records ORDER BY container')
                .all(),
        ).toEqual([
            {container: 'org-a', pr_id: 'pr-a'},
            {container: 'org-b', pr_id: 'pr-b'},
        ]);
    });

    // #264 review SEC-9: `resolveGitProviderConfigs` deliberately keeps a malformed entry so
    // `doctor` can name it, so a provider with no org/workspace/group reaches the pipeline with
    // `container: undefined`. Before this guard it threw at the raw-store write boundary INSIDE
    // the run's write transaction, taking every other provider's data down with it.
    describe('provider with no container (#264)', () => {
        it('skips it with a surfaced error and still writes its healthy siblings', async () => {
            seedDev(db, 'alice');
            const provider = (): ReturnType<typeof makeMockProvider> =>
                makeMockProvider({
                    name: 'github',
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    getCommits: vi.fn().mockResolvedValue([makeProviderCommit('alice')]),
                });
            const createGitProvider = await getCreateGitProvider();
            // Delegate to the REAL `validateGitProviderConfig` before returning the stub, so this
            // test models production: `createGitProvider` is the canonical validation seam, and a
            // config with no org/workspace/group throws there — on `fetchProviderData`'s very
            // first statement, long before any key or write. Without this the mock would let the
            // bad config through and the failure would surface at the raw-store write boundary,
            // which is NOT where production sees it.
            createGitProvider.mockImplementation((cfg: GitProviderConfig) => {
                validateGitProviderConfig(cfg);
                return provider();
            });

            const result = await new GitSync({enabled: true}).syncProviders(db, [
                // No `org` — exactly what a YAML entry missing the field resolves to.
                {type: 'github', auth: {type: 'token', api_token: 't'}} as unknown as GitProviderConfig,
                {type: 'github', org: 'good-org', auth: {type: 'token', api_token: 't'}},
            ]);

            // The healthy sibling's data landed…
            expect(db.prepare('SELECT container FROM raw_author_daily').all()).toEqual([
                {container: 'good-org'},
            ]);
            // …and no `github:undefined` cursor was minted.
            expect(
                (
                    db
                        .prepare("SELECT COUNT(*) AS n FROM sync_state WHERE key LIKE '%undefined%'")
                        .get() as {n: number}
                ).n,
            ).toBe(0);
            // Reported as a genuine error (the operator must fix the config), not an advisory —
            // and carrying the factory's own message rather than a re-implemented one.
            const line = result.errors.find((e) => e.includes('requires org'));
            expect(line).toBeDefined();
            expect(line).toContain('Skipped');
            expect(isAdvisoryError(line as string)).toBe(false);
        });
    });

    // #264 review SO-1/SEC-1: a provider deleted DURING a run must not have its data and
    // cursor re-created by the settling run. The admin DELETE route only guards against its
    // own in-flight sync-now runs; the scheduler and CLI resolve DB providers too and are
    // invisible to that registry. The gate therefore lives at the write boundary.
    describe('mid-run provider delete (#264)', () => {
        // A DB-backed provider config: passed to syncProviders explicitly, and deliberately
        // NOT present in the connector config — so its only possible owner is a
        // `git_providers` row, exactly like a UI-connected provider.
        const DB_PROVIDER: GitProviderConfig = {
            type: 'github',
            org: 'db-org',
            auth: {type: 'token', api_token: 'token'},
        };

        function insertProviderRow(db: Database.Database, container: string): void {
            db.prepare(
                `INSERT INTO git_providers
                 (id, type, container, url, include_subgroups, auth_method, auth_username,
                  token_ciphertext, token_meta, token_last4, repos_include, repos_exclude,
                  enabled, created_at, updated_at, created_by, last_sync_at, last_sync_status, last_sync_error)
                 VALUES ('p1', 'github', ?, NULL, NULL, 'token', NULL, ?, ?, '1234', NULL, NULL,
                         1, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', NULL, NULL, NULL, NULL)`,
            ).run(
                container,
                Buffer.from('cipher'),
                '{"algo":"AES-256-GCM","iv":"x","auth_tag":"y","key_id":"k1"}',
            );
        }

        /**
         * Run one provider, optionally deleting a `git_providers` row DURING the fetch —
         * `getCommits` is called after the run has snapshotted which containers were owned, so
         * this reproduces the real interleaving (admin deletes while the run is on the network)
         * rather than the trivially-different "never owned" state.
         */
        async function runWithOneCommit(
            db: Database.Database,
            configs: GitProviderConfig[] = [DB_PROVIDER],
            /** Mutation applied DURING the fetch — the delete (and optional re-add). */
            duringFetch?: () => void,
            /** The `GitCommitDrop.reason` the mock reports (#275). */
            dropReason: string = NO_AUTHOR_DATE_DROP_REASON,
            /**
             * Return the commit WITHOUT `diffs` and fail its fallback fetch (#280), so the run
             * also stages a permanent-diff-loss advisory. Off by default: every other test in
             * this block is about the #275 drop line and must stay on the reuse path.
             */
            diffLessWithFailingFetch: boolean = false,
        ): Promise<SyncResult> {
            const createGitProvider = await getCreateGitProvider();
            const provider = (): ReturnType<typeof makeMockProvider> =>
                makeMockProvider({
                    name: 'github',
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    // Overridden only in the #280 case — and overriding it is exactly how a test
                    // that MEANS to exercise the fallback opts out of the `unaskedFallbackFetches`
                    // guard. The default path leaves the guarded stub in place.
                    ...(diffLessWithFailingFetch
                        ? {
                              getCommitDiff: vi
                                  .fn()
                                  .mockRejectedValue(new Error('502 from the diff endpoint')),
                          }
                        : {}),
                    getCommits: vi
                        .fn()
                        .mockImplementation(
                            (
                                _repo: string,
                                _since: string,
                                _until: string,
                                _onProgress: unknown,
                                onDrop?: (d: {sha: string; reason: string}) => void,
                            ) => {
                                duringFetch?.();
                                // ALSO report a dropped commit (#275). The drop advisory claims
                                // "this run has recorded its window as covered", which is false
                                // on every path this describe block exercises — a deleted
                                // container advances no cursor and writes nothing. The claim is
                                // suppressed by the advisory being staged INSIDE the
                                // `cursorAdvances` closure, below its `isWritable` guard; move
                                // the push above that guard and the assertions below fail.
                                onDrop?.({sha: 'dead01', reason: dropReason});
                                return Promise.resolve([
                                    diffLessWithFailingFetch
                                        ? makeProviderCommit(
                                              'alice',
                                              undefined,
                                              undefined,
                                              NO_PROVIDER_DIFFS,
                                          )
                                        : makeProviderCommit('alice'),
                                ]);
                            },
                        ),
                    // A PR is fetched too, so `fetchedPRRecords` is NON-EMPTY and the gate's
                    // `pr_records` arm is actually exercised. Without this the "0 pr_records"
                    // assertions below hold whether the gate works or not — and a `pr_records`
                    // row re-created for an unowned container is permanently unretractable,
                    // because the cascade is keyed off a `git_providers` row.
                    getPullRequests: vi.fn().mockResolvedValue([makeProviderPR('alice')]),
                });
            configs.forEach(() => createGitProvider.mockReturnValueOnce(provider()));
            // `enabled: true` with NO config providers — the container's only owner is the row.
            return new GitSync({enabled: true}).syncProviders(db, configs);
        }

        /** Delete `id` mid-fetch. */
        function deleteRow(db: Database.Database, id: string): () => void {
            return () => {
                db.prepare('DELETE FROM git_providers WHERE id = ?').run(id);
            };
        }

        it('discards the whole fetched window when the provider row is deleted mid-run', async () => {
            seedDev(db, 'alice');
            insertProviderRow(db, 'db-org');
            // Owned when the run starts; the row disappears while it is fetching.
            const result = await runWithOneCommit(db, [DB_PROVIDER], deleteRow(db, 'p1'));

            expect(
                (db.prepare('SELECT COUNT(*) AS n FROM raw_author_daily').get() as {n: number}).n,
            ).toBe(0);
            expect(countSnapshots(db)).toBe(0);
            expect(
                (db.prepare('SELECT COUNT(*) AS n FROM pr_records').get() as {n: number}).n,
            ).toBe(0);
            // Critically: NO cursor. A resurrected cursor is what hands a re-added provider the
            // #262 "window silently discarded" state.
            expect(
                (
                    db.prepare("SELECT COUNT(*) AS n FROM sync_state WHERE key LIKE 'git_%'").get() as {
                        n: number;
                    }
                ).n,
            ).toBe(0);
            // Loud, not silent — and an ADVISORY, since the operator's own delete caused it.
            const line = result.errors.find((e) => e.startsWith(PROVIDER_DELETED_MID_RUN_PREFIX));
            expect(line).toBeDefined();
            expect(line).toContain('github:db-org');
            expect(isAdvisoryError(line as string)).toBe(true);
            // The THIRD discard path for #275's drop advisory, and the one the first version of
            // that gate missed. This run dropped a commit (the mock reports one), the fetch was
            // COMPLETE, and the transaction COMMITTED — so neither the completeness check nor
            // the rollback path suppresses the line. Only `isWritable` does. Nothing may claim
            // the window was recorded when no cursor moved and nothing was written.
            expect(result.errors.some((e) => e.startsWith(COMMITS_DROPPED_PREFIX))).toBe(false);
        });

        /**
         * The SAME third discard path, for #280's permanent-diff-loss advisory. It is staged in
         * the same closure, below the same `isWritable` guard, and its line makes the same
         * "recorded as covered" claim — so it inherits the same failure mode, and the same
         * precedent: the first version of #275's gate missed exactly this path.
         *
         * Untested, the guard is free: hoisting `diffLossAdvisories.push` to the top of the
         * cursor-advance closure (the obvious "keep the two staged pushes together" tidy-up)
         * leaves every other test green, because the rollback case never runs the closure and
         * the incomplete case never pushes it. Only a deleted container reaches the closure and
         * returns early.
         *
         * What escapes if it regresses is not a cosmetic overstatement: the line tells the
         * operator to delete and re-add a provider whose data the cascade has ALREADY removed.
         */
        it('does NOT claim permanent diff loss when the container was deleted mid-run', async () => {
            seedDev(db, 'alice');
            insertProviderRow(db, 'db-org');
            const result = await runWithOneCommit(
                db,
                [DB_PROVIDER],
                deleteRow(db, 'p1'),
                NO_AUTHOR_DATE_DROP_REASON,
                true,
            );

            // Positive control on the discard: the window really was thrown away, so nothing
            // about it can honestly be called permanent.
            expect(countSnapshots(db)).toBe(0);
            expect(
                (
                    db.prepare("SELECT COUNT(*) AS n FROM sync_state WHERE key LIKE 'git_%'").get() as {
                        n: number;
                    }
                ).n,
            ).toBe(0);

            const diffLines = result.errors.filter((e) => e.startsWith(DIFFS_NOT_SUPPLIED_PREFIX));
            // Positive control on the emission: the run really did take the fallback and really
            // did fail it, so "no PERMANENT line" cannot pass by nothing being reported at all.
            expect(diffLines).toHaveLength(1);
            expect(diffLines[0]).toContain('1 of those requests FAILED');
            // …and the staged half is suppressed, exactly as for the drop line above.
            expect(diffLines.some((e) => e.includes('PERMANENT'))).toBe(false);
            expect(diffLines.some((e) => e.includes('delete cascade'))).toBe(false);
        });

        // Positive control for the assertion above: the identical mock reports a drop on a run
        // whose row SURVIVES, and there the advisory must appear. Without this, "no drop line
        // after a delete" would also hold if the advisory were never emitted at all.
        it('positive control — the same dropped commit IS reported when the row survives', async () => {
            seedDev(db, 'alice');
            insertProviderRow(db, 'db-org');
            const result = await runWithOneCommit(db);
            const dropLine = result.errors.find((e) => e.startsWith(COMMITS_DROPPED_PREFIX));
            expect(dropLine).toBeDefined();
            expect(dropLine).toContain('dead01');
            // The `(+N more)` suffix must not appear for a single drop — `more > 0`, not `>= 0`.
            expect(dropLine).not.toContain('more)');
        });

        // #275 review cycle 3, SEC-2: the reason crosses a provider boundary before reaching a
        // terminal and `sync_logs`, and TypeScript's union is not a runtime control. A provider
        // that interpolated an API error body (or a response field) must not reach the log.
        it('names an unrecognized drop reason instead of pasting it into the advisory', async () => {
            seedDev(db, 'alice');
            insertProviderRow(db, 'db-org');
            const result = await runWithOneCommit(
                db,
                [DB_PROVIDER],
                undefined,
                'rate limit exceeded for token ghp_SECRET[31m',
            );
            const dropLine = result.errors.find((e) => e.startsWith(COMMITS_DROPPED_PREFIX));
            expect(dropLine).toBeDefined();
            expect(dropLine).toContain('<unrecognized drop reason>');
            expect(dropLine).not.toContain('ghp_SECRET');
            expect(dropLine).not.toContain('rate limit exceeded');
        });

        // Positive control for the assertions above: with the row INTACT the same run writes a
        // pr_records row. Without this, "0 pr_records" after a delete proves nothing — it would
        // hold even if the gate's pr_records arm were removed entirely.
        it('positive control — the same run DOES write a pr_records row when the row survives', async () => {
            seedDev(db, 'alice');
            insertProviderRow(db, 'db-org');
            await runWithOneCommit(db);
            expect(db.prepare('SELECT container FROM pr_records').all()).toEqual([
                {container: 'db-org'},
            ]);
        });

        // #264 review SEC-2/SO-3/TST-5: the gate must compare the OWNER, not merely "is it
        // owned". Delete + re-add during one run leaves a DIFFERENT row on the pair, and the
        // immutable-container UX actively directs admins down exactly this path.
        it('discards the window when the container is deleted AND RE-ADDED mid-run', async () => {
            seedDev(db, 'alice');
            insertProviderRow(db, 'db-org'); // id 'p1'
            const deleteAndReAdd = (): void => {
                db.prepare('DELETE FROM git_providers WHERE id = ?').run('p1');
                db.prepare(
                    `INSERT INTO git_providers
                     (id, type, container, url, include_subgroups, auth_method, auth_username,
                      token_ciphertext, token_meta, token_last4, repos_include, repos_exclude,
                      enabled, created_at, updated_at, created_by, last_sync_at, last_sync_status,
                      last_sync_error)
                     VALUES ('p1-new', 'github', 'db-org', NULL, NULL, 'token', NULL, ?, ?, '1234',
                             NULL, NULL, 1, '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z',
                             NULL, NULL, NULL, NULL)`,
                ).run(
                    Buffer.from('cipher'),
                    '{"algo":"AES-256-GCM","iv":"x","auth_tag":"y","key_id":"k1"}',
                );
            };

            const result = await runWithOneCommit(db, [DB_PROVIDER], deleteAndReAdd);

            // A row DOES own the pair now — but not the one this run was predicated on, so
            // nothing is written and, crucially, no cursor is minted for the re-added provider.
            expect(
                (db.prepare('SELECT COUNT(*) AS n FROM raw_author_daily').get() as {n: number}).n,
            ).toBe(0);
            expect(
                (db.prepare('SELECT COUNT(*) AS n FROM pr_records').get() as {n: number}).n,
            ).toBe(0);
            expect(
                db.prepare("SELECT value FROM sync_state WHERE key = 'git_last_sync:github:db-org'").get(),
            ).toBeUndefined();
            // Which is what keeps the re-added provider's first-sync window honored (#262).
            expect(
                result.errors.some((e) => e.startsWith(PROVIDER_DELETED_MID_RUN_PREFIX)),
            ).toBe(true);
        });

        // #264 review TST-2: the stall arm. A COMPLETE run's stall update is a DELETE of a key
        // that was never seeded, so it is unobservable — the case that can actually leave a row
        // behind is an INCOMPLETE fetch, which writes the stall key the cascade just purged.
        it('does not re-create the stall key for a container deleted mid-run (incomplete fetch)', async () => {
            seedDev(db, 'alice');
            insertProviderRow(db, 'db-org');
            db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
                'git_stall:github:db-org',
                '{"runs":2,"since":"2026-07-01T00:00:00.000Z"}',
            );

            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    name: 'github',
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    // Fails → incomplete fetch → the stall arm would RECORD a run.
                    getCommits: vi.fn().mockImplementation(() => {
                        db.prepare('DELETE FROM git_providers WHERE id = ?').run('p1');
                        return Promise.reject(new Error('boom'));
                    }),
                }),
            );
            // The cascade would have purged this along with the row.
            db.prepare('DELETE FROM sync_state WHERE key = ?').run('git_stall:github:db-org');

            await new GitSync({enabled: true}).syncProviders(db, [DB_PROVIDER]);

            expect(
                (
                    db.prepare("SELECT COUNT(*) AS n FROM sync_state WHERE key LIKE 'git_stall:%'").get() as {
                        n: number;
                    }
                ).n,
            ).toBe(0);
        });

        // The narrower "never owned" shape is deliberately NOT rejected: an embedder (or a test)
        // passing an ad-hoc provider config was never predicated on a row existing, so there is
        // nothing that could have been retracted underneath it. The gate targets the
        // owned→deleted TRANSITION, not the absence of a row.
        it('leaves a container that was never owned alone', async () => {
            seedDev(db, 'alice');
            const result = await runWithOneCommit(db);
            expect(
                (db.prepare('SELECT COUNT(*) AS n FROM raw_author_daily').get() as {n: number}).n,
            ).toBeGreaterThan(0);
            expect(
                result.errors.some((e) => e.startsWith(PROVIDER_DELETED_MID_RUN_PREFIX)),
            ).toBe(false);
        });

        it('writes normally while the provider row still exists', async () => {
            seedDev(db, 'alice');
            insertProviderRow(db, 'db-org');

            const result = await runWithOneCommit(db);

            expect(
                (db.prepare('SELECT COUNT(*) AS n FROM raw_author_daily').get() as {n: number}).n,
            ).toBeGreaterThan(0);
            expect(
                db.prepare("SELECT value FROM sync_state WHERE key = 'git_last_sync:github:db-org'").get(),
            ).toBeDefined();
            expect(
                result.errors.some((e) => e.startsWith(PROVIDER_DELETED_MID_RUN_PREFIX)),
            ).toBe(false);
        });

        it('treats a CONFIG-file provider as an owner (it has no git_providers row by design)', async () => {
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    name: 'github',
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    getCommits: vi.fn().mockResolvedValue([makeProviderCommit('alice')]),
                }),
            );
            // Same provider, but now declared in the connector config.
            const result = await new GitSync({enabled: true, providers: [DB_PROVIDER]}).syncProviders(
                db,
                [DB_PROVIDER],
            );

            expect(
                (db.prepare('SELECT COUNT(*) AS n FROM raw_author_daily').get() as {n: number}).n,
            ).toBe(1);
            expect(
                result.errors.some((e) => e.startsWith(PROVIDER_DELETED_MID_RUN_PREFIX)),
            ).toBe(false);
        });

        it('writes a SURVIVING provider’s data even when a sibling in the same run was deleted', async () => {
            // (the config-owned case above fetches no PR, so its raw-row count stays 1)
            seedDev(db, 'alice');
            insertProviderRow(db, 'db-org'); // id 'p1' — deleted mid-run below
            db.prepare(
                `INSERT INTO git_providers
                 (id, type, container, url, include_subgroups, auth_method, auth_username,
                  token_ciphertext, token_meta, token_last4, repos_include, repos_exclude,
                  enabled, created_at, updated_at, created_by, last_sync_at, last_sync_status, last_sync_error)
                 VALUES ('p2', 'github', 'kept-org', NULL, NULL, 'token', NULL, ?, ?, '1234', NULL,
                         NULL, 1, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
                         NULL, NULL, NULL, NULL)`,
            ).run(
                Buffer.from('cipher'),
                '{"algo":"AES-256-GCM","iv":"x","auth_tag":"y","key_id":"k1"}',
            );
            const kept: GitProviderConfig = {
                type: 'github',
                org: 'kept-org',
                auth: {type: 'token', api_token: 'token'},
            };

            const result = await runWithOneCommit(db, [DB_PROVIDER, kept], deleteRow(db, 'p1'));

            // Only the surviving container's rows and cursor land — including its PR record,
            // which is the arm that would otherwise leave an unretractable row behind.
            expect(
                db.prepare('SELECT DISTINCT container FROM raw_author_daily').all(),
            ).toEqual([{container: 'kept-org'}]);
            expect(db.prepare('SELECT container FROM pr_records').all()).toEqual([
                {container: 'kept-org'},
            ]);
            const cursors = (
                db.prepare("SELECT key FROM sync_state WHERE key LIKE 'git_last_sync:%'").all() as {
                    key: string;
                }[]
            ).map((r) => r.key);
            expect(cursors).toEqual(['git_last_sync:github:kept-org']);
            expect(
                result.errors.find((e) => e.startsWith(PROVIDER_DELETED_MID_RUN_PREFIX)),
            ).toContain('github:db-org');
        });
    });

    // #264: a PR id is unique only WITHIN a container, so two orgs that happen to use the
    // same repo name and PR number must not collide into one `pr_records` row (the pre-042
    // unique key `(provider, repo, pr_id)` would have made the second an UPDATE of the
    // first, silently losing one org's PR).
    it('keeps same-repo/same-PR-id records from two orgs as separate pr_records rows', async () => {
        const devLogin = 'alice';
        seedDev(db, devLogin);

        const org = (sha: string): ReturnType<typeof makeMockProvider> =>
            makeMockProvider({
                name: 'github',
                listRepos: vi.fn().mockResolvedValue([makeRepo('shared-name')]),
                getCommits: vi.fn().mockResolvedValue([makeProviderCommit(devLogin, '2024-01-15T10:00:00Z', sha)]),
                getPullRequests: vi.fn().mockResolvedValue([{...makeProviderPR(devLogin), id: '42'}]),
            });
        const createGitProvider = await getCreateGitProvider();
        createGitProvider.mockReturnValueOnce(org('sha-a')).mockReturnValueOnce(org('sha-b'));

        await new GitSync({
            enabled: true,
            providers: [
                {type: 'github', org: 'org-a', auth: {type: 'token', api_token: 'token'}},
                {type: 'github', org: 'org-b', auth: {type: 'token', api_token: 'token'}},
            ],
        }).sync(db);

        expect(
            db
                .prepare("SELECT container FROM pr_records WHERE repo = 'shared-name' AND pr_id = '42' ORDER BY container")
                .all(),
        ).toEqual([{container: 'org-a'}, {container: 'org-b'}]);
    });

    it('returns error when filtered provider type is not configured', async () => {
        const createGitProvider = await getCreateGitProvider();
        createGitProvider.mockReturnValue(makeMockProvider());

        const syncer = new GitSync(makeGithubConfig()); // only github configured
        const result = await syncer.sync(db, 'bitbucket');

        expect(result.errors[0]).toMatch(/No provider of type 'bitbucket'/);
    });

    it('writes PR metrics alongside commit metrics', async () => {
        const devLogin = 'alice';
        seedDev(db, devLogin);

        const createGitProvider = await getCreateGitProvider();
        const provider = makeMockProvider({
            listRepos: vi.fn().mockResolvedValue([makeRepo('myrepo')]),
            getCommits: vi.fn().mockResolvedValue([]),
            getPullRequests: vi.fn().mockResolvedValue([makeProviderPR(devLogin)]),
        });
        createGitProvider.mockReturnValue(provider);

        const syncer = new GitSync(makeGithubConfig());
        await syncer.sync(db);

        const row = db
            .prepare(`SELECT prs_opened FROM git_snapshots WHERE date = '2024-01-15'`)
            .get() as {prs_opened: number} | undefined;

        expect(row).toBeDefined();
        expect(row!.prs_opened).toBe(1);
    });

    it('attributes review_comments_given to the reviewer, not the PR author', async () => {
        seedDev(db, 'alice');
        seedDev(db, 'bob');

        const createGitProvider = await getCreateGitProvider();
        const provider = makeMockProvider({
            listRepos: vi.fn().mockResolvedValue([makeRepo('myrepo')]),
            getPullRequests: vi.fn().mockResolvedValue([makeProviderPR('alice')]),
            getReviewComments: vi.fn().mockResolvedValue([
                makeProviderReviewComment('bob'),
                {...makeProviderReviewComment('bob'), createdAt: '2024-01-15T11:00:00Z'},
            ]),
        });
        createGitProvider.mockReturnValue(provider);

        const syncer = new GitSync(makeGithubConfig());
        const result = await syncer.sync(db);
        expect(result.errors.filter((e) => !e.includes('Unmatched'))).toHaveLength(0);

        const bobId = db
            .prepare(`SELECT id FROM developers WHERE external_ids = '{"github":"bob"}'`)
            .get() as {id: string};
        const row = db
            .prepare(`SELECT review_comments_given FROM git_snapshots WHERE developer_id = ? AND date = '2024-01-15'`)
            .get(bobId.id) as {review_comments_given: number} | undefined;

        expect(row).toBeDefined();
        expect(row!.review_comments_given).toBe(2);
    });

    it('aggregates same developer+day across multiple repos without overwriting', async () => {
        seedDev(db, 'alice');

        const createGitProvider = await getCreateGitProvider();
        const provider = makeMockProvider({
            listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a'), makeRepo('repo-b')]),
            getCommits: vi.fn().mockImplementation(async () => [
                makeProviderCommit('alice', '2024-01-15T10:00:00Z'),
            ]),
        });
        createGitProvider.mockReturnValue(provider);

        const syncer = new GitSync(makeGithubConfig());
        await syncer.sync(db);

        const row = db
            .prepare(`SELECT commits, lines_added FROM git_snapshots WHERE date = '2024-01-15'`)
            .get() as {commits: number; lines_added: number} | undefined;

        expect(row).toBeDefined();
        // Both repos' commits must be summed, not overwritten
        expect(row!.commits).toBe(2);
        expect(row!.lines_added).toBe(100);
    });

    it('records error when listRepos fails and returns early', async () => {
        const createGitProvider = await getCreateGitProvider();
        const provider = makeMockProvider({
            listRepos: vi.fn().mockRejectedValue(new Error('network failure')),
        });
        createGitProvider.mockReturnValue(provider);

        const syncer = new GitSync(makeGithubConfig());
        const result = await syncer.sync(db);

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toMatch(/network failure/);
    });

    it('stores correct churn_rate when same file changed twice within window', async () => {
        const devLogin = 'alice';
        seedDev(db, devLogin);

        const createGitProvider = await getCreateGitProvider();
        // The SAME path on both commits is the whole fixture — churn is rework of a file
        // already touched in the window. Supplied on the commits (the reuse path) rather
        // than through `getCommitDiff`, and un-namespaced, which is the contract: the sync
        // loop prefixes the repo itself.
        const sameFile = [{path: 'src/foo.ts', additions: 100, deletions: 0, status: 'modified'}];
        const commit1 = makeProviderCommit(devLogin, '2024-01-15T08:00:00Z', 'c1', sameFile);
        const commit2 = makeProviderCommit(devLogin, '2024-01-15T12:00:00Z', 'c2', sameFile);
        const provider = makeMockProvider({
            listRepos: vi.fn().mockResolvedValue([makeRepo('myrepo')]),
            getCommits: vi.fn().mockResolvedValue([commit1, commit2]),
        });
        createGitProvider.mockReturnValue(provider);

        const syncer = new GitSync(makeGithubConfig());
        await syncer.sync(db);

        const row = db
            .prepare(`SELECT code_churn_rate FROM git_snapshots WHERE date = '2024-01-15'`)
            .get() as {code_churn_rate: number} | undefined;

        expect(row).toBeDefined();
        expect(row!.code_churn_rate).toBeGreaterThan(0);
    });

    it('maps developer by email when no username match exists', async () => {
        // Developer has no external_ids for github but has email
        const devId = (function () {
            try { addTeam(db, 'eng'); } catch {}
            const dev = addDeveloper(db, 'Carol', 'eng', 'carol@example.com', undefined);
            return dev.id;
        })();

        const createGitProvider = await getCreateGitProvider();
        // Commit has no username but has email matching the developer
        const commit: GitCommit = {
            sha: 'sha-carol',
            author: {name: 'Carol', email: 'carol@example.com', username: ''},
            date: '2024-01-15T10:00:00Z',
            message: 'feat: stuff',
            additions: 20,
            deletions: 5,
            diffs: [{path: 'src/x.ts', additions: 20, deletions: 5, status: 'modified'}],
        };
        const provider = makeMockProvider({
            listRepos: vi.fn().mockResolvedValue([makeRepo('myrepo')]),
            getCommits: vi.fn().mockResolvedValue([commit]),
        });
        createGitProvider.mockReturnValue(provider);

        const syncer = new GitSync(makeGithubConfig());
        await syncer.sync(db);

        const row = db
            .prepare(`SELECT commits FROM git_snapshots WHERE developer_id = ? AND date = '2024-01-15'`)
            .get(devId) as {commits: number} | undefined;

        expect(row).toBeDefined();
        expect(row!.commits).toBe(1);
    });

    it('matches a commit by a secondary git email from external_ids', async () => {
        try {
            addTeam(db, 'eng');
        } catch {
            // team may already exist
        }
        // Primary email is dana@primary.com; the commit is authored under a
        // secondary email registered via gitEmails.
        const dev = addDeveloper(db, 'Dana', 'eng', 'dana@primary.com', undefined, {
            gitEmails: ['dana@work.com'],
        });

        const createGitProvider = await getCreateGitProvider();
        const commit: GitCommit = {
            sha: 'sha-dana',
            author: {name: 'Dana', email: 'dana@work.com', username: ''},
            date: '2024-01-15T10:00:00Z',
            message: 'feat: secondary email',
            additions: 10,
            deletions: 2,
            diffs: [{path: 'src/a.ts', additions: 10, deletions: 2, status: 'modified'}],
        };
        const provider = makeMockProvider({
            listRepos: vi.fn().mockResolvedValue([makeRepo('myrepo')]),
            getCommits: vi.fn().mockResolvedValue([commit]),
        });
        createGitProvider.mockReturnValue(provider);

        const syncer = new GitSync(makeGithubConfig());
        await syncer.sync(db);

        const row = db
            .prepare(`SELECT commits FROM git_snapshots WHERE developer_id = ? AND date = '2024-01-15'`)
            .get(dev.id) as {commits: number} | undefined;

        expect(row).toBeDefined();
        expect(row!.commits).toBe(1);
    });

    it('stores data_source matching provider type', async () => {
        seedDev(db, 'alice');

        const createGitProvider = await getCreateGitProvider();
        const commit = makeProviderCommit('alice');
        const provider = makeMockProvider({
            name: 'github',
            listRepos: vi.fn().mockResolvedValue([makeRepo('myrepo')]),
            getCommits: vi.fn().mockResolvedValue([commit]),
        });
        createGitProvider.mockReturnValue(provider);

        const syncer = new GitSync(makeGithubConfig());
        await syncer.sync(db);

        const row = db
            .prepare(`SELECT data_source FROM git_snapshots WHERE date = '2024-01-15'`)
            .get() as {data_source: string} | undefined;

        expect(row?.data_source).toBe('github');
    });

    it('merges multi-provider data for same developer+day with data_source = multi', async () => {
        // Seed developer with both github and bitbucket external_ids
        try { addTeam(db, 'eng'); } catch {}
        const dev = addDeveloper(db, 'Alice', 'eng', 'alice@example.com', 'alice');
        db.prepare(`UPDATE developers SET external_ids = '{"github":"alice","bitbucket":"alice-bb"}' WHERE id = ?`).run(dev.id);

        const createGitProvider = await getCreateGitProvider();

        const githubCommit = makeProviderCommit('alice', '2024-01-15T10:00:00Z', 'gh-sha');
        const bitbucketCommit: GitCommit = {
            sha: 'bb-sha',
            author: {name: 'Alice', email: 'alice@example.com', username: 'alice-bb'},
            date: '2024-01-15T14:00:00Z',
            message: 'fix: bug',
            additions: 30,
            deletions: 5,
            diffs: [{path: 'src/y.ts', additions: 30, deletions: 5, status: 'modified'}],
        };

        const githubProvider = makeMockProvider({
            name: 'github',
            listRepos: vi.fn().mockResolvedValue([makeRepo('gh-repo')]),
            getCommits: vi.fn().mockResolvedValue([githubCommit]),
        });
        const bitbucketProvider = makeMockProvider({
            name: 'bitbucket',
            listRepos: vi.fn().mockResolvedValue([makeRepo('bb-repo')]),
            getCommits: vi.fn().mockResolvedValue([bitbucketCommit]),
        });

        createGitProvider
            .mockReturnValueOnce(githubProvider)
            .mockReturnValueOnce(bitbucketProvider);

        const syncer = new GitSync({
            enabled: true,
            providers: [
                {type: 'github', org: 'myorg', auth: {type: 'token', api_token: 'ghtoken'}},
                {type: 'bitbucket', workspace: 'myws', auth: {type: 'app_password', username: 'u', app_password: 'p'}},
            ],
        });

        await syncer.sync(db);

        const row = db
            .prepare(`SELECT commits, data_source FROM git_snapshots WHERE date = '2024-01-15'`)
            .get() as {commits: number; data_source: string} | undefined;

        expect(row).toBeDefined();
        expect(row!.commits).toBe(2); // one from each provider
        expect(row!.data_source).toBe('multi');
    });

    it('scoped per-provider sync merges into — not replaces — another provider\'s same-day row (#205)', async () => {
        // Developer known under both providers, so both providers' commits resolve
        // to the same (developer_id, date) row.
        try { addTeam(db, 'eng'); } catch {}
        const dev = addDeveloper(db, 'Alice', 'eng', 'alice@example.com', 'alice');
        db.prepare(`UPDATE developers SET external_ids = '{"github":"alice","bitbucket":"alice-bb"}' WHERE id = ?`).run(dev.id);

        const createGitProvider = await getCreateGitProvider();

        // First scoped run (e.g. UI "Sync now" on GitHub): one GitHub commit on 01-15.
        const githubProvider = makeMockProvider({
            name: 'github',
            listRepos: vi.fn().mockResolvedValue([makeRepo('gh-repo')]),
            getCommits: vi.fn().mockResolvedValue([makeProviderCommit('alice', '2024-01-15T10:00:00Z', 'gh-1')]),
        });
        createGitProvider.mockReturnValueOnce(githubProvider);
        await new GitSync({enabled: false}).syncProviders(db, [
            {type: 'github', org: 'gh-org', auth: {type: 'token', api_token: 't'}},
        ]);

        const afterGithub = db
            .prepare(`SELECT commits, data_source FROM git_snapshots WHERE developer_id = ? AND date = '2024-01-15'`)
            .get(dev.id) as {commits: number; data_source: string};
        expect(afterGithub.commits).toBe(1);
        expect(afterGithub.data_source).toBe('github');

        // Second scoped run (Sync now on Bitbucket): a DIFFERENT commit the same day.
        // Under the old REPLACE upsert this run would overwrite the GitHub row and
        // permanently drop the GitHub commit (its cursor won't re-fetch it).
        const bitbucketProvider = makeMockProvider({
            name: 'bitbucket',
            listRepos: vi.fn().mockResolvedValue([makeRepo('bb-repo')]),
            getCommits: vi.fn().mockResolvedValue([{
                sha: 'bb-1',
                author: {name: 'Alice', email: 'alice@example.com', username: 'alice-bb'},
                date: '2024-01-15T14:00:00Z',
                message: 'fix: bug',
                additions: 20,
                deletions: 3,
                diffs: [{path: 'src/y.ts', additions: 20, deletions: 3, status: 'modified'}],
            }]),
        });
        createGitProvider.mockReturnValueOnce(bitbucketProvider);
        await new GitSync({enabled: false}).syncProviders(db, [
            {type: 'bitbucket', workspace: 'bb-ws', auth: {type: 'app_password', username: 'u', app_password: 'p'}},
        ]);

        const merged = db
            .prepare(`SELECT commits, data_source FROM git_snapshots WHERE developer_id = ? AND date = '2024-01-15'`)
            .get(dev.id) as {commits: number; data_source: string};
        // GitHub's contribution survived the scoped Bitbucket run: 1 + 1, not replaced by 1.
        expect(merged.commits).toBe(2);
        expect(merged.data_source).toBe('multi');
        // Merged into the single existing row, not duplicated.
        expect(countSnapshots(db)).toBe(1);
    });

    it('two incremental runs of the same provider on the same day accumulate rather than replace (#205)', async () => {
        seedDev(db, 'alice');
        const createGitProvider = await getCreateGitProvider();

        // Run 1: one GitHub commit on 01-15.
        const run1 = makeMockProvider({
            name: 'github',
            listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a')]),
            getCommits: vi.fn().mockResolvedValue([makeProviderCommit('alice', '2024-01-15T09:00:00Z', 'c1')]),
        });
        createGitProvider.mockReturnValueOnce(run1);
        await new GitSync(makeGithubConfig()).sync(db);

        const after1 = db
            .prepare(`SELECT commits, lines_added, avg_commit_size FROM git_snapshots WHERE date = '2024-01-15'`)
            .get() as {commits: number; lines_added: number; avg_commit_size: number};
        expect(after1.commits).toBe(1);
        expect(after1.lines_added).toBe(50);
        expect(after1.avg_commit_size).toBeGreaterThan(0);

        // Run 2: a NEW GitHub commit the same day (incremental — the `since` cursor
        // has advanced past c1, so run 2 fetches only c2). REPLACE would drop c1;
        // the merge must accumulate to two commits.
        const run2 = makeMockProvider({
            name: 'github',
            listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a')]),
            getCommits: vi.fn().mockResolvedValue([makeProviderCommit('alice', '2024-01-15T15:00:00Z', 'c2')]),
        });
        createGitProvider.mockReturnValueOnce(run2);
        await new GitSync(makeGithubConfig()).sync(db);

        const after2 = db
            .prepare(`SELECT commits, lines_added, data_source, avg_commit_size FROM git_snapshots WHERE date = '2024-01-15'`)
            .get() as {commits: number; lines_added: number; data_source: string; avg_commit_size: number};
        expect(after2.commits).toBe(2); // c1 + c2, not just c2
        expect(after2.lines_added).toBe(100); // 50 + 50
        expect(after2.data_source).toBe('github'); // same provider on both runs
        // Rate/score fields go through the commit-weighted re-merge path: two identical
        // commits keep avg_commit_size stable (a break in the weighting would move it).
        expect(after2.avg_commit_size).toBeCloseTo(after1.avg_commit_size, 10);
        expect(countSnapshots(db)).toBe(1);
    });

    it('re-delivered PRs and review comments do not double-count across incremental runs (#205, SEC-1)', async () => {
        // PR author + a distinct reviewer, both known.
        const aliceId = seedDev(db, 'alice');
        const bobId = seedDev(db, 'bob');
        const createGitProvider = await getCreateGitProvider();

        // Providers fetch PRs by updated_at, so an active PR (and its comments) is
        // re-fetched on every subsequent sync. Two runs deliver the SAME PR + comment;
        // the day's prs_opened / prs_merged / review_comments_given must not inflate.
        const makeProvider = (): GitProvider => makeMockProvider({
            name: 'github',
            listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a')]),
            getCommits: vi.fn().mockResolvedValue([]),
            getPullRequests: vi.fn().mockResolvedValue([makeProviderPR('alice')]),
            getReviewComments: vi.fn().mockResolvedValue([makeProviderReviewComment('bob')]),
        });

        createGitProvider.mockReturnValueOnce(makeProvider());
        await new GitSync(makeGithubConfig()).sync(db);

        // makeProviderPR: created 01-15 (prs_opened), merged 01-16 (prs_merged);
        // comment by bob on 01-15 (review_comments_given).
        const openedAfter1 = db
            .prepare(`SELECT prs_opened FROM git_snapshots WHERE developer_id = ? AND date = '2024-01-15'`)
            .get(aliceId) as {prs_opened: number};
        expect(openedAfter1.prs_opened).toBe(1);

        // Second run re-delivers the identical PR + comment.
        createGitProvider.mockReturnValueOnce(makeProvider());
        await new GitSync(makeGithubConfig()).sync(db);

        const opened = db
            .prepare(`SELECT prs_opened FROM git_snapshots WHERE developer_id = ? AND date = '2024-01-15'`)
            .get(aliceId) as {prs_opened: number};
        const merged = db
            .prepare(`SELECT prs_merged, avg_time_to_merge_hours FROM git_snapshots WHERE developer_id = ? AND date = '2024-01-16'`)
            .get(aliceId) as {prs_merged: number; avg_time_to_merge_hours: number};
        const reviewed = db
            .prepare(`SELECT review_comments_given FROM git_snapshots WHERE developer_id = ? AND date = '2024-01-15'`)
            .get(bobId) as {review_comments_given: number};

        // Additive summing would make each of these 2; the idempotent re-merge holds them at 1.
        expect(opened.prs_opened).toBe(1);
        expect(merged.prs_merged).toBe(1);
        expect(merged.avg_time_to_merge_hours).toBeCloseTo(26, 5); // 01-15T08:00 → 01-16T10:00
        expect(reviewed.review_comments_given).toBe(1);
    });

    it('a scoped run that adds commits does not drop another provider\'s already-recorded PR (#205, max never below stored)', async () => {
        // Developer known under both providers.
        try { addTeam(db, 'eng'); } catch {}
        const dev = addDeveloper(db, 'Alice', 'eng', 'alice@example.com', 'alice');
        db.prepare(`UPDATE developers SET external_ids = '{"github":"alice","bitbucket":"alice-bb"}' WHERE id = ?`).run(dev.id);

        const createGitProvider = await getCreateGitProvider();

        // Run 1 (GitHub): a PR opened 01-15, no commits → stored prs_opened=1.
        const githubProvider = makeMockProvider({
            name: 'github',
            listRepos: vi.fn().mockResolvedValue([makeRepo('gh-repo')]),
            getCommits: vi.fn().mockResolvedValue([]),
            getPullRequests: vi.fn().mockResolvedValue([makeProviderPR('alice')]),
        });
        createGitProvider.mockReturnValueOnce(githubProvider);
        await new GitSync({enabled: false}).syncProviders(db, [
            {type: 'github', org: 'gh-org', auth: {type: 'token', api_token: 't'}},
        ]);
        expect(
            (db.prepare(`SELECT prs_opened FROM git_snapshots WHERE developer_id = ? AND date = '2024-01-15'`)
                .get(dev.id) as {prs_opened: number}).prs_opened,
        ).toBe(1);

        // Run 2 (Bitbucket, scoped): a COMMIT on the same day, NO PRs → incoming.prs_opened=0.
        // remerge must keep the stored prs_opened (max(1,0)=1); a regression to `incoming`
        // would drop it to 0 — the exact #205 data-loss bug, for PR fields.
        const bitbucketProvider = makeMockProvider({
            name: 'bitbucket',
            listRepos: vi.fn().mockResolvedValue([makeRepo('bb-repo')]),
            getCommits: vi.fn().mockResolvedValue([{
                sha: 'bb-1',
                author: {name: 'Alice', email: 'alice@example.com', username: 'alice-bb'},
                date: '2024-01-15T14:00:00Z',
                message: 'fix: bug',
                additions: 10,
                deletions: 2,
                diffs: [{path: 'src/y.ts', additions: 10, deletions: 2, status: 'modified'}],
            }]),
        });
        createGitProvider.mockReturnValueOnce(bitbucketProvider);
        await new GitSync({enabled: false}).syncProviders(db, [
            {type: 'bitbucket', workspace: 'bb-ws', auth: {type: 'app_password', username: 'u', app_password: 'p'}},
        ]);

        const row = db
            .prepare(`SELECT prs_opened, commits FROM git_snapshots WHERE developer_id = ? AND date = '2024-01-15'`)
            .get(dev.id) as {prs_opened: number; commits: number};
        expect(row.prs_opened).toBe(1); // preserved, not dropped to 0
        expect(row.commits).toBe(1); // Bitbucket's commit accumulated
    });

    it('commit-weights rate fields on re-merge (a small delta cannot drag a large accumulated row to a plain mean) (#205)', async () => {
        seedDev(db, 'alice');
        const createGitProvider = await getCreateGitProvider();

        // avg_commit_size = (additions + deletions) / commits (per analyzer). Run 1:
        // two commits @ 100 additions → stored avg_commit_size = 100 over 2 commits.
        const bigCommit = (sha: string): GitCommit => ({
            sha,
            author: {name: 'alice', email: 'alice@example.com', username: 'alice'},
            date: '2024-01-15T09:00:00Z',
            message: 'feat: big',
            additions: 100,
            deletions: 0,
            diffs: [{path: 'src/a.ts', additions: 100, deletions: 0, status: 'modified'}],
        });
        createGitProvider.mockReturnValueOnce(makeMockProvider({
            name: 'github',
            listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a')]),
            getCommits: vi.fn().mockResolvedValue([bigCommit('b1'), bigCommit('b2')]),
        }));
        await new GitSync(makeGithubConfig()).sync(db);
        expect(
            (db.prepare(`SELECT commits, avg_commit_size FROM git_snapshots WHERE date = '2024-01-15'`)
                .get() as {commits: number; avg_commit_size: number}).avg_commit_size,
        ).toBeCloseTo(100, 5);

        // Run 2: one small commit @ 20 additions (this run's avg_commit_size = 20).
        createGitProvider.mockReturnValueOnce(makeMockProvider({
            name: 'github',
            listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a')]),
            getCommits: vi.fn().mockResolvedValue([{
                sha: 's1',
                author: {name: 'alice', email: 'alice@example.com', username: 'alice'},
                date: '2024-01-15T15:00:00Z',
                message: 'fix: small',
                additions: 20,
                deletions: 0,
                diffs: [{path: 'src/a.ts', additions: 20, deletions: 0, status: 'modified'}],
            }]),
        }));
        await new GitSync(makeGithubConfig()).sync(db);

        const row = db
            .prepare(`SELECT commits, avg_commit_size FROM git_snapshots WHERE date = '2024-01-15'`)
            .get() as {commits: number; avg_commit_size: number};
        expect(row.commits).toBe(3);
        // Commit-weighted: (100*2 + 20*1)/3 = 73.33 — NOT the plain mean (100+20)/2 = 60.
        expect(row.avg_commit_size).toBeCloseTo(73.333, 2);
    });

    it('avg_time_to_merge tracks the run that owns the larger prs_merged, not a frozen first value (#205, SO-1)', async () => {
        seedDev(db, 'alice');
        const createGitProvider = await getCreateGitProvider();

        // Run 1: one PR merged 01-16 → ttm 26h (created 01-15T08 → merged 01-16T10).
        createGitProvider.mockReturnValueOnce(makeMockProvider({
            name: 'github',
            listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a')]),
            getPullRequests: vi.fn().mockResolvedValue([makeProviderPR('alice')]),
        }));
        await new GitSync(makeGithubConfig()).sync(db);
        expect(
            (db.prepare(`SELECT prs_merged, avg_time_to_merge_hours FROM git_snapshots WHERE developer_id = (SELECT id FROM developers WHERE external_ids = '{"github":"alice"}') AND date = '2024-01-16'`)
                .get() as {prs_merged: number; avg_time_to_merge_hours: number}).avg_time_to_merge_hours,
        ).toBeCloseTo(26, 5);

        // Run 2 re-delivers PR#1 AND a distinct PR#2 also merged 01-16 with ttm 10h
        // (created 01-16T00 → merged 01-16T10). incoming prs_merged=2, avg ttm=(26+10)/2=18.
        const pr2: GitPR = {
            id: '2',
            title: 'feat: second',
            author: {name: 'alice', email: 'alice@example.com', username: 'alice'},
            state: 'merged',
            createdAt: '2024-01-16T00:00:00Z',
            mergedAt: '2024-01-16T10:00:00Z',
            closedAt: '2024-01-16T10:00:00Z',
            reviewers: [],
            additions: 10,
            deletions: 2,
        };
        createGitProvider.mockReturnValueOnce(makeMockProvider({
            name: 'github',
            listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a')]),
            getPullRequests: vi.fn().mockResolvedValue([makeProviderPR('alice'), pr2]),
        }));
        await new GitSync(makeGithubConfig()).sync(db);

        const row = db
            .prepare(`SELECT prs_merged, avg_time_to_merge_hours FROM git_snapshots WHERE developer_id = (SELECT id FROM developers WHERE external_ids = '{"github":"alice"}') AND date = '2024-01-16'`)
            .get() as {prs_merged: number; avg_time_to_merge_hours: number};
        expect(row.prs_merged).toBe(2); // max(1, 2)
        // TTM follows the larger-merge-count side (incoming, 18h), not the frozen 26h.
        expect(row.avg_time_to_merge_hours).toBeCloseTo(18, 5);
    });

    it('tracks sync state independently per provider', async () => {
        const createGitProvider = await getCreateGitProvider();
        const githubProvider = makeMockProvider({name: 'github', listRepos: vi.fn().mockResolvedValue([])});
        const bitbucketProvider = makeMockProvider({name: 'bitbucket', listRepos: vi.fn().mockResolvedValue([])});
        createGitProvider
            .mockReturnValueOnce(githubProvider)
            .mockReturnValueOnce(bitbucketProvider);

        const syncer = new GitSync({
            enabled: true,
            providers: [
                {type: 'github', org: 'myorg', auth: {type: 'token', api_token: 'token'}},
                {type: 'bitbucket', workspace: 'myws', auth: {type: 'app_password', username: 'u', app_password: 'p'}},
            ],
        });

        await syncer.sync(db);

        // Both providers should have their own sync state key
        const githubKey = db.prepare(`SELECT value FROM sync_state WHERE key = 'git_last_sync:github:myorg'`).get();
        const bbKey = db.prepare(`SELECT value FROM sync_state WHERE key = 'git_last_sync:bitbucket:myws'`).get();
        expect(githubKey).toBeDefined();
        expect(bbKey).toBeDefined();
    });

    describe('pr_records (Task 5.2)', () => {
        interface PRRecordRow {
            developer_id: string;
            provider: string;
            repo: string;
            pr_id: string;
            state: string;
            review_comment_count: number;
            review_rounds: number;
            changes_requested_count: number;
            merged_at: string | null;
            time_to_merge_hours: number | null;
        }

        function getPRRecords(): PRRecordRow[] {
            return db.prepare('SELECT * FROM pr_records ORDER BY pr_id').all() as PRRecordRow[];
        }

        it('persists per-PR records with normalized review outcomes', async () => {
            const devId = seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            const provider = makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a')]),
                getPullRequests: vi.fn().mockResolvedValue([makeProviderPR('alice')]),
                getReviewComments: vi.fn().mockResolvedValue([
                    makeProviderReviewComment('bob'),
                    makeProviderReviewComment('bob'),
                ]),
                getPRReviews: vi.fn().mockResolvedValue([
                    {author: {name: '', email: '', username: 'bob'}, state: 'changes_requested', submittedAt: '2024-01-15T12:00:00Z', prId: '1'},
                    {author: {name: '', email: '', username: 'bob'}, state: 'approved', submittedAt: '2024-01-16T09:00:00Z', prId: '1'},
                ]),
            });
            createGitProvider.mockReturnValue(provider);

            await new GitSync(makeGithubConfig()).sync(db);

            const records = getPRRecords();
            expect(records).toHaveLength(1);
            expect(records[0].developer_id).toBe(devId);
            expect(records[0].provider).toBe('github');
            expect(records[0].repo).toBe('repo-a');
            expect(records[0].state).toBe('merged');
            expect(records[0].review_comment_count).toBe(2);
            expect(records[0].changes_requested_count).toBe(1);
            // One initial round + one send-back
            expect(records[0].review_rounds).toBe(2);
            // makeProviderPR: created 01-15T08:00 → merged 01-16T10:00 = 26h
            expect(records[0].time_to_merge_hours).toBeCloseTo(26, 5);
        });

        it('records zero review rounds for a PR with no review activity', async () => {
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            const provider = makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a')]),
                getPullRequests: vi.fn().mockResolvedValue([makeProviderPR('alice')]),
            });
            createGitProvider.mockReturnValue(provider);

            await new GitSync(makeGithubConfig()).sync(db);

            const records = getPRRecords();
            expect(records).toHaveLength(1);
            expect(records[0].review_rounds).toBe(0);
            expect(records[0].changes_requested_count).toBe(0);
        });

        it('upserts the same PR on re-sync instead of duplicating it', async () => {
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            const openPR = {...makeProviderPR('alice'), state: 'open', mergedAt: null, closedAt: null};
            const provider = makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a')]),
                getPullRequests: vi.fn().mockResolvedValue([openPR]),
            });
            createGitProvider.mockReturnValue(provider);
            await new GitSync(makeGithubConfig()).sync(db);
            expect(getPRRecords()[0].state).toBe('open');

            // Next sync: the PR has merged and gained a send-back round.
            const mergedProvider = makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a')]),
                getPullRequests: vi.fn().mockResolvedValue([makeProviderPR('alice')]),
                getPRReviews: vi.fn().mockResolvedValue([
                    {author: {name: '', email: '', username: 'bob'}, state: 'changes_requested', submittedAt: '2024-01-15T12:00:00Z', prId: '1'},
                ]),
            });
            createGitProvider.mockReturnValue(mergedProvider);
            await new GitSync(makeGithubConfig()).sync(db);

            const records = getPRRecords();
            expect(records).toHaveLength(1); // updated in place
            expect(records[0].state).toBe('merged');
            expect(records[0].review_rounds).toBe(2);
        });

        it('still records the PR when the review fetch fails, and surfaces the failure as a sync error', async () => {
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            const provider = makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a')]),
                getPullRequests: vi.fn().mockResolvedValue([makeProviderPR('alice')]),
                getReviewComments: vi.fn().mockResolvedValue([makeProviderReviewComment('bob')]),
                getPRReviews: vi.fn().mockRejectedValue(new Error('boom')),
            });
            createGitProvider.mockReturnValue(provider);

            const result = await new GitSync(makeGithubConfig()).sync(db);

            const records = getPRRecords();
            expect(records).toHaveLength(1);
            expect(records[0].changes_requested_count).toBe(0);
            // Comments alone still count as review activity
            expect(records[0].review_rounds).toBe(1);
            // The failure is not silent — a token missing the reviews scope
            // must not masquerade as a clean review history.
            expect(result.errors.some((e) => /review verdicts/.test(e))).toBe(true);
        });

        it('a failed review fetch on re-sync preserves previously-observed verdict data', async () => {
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            const goodProvider = makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a')]),
                getPullRequests: vi.fn().mockResolvedValue([makeProviderPR('alice')]),
                getReviewComments: vi.fn().mockResolvedValue([
                    makeProviderReviewComment('bob'),
                    makeProviderReviewComment('bob'),
                ]),
                getPRReviews: vi.fn().mockResolvedValue([
                    {author: {name: '', email: '', username: 'bob'}, state: 'changes_requested', submittedAt: '2024-01-15T12:00:00Z', prId: '1'},
                ]),
            });
            createGitProvider.mockReturnValue(goodProvider);
            await new GitSync(makeGithubConfig()).sync(db);
            expect(getPRRecords()[0].changes_requested_count).toBe(1);
            expect(getPRRecords()[0].review_rounds).toBe(2);

            // Re-sync with both fetches failing (rate limit, revoked scope…).
            const badProvider = makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a')]),
                getPullRequests: vi.fn().mockResolvedValue([makeProviderPR('alice')]),
                getReviewComments: vi.fn().mockRejectedValue(new Error('rate limited')),
                getPRReviews: vi.fn().mockRejectedValue(new Error('rate limited')),
            });
            createGitProvider.mockReturnValue(badProvider);
            await new GitSync(makeGithubConfig()).sync(db);

            // The bad sync must not rewrite real review history as "clean".
            const records = getPRRecords();
            expect(records).toHaveLength(1);
            expect(records[0].review_comment_count).toBe(2);
            expect(records[0].changes_requested_count).toBe(1);
            expect(records[0].review_rounds).toBe(2);
        });

        it('a window-deferred PR on a capped catch-up preserves prior review counts (no clobber, no fetch) (#247)', async () => {
            // The fix routes a window-deferral through the SAME "not observed" channel a
            // fetch FAILURE uses (commentsOk/reviewsOk=false). Prove the defer→carry-forward
            // integration directly: a PR fully observed once, then deferred on a capped
            // run, must keep its stored counts AND trigger no fan-out call.
            const FWD = 'git_last_sync:github:test-org';
            const DAY = 86_400_000;
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();

            // First sync fully observes PR #1: two comments + one send-back.
            const good = makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a')]),
                getPullRequests: vi.fn().mockResolvedValue([makeProviderPR('alice')]),
                getReviewComments: vi.fn().mockResolvedValue([
                    makeProviderReviewComment('bob'),
                    makeProviderReviewComment('bob'),
                ]),
                getPRReviews: vi.fn().mockResolvedValue([
                    {author: {name: '', email: '', username: 'bob'}, state: 'changes_requested', submittedAt: '2024-01-15T12:00:00Z', prId: '1'},
                ]),
            });
            createGitProvider.mockReturnValue(good);
            await new GitSync(makeGithubConfig()).sync(db);
            expect(getPRRecords()[0].review_comment_count).toBe(2);
            expect(getPRRecords()[0].review_rounds).toBe(2);
            expect(getPRRecords()[0].changes_requested_count).toBe(1);

            // Hold the cursor 90d back → next run is capped (until = cursor+30d ≈ 60d ago).
            // PR #1 was updated 10d ago, so updatedAt > until → its fan-out is DEFERRED.
            db.prepare(
                'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            ).run(FWD, new Date(Date.now() - 90 * DAY).toISOString());
            const recentPr = {
                ...makeProviderPR('alice'),
                id: '1',
                updatedAt: new Date(Date.now() - 10 * DAY).toISOString(),
            };
            const getReviewComments = vi.fn().mockResolvedValue([]);
            const getPRReviews = vi.fn().mockResolvedValue([]);
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a')]),
                    getCommits: vi.fn().mockResolvedValue([]),
                    getPullRequests: vi.fn().mockResolvedValue([recentPr]),
                    getReviewComments,
                    getPRReviews,
                }),
            );
            await new GitSync(makeGithubConfig()).sync(db);

            // Deferred = not observed this run: no fan-out attempted, and the prior counts
            // survive rather than being clobbered with the zeros a deferred PR produces.
            expect(getReviewComments).not.toHaveBeenCalled();
            expect(getPRReviews).not.toHaveBeenCalled();
            const rec = getPRRecords();
            expect(rec).toHaveLength(1);
            expect(rec[0].review_comment_count).toBe(2);
            expect(rec[0].review_rounds).toBe(2);
            expect(rec[0].changes_requested_count).toBe(1);
        });

        it('restores the prior review_rounds verdict when only the verdict fetch fails (no stale/fresh blend)', async () => {
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            // First good sync: two send-backs → review_rounds 3, with no review
            // comments yet.
            const goodProvider = makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a')]),
                getPullRequests: vi.fn().mockResolvedValue([makeProviderPR('alice')]),
                getPRReviews: vi.fn().mockResolvedValue([
                    {author: {name: '', email: '', username: 'bob'}, state: 'changes_requested', submittedAt: '2024-01-15T12:00:00Z', prId: '1'},
                    {author: {name: '', email: '', username: 'carol'}, state: 'changes_requested', submittedAt: '2024-01-15T13:00:00Z', prId: '1'},
                    {author: {name: '', email: '', username: 'bob'}, state: 'approved', submittedAt: '2024-01-16T09:00:00Z', prId: '1'},
                ]),
            });
            createGitProvider.mockReturnValue(goodProvider);
            await new GitSync(makeGithubConfig()).sync(db);
            expect(getPRRecords()[0].review_rounds).toBe(3);
            expect(getPRRecords()[0].changes_requested_count).toBe(2);

            // Re-sync: comments NOW arrive (fresh), but the verdict fetch fails.
            // The rounds must be restored from the last observed verdict (3), not
            // recomputed from the fresh comment count alone — which would collapse
            // a 3-round PR to 1 and erase the send-back history.
            const mixedProvider = makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a')]),
                getPullRequests: vi.fn().mockResolvedValue([makeProviderPR('alice')]),
                getReviewComments: vi.fn().mockResolvedValue([makeProviderReviewComment('bob')]),
                getPRReviews: vi.fn().mockRejectedValue(new Error('rate limited')),
            });
            createGitProvider.mockReturnValue(mixedProvider);
            await new GitSync(makeGithubConfig()).sync(db);

            const rec = getPRRecords()[0];
            expect(rec.review_comment_count).toBe(1); // fresh comment count applied
            expect(rec.changes_requested_count).toBe(2); // verdict carried forward
            expect(rec.review_rounds).toBe(3); // verdict-derived rounds preserved
        });

        it('freezes merged_at against a provider re-reporting a later merge timestamp', async () => {
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            // First observation: merged at the real merge time.
            const firstProvider = makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a')]),
                getPullRequests: vi.fn().mockResolvedValue([makeProviderPR('alice')]),
            });
            createGitProvider.mockReturnValue(firstProvider);
            await new GitSync(makeGithubConfig()).sync(db);
            const firstMerged = getPRRecords()[0].merged_at;
            const firstTtm = getPRRecords()[0].time_to_merge_hours;
            expect(firstMerged).not.toBeNull();

            // Re-sync where the provider reports a later merge timestamp (e.g.
            // Bitbucket's updated_on bumped by post-merge activity). The stored
            // merged_at must stay frozen so it never disagrees with the frozen
            // time_to_merge_hours.
            const driftedPR = {...makeProviderPR('alice'), mergedAt: '2024-02-01T10:00:00Z'};
            const driftProvider = makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a')]),
                getPullRequests: vi.fn().mockResolvedValue([driftedPR]),
            });
            createGitProvider.mockReturnValue(driftProvider);
            await new GitSync(makeGithubConfig()).sync(db);

            expect(getPRRecords()[0].merged_at).toBe(firstMerged);
            expect(getPRRecords()[0].time_to_merge_hours).toBe(firstTtm);
        });

        it('skips PRs from authors with no developer record', async () => {
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            const provider = makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a')]),
                getPullRequests: vi.fn().mockResolvedValue([makeProviderPR('stranger')]),
            });
            createGitProvider.mockReturnValue(provider);

            await new GitSync(makeGithubConfig()).sync(db);

            expect(getPRRecords()).toHaveLength(0);
        });
    });
});

describe('GitSync with DB-connected providers (#196)', () => {
    let db: Database.Database;
    const savedKey = process.env.TOPROPE_SECRET_KEY;

    beforeEach(() => {
        db = makeDb();
        vi.resetAllMocks();
        process.env.TOPROPE_SECRET_KEY = TEST_SECRET_KEY;
    });

    afterEach(() => {
        db.close();
        vi.restoreAllMocks();
        if (savedKey === undefined) delete process.env.TOPROPE_SECRET_KEY;
        else process.env.TOPROPE_SECRET_KEY = savedKey;
    });

    function seedDbProvider(org: string, token: string, enabled = true): void {
        createProvider(db, loadServerKey(), {
            config: {type: 'github', org, auth: {type: 'token', api_token: token}} as GitProviderConfig,
            enabled,
        });
    }

    it('picks up an enabled DB provider and writes snapshots (no config providers)', async () => {
        const devLogin = 'alice';
        seedDev(db, devLogin);
        seedDbProvider('db-org', 'db-token-1234');

        const createGitProvider = await getCreateGitProvider();
        const provider = makeMockProvider({
            listRepos: vi.fn().mockResolvedValue([makeRepo('myrepo')]),
            getCommits: vi.fn().mockResolvedValue([makeProviderCommit(devLogin)]),
        });
        createGitProvider.mockReturnValue(provider);

        // No config providers — the only provider comes from the DB.
        const result = await new GitSync({enabled: true}).sync(db);

        // The decrypted DB provider config reached the factory...
        expect(createGitProvider).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'github',
                org: 'db-org',
                auth: {type: 'token', api_token: 'db-token-1234'},
            }),
            DIFFSTAT_CACHE_ARG,
        );
        // ...and produced snapshots.
        expect(result.errors.filter((e) => !e.includes('Unmatched'))).toHaveLength(0);
        expect(result.snapshotsWritten).toBeGreaterThan(0);
        expect(countSnapshots(db)).toBeGreaterThan(0);
    });

    it('excludes a disabled DB provider from the sync run', async () => {
        seedDbProvider('db-org', 'db-token', false);

        const createGitProvider = await getCreateGitProvider();
        createGitProvider.mockReturnValue(makeMockProvider());

        // Disabled DB provider + no config providers → nothing to sync.
        const result = await new GitSync({enabled: true}).sync(db);

        expect(createGitProvider).not.toHaveBeenCalled();
        expect(result.errors[0]).toMatch(/No git providers configured/);
        expect(countSnapshots(db)).toBe(0);
    });

    it('runs both a DB provider and a differently-scoped config provider', async () => {
        seedDev(db, 'alice');
        seedDbProvider('db-org', 'db-token');

        const createGitProvider = await getCreateGitProvider();
        createGitProvider.mockReturnValue(makeMockProvider({listRepos: vi.fn().mockResolvedValue([])}));

        // Config provider on a different container → both resolve and run.
        const config: GitConnectorConfig = {
            enabled: true,
            providers: [{type: 'github', org: 'cfg-org', auth: {type: 'token', api_token: 'cfg-token'}}],
        };
        await new GitSync(config).sync(db);

        const orgs = createGitProvider.mock.calls.map((c) => (c[0] as {org: string}).org).sort();
        expect(orgs).toEqual(['cfg-org', 'db-org']);
    });
});

describe('GitSync.syncProviders — explicit provider set (sync-now #199)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        vi.resetAllMocks();
    });

    afterEach(() => {
        db.close();
        vi.restoreAllMocks();
    });

    it('runs the same fetch→merge→upsert pipeline for the one provided config (writes snapshots)', async () => {
        const devLogin = 'alice';
        seedDev(db, devLogin);

        const createGitProvider = await getCreateGitProvider();
        const provider = makeMockProvider({
            listRepos: vi.fn().mockResolvedValue([makeRepo('myrepo')]),
            getCommits: vi.fn().mockResolvedValue([makeProviderCommit(devLogin)]),
        });
        createGitProvider.mockReturnValue(provider);

        const config: GitProviderConfig = {
            type: 'github',
            org: 'scoped-org',
            auth: {type: 'token', api_token: 'scoped-token'},
        };
        const result = await new GitSync({enabled: false}).syncProviders(db, [config]);

        // The exact config handed to syncProviders reached the factory (scoped run).
        expect(createGitProvider).toHaveBeenCalledWith(
            expect.objectContaining({type: 'github', org: 'scoped-org'}),
            DIFFSTAT_CACHE_ARG,
        );
        expect(result.errors.filter((e) => !e.includes('Unmatched'))).toHaveLength(0);
        expect(result.snapshotsWritten).toBeGreaterThan(0);
        expect(countSnapshots(db)).toBeGreaterThan(0);
    });

    it('returns the "nothing configured" shape for an empty provider set (no throw)', async () => {
        const createGitProvider = await getCreateGitProvider();
        createGitProvider.mockReturnValue(makeMockProvider());

        const result = await new GitSync({enabled: false}).syncProviders(db, []);

        expect(result.snapshotsWritten).toBe(0);
        expect(result.errors[0]).toMatch(/No git providers configured/);
        expect(createGitProvider).not.toHaveBeenCalled();
    });

    it('surfaces a provider failure as a sync error rather than throwing', async () => {
        const createGitProvider = await getCreateGitProvider();
        createGitProvider.mockReturnValue(
            makeMockProvider({listRepos: vi.fn().mockRejectedValue(new Error('network failure'))}),
        );

        const config: GitProviderConfig = {
            type: 'github',
            org: 'scoped-org',
            auth: {type: 'token', api_token: 'scoped-token'},
        };
        const result = await new GitSync({enabled: false}).syncProviders(db, [config]);

        expect(result.errors.some((e) => /network failure/.test(e))).toBe(true);
    });

    it('scopes strictly to the passed provider — a second configured provider is untouched', async () => {
        const createGitProvider = await getCreateGitProvider();
        const provider = makeMockProvider({listRepos: vi.fn().mockResolvedValue([])});
        createGitProvider.mockReturnValue(provider);

        const only: GitProviderConfig = {
            type: 'github',
            org: 'only-org',
            auth: {type: 'token', api_token: 'tok'},
        };
        await new GitSync({enabled: false}).syncProviders(db, [only]);

        // Exactly one provider was constructed — the one we passed.
        expect(createGitProvider).toHaveBeenCalledTimes(1);
        expect(createGitProvider).toHaveBeenCalledWith(
            expect.objectContaining({org: 'only-org'}),
            DIFFSTAT_CACHE_ARG,
        );
    });

    describe('syncProviders — progress listener (#209)', () => {
        const CONFIG: GitProviderConfig = {
            type: 'github',
            org: 'test-org',
            auth: {type: 'token', api_token: 'test-token'},
        };

        // Counters the pipeline promises are cumulative — they must never move
        // backwards across emissions.
        const MONOTONIC: Array<'repos_processed' | 'commits_fetched' | 'prs_fetched' | 'developers_matched'> = [
            'repos_processed',
            'commits_fetched',
            'prs_fetched',
            'developers_matched',
        ];

        it('emits the full stage sequence with monotonic counters and a final developer count', async () => {
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1'), makeRepo('repo2')]),
                    getCommits: vi.fn().mockResolvedValue([makeProviderCommit('alice')]),
                    getPullRequests: vi.fn().mockResolvedValue([makeProviderPR('alice')]),
                }),
            );

            const snapshots: GitSyncProgress[] = [];
            const result = await new GitSync({enabled: false}).syncProviders(db, [CONFIG], (p) =>
                snapshots.push(p),
            );

            // (a) Stages never move backwards across ANY consecutive pair of
            // emissions (rank-based, so a mid-run bounce back to an earlier
            // stage fails — a first-occurrence dedup would hide that), and all
            // four stages actually occur in the run.
            const STAGE_RANK: Record<GitSyncStage, number> = {
                listing_repos: 0,
                fetching: 1,
                analyzing: 2,
                writing: 3,
            };
            for (let i = 1; i < snapshots.length; i++) {
                expect(STAGE_RANK[snapshots[i].stage]).toBeGreaterThanOrEqual(
                    STAGE_RANK[snapshots[i - 1].stage],
                );
            }
            expect(new Set(snapshots.map((s) => s.stage)).size).toBe(4);
            expect(snapshots[0].stage).toBe('listing_repos');
            // The wire contract: repos_total is null until listing completes.
            expect(snapshots[0].repos_total).toBeNull();

            // (b) Every cumulative counter is monotonically non-decreasing.
            for (const key of MONOTONIC) {
                for (let i = 1; i < snapshots.length; i++) {
                    expect(snapshots[i][key]).toBeGreaterThanOrEqual(snapshots[i - 1][key]);
                }
            }

            // (c) The final snapshot carries the full run totals: both repos
            // processed, both commits and both PRs counted (one per repo), and
            // exactly one distinct developer resolved.
            const final = snapshots[snapshots.length - 1];
            expect(final).toMatchObject({
                stage: 'writing',
                repos_total: 2,
                repos_processed: 2,
                current_repo: null,
                commits_fetched: 2,
                prs_fetched: 2,
                developers_matched: 1,
            });
            // The run itself succeeded and wrote alice's snapshots — one for the
            // commit day (Jan 15) and one for the PR-merge day (Jan 16).
            expect(result.errors.filter((e) => !/Unmatched authors/.test(e))).toEqual([]);
            expect(countSnapshots(db)).toBe(2);

            // Listener snapshots are independent copies, not one shared object.
            expect(snapshots[0]).not.toBe(snapshots[1]);
        });

        it('counts a repo whose commit fetch fails as processed, so the N/M counter still reaches M', async () => {
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('bad-repo'), makeRepo('good-repo')]),
                    getCommits: vi.fn().mockImplementation(async (repo: string) => {
                        if (repo === 'bad-repo') throw new Error('GitHub API error 500');
                        return [makeProviderCommit('alice')];
                    }),
                }),
            );

            const snapshots: GitSyncProgress[] = [];
            const result = await new GitSync({enabled: false}).syncProviders(db, [CONFIG], (p) =>
                snapshots.push(p),
            );

            // The failed repo still counts as processed — the counter reaches the
            // total instead of freezing at "repo 1/2" forever.
            const final = snapshots[snapshots.length - 1];
            expect(final.repos_processed).toBe(2);
            expect(final.repos_total).toBe(2);
            expect(final.current_repo).toBeNull();
            expect(final.stage).toBe('writing');
            // Only the good repo's commit was counted, and the failure surfaced.
            expect(final.commits_fetched).toBe(1);
            expect(result.errors.some((e) => /bad-repo.*Failed to fetch commits/.test(e))).toBe(true);
        });
    });

    describe('syncProviders — within-repo progress (#270)', () => {
        const CONFIG: GitProviderConfig = {
            type: 'github',
            org: 'test-org',
            auth: {type: 'token', api_token: 'test-token'},
        };

        /** The (step, done, total) triples a listener observed, in order. */
        function steps(
            snapshots: GitSyncProgress[],
        ): Array<[GitSyncRepoStep | null, number, number | null]> {
            return snapshots.map((s) => [s.repo_step, s.repo_step_done, s.repo_step_total]);
        }

        /**
         * The indicator triples in order, with consecutive duplicates collapsed —
         * emissions that changed some OTHER field (a stage flip, a cumulative counter)
         * repeat the current triple, and those repeats are noise here.
         *
         * Order is the thing worth asserting: the VALUES this feature emits are
         * trivially correct, so the only way it can regress is by emitting them in the
         * wrong sequence (a seed landing after its ticks, a completed counter left
         * standing across the next await). A `toContainEqual` membership check cannot
         * fail on any of that.
         */
        function stepSequence(
            snapshots: GitSyncProgress[],
        ): Array<[GitSyncRepoStep | null, number, number | null]> {
            const out: Array<[GitSyncRepoStep | null, number, number | null]> = [];
            for (const triple of steps(snapshots)) {
                const last = out[out.length - 1];
                if (!last || last[0] !== triple[0] || last[1] !== triple[1] || last[2] !== triple[2]) {
                    out.push(triple);
                }
            }
            return out;
        }

        /**
         * A provider that drives the onProgress callback the sync loop hands it in the
         * SAME sequence the three real providers do: one null-total report per list
         * page, then a `done: 0` seed carrying the now-known total, then one report per
         * item. `repos` lets a test span more than one repo.
         */
        function makeTickingProvider(
            commits: GitCommit[],
            prs: GitPR[],
            repos: string[] = ['repo1'],
        ): GitProvider {
            return makeMockProvider({
                listRepos: vi.fn().mockResolvedValue(repos.map(makeRepo)),
                getCommits: vi
                    .fn()
                    .mockImplementation(
                        async (
                            _repo: string,
                            _since: string,
                            _until: string,
                            onProgress?: (p: GitFetchProgress) => void,
                        ) => {
                            onProgress?.({done: commits.length, total: null});
                            onProgress?.({done: 0, total: commits.length});
                            for (let i = 1; i <= commits.length; i++) {
                                onProgress?.({done: i, total: commits.length});
                            }
                            return commits;
                        },
                    ),
                getPullRequests: vi
                    .fn()
                    .mockImplementation(
                        async (
                            _repo: string,
                            _state: string,
                            _since: string,
                            onProgress?: (p: GitFetchProgress) => void,
                        ) => {
                            onProgress?.({done: prs.length, total: null});
                            return prs;
                        },
                    ),
            });
        }

        it('advances the commit counter while the list pages in and through the detail fetch', async () => {
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            const commits = [
                makeProviderCommit('alice', '2024-01-15T10:00:00Z', 's1'),
                makeProviderCommit('alice', '2024-01-15T11:00:00Z', 's2'),
                makeProviderCommit('alice', '2024-01-15T12:00:00Z', 's3'),
            ];
            createGitProvider.mockReturnValue(makeTickingProvider(commits, []));

            const snapshots: GitSyncProgress[] = [];
            await new GitSync({enabled: false}).syncProviders(db, [CONFIG], (p) => snapshots.push(p));

            // The EXACT ordered sequence for the whole repo, not just membership: a
            // null-total listing count, then the detail fan-out seeded at 0 and passing
            // through every intermediate value (the whole point of #270 is that it does
            // not jump 0 → 3), then the diff fan-out, then the PR step entered before
            // its list request, then the idle clear when the repo finishes.
            expect(stepSequence(snapshots)).toEqual([
                [null, 0, null],
                // Step entered before the list request, so the label is never blank
                // while that (possibly rate-limited) request is in flight.
                ['commits', 0, null],
                ['commits', 3, null],
                ['commits', 0, 3],
                ['commits', 1, 3],
                ['commits', 2, 3],
                ['commits', 3, 3],
                ['diffs', 0, 3],
                ['diffs', 1, 3],
                ['diffs', 2, 3],
                ['diffs', 3, 3],
                ['prs', 0, null],
                ['prs', 0, 0],
                [null, 0, null],
            ]);
            // Meanwhile the run-level counter stayed frozen at 0 across every
            // still-in-flight emission — proving the motion came from the within-repo
            // fields and not from something the #209 label already showed. (It only
            // moves once, after the whole repo's commits are in hand; that is exactly
            // the granularity this issue exists to fix.)
            const inFlight = snapshots.filter(
                (s) =>
                    s.repo_step === 'commits' &&
                    s.repo_step_total !== null &&
                    s.repo_step_done < s.repo_step_total,
            );
            expect(inFlight.length).toBeGreaterThan(1);
            expect(inFlight.every((s) => s.commits_fetched === 0)).toBe(true);
        });

        it('advances a diff counter through the per-commit diff fan-out', async () => {
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            const commits = [
                makeProviderCommit('alice', '2024-01-15T10:00:00Z', 's1'),
                makeProviderCommit('alice', '2024-01-15T11:00:00Z', 's2'),
            ];
            createGitProvider.mockReturnValue(makeTickingProvider(commits, []));

            const snapshots: GitSyncProgress[] = [];
            await new GitSync({enabled: false}).syncProviders(db, [CONFIG], (p) => snapshots.push(p));

            // The sync loop's OWN diff pass reports separately from the provider's commit
            // step, seeded at 0 then ticking to the total — and it starts only AFTER the
            // commit step has finished, never interleaved.
            //
            // The pass is a REUSE pass, not a fan-out: these commits carry `diffs` (as every
            // in-tree provider's do since #271), so the loop makes no request per commit and
            // the whole sequence lands within one tick. It still has to REPORT, because a
            // provider that supplies no diffs falls back to a real `getCommitDiff` fan-out
            // here — see `GitSyncProgress.repo_step`.
            const diffPhase = stepSequence(snapshots).filter(([step]) => step === 'diffs');
            expect(diffPhase).toEqual([
                ['diffs', 0, 2],
                ['diffs', 1, 2],
                ['diffs', 2, 2],
            ]);
            const order = stepSequence(snapshots).map(([step]) => step);
            expect(order.lastIndexOf('commits')).toBeLessThan(order.indexOf('diffs'));
        });

        it('advances the PR counter during listing and the per-PR review fan-out', async () => {
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            const prs: GitPR[] = [
                {...makeProviderPR('alice'), id: '1'},
                {...makeProviderPR('alice'), id: '2'},
            ];
            createGitProvider.mockReturnValue(makeTickingProvider([], prs));

            const snapshots: GitSyncProgress[] = [];
            await new GitSync({enabled: false}).syncProviders(db, [CONFIG], (p) => snapshots.push(p));

            // Ordered: the step is entered with an unknown total BEFORE the list
            // request, the provider's listing count lands, the total becomes real once
            // the list is in hand, then the comment/verdict fan-out ticks per PR.
            const prPhase = stepSequence(snapshots).filter(([step]) => step === 'prs');
            expect(prPhase).toEqual([
                ['prs', 0, null],
                ['prs', 2, null],
                ['prs', 0, 2],
                ['prs', 1, 2],
                ['prs', 2, 2],
            ]);
        });

        it('enters the PR step before the list request, so no completed diff counter is left standing', async () => {
            // The diff fan-out ends at N/N and the PR list request can then run for
            // minutes under a rate-limit backoff. If the PR step were only entered
            // AFTER that request returned, the label would show a finished counter for
            // the whole wait — the exact "reads as hung" symptom #270 removes (SO-3).
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            const commits = [makeProviderCommit('alice', '2024-01-15T10:00:00Z', 's1')];
            const snapshots: GitSyncProgress[] = [];
            let atListRequest: Array<[GitSyncRepoStep | null, number, number | null]> = [];
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    getCommits: vi.fn().mockResolvedValue(commits),
                    // Capture what a 1s poll would have seen at the instant the PR list
                    // request is in flight.
                    getPullRequests: vi.fn().mockImplementation(async () => {
                        atListRequest = steps(snapshots);
                        return [];
                    }),
                }),
            );

            await new GitSync({enabled: false}).syncProviders(db, [CONFIG], (p) => snapshots.push(p));

            expect(atListRequest[atListRequest.length - 1]).toEqual(['prs', 0, null]);
        });

        it('retracts a partial PR listing count when the PR fetch fails', async () => {
            // Page 1 lists 5 PRs, page 2 throws. Without a post-fetch report the label
            // would sit on a frozen "5 PRs found" for the rest of the repo.
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    getCommits: vi.fn().mockResolvedValue([]),
                    getPullRequests: vi
                        .fn()
                        .mockImplementation(
                            async (
                                _repo: string,
                                _state: string,
                                _since: string,
                                onProgress?: (p: GitFetchProgress) => void,
                            ) => {
                                onProgress?.({done: 5, total: null});
                                throw new Error('GitHub API error 429');
                            },
                        ),
                }),
            );

            const snapshots: GitSyncProgress[] = [];
            const result = await new GitSync({enabled: false}).syncProviders(db, [CONFIG], (p) =>
                snapshots.push(p),
            );

            const observed = stepSequence(snapshots);
            // The partial count was seen…
            expect(observed).toContainEqual(['prs', 5, null]);
            // …and the very next indicator change retracts it to a zero total, which
            // the label renders as no counter rather than a stale "5 PRs found".
            const afterPartial = observed.slice(observed.findIndex((t) => t[1] === 5 && t[2] === null) + 1);
            expect(afterPartial[0]).toEqual(['prs', 0, 0]);
            expect(result.errors.some((e) => /repo1.*Failed to fetch PRs/.test(e))).toBe(true);
        });

        it('clears the indicator when a repo finishes and between repos', async () => {
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            const commits = [makeProviderCommit('alice', '2024-01-15T10:00:00Z', 's1')];
            createGitProvider.mockReturnValue(
                makeTickingProvider(commits, [makeProviderPR('alice')], ['repo1', 'repo2']),
            );

            const snapshots: GitSyncProgress[] = [];
            await new GitSync({enabled: false}).syncProviders(db, [CONFIG], (p) => snapshots.push(p));

            // Every emission that completes a repo (repos_processed just advanced) has
            // an idle indicator, so a finished repo's "PR 1/1" is never left on screen.
            const repoDone = snapshots.filter((s, i) => i > 0 && s.repos_processed > snapshots[i - 1].repos_processed);
            expect(repoDone).toHaveLength(2);
            for (const s of repoDone) {
                expect([s.repo_step, s.repo_step_done, s.repo_step_total]).toEqual([null, 0, null]);
            }
            // …and the final snapshot (analyzing/writing, long past any repo) is idle too.
            const final = snapshots[snapshots.length - 1];
            expect([final.repo_step, final.repo_step_done, final.repo_step_total]).toEqual([null, 0, null]);
        });

        it('clears the indicator when a repo\'s commit fetch fails mid-step', async () => {
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('bad-repo')]),
                    // Ticks partway, then throws — the failure path must not leave a
                    // half-finished "commit 2/9" frozen on the label forever.
                    getCommits: vi
                        .fn()
                        .mockImplementation(
                            async (
                                _repo: string,
                                _since: string,
                                _until: string,
                                onProgress?: (p: GitFetchProgress) => void,
                            ) => {
                                // `scanned` rides on the same tick (#276) so this test also
                                // covers the failure branch clearing it. It has to be in
                                // flight when the throw happens, or the four-field assertion
                                // below would pass on a field that was never set. Note the
                                // tick is deliberately OUT of contract — a real producer
                                // reports `scanned` only while `total` is null — so that one
                                // fixture isolates the clear without needing a second run
                                // shaped like a listing walk.
                                onProgress?.({done: 2, total: 9, scanned: 11});
                                throw new Error('GitHub API error 500');
                            },
                        ),
                }),
            );

            const snapshots: GitSyncProgress[] = [];
            const result = await new GitSync({enabled: false}).syncProviders(db, [CONFIG], (p) =>
                snapshots.push(p),
            );

            // The partial tick was observed, carrying its scanned count…
            expect(steps(snapshots)).toContainEqual(['commits', 2, 9]);
            expect(snapshots.some((s) => s.repo_step_scanned === 11)).toBe(true);
            // …and then cleared by the failure branch, on all four fields, which still
            // counts the repo.
            const final = snapshots[snapshots.length - 1];
            expect([
                final.repo_step,
                final.repo_step_done,
                final.repo_step_scanned,
                final.repo_step_total,
            ]).toEqual([null, 0, null, null]);
            expect(final.repos_processed).toBe(1);
            expect(result.errors.some((e) => /bad-repo.*Failed to fetch commits/.test(e))).toBe(true);
        });

        it('reports an empty repo as zero totals, leaving the "no 0/0 counter" call to the consumer', async () => {
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(makeTickingProvider([], []));

            const snapshots: GitSyncProgress[] = [];
            await new GitSync({enabled: false}).syncProviders(db, [CONFIG], (p) => snapshots.push(p));

            // The pipeline reports what actually happened — steps that ran over an
            // empty set — rather than suppressing them here. Suppressing "commit 0/0"
            // is one decision in one place (repoStepCount, covered in
            // adminGitProviders.test.tsx); duplicating it across every producer is how
            // a fourth provider ends up forgetting it.
            expect(stepSequence(snapshots)).toEqual([
                [null, 0, null],
                ['commits', 0, null],
                ['commits', 0, 0],
                ['diffs', 0, 0],
                ['prs', 0, null],
                ['prs', 0, 0],
                [null, 0, null],
            ]);
        });

        it('enters both steps before their list requests, so the label is never blank mid-request', async () => {
            // Symmetric guarantee for commits and PRs: at the instant each list request
            // is in flight, a poll sees that step with an unknown total — not the
            // previous step's finished counter, and not an idle indicator.
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            const snapshots: GitSyncProgress[] = [];
            let atCommitList: Array<[GitSyncRepoStep | null, number, number | null]> = [];
            let atPRList: Array<[GitSyncRepoStep | null, number, number | null]> = [];
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    getCommits: vi.fn().mockImplementation(async () => {
                        atCommitList = steps(snapshots);
                        return [makeProviderCommit('alice', '2024-01-15T10:00:00Z', 's1')];
                    }),
                    getPullRequests: vi.fn().mockImplementation(async () => {
                        atPRList = steps(snapshots);
                        return [];
                    }),
                }),
            );

            await new GitSync({enabled: false}).syncProviders(db, [CONFIG], (p) => snapshots.push(p));

            expect(atCommitList[atCommitList.length - 1]).toEqual(['commits', 0, null]);
            expect(atPRList[atPRList.length - 1]).toEqual(['prs', 0, null]);
        });

        it('restarts the per-repo counters on the second repo instead of accumulating', async () => {
            // diffsProcessed/prsProcessed are per-repo `let`s inside the repo loop.
            // Hoisting either (they sit beside loop-scoped failure counters, so it is a
            // plausible refactor) would make repo2 report `diff 2/1` — a done greater
            // than its total. The full sequence across BOTH repos is the only assertion
            // that catches it; repo-boundary snapshots are idle either way.
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1'), makeRepo('repo2')]),
                    getCommits: vi
                        .fn()
                        .mockResolvedValue([makeProviderCommit('alice', '2024-01-15T10:00:00Z', 's1')]),
                    getPullRequests: vi.fn().mockResolvedValue([makeProviderPR('alice')]),
                }),
            );

            const snapshots: GitSyncProgress[] = [];
            await new GitSync({enabled: false}).syncProviders(db, [CONFIG], (p) => snapshots.push(p));

            const perRepo: Array<[GitSyncRepoStep | null, number, number | null]> = [
                ['commits', 0, null],
                ['diffs', 0, 1],
                ['diffs', 1, 1],
                ['prs', 0, null],
                ['prs', 0, 1],
                ['prs', 1, 1],
                [null, 0, null],
            ];
            expect(stepSequence(snapshots)).toEqual([[null, 0, null], ...perRepo, ...perRepo]);
            // Stated as an invariant too, since it is the property that actually matters.
            for (const s of snapshots) {
                if (s.repo_step_total !== null) {
                    expect(s.repo_step_done).toBeLessThanOrEqual(s.repo_step_total);
                }
            }
        });

        it('a throwing listener loses its update and nothing else — no phantom fetch error, no held cursor', async () => {
            // The guard in syncProviders' `report` closure is load-bearing, not defensive
            // habit. These reports fire from INSIDE provider.getCommits/getPullRequests,
            // whose per-repo catch would read an escaping throw as a failed fetch — which
            // sets commitsComplete = false, holds the provider's forward cursor and drops
            // its snapshots (#231) — and other report sites sit outside those try blocks
            // entirely, where the provider-level handler would discard the whole
            // provider's results. Delete the try/catch and this test fails on all three
            // assertions; without it, a cosmetic listener bug becomes silent data loss
            // three releases later with no visible connection.
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeTickingProvider(
                    [makeProviderCommit('alice', '2024-01-15T10:00:00Z', 's1')],
                    [makeProviderPR('alice')],
                ),
            );

            let calls = 0;
            const result = await new GitSync({enabled: false}).syncProviders(db, [CONFIG], () => {
                // Throws on every emission — the worst case, and it covers both the
                // guarded-await sites and the ones outside them.
                calls++;
                throw new Error('listener bug');
            });

            expect(calls).toBeGreaterThan(1);
            // No fetch failed, so no fetch error may be reported…
            expect(result.errors.filter((e) => !/Unmatched authors/.test(e))).toEqual([]);
            // …the provider was not skipped wholesale…
            expect(result.errors.some((e) => /could not be used/.test(e))).toBe(false);
            // …the snapshots were written…
            expect(countSnapshots(db)).toBeGreaterThan(0);
            // …and the forward cursor advanced, i.e. the window is not re-covered.
            const cursor = db
                .prepare('SELECT value FROM sync_state WHERE key = ?')
                .get(syncStateKey('github', 'test-org')) as {value: string} | undefined;
            expect(cursor?.value).toBe(result.lastSyncTime);
        });

        it('passes no listener to the provider on the observer-free scheduled path', async () => {
            // AC: the scheduled sync is unchanged — `onProgress` stays undefined all
            // the way down, so a provider pays nothing (not even an allocated object).
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            const getCommits = vi.fn().mockResolvedValue([]);
            const getPullRequests = vi.fn().mockResolvedValue([]);
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    getCommits,
                    getPullRequests,
                }),
            );

            await new GitSync({enabled: false}).syncProviders(db, [CONFIG]);

            expect(getCommits).toHaveBeenCalledTimes(1);
            expect(getCommits.mock.calls[0][3]).toBeUndefined();
            expect(getPullRequests).toHaveBeenCalledTimes(1);
            expect(getPullRequests.mock.calls[0][3]).toBeUndefined();
        });
    });

    describe('syncProviders — scanned-vs-retained listing progress (#276)', () => {
        const CONFIG: GitProviderConfig = {
            type: 'bitbucket',
            workspace: 'test-ws',
            auth: {type: 'api_token', email: 'a@b.c', api_token: 'test-token'},
        };

        /**
         * A provider whose commit listing walks pages that RETAIN nothing — the shape a
         * Bitbucket backfill produces, where the window is filtered in memory and `done`
         * cannot move. `pageSizes` is how many rows each page returned.
         */
        function makeApproachWalkProvider(pageSizes: number[]): GitProvider {
            return makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                getCommits: vi
                    .fn()
                    .mockImplementation(
                        async (
                            _repo: string,
                            _since: string,
                            _until: string,
                            onProgress?: (p: GitFetchProgress) => void,
                        ) => {
                            let scanned = 0;
                            for (const size of pageSizes) {
                                scanned += size;
                                onProgress?.({done: 0, total: null, scanned});
                            }
                            onProgress?.({done: 0, total: 0});
                            return [];
                        },
                    ),
                getPullRequests: vi.fn().mockResolvedValue([]),
            });
        }

        it('puts a provider\'s scanned count on the wire, so the label can move while nothing is retained', async () => {
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(makeApproachWalkProvider([100, 100, 100]));

            const snapshots: GitSyncProgress[] = [];
            await new GitSync({enabled: false}).syncProviders(db, [CONFIG], (p) => snapshots.push(p));

            // The (done, scanned) pairs a poller could observe during the listing walk.
            // `done` is pinned at 0 the whole way — that is the reported bug — so the
            // scanned column is the only thing that distinguishes these snapshots.
            const listing = snapshots
                .filter((s) => s.repo_step === 'commits' && s.repo_step_total === null)
                .map((s) => [s.repo_step_done, s.repo_step_scanned]);
            expect(listing).toEqual([
                // Entering the step, before the list request: nothing scanned yet.
                [0, null],
                [0, 100],
                [0, 200],
                [0, 300],
            ]);
        });

        it('clears a scanned count as soon as a producer that has none reports', async () => {
            // Every field of the indicator describes the step named in the SAME report.
            // A scanned value left standing would attach a listing-phase number to the
            // fan-out counter beside it, which is a different set entirely.
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(makeApproachWalkProvider([50, 50]));

            const snapshots: GitSyncProgress[] = [];
            await new GitSync({enabled: false}).syncProviders(db, [CONFIG], (p) => snapshots.push(p));

            // A scanned count was genuinely observed…
            expect(snapshots.some((s) => s.repo_step_scanned === 100)).toBe(true);
            // …and no snapshot from the moment the total became real onward carries one.
            const afterListing = snapshots.slice(
                snapshots.findIndex((s) => s.repo_step_scanned === 100) + 1,
            );
            expect(afterListing.length).toBeGreaterThan(0);
            expect(afterListing.every((s) => s.repo_step_scanned === null)).toBe(true);
            // Including the idle clear, which every consumer reads as "no step at all".
            const final = snapshots[snapshots.length - 1];
            expect([final.repo_step, final.repo_step_done, final.repo_step_scanned, final.repo_step_total]).toEqual(
                [null, 0, null, null],
            );
        });

        it('leaves the field null for a provider that reports no scanned count', async () => {
            // GitHub and GitLab push the window to the server, so scanned == retained and
            // the seam's optional field stays absent. It must land as null, never as a
            // second copy of `done` — a consumer renders a non-null value.
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
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
                                onProgress?: (p: GitFetchProgress) => void,
                            ) => {
                                onProgress?.({done: 3, total: null});
                                return [];
                            },
                        ),
                    getPullRequests: vi.fn().mockResolvedValue([]),
                }),
            );

            const snapshots: GitSyncProgress[] = [];
            await new GitSync({enabled: false}).syncProviders(db, [CONFIG], (p) => snapshots.push(p));

            expect(snapshots.some((s) => s.repo_step_done === 3)).toBe(true);
            expect(snapshots.every((s) => s.repo_step_scanned === null)).toBe(true);
        });
    });
});

describe('firstSyncSince — first-sync window math (#228)', () => {
    it('clamps to now − N months in UTC for an in-range integer', () => {
        expect(firstSyncSince('2026-03-15T12:00:00.000Z', 6)).toBe('2025-09-15T12:00:00.000Z');
        expect(firstSyncSince('2026-03-15T12:00:00.000Z', 1)).toBe('2026-02-15T12:00:00.000Z');
    });

    it('handles the year rollover when the subtraction crosses January', () => {
        expect(firstSyncSince('2026-02-15T00:00:00.000Z', 6)).toBe('2025-08-15T00:00:00.000Z');
        expect(firstSyncSince('2026-01-10T00:00:00.000Z', 3)).toBe('2025-10-10T00:00:00.000Z');
    });

    it('day-overflow on an end-of-month `now` shortens the window (never widens it)', () => {
        // Mar 31 − 1 month = "Feb 31" → JS normalizes forward to Mar 3, so the window
        // is ~28 days, a few days SHORTER than a calendar month. Pinned deliberately:
        // the drift is safe (it can only under-import, never re-drain quota).
        expect(firstSyncSince('2026-03-31T00:00:00.000Z', 1)).toBe('2026-03-03T00:00:00.000Z');
        // The resulting `since` is strictly AFTER a naive month-earlier date, proving
        // the window only ever narrows.
        expect(Date.parse(firstSyncSince('2026-03-31T00:00:00.000Z', 1))).toBeGreaterThan(
            Date.parse('2026-02-28T00:00:00.000Z'),
        );
    });

    it('falls back to "" (walk all history) when the window is undefined', () => {
        expect(firstSyncSince('2026-03-15T12:00:00.000Z', undefined)).toBe('');
    });

    it('falls back to "" for out-of-range or non-integer months (fail-safe, not clamp)', () => {
        // Below the floor, above the ceiling, and fractional — each degrades to the
        // legacy behavior rather than silently importing a wrong window.
        expect(firstSyncSince('2026-03-15T12:00:00.000Z', FIRST_SYNC_WINDOW_MIN_MONTHS - 1)).toBe('');
        expect(firstSyncSince('2026-03-15T12:00:00.000Z', FIRST_SYNC_WINDOW_MAX_MONTHS + 1)).toBe('');
        expect(firstSyncSince('2026-03-15T12:00:00.000Z', 3.5)).toBe('');
        expect(firstSyncSince('2026-03-15T12:00:00.000Z', Number.NaN)).toBe('');
    });

    it('falls back to "" when now is not a parseable date', () => {
        expect(firstSyncSince('not-a-date', 6)).toBe('');
    });
});

describe('GitSync.syncProviders — first-sync window plumbing (#228)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        vi.resetAllMocks();
    });

    afterEach(() => {
        db.close();
        vi.restoreAllMocks();
    });

    const CONFIG: GitProviderConfig = {
        type: 'github',
        org: 'test-org',
        auth: {type: 'token', api_token: 'test-token'},
    };
    // The cursor key the pipeline reads/writes for this provider.
    const STATE_KEY = 'git_last_sync:github:test-org';

    // Run one sync and return the `since` argument getCommits was invoked with.
    async function sinceForRun(options?: {firstSyncWindowMonths?: number}): Promise<string> {
        const createGitProvider = await getCreateGitProvider();
        const getCommits = vi.fn().mockResolvedValue([]);
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                getCommits,
            }),
        );
        await new GitSync({enabled: false}).syncProviders(db, [CONFIG], undefined, options);
        expect(getCommits).toHaveBeenCalled();
        return getCommits.mock.calls[0][1] as string;
    }

    it('clamps the first-sync window to ~now − months when no cursor exists', async () => {
        const before = Date.now();
        const since = await sinceForRun({firstSyncWindowMonths: 3});
        expect(since).not.toBe('');
        const expected = new Date(before);
        expected.setUTCMonth(expected.getUTCMonth() - 3);
        // Within a minute of the computed instant (wall-clock advances during the run).
        expect(Math.abs(Date.parse(since) - expected.getTime())).toBeLessThan(60_000);
    });

    it('walks all history ("") on the first sync when no window option is passed', async () => {
        // The scheduled path passes no options — behavior must be unchanged.
        expect(await sinceForRun(undefined)).toBe('');
        // The first run stored a cursor (even with 0 commits); clear it so this
        // asserts the fresh-first-sync path again with an empty options object.
        db.prepare('DELETE FROM sync_state').run();
        expect(await sinceForRun({})).toBe('');
    });

    it('IGNORES the window once a cursor exists — since is the cursor, not now − months', async () => {
        // Double-count guard: snapshots are additive and `since` is cursor-derived,
        // so a later "Sync now" must not re-widen the window and re-import the span.
        const cursor = '2025-01-01T00:00:00.000Z';
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(STATE_KEY, cursor);
        const since = await sinceForRun({firstSyncWindowMonths: 3});
        expect(since).toBe(cursor);
    });

    it('applies the DEFAULT window constant like the API does when asked for it', async () => {
        const before = Date.now();
        const since = await sinceForRun({firstSyncWindowMonths: FIRST_SYNC_WINDOW_DEFAULT_MONTHS});
        const expected = new Date(before);
        expected.setUTCMonth(expected.getUTCMonth() - FIRST_SYNC_WINDOW_DEFAULT_MONTHS);
        expect(Math.abs(Date.parse(since) - expected.getTime())).toBeLessThan(60_000);
    });
});

describe('subtractUtcMonths — shared month arithmetic (#229)', () => {
    it('subtracts whole UTC months, preserving the day of month', () => {
        expect(subtractUtcMonths('2026-03-15T12:00:00.000Z', 6)).toBe('2025-09-15T12:00:00.000Z');
        expect(subtractUtcMonths('2026-01-10T00:00:00.000Z', 3)).toBe('2025-10-10T00:00:00.000Z');
    });

    it('normalizes a long-month day SHORT, never over (a window can only shrink)', () => {
        // Mar 31 − 1mo → Feb has no 31st → JS rolls to Mar 3, a few days LATER than
        // Feb 28/29, so the resulting edge is never earlier than a strict month.
        expect(subtractUtcMonths('2026-03-31T00:00:00.000Z', 1)).toBe('2026-03-03T00:00:00.000Z');
        expect(Date.parse(subtractUtcMonths('2026-03-31T00:00:00.000Z', 1) as string)).toBeGreaterThan(
            Date.parse('2026-02-28T00:00:00.000Z'),
        );
    });

    it('returns null for an unparseable now', () => {
        expect(subtractUtcMonths('not-a-date', 6)).toBeNull();
    });
});

describe('getEarliestSyncedWatermark — never-synced default (#229) / legacy unknown (#233)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });

    afterEach(() => {
        db.close();
    });

    it('defaults to now − default window for a NEVER-synced provider (no cursor, no marker)', () => {
        // Not a guess: nothing is imported, so the window its first sync will use is
        // the honest floor and any backfill below it stays disjoint.
        const now = '2026-03-15T12:00:00.000Z';
        expect(getEarliestSyncedWatermark(db, 'github', 'test-org', now)).toEqual({
            kind: 'exact',
            watermark: firstSyncSince(now, FIRST_SYNC_WINDOW_DEFAULT_MONTHS),
        });
    });

    it('returns the stored watermark verbatim once set', () => {
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
            earliestSyncStateKey('github', 'test-org'),
            '2024-01-01T00:00:00.000Z',
        );
        expect(
            getEarliestSyncedWatermark(db, 'github', 'test-org', '2026-03-15T12:00:00.000Z'),
        ).toEqual({kind: 'exact', watermark: '2024-01-01T00:00:00.000Z'});
    });

    it('falls back to now (a zero-width window the guard rejects) when now is unparseable and unset', () => {
        expect(getEarliestSyncedWatermark(db, 'github', 'test-org', 'not-a-date')).toEqual({
            kind: 'exact',
            watermark: 'not-a-date',
        });
    });

    it('returns `unknown` for a LEGACY provider — cursor present, floor absent (#233)', () => {
        // The regression this closes: before #233 this returned `now − 6mo`, which is
        // NEWER than the true floor, so the first backfill re-covered the overlap and
        // additively double-counted it. The legacy state is DERIVED: a pre-#229 first
        // sync left a cursor behind but never recorded the floor it reached.
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
            syncStateKey('github', 'test-org'),
            '2026-03-01T00:00:00.000Z',
        );
        expect(
            getEarliestSyncedWatermark(db, 'github', 'test-org', '2026-03-15T12:00:00.000Z'),
        ).toEqual({kind: 'unknown'});
    });

    it('a cursor AND a floor (a #229-era provider) is exact, never unknown', () => {
        // The other side of the derived predicate: the pair is written atomically by a
        // post-#229 first sync, so both-present is the normal, trustworthy state.
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
            syncStateKey('github', 'test-org'),
            '2026-03-01T00:00:00.000Z',
        );
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
            earliestSyncStateKey('github', 'test-org'),
            '2024-01-01T00:00:00.000Z',
        );
        expect(
            getEarliestSyncedWatermark(db, 'github', 'test-org', '2026-03-15T12:00:00.000Z'),
        ).toEqual({kind: 'exact', watermark: '2024-01-01T00:00:00.000Z'});
    });

    it('a floor with NO cursor (backfill-before-first-sync) is exact, not unknown', () => {
        // The backfill route does not require a cursor, so this ordering is reachable:
        // the floor is real and recorded, so there is nothing to refuse.
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
            earliestSyncStateKey('github', 'test-org'),
            '2020-01-01T00:00:00.000Z',
        );
        expect(
            getEarliestSyncedWatermark(db, 'github', 'test-org', '2026-03-15T12:00:00.000Z'),
        ).toEqual({kind: 'exact', watermark: '2020-01-01T00:00:00.000Z'});
    });
});

describe('declareEarliestSyncedFloor — the admin recovery path (#233)', () => {
    let db: Database.Database;
    const NOW = '2026-03-15T12:00:00.000Z';

    beforeEach(() => {
        db = makeDb();
    });

    afterEach(() => {
        db.close();
    });

    // The legacy state is derived, so "make legacy" = leave a cursor with no floor,
    // exactly what a pre-#229 first sync left behind.
    const markLegacy = (): void => {
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
            syncStateKey('github', 'test-org'),
            '2026-03-01T00:00:00.000Z',
        );
    };
    const readState = (key: string): string | null =>
        (db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
            | {value: string}
            | undefined)?.value ?? null;

    it('records the declared floor, restoring backfill', () => {
        markLegacy();
        const floor = '2025-01-01T00:00:00.000Z';
        expect(declareEarliestSyncedFloor(db, 'github', 'test-org', floor, NOW)).toEqual({ok: true});
        expect(readState(earliestSyncStateKey('github', 'test-org'))).toBe(floor);
        // Recording the floor is itself what makes the provider non-legacy — the route
        // stops refusing, with no second key to keep in sync.
        expect(getEarliestSyncedWatermark(db, 'github', 'test-org', NOW)).toEqual({
            kind: 'exact',
            watermark: floor,
        });
    });

    it('refuses a non-legacy provider rather than overwrite a recorded floor', () => {
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
            earliestSyncStateKey('github', 'test-org'),
            '2024-01-01T00:00:00.000Z',
        );
        expect(declareEarliestSyncedFloor(db, 'github', 'test-org', '2025-06-01T00:00:00.000Z', NOW)).toEqual(
            {ok: false, reason: 'not_legacy'},
        );
        // The exact floor is untouched — clobbering a sync-earned floor is the
        // corruption we guard, so it takes an explicit --force (below).
        expect(readState(earliestSyncStateKey('github', 'test-org'))).toBe('2024-01-01T00:00:00.000Z');
    });

    it('refuses a never-synced provider (nothing to declare)', () => {
        expect(declareEarliestSyncedFloor(db, 'github', 'test-org', '2025-06-01T00:00:00.000Z', NOW)).toEqual(
            {ok: false, reason: 'never_synced'},
        );
        expect(readState(earliestSyncStateKey('github', 'test-org'))).toBeNull();
    });

    // The dangerous cell: force must relax "a floor is recorded", NOT "this provider
    // exists". An invented floor is never corrected (a first sync only records one when
    // none is stored) and the backfill only walks BELOW it — so the span between the
    // invented floor and the window the first sync actually reached is stranded forever.
    // A mistyped --container lands here, which is exactly why force must not pass.
    it('force does NOT waive the existence check — a never-synced provider is still refused', () => {
        expect(
            declareEarliestSyncedFloor(db, 'github', 'ghost-org', '2025-06-01T00:00:00.000Z', NOW, {
                force: true,
            }),
        ).toEqual({ok: false, reason: 'never_synced'});
        // No floor conjured for a provider that has synced nothing.
        expect(readState(earliestSyncStateKey('github', 'ghost-org'))).toBeNull();
        expect(getEarliestSyncedWatermark(db, 'github', 'ghost-org', NOW)).toEqual({
            kind: 'exact',
            watermark: firstSyncSince(NOW, FIRST_SYNC_WINDOW_DEFAULT_MONTHS),
        });
    });

    it('force applies to a floor-without-cursor provider (backfilled before its first sync)', () => {
        // This state DID sync something (a direct-API backfill), so it is a real target
        // for a correction — the existence check passes on the floor alone.
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
            earliestSyncStateKey('github', 'test-org'),
            '2024-01-01T00:00:00.000Z',
        );
        expect(
            declareEarliestSyncedFloor(db, 'github', 'test-org', '2023-01-01T00:00:00.000Z', NOW, {
                force: true,
            }),
        ).toEqual({ok: true});
        expect(readState(earliestSyncStateKey('github', 'test-org'))).toBe('2023-01-01T00:00:00.000Z');
    });

    // The declare path takes a hand-typed instant, so a typo is the EXPECTED failure —
    // and a too-recent floor silently double-counts on the next backfill. Without a way
    // to correct a declaration before it is consumed, the admin's own typo is permanent.
    it('force lets a mis-typed floor be corrected before any backfill consumes it', () => {
        markLegacy();
        const typo = '2025-01-01T00:00:00.000Z';
        const truth = '2024-01-01T00:00:00.000Z';
        expect(declareEarliestSyncedFloor(db, 'github', 'test-org', typo, NOW)).toEqual({ok: true});
        // Without force the correction is refused (the floor now looks "recorded")…
        expect(declareEarliestSyncedFloor(db, 'github', 'test-org', truth, NOW)).toEqual({
            ok: false,
            reason: 'not_legacy',
        });
        expect(readState(earliestSyncStateKey('github', 'test-org'))).toBe(typo);
        // …and with force it lands, so the backfill uses the true floor.
        expect(
            declareEarliestSyncedFloor(db, 'github', 'test-org', truth, NOW, {force: true}),
        ).toEqual({ok: true});
        expect(getEarliestSyncedWatermark(db, 'github', 'test-org', NOW)).toEqual({
            kind: 'exact',
            watermark: truth,
        });
    });

    it('force still enforces the value guards (it overrides WHO, not WHAT)', () => {
        markLegacy();
        expect(
            declareEarliestSyncedFloor(db, 'github', 'test-org', '2025-01-01', NOW, {force: true}),
        ).toEqual({ok: false, reason: 'invalid_floor'});
        expect(
            declareEarliestSyncedFloor(db, 'github', 'test-org', '2027-01-01T00:00:00.000Z', NOW, {
                force: true,
            }),
        ).toEqual({ok: false, reason: 'future_floor'});
        expect(readState(earliestSyncStateKey('github', 'test-org'))).toBeNull();
    });

    it.each([
        ['a non-date', 'yesterday'],
        ['a date-only string', '2025-01-01'],
        ['a non-UTC offset instant', '2025-01-01T00:00:00+02:00'],
        ['a second-precision instant (no millis)', '2025-01-01T00:00:00Z'],
        ['an expanded-year instant', '+010000-01-01T00:00:00.000Z'],
        // The two below pass the shape regex — they exist so the validator's other two
        // checks are not free to be deleted silently:
        //  - only the ROUND-TRIP rejects this; without it the floor would be stored as
        //    2025-03-02, two days NEWER than declared, which is the double-count
        //    direction — written by the very command meant to prevent it.
        ['a shape-valid non-existent date', '2025-02-30T00:00:00.000Z'],
        //  - only the NaN guard rejects this; without it toISOString() throws RangeError
        //    out of the typed result and the CLI dies with a stack trace.
        ['a shape-valid out-of-range month', '2025-13-01T00:00:00.000Z'],
    ])('refuses %s as a floor (must be a canonical UTC ISO instant)', (_label, floor) => {
        markLegacy();
        expect(declareEarliestSyncedFloor(db, 'github', 'test-org', floor, NOW)).toEqual({
            ok: false,
            reason: 'invalid_floor',
        });
        // Still legacy after a rejected declare — the cursor stands, no floor written.
        expect(getEarliestSyncedWatermark(db, 'github', 'test-org', NOW)).toEqual({kind: 'unknown'});
        expect(readState(earliestSyncStateKey('github', 'test-org'))).toBeNull();
    });

    it.each([
        ['at now', NOW],
        ['in the future', '2027-01-01T00:00:00.000Z'],
    ])('refuses a floor %s (upper bound)', (_label, floor) => {
        markLegacy();
        expect(declareEarliestSyncedFloor(db, 'github', 'test-org', floor, NOW)).toEqual({
            ok: false,
            reason: 'future_floor',
        });
        expect(readState(earliestSyncStateKey('github', 'test-org'))).toBeNull();
    });
});

describe('GitSync.syncProviders — sync-older-history backfill plumbing (#229)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        vi.resetAllMocks();
    });

    afterEach(() => {
        db.close();
        vi.restoreAllMocks();
    });

    const CONFIG: GitProviderConfig = {
        type: 'github',
        org: 'test-org',
        auth: {type: 'token', api_token: 'test-token'},
    };
    const FORWARD_KEY = 'git_last_sync:github:test-org';
    const EARLIEST_KEY = 'git_earliest_sync:github:test-org';

    // Run one backfill and return the getCommits mock so callers can inspect the
    // exact [since, until] slice it fetched.
    async function runBackfill(
        backfill: {since: string; until: string},
        commits: GitCommit[] = [],
    ): Promise<ReturnType<typeof vi.fn>> {
        const createGitProvider = await getCreateGitProvider();
        const getCommits = vi.fn().mockResolvedValue(commits);
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                getCommits,
            }),
        );
        await new GitSync({enabled: false}).syncProviders(db, [CONFIG], undefined, {backfill});
        return getCommits;
    }

    function readState(key: string): string | undefined {
        return (db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
            | {value: string}
            | undefined)?.value;
    }

    it('fetches the EXACT [since, until] slice and ignores the forward cursor', async () => {
        // A forward cursor is present — backfill must not read it as `since`.
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
            FORWARD_KEY,
            '2026-06-01T00:00:00.000Z',
        );
        const backfill = {since: '2024-01-01T00:00:00.000Z', until: '2024-07-01T00:00:00.000Z'};
        const getCommits = await runBackfill(backfill);
        // Trailing args: the optional #270 progress listener (absent here, this caller
        // observes nothing) and the #275 drop listener, which is ALWAYS supplied — it is
        // the only record that a commit was lost, so it must exist on the observer-free
        // path too.
        expect(getCommits).toHaveBeenCalledWith(
            'repo1',
            backfill.since,
            backfill.until,
            undefined,
            expect.any(Function),
        );
    });

    it('LOWERS the earliest watermark to `since` and leaves the forward cursor untouched', async () => {
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
            FORWARD_KEY,
            '2026-06-01T00:00:00.000Z',
        );
        const backfill = {since: '2024-01-01T00:00:00.000Z', until: '2024-07-01T00:00:00.000Z'};
        await runBackfill(backfill);
        expect(readState(EARLIEST_KEY)).toBe(backfill.since);
        // The forward cursor is the invariant "Sync now" resumes from — untouched.
        expect(readState(FORWARD_KEY)).toBe('2026-06-01T00:00:00.000Z');
    });

    it('lowers the watermark even when the older slice has no commits (window now covered)', async () => {
        const backfill = {since: '2024-01-01T00:00:00.000Z', until: '2024-07-01T00:00:00.000Z'};
        await runBackfill(backfill, []);
        expect(readState(EARLIEST_KEY)).toBe(backfill.since);
        // Backfill must never mint a forward cursor either.
        expect(readState(FORWARD_KEY)).toBeUndefined();
    });

    it('additively writes an OLD-date snapshot without clobbering an existing recent one', async () => {
        const devId = seedDev(db, 'alice');
        // A recent snapshot as if written by the first sync.
        db.prepare(
            `INSERT INTO git_snapshots
             (id, developer_id, date, commits, lines_added, lines_removed, files_changed,
              prs_opened, prs_merged, review_comments_given, avg_time_to_merge_hours,
              code_churn_rate, ai_signature_score, avg_commit_size, commit_burst_count, data_source)
             VALUES ('s-recent', ?, '2025-06-15', 5, 100, 20, 3, 0, 0, 0, NULL, 0, 0, 30, 0, 'github')`,
        ).run(devId);

        const backfill = {since: '2024-01-01T00:00:00.000Z', until: '2024-07-01T00:00:00.000Z'};
        await runBackfill(backfill, [makeProviderCommit('alice', '2024-03-10T10:00:00Z', 'sha-old')]);

        // The older window produced its own day's snapshot…
        const oldSnap = db
            .prepare(`SELECT commits FROM git_snapshots WHERE developer_id = ? AND date = '2024-03-10'`)
            .get(devId) as {commits: number} | undefined;
        expect(oldSnap?.commits).toBe(1);
        // …and the pre-existing recent snapshot is left exactly as it was.
        const recent = db
            .prepare(`SELECT commits FROM git_snapshots WHERE developer_id = ? AND date = '2025-06-15'`)
            .get(devId) as {commits: number};
        expect(recent.commits).toBe(5);
    });

    // TST-1 / SO-4: the commit slice is disjoint, but PRs are re-fetched by `since`
    // only (no `until`), so a backfill re-delivers already-counted recent PRs. The
    // feature's no-double-count claim rests entirely on remergeStoredSnapshot folding
    // PR counts via max(). Drive that vector directly: a backfill that re-delivers a
    // recent, already-counted PR must NOT inflate the recent row's prs_opened.
    it('re-delivered recent PRs do not double-count on backfill (max()-merge)', async () => {
        const devId = seedDev(db, 'alice');
        // makeProviderPR attributes prs_opened→createdAt (2024-01-15) and
        // prs_merged→mergedAt (2024-01-16), so seed BOTH day-rows as if the first
        // sync already counted them — each on the row the re-delivery lands on, so
        // both assertions are discriminating (additive would push either to 2).
        db.prepare(
            `INSERT INTO git_snapshots
             (id, developer_id, date, commits, lines_added, lines_removed, files_changed,
              prs_opened, prs_merged, review_comments_given, avg_time_to_merge_hours,
              code_churn_rate, ai_signature_score, avg_commit_size, commit_burst_count, data_source)
             VALUES ('s-pr-open', ?, '2024-01-15', 0, 0, 0, 0, 1, 0, 0, NULL, 0, 0, 0, 0, 'github')`,
        ).run(devId);
        db.prepare(
            `INSERT INTO git_snapshots
             (id, developer_id, date, commits, lines_added, lines_removed, files_changed,
              prs_opened, prs_merged, review_comments_given, avg_time_to_merge_hours,
              code_churn_rate, ai_signature_score, avg_commit_size, commit_burst_count, data_source)
             VALUES ('s-pr-merge', ?, '2024-01-16', 0, 0, 0, 0, 0, 1, 0, 24, 0, 0, 0, 0, 'github')`,
        ).run(devId);

        // Backfill an OLDER slice; getPullRequests (fetched by `since` only) re-delivers
        // the same recent merged PR dated 2024-01-15/16.
        const createGitProvider = await getCreateGitProvider();
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                getCommits: vi.fn().mockResolvedValue([]),
                getPullRequests: vi.fn().mockResolvedValue([makeProviderPR('alice')]),
            }),
        );
        await new GitSync({enabled: false}).syncProviders(db, [CONFIG], undefined, {
            backfill: {since: '2023-07-01T00:00:00.000Z', until: '2024-01-01T00:00:00.000Z'},
        });

        // max()-merge keeps each recent row at 1 — not 2 — despite the re-delivery.
        const opened = db
            .prepare(`SELECT prs_opened FROM git_snapshots WHERE developer_id = ? AND date = '2024-01-15'`)
            .get(devId) as {prs_opened: number};
        const merged = db
            .prepare(`SELECT prs_merged FROM git_snapshots WHERE developer_id = ? AND date = '2024-01-16'`)
            .get(devId) as {prs_merged: number};
        expect(opened.prs_opened).toBe(1);
        expect(merged.prs_merged).toBe(1);
    });
});

// The two atomicity paths #233 set out to close. Both are enforced by #231's design
// (a provider whose commit fetch is incomplete is skipped whole; every cursor/watermark
// advance is a deferred closure applied INSIDE the snapshot transaction) — these lock
// that in from the BACKFILL direction specifically, where the failure mode is not a
// re-fetch but a permanently orphaned older slice: the absolute-months overlap guard
// turns the admin's retry into a 409 no-op, so a watermark lowered over data that was
// never written can never be recovered through the UI.
describe('GitSync.syncProviders — backfill atomicity (#233)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        vi.resetAllMocks();
    });

    afterEach(() => {
        db.close();
        vi.restoreAllMocks();
    });

    const CONFIG: GitProviderConfig = {
        type: 'github',
        org: 'test-org',
        auth: {type: 'token', api_token: 'test-token'},
    };
    const EARLIEST_KEY = 'git_earliest_sync:github:test-org';
    const BACKFILL = {since: '2024-01-01T00:00:00.000Z', until: '2024-07-01T00:00:00.000Z'};

    const readState = (key: string): string | undefined =>
        (db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
            | {value: string}
            | undefined)?.value;
    const countSnapshots = (devId: string): number =>
        (db
            .prepare('SELECT COUNT(*) AS n FROM git_snapshots WHERE developer_id = ?')
            .get(devId) as {n: number}).n;

    it('does NOT lower the watermark — or write ANY snapshot — when a repo commit fetch fails', async () => {
        // Positive control: repo1 succeeds and DOES produce commits, so a passing
        // assertion below can only mean the run discarded real, fetched data.
        const devId = seedDev(db, 'alice');
        const createGitProvider = await getCreateGitProvider();
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1'), makeRepo('repo2')]),
                getCommits: vi.fn(async (repo: string) => {
                    if (repo === 'repo2') throw new Error('boom: 500 from provider');
                    return [makeProviderCommit('alice', '2024-03-10T10:00:00Z', 'sha-old')];
                }),
            }),
        );

        const result = await new GitSync({enabled: false}).syncProviders(db, [CONFIG], undefined, {
            backfill: BACKFILL,
        });

        // The watermark must NOT move: repo2's [since, until] slice was never covered,
        // and the overlap guard would reject the retry that should re-cover it.
        expect(readState(EARLIEST_KEY)).toBeUndefined();
        // repo1's fetched commits are discarded rather than half-written: they are
        // ADDITIVE, so persisting them now and re-fetching the same slice on retry
        // would double-count. Whole-window re-cover is the only gap-free option.
        expect(countSnapshots(devId)).toBe(0);
        expect(result.snapshotsWritten).toBe(0);
        // …and the failure is loud, not a silent skip.
        expect(result.errors.some((e) => e.includes('repo2') && e.includes('boom'))).toBe(true);
    });

    it('does NOT lower the watermark when the snapshot write throws (single transaction)', async () => {
        seedDev(db, 'alice');
        const createGitProvider = await getCreateGitProvider();
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                getCommits: vi
                    .fn()
                    .mockResolvedValue([makeProviderCommit('alice', '2024-03-10T10:00:00Z', 'sha-old')]),
            }),
        );
        // Break the snapshot write at the storage layer. This is the exact hazard the
        // issue named: a watermark written BEFORE the snapshot tx would already be
        // lowered here, marking the older slice "synced" while holding nothing.
        db.exec('DROP TABLE git_snapshots');

        const result = await new GitSync({enabled: false}).syncProviders(db, [CONFIG], undefined, {
            backfill: BACKFILL,
        });

        // Watermark not lowered: the slice was never persisted, so the next run must be
        // free to re-cover it rather than find the edge already marked "synced".
        expect(readState(EARLIEST_KEY)).toBeUndefined();
        expect(result.snapshotsWritten).toBe(0);
        expect(result.errors.some((e) => e.includes('transaction rolled back'))).toBe(true);
    });

    it('rolls back snapshots ALREADY written when a later statement in the tx fails', async () => {
        // The test above breaks the FIRST statement, so it proves the watermark is not
        // written ahead of the tx — but it can't prove the tx envelope itself holds:
        // nothing had been written yet when it threw. Fail a LATER statement instead
        // (snapshots succeed, then upsertPRRecord hits a missing table) so the only way
        // the assertions below can pass is if the earlier snapshot writes were actually
        // rolled back with the watermark. This is the transaction shape's real property.
        const devId = seedDev(db, 'alice');
        const createGitProvider = await getCreateGitProvider();
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                getCommits: vi
                    .fn()
                    .mockResolvedValue([makeProviderCommit('alice', '2024-03-10T10:00:00Z', 'sha-old')]),
                // A PR is required for the run to reach upsertPRRecord at all.
                getPullRequests: vi.fn().mockResolvedValue([makeProviderPR('alice')]),
            }),
        );
        db.exec('DROP TABLE pr_records');

        const result = await new GitSync({enabled: false}).syncProviders(db, [CONFIG], undefined, {
            backfill: BACKFILL,
        });

        // Snapshots were written inside the tx before the failure — they must be gone.
        expect(countSnapshots(devId)).toBe(0);
        expect(readState(EARLIEST_KEY)).toBeUndefined();
        expect(result.snapshotsWritten).toBe(0);
        expect(result.errors.some((e) => e.includes('transaction rolled back'))).toBe(true);
    });

    it('lowers the watermark when every repo succeeds (control — the guard is not vacuous)', async () => {
        // Without this, both assertions above would pass on a build that never lowers
        // the watermark at all.
        const devId = seedDev(db, 'alice');
        const createGitProvider = await getCreateGitProvider();
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1'), makeRepo('repo2')]),
                getCommits: vi
                    .fn()
                    .mockResolvedValue([makeProviderCommit('alice', '2024-03-10T10:00:00Z', 'sha-old')]),
            }),
        );

        await new GitSync({enabled: false}).syncProviders(db, [CONFIG], undefined, {
            backfill: BACKFILL,
        });

        expect(readState(EARLIEST_KEY)).toBe(BACKFILL.since);
        expect(countSnapshots(devId)).toBe(1);
    });
});

describe('GitSync.syncProviders — first-sync earliest-watermark recording (#229)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        vi.resetAllMocks();
    });

    afterEach(() => {
        db.close();
        vi.restoreAllMocks();
    });

    const CONFIG: GitProviderConfig = {
        type: 'github',
        org: 'test-org',
        auth: {type: 'token', api_token: 'test-token'},
    };
    const FORWARD_KEY = 'git_last_sync:github:test-org';
    const EARLIEST_KEY = 'git_earliest_sync:github:test-org';

    function readState(key: string): string | undefined {
        return (db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
            | {value: string}
            | undefined)?.value;
    }

    async function firstSync(options?: {firstSyncWindowMonths?: number}): Promise<string> {
        const createGitProvider = await getCreateGitProvider();
        const getCommits = vi.fn().mockResolvedValue([]);
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                getCommits,
            }),
        );
        await new GitSync({enabled: false}).syncProviders(db, [CONFIG], undefined, options);
        return getCommits.mock.calls[0][1] as string;
    }

    it('records the earliest watermark = the clamped window start on a first sync', async () => {
        // This is what makes the backfill default EXACT rather than a lazy guess:
        // the watermark must equal the `since` the first sync actually reached.
        const since = await firstSync({firstSyncWindowMonths: 6});
        expect(since).not.toBe('');
        expect(readState(EARLIEST_KEY)).toBe(since);
    });

    it('records the EPOCH sentinel when the first sync walks all history ("")', async () => {
        // Scheduled/CLI path passes no window → since === '' (walk all). The floor is
        // the beginning of time, stored as the epoch sentinel so a later backfill's
        // overlap guard rejects (nothing older exists) instead of re-covering.
        const since = await firstSync(undefined);
        expect(since).toBe('');
        expect(readState(EARLIEST_KEY)).toBe(EARLIEST_SYNC_EPOCH);
        // And the guard sees "everything already synced" for any real target.
        const target = '2020-01-01T00:00:00.000Z';
        const earliest = getEarliestSyncedWatermark(db, 'github', 'test-org', '2026-03-15T12:00:00.000Z');
        expect(earliest.kind).toBe('exact');
        expect(earliest.kind === 'exact' && target >= earliest.watermark).toBe(true);
    });

    it('does NOT re-write the watermark on an incremental (non-first) sync', async () => {
        // Seed a forward cursor so the next run is incremental, and a watermark that
        // must survive untouched.
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
            FORWARD_KEY,
            '2026-06-01T00:00:00.000Z',
        );
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
            EARLIEST_KEY,
            '2024-01-01T00:00:00.000Z',
        );
        await firstSync({firstSyncWindowMonths: 6});
        // The incremental run advances the forward cursor but leaves the watermark.
        expect(readState(EARLIEST_KEY)).toBe('2024-01-01T00:00:00.000Z');
    });

    it('does NOT raise a lower watermark a prior backfill wrote (first-sync clobber guard)', async () => {
        // Route-reachable ordering (the UI hides the control pre-first-sync, but the
        // backfill route does not require a cursor): a direct-API "sync older history"
        // lowers the earliest watermark WITHOUT minting a forward cursor. The later
        // FIRST forward sync then has a non-null firstSyncFloor (≈ now − window, which
        // is NEWER than the backfilled floor) — it must not raise the watermark and
        // reopen the double-count the guard exists to prevent.
        const backfilled = '2020-01-01T00:00:00.000Z';
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(EARLIEST_KEY, backfilled);
        // No FORWARD_KEY → this is a genuine first forward sync.
        await firstSync({firstSyncWindowMonths: 6});
        // Watermark stays at the older backfilled floor, not raised to now − 6mo.
        expect(readState(EARLIEST_KEY)).toBe(backfilled);
        // The first sync did mint the forward cursor.
        expect(readState(FORWARD_KEY)).toBeDefined();
    });

    it('advances NEITHER the watermark NOR the forward cursor when the first sync fails to list repos (#231)', async () => {
        // listRepos throws before any repo is processed — nothing imported, so the
        // provider's fetch is incomplete: neither the synced-back-to floor NOR the
        // forward cursor may advance, or the un-covered window would be silently
        // skipped next run (#231). Both stay unset so the whole window retries.
        const createGitProvider = await getCreateGitProvider();
        createGitProvider.mockReturnValue(
            makeMockProvider({
                listRepos: vi.fn().mockRejectedValue(new Error('boom')),
            }),
        );
        await new GitSync({enabled: false}).syncProviders(db, [CONFIG], undefined, {
            firstSyncWindowMonths: 6,
        });
        expect(readState(EARLIEST_KEY)).toBeUndefined();
        // Forward cursor must NOT advance on a failed listRepos (was the #231 bug).
        expect(readState(FORWARD_KEY)).toBeUndefined();
    });

    // #231: the cursor advance must be ATOMIC with, and CONDITIONAL on, the data
    // write. A cursor that moves past a window whose snapshots were never persisted is
    // a silent, permanent gap (commit counts are additive → never re-fetched, never
    // safely reset). These drive the two failure vectors the issue names.
    describe('atomic cursor advance (#231)', () => {
        it('does NOT advance the forward cursor and writes nothing when the data-write transaction fails', async () => {
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    getCommits: vi.fn().mockResolvedValue([makeProviderCommit('alice')]),
                }),
            );

            // Force the write transaction to throw: drop the target table so the
            // snapshot upsert (inside the tx) fails and the whole tx — cursor advance
            // included — rolls back. This models any DB-level write failure.
            db.exec('DROP TABLE git_snapshots');

            const result = await new GitSync({enabled: false}).syncProviders(db, [CONFIG]);

            // Hard failure surfaced (not swallowed into a "successful" result)…
            expect(result.errors.some((e) => /transaction rolled back/.test(e))).toBe(true);
            // …no phantom write count…
            expect(result.snapshotsWritten).toBe(0);
            // …and CRUCIALLY the cursor did not move, so the window re-fetches next run.
            expect(readState(FORWARD_KEY)).toBeUndefined();
        });

        it('does NOT advance the cursor and persists NO snapshots when a single repo commit fetch throws', async () => {
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('bad-repo'), makeRepo('good-repo')]),
                    getCommits: vi.fn().mockImplementation(async (repo: string) => {
                        if (repo === 'bad-repo') throw new Error('GitHub API error 500');
                        return [makeProviderCommit('alice')];
                    }),
                }),
            );

            const result = await new GitSync({enabled: false}).syncProviders(db, [CONFIG]);

            // The per-repo failure is surfaced loudly…
            expect(result.errors.some((e) => /bad-repo.*Failed to fetch commits/.test(e))).toBe(true);
            // …the provider is held all-or-nothing: even the GOOD repo's commit is NOT
            // written (writing it now + re-fetching the whole window next run would
            // double-count the additive commit)…
            expect(countSnapshots(db)).toBe(0);
            expect(result.snapshotsWritten).toBe(0);
            // …and the cursor stays put so the whole window is re-covered next run.
            expect(readState(FORWARD_KEY)).toBeUndefined();
        });

        it('DOES advance the cursor and persist snapshots on a fully-successful sync (positive control)', async () => {
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    getCommits: vi.fn().mockResolvedValue([makeProviderCommit('alice')]),
                }),
            );

            const result = await new GitSync({enabled: false}).syncProviders(db, [CONFIG]);

            expect(result.snapshotsWritten).toBeGreaterThan(0);
            expect(countSnapshots(db)).toBeGreaterThan(0);
            // The cursor advanced to the run's `now`, committed atomically with the data.
            expect(readState(FORWARD_KEY)).toBe(result.lastSyncTime);
        });

        it('does NOT lower the earliest watermark when a backfill repo commit fetch throws', async () => {
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    getCommits: vi.fn().mockRejectedValue(new Error('GitHub API error 500')),
                }),
            );

            const backfill = {since: '2024-01-01T00:00:00.000Z', until: '2024-07-01T00:00:00.000Z'};
            await new GitSync({enabled: false}).syncProviders(db, [CONFIG], undefined, {backfill});

            // The older slice was not fully fetched, so the watermark must NOT drop to
            // `since` — else the un-fetched span below the old watermark is lost.
            expect(readState(EARLIEST_KEY)).toBeUndefined();
        });

        it('re-covers the window on the NEXT run after a held cursor — no gap AND no double-count (#231 acceptance)', async () => {
            // The headline acceptance criterion: a run whose fetch was incomplete
            // persists nothing and holds the cursor, so the NEXT (successful) run
            // re-fetches the whole [since, now] window and lands the data exactly once.
            // This is the end-to-end proof — the hold is worthless if recovery doesn't
            // actually fill the gap, and dangerous if it double-counts the additive commit.
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();

            // Run 1: bad-repo throws, good-repo returns alice's commit c-good. Provider
            // incomplete → NOTHING written, cursor held.
            createGitProvider.mockReturnValueOnce(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('bad-repo'), makeRepo('good-repo')]),
                    getCommits: vi.fn().mockImplementation(async (repo: string) => {
                        if (repo === 'bad-repo') throw new Error('GitHub API error 500');
                        return [makeProviderCommit('alice', '2024-01-15T10:00:00Z', 'c-good')];
                    }),
                }),
            );
            await new GitSync({enabled: false}).syncProviders(db, [CONFIG]);
            expect(countSnapshots(db)).toBe(0);
            expect(readState(FORWARD_KEY)).toBeUndefined();

            // Run 2: both repos succeed. Because the cursor was held, this run re-fetches
            // the WHOLE window — both repos' commits (c-good re-delivered by good-repo,
            // plus c-bad now available from bad-repo) for alice on 01-15.
            createGitProvider.mockReturnValueOnce(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('bad-repo'), makeRepo('good-repo')]),
                    getCommits: vi.fn().mockImplementation(async (repo: string) => {
                        if (repo === 'bad-repo') {
                            return [makeProviderCommit('alice', '2024-01-15T11:00:00Z', 'c-bad')];
                        }
                        return [makeProviderCommit('alice', '2024-01-15T10:00:00Z', 'c-good')];
                    }),
                }),
            );
            await new GitSync({enabled: false}).syncProviders(db, [CONFIG]);

            // Exactly the two distinct commits, once each: 3 would mean run 1's partial
            // c-good was persisted and additively re-counted (the double-count the hold
            // exists to prevent); <2 would mean a gap. Neither.
            const row = db
                .prepare(`SELECT commits FROM git_snapshots WHERE date = '2024-01-15'`)
                .get() as {commits: number} | undefined;
            expect(row?.commits).toBe(2);
            // And the cursor now advanced, since run 2 fully covered the window.
            expect(readState(FORWARD_KEY)).toBeDefined();
        });

        it('isolates providers: a complete sibling still writes + advances while an incomplete provider is held', async () => {
            // The all-or-nothing skip is per-provider inside a loop feeding one shared
            // write transaction. A healthy provider must NOT be poisoned by a sibling's
            // incomplete fetch — it still persists its data and advances its own cursor,
            // while the incomplete sibling writes nothing and holds its cursor.
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();

            const githubProvider = makeMockProvider({
                name: 'github',
                listRepos: vi.fn().mockResolvedValue([makeRepo('gh-repo')]),
                getCommits: vi.fn().mockResolvedValue([makeProviderCommit('alice', '2024-01-15T10:00:00Z', 'gh-1')]),
            });
            const bitbucketProvider = makeMockProvider({
                name: 'bitbucket',
                listRepos: vi.fn().mockResolvedValue([makeRepo('bb-repo')]),
                getCommits: vi.fn().mockRejectedValue(new Error('Bitbucket API error 500')),
            });
            createGitProvider
                .mockReturnValueOnce(githubProvider)
                .mockReturnValueOnce(bitbucketProvider);

            const result = await new GitSync({enabled: true}).syncProviders(db, [
                {type: 'github', org: 'myorg', auth: {type: 'token', api_token: 'token'}},
                {type: 'bitbucket', workspace: 'myws', auth: {type: 'app_password', username: 'u', app_password: 'p'}},
            ]);

            // The healthy GitHub provider committed its data and advanced its cursor…
            expect(result.snapshotsWritten).toBeGreaterThan(0);
            expect(countSnapshots(db)).toBe(1);
            expect(readState('git_last_sync:github:myorg')).toBe(result.lastSyncTime);
            // …while the incomplete Bitbucket provider wrote nothing and held its cursor.
            expect(readState('git_last_sync:bitbucket:myws')).toBeUndefined();
            expect(result.errors.some((e) => /bb-repo.*Failed to fetch commits/.test(e))).toBe(true);
        });
    });
});

// #235 — the operational follow-up to #231. #231 holds a broken provider's cursor
// (correct: a silent gap is worse than a loud retry), but that left two untracked
// problems: the stall is INVISIBLE (a healthy sibling still writes, so the run
// "succeeds" and looks like a transient hiccup), and the held re-fetch window GROWS
// without bound. These lock in the counter that makes the stall queryable and the
// cap that bounds the catch-up.
describe('GitSync — stalled-provider detection (#235)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        vi.resetAllMocks();
    });

    afterEach(() => {
        // Unconditional: a test that froze the clock must not leak it into a sibling
        // (vitest keeps fake timers installed across tests otherwise). Safe when no
        // test in this block installed them.
        vi.useRealTimers();
        db.close();
        vi.restoreAllMocks();
    });

    const CONFIG: GitProviderConfig = {
        type: 'github',
        org: 'test-org',
        auth: {type: 'token', api_token: 'test-token'},
    };
    const FORWARD_KEY = 'git_last_sync:github:test-org';
    const STALL_KEY = 'git_stall:github:test-org';

    const readState = (key: string): string | undefined =>
        (db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
            | {value: string}
            | undefined)?.value;
    const writeState = (key: string, value: string): void => {
        db.prepare(
            'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        ).run(key, value);
    };

    /** A provider whose only repo always fails its commit fetch — a permanent stall. */
    const brokenProvider = (): GitProvider =>
        makeMockProvider({
            listRepos: vi.fn().mockResolvedValue([makeRepo('broken-repo')]),
            getCommits: vi.fn().mockRejectedValue(new Error('GitHub API error 500')),
        });

    /** A provider whose repos all succeed. */
    const healthyProvider = (): GitProvider =>
        makeMockProvider({
            listRepos: vi.fn().mockResolvedValue([makeRepo('good-repo')]),
            getCommits: vi.fn().mockResolvedValue([]),
        });

    describe('stall counter', () => {
        it('opens a streak at 1 on the first held run, stamped with that run instant', async () => {
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(brokenProvider());

            const result = await new GitSync({enabled: false}).syncProviders(db, [CONFIG]);

            // Precondition: this run really was held (else the assertion below is vacuous).
            expect(readState(FORWARD_KEY)).toBeUndefined();
            expect(getProviderStall(db, 'github', 'test-org')).toEqual({
                runs: 1,
                since: result.lastSyncTime,
            });
        });

        it('extends the streak across consecutive held runs, PRESERVING the original since', async () => {
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(brokenProvider());
            const sync = new GitSync({enabled: false});

            // The clock is frozen and stepped explicitly: on the real clock three
            // back-to-back runs can share a millisecond, which makes `first` and `third`
            // identical and silently turns the "does not creep" assertion below into a
            // tautology that passes for the wrong reason (and fails at random when the
            // runs straddle a tick). Distinct instants by construction.
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-07-01T00:00:00.000Z'));
            const first = await sync.syncProviders(db, [CONFIG]);
            vi.setSystemTime(new Date('2026-07-02T00:00:00.000Z'));
            await sync.syncProviders(db, [CONFIG]);
            vi.setSystemTime(new Date('2026-07-03T00:00:00.000Z'));
            const third = await sync.syncProviders(db, [CONFIG]);

            const stall = getProviderStall(db, 'github', 'test-org');
            expect(stall?.runs).toBe(3);
            // "Stalled SINCE" must anchor to the streak's start, not creep forward to the
            // latest run — a creeping `since` would report an ancient stall as brand new.
            expect(stall?.since).toBe(first.lastSyncTime);
            expect(first.lastSyncTime).not.toBe(third.lastSyncTime);
            expect(stall?.since).not.toBe(third.lastSyncTime);
        });

        it('clears the streak the moment a run completes the window', async () => {
            const createGitProvider = await getCreateGitProvider();
            createGitProvider
                .mockReturnValueOnce(brokenProvider())
                .mockReturnValueOnce(brokenProvider())
                .mockReturnValueOnce(healthyProvider());
            const sync = new GitSync({enabled: false});

            await sync.syncProviders(db, [CONFIG]);
            await sync.syncProviders(db, [CONFIG]);
            expect(getProviderStall(db, 'github', 'test-org')?.runs).toBe(2);

            await sync.syncProviders(db, [CONFIG]);

            expect(getProviderStall(db, 'github', 'test-org')).toBeNull();
            expect(readState(STALL_KEY)).toBeUndefined();
            // Positive control: the recovery run really did advance the cursor.
            expect(readState(FORWARD_KEY)).toBeDefined();
        });

        it('restarts the streak after a recovery rather than resuming the old count', async () => {
            const createGitProvider = await getCreateGitProvider();
            createGitProvider
                .mockReturnValueOnce(brokenProvider())
                .mockReturnValueOnce(brokenProvider())
                .mockReturnValueOnce(healthyProvider())
                .mockReturnValueOnce(brokenProvider());
            const sync = new GitSync({enabled: false});

            await sync.syncProviders(db, [CONFIG]);
            await sync.syncProviders(db, [CONFIG]);
            await sync.syncProviders(db, [CONFIG]);
            const fourth = await sync.syncProviders(db, [CONFIG]);

            // CONSECUTIVE, not cumulative: the recovery reset the count, so the new
            // failure is run 1 of a new streak — not run 3 of the old one.
            expect(getProviderStall(db, 'github', 'test-org')).toEqual({
                runs: 1,
                since: fourth.lastSyncTime,
            });
        });

        it('counts a listRepos failure, not just a per-repo commit failure', async () => {
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockRejectedValue(new Error('GitHub API error 403')),
                }),
            );

            await new GitSync({enabled: false}).syncProviders(db, [CONFIG]);

            // fetchProviderData early-returns on this path; a held cursor there must
            // still reach the same counter.
            expect(getProviderStall(db, 'github', 'test-org')?.runs).toBe(1);
        });

        it('tracks each provider independently — a healthy sibling is never marked stalled', async () => {
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            createGitProvider
                .mockReturnValueOnce(
                    makeMockProvider({
                        name: 'github',
                        listRepos: vi.fn().mockResolvedValue([makeRepo('gh-repo')]),
                        getCommits: vi.fn().mockResolvedValue([makeProviderCommit('alice')]),
                    }),
                )
                .mockReturnValueOnce(
                    makeMockProvider({
                        name: 'bitbucket',
                        listRepos: vi.fn().mockResolvedValue([makeRepo('bb-repo')]),
                        getCommits: vi.fn().mockRejectedValue(new Error('Bitbucket API error 500')),
                    }),
                );

            const result = await new GitSync({enabled: true}).syncProviders(db, [
                {type: 'github', org: 'myorg', auth: {type: 'token', api_token: 'token'}},
                {type: 'bitbucket', workspace: 'myws', auth: {type: 'app_password', username: 'u', app_password: 'p'}},
            ]);

            // This is the exact shape the counter exists to disambiguate: the run wrote
            // real data and looks healthy, yet one provider imported nothing at all.
            expect(result.snapshotsWritten).toBeGreaterThan(0);
            expect(getProviderStall(db, 'github', 'myorg')).toBeNull();
            expect(getProviderStall(db, 'bitbucket', 'myws')?.runs).toBe(1);
        });

        it('does NOT count a failed BACKFILL run — a backfill never advances the forward cursor', async () => {
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(brokenProvider());

            await new GitSync({enabled: false}).syncProviders(db, [CONFIG], undefined, {
                backfill: {since: '2024-01-01T00:00:00.000Z', until: '2024-07-01T00:00:00.000Z'},
            });

            // A backfill walks OLDER history and leaves the forward cursor alone, so its
            // failure is not evidence the cursor is stuck. Counting it would raise a
            // stall alert against a provider syncing perfectly.
            expect(getProviderStall(db, 'github', 'test-org')).toBeNull();
        });

        it('does NOT let a successful BACKFILL clear a real forward stall', async () => {
            const createGitProvider = await getCreateGitProvider();
            createGitProvider
                .mockReturnValueOnce(brokenProvider())
                .mockReturnValueOnce(brokenProvider())
                .mockReturnValueOnce(brokenProvider())
                .mockReturnValueOnce(healthyProvider());
            const sync = new GitSync({enabled: false});

            await sync.syncProviders(db, [CONFIG]);
            await sync.syncProviders(db, [CONFIG]);
            await sync.syncProviders(db, [CONFIG]);
            expect(getProviderStall(db, 'github', 'test-org')?.runs).toBe(3);

            await sync.syncProviders(db, [CONFIG], undefined, {
                backfill: {since: '2024-01-01T00:00:00.000Z', until: '2024-07-01T00:00:00.000Z'},
            });

            // The forward cursor is still stuck — a backfill succeeding says nothing
            // about that, so it must not silence a live alert.
            expect(getProviderStall(db, 'github', 'test-org')?.runs).toBe(3);
        });

        it('records NO stall when the write transaction rolls back', async () => {
            // A broken provider alone writes no snapshots, so the tx would never touch
            // git_snapshots and never throw. Pair it with a HEALTHY provider that does
            // write: that write is what trips the dropped table and rolls back the whole
            // tx — including the broken sibling's stall update.
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            createGitProvider
                .mockReturnValueOnce(
                    makeMockProvider({
                        name: 'github',
                        listRepos: vi.fn().mockResolvedValue([makeRepo('gh-repo')]),
                        getCommits: vi.fn().mockResolvedValue([makeProviderCommit('alice')]),
                    }),
                )
                .mockReturnValueOnce(
                    makeMockProvider({
                        name: 'bitbucket',
                        listRepos: vi.fn().mockResolvedValue([makeRepo('bb-repo')]),
                        getCommits: vi.fn().mockRejectedValue(new Error('Bitbucket API error 500')),
                    }),
                );
            db.exec('DROP TABLE git_snapshots');

            const result = await new GitSync({enabled: true}).syncProviders(db, [
                {type: 'github', org: 'myorg', auth: {type: 'token', api_token: 'token'}},
                {type: 'bitbucket', workspace: 'myws', auth: {type: 'app_password', username: 'u', app_password: 'p'}},
            ]);

            expect(result.errors.some((e) => /transaction rolled back/.test(e))).toBe(true);
            // The counter moves with the cursor on the same all-or-nothing terms: a run
            // that persisted nothing must not persist a stall either. The next run
            // re-covers the window and accounts for itself.
            expect(readState('git_stall:bitbucket:myws')).toBeUndefined();
            expect(readState('git_last_sync:github:myorg')).toBeUndefined();
        });

        it('does NOT clear an existing streak when the write transaction rolls back', async () => {
            // The mirror of the test above, and the arm that would silently regress: if
            // clearProviderStall were ever hoisted out of the deferred stallUpdates and
            // called eagerly in the fetch loop, every other test here still passes (the
            // record-direction rollback test uses a broken provider that never clears,
            // and every clear test commits successfully). A rolled-back run wiping a live
            // streak would reset the alert to zero and hide a permanent stall for good.
            seedDev(db, 'alice');
            writeState(STALL_KEY, JSON.stringify({runs: 5, since: '2026-07-01T00:00:00.000Z'}));

            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    getCommits: vi.fn().mockResolvedValue([makeProviderCommit('alice')]),
                }),
            );
            // This provider's fetch is COMPLETE, so the run wants to clear the streak —
            // but the snapshot write it commits with will fail.
            db.exec('DROP TABLE git_snapshots');

            const result = await new GitSync({enabled: false}).syncProviders(db, [CONFIG]);

            expect(result.errors.some((e) => /transaction rolled back/.test(e))).toBe(true);
            // Nothing persisted, so the streak stands — the provider has still imported
            // nothing, and the cursor did not move either.
            expect(getProviderStall(db, 'github', 'test-org')).toEqual({
                runs: 5,
                since: '2026-07-01T00:00:00.000Z',
            });
            expect(readState(FORWARD_KEY)).toBeUndefined();
        });

        it('treats a corrupt stall row as no streak and self-heals on the next held run', async () => {
            writeState(STALL_KEY, 'not json at all');
            expect(getProviderStall(db, 'github', 'test-org')).toBeNull();

            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(brokenProvider());
            const result = await new GitSync({enabled: false}).syncProviders(db, [CONFIG]);

            // Rewritten from scratch rather than incremented into NaN.
            expect(getProviderStall(db, 'github', 'test-org')).toEqual({
                runs: 1,
                since: result.lastSyncTime,
            });
        });

        it.each([
            ['non-integer runs', JSON.stringify({runs: 2.5, since: '2026-01-01T00:00:00.000Z'})],
            ['zero runs', JSON.stringify({runs: 0, since: '2026-01-01T00:00:00.000Z'})],
            ['negative runs', JSON.stringify({runs: -3, since: '2026-01-01T00:00:00.000Z'})],
            ['non-numeric runs', JSON.stringify({runs: '4', since: '2026-01-01T00:00:00.000Z'})],
            ['missing since', JSON.stringify({runs: 4})],
            ['unparseable since', JSON.stringify({runs: 4, since: 'yesterday-ish'})],
            ['a JSON array', JSON.stringify([1, 2])],
            ['a JSON scalar', JSON.stringify(7)],
            ['JSON null', 'null'],
            ['an empty value', ''],
        ])('range-validates the stored row: %s reads as no streak', (_label, stored) => {
            writeState(STALL_KEY, stored);
            // sync_state.value is unconstrained TEXT, so every field is validated on read
            // rather than cast — a corrupt row must never surface as a stall of NaN runs.
            expect(getProviderStall(db, 'github', 'test-org')).toBeNull();
        });
    });

    // #248: the three former readers (loadStalledProviders, loadLaggingProviders,
    // countNeverSyncedProviders) are one classification over the same two row sets.
    // Every configured provider lands in exactly one of four disjoint states, or in
    // none of them (a held sub-threshold streak / garbage cursor is neither current nor
    // reportable) — the positive `current` count is what lets doctor stop inferring
    // health from two readers' emptiness.
    describe('loadGitSyncHealth', () => {
        const DAY_MS = 86_400_000;
        const NOW = '2026-07-15T00:00:00.000Z';
        const at = (daysBefore: number): string =>
            new Date(Date.parse(NOW) - daysBefore * DAY_MS).toISOString();

        describe('stalled', () => {
            it('reports nothing below the alert threshold, and the provider once it is reached', async () => {
                const createGitProvider = await getCreateGitProvider();
                createGitProvider.mockReturnValue(brokenProvider());
                const sync = new GitSync({enabled: false});

                for (let run = 1; run < GIT_STALL_ALERT_RUNS; run++) {
                    await sync.syncProviders(db, [CONFIG]);
                    // Below the threshold a held run is the ordinary self-healing case —
                    // alerting here would train the reader to ignore the signal.
                    expect(loadGitSyncHealth(db, [CONFIG], NOW).stalled).toEqual([]);
                }
                // Precondition for the boundary: we are exactly one run short.
                expect(getProviderStall(db, 'github', 'test-org')?.runs).toBe(
                    GIT_STALL_ALERT_RUNS - 1,
                );

                await sync.syncProviders(db, [CONFIG]);

                expect(loadGitSyncHealth(db, [CONFIG], NOW).stalled).toEqual([
                    {
                        type: 'github',
                        identifier: 'test-org',
                        runs: GIT_STALL_ALERT_RUNS,
                        since: expect.any(String),
                    },
                ]);
            });

            it('ignores a stall row orphaned by a provider that is no longer configured', () => {
                writeState(
                    'git_stall:github:deleted-org',
                    JSON.stringify({runs: 99, since: '2026-01-01T00:00:00.000Z'}),
                );

                // Filtering to the CONFIGURED set is what stops a row left behind by a
                // deleted/renamed provider being reported forever against a dead target.
                expect(loadGitSyncHealth(db, [CONFIG], NOW).stalled).toEqual([]);
            });

            it('returns every stalled provider, in the provider-config order', () => {
                const stalled = JSON.stringify({runs: 5, since: '2026-01-01T00:00:00.000Z'});
                writeState('git_stall:github:org-b', stalled);
                writeState('git_stall:bitbucket:ws-a', stalled);

                const configs: GitProviderConfig[] = [
                    {type: 'bitbucket', workspace: 'ws-a', auth: {type: 'app_password', username: 'u', app_password: 'p'}},
                    {type: 'github', org: 'org-b', auth: {type: 'token', api_token: 't'}},
                    {type: 'github', org: 'healthy-org', auth: {type: 'token', api_token: 't'}},
                ];

                // >= 2 stalled providers, so a single-item happy path can't hide an
                // ordering or accumulation bug. Order follows providerConfigs.
                expect(
                    loadGitSyncHealth(db, configs, NOW).stalled.map(
                        (s) => `${s.type}:${s.identifier}`,
                    ),
                ).toEqual(['bitbucket:ws-a', 'github:org-b']);
            });

            it('reports a stalled provider that has no cursor at all — the stall wins over never-synced', () => {
                writeState(STALL_KEY, JSON.stringify({runs: 4, since: '2026-01-01T00:00:00.000Z'}));

                // Every run failed from the start, so the cursor was never written, yet
                // the streak reached the alert threshold. It is the actionable signal, so
                // it is reported as stalled rather than counted as a pending first sync.
                const health = loadGitSyncHealth(db, [CONFIG], NOW);
                expect(health.stalled).toHaveLength(1);
                expect(health.neverSynced).toBe(0);
                expect(health.current).toBe(0);
            });

            it('returns no stalled providers when nothing is stalled', () => {
                expect(loadGitSyncHealth(db, [CONFIG], NOW).stalled).toEqual([]);
            });
        });

        // The cap CREATES this state: before it, a complete run always reached `now`, so
        // "the run completed" and "the data is current" were one statement. They are no
        // longer, and a bare "no stall → advancing" would be a false all-clear.
        describe('lagging', () => {
            it('reports a provider whose cursor is more than one cap-width behind', () => {
                writeState(FORWARD_KEY, at(170));

                expect(loadGitSyncHealth(db, [CONFIG], NOW).lagging).toEqual([
                    {type: 'github', identifier: 'test-org', cursor: at(170), daysBehind: 170},
                ]);
            });

            it('says nothing about a current provider, or one exactly at the cap boundary', () => {
                writeState(FORWARD_KEY, at(1));
                expect(loadGitSyncHealth(db, [CONFIG], NOW).lagging).toEqual([]);

                // At the cap the next run is NOT capped (catchUpUntil returns `now`), so
                // the provider will reach the present — not lagging. Same boundary.
                writeState(FORWARD_KEY, at(GIT_CATCHUP_WINDOW_MAX_DAYS));
                expect(loadGitSyncHealth(db, [CONFIG], NOW).lagging).toEqual([]);
            });

            it('excludes a provider held BELOW the stall threshold — it is not advancing', async () => {
                writeState(FORWARD_KEY, at(200));
                const createGitProvider = await getCreateGitProvider();
                createGitProvider.mockReturnValue(brokenProvider());

                await new GitSync({enabled: false}).syncProviders(db, [CONFIG]);

                // One held run: below GIT_STALL_ALERT_RUNS, so it is not a reportable
                // stall yet — but the cursor IS held, so calling it "catching up —
                // advancing" would state the exact opposite of the truth, and it cannot
                // be current either. The exclusion keys on an OPEN streak, not the
                // reporting threshold, so it falls through every bucket.
                expect(getProviderStall(db, 'github', 'test-org')?.runs).toBe(1);
                const health = loadGitSyncHealth(db, [CONFIG], NOW);
                expect(health.stalled).toEqual([]);
                expect(health.lagging).toEqual([]);
                expect(health.current).toBe(0);
                expect(health.neverSynced).toBe(0);
            });

            it('excludes a STALLED provider from lagging — the stall is the more specific signal', async () => {
                writeState(FORWARD_KEY, at(200));
                const createGitProvider = await getCreateGitProvider();
                createGitProvider.mockReturnValue(brokenProvider());
                const sync = new GitSync({enabled: false});
                for (let run = 0; run < GIT_STALL_ALERT_RUNS; run++) {
                    await sync.syncProviders(db, [CONFIG]);
                }

                // Precondition: it IS stalled, and its cursor IS far behind — so without
                // the exclusion it would be reported twice under two different headings.
                const health = loadGitSyncHealth(db, [CONFIG], NOW);
                expect(health.stalled).toHaveLength(1);
                expect(health.lagging).toEqual([]);
            });

            it('does not treat a never-synced provider as lagging', () => {
                // No cursor at all is a pending first sync, not a provider falling behind.
                const health = loadGitSyncHealth(db, [CONFIG], NOW);
                expect(health.lagging).toEqual([]);
                expect(health.neverSynced).toBe(1);
            });

            it.each([
                ['an unparseable cursor', 'not-a-date'],
                ['a future-dated cursor', '2027-01-01T00:00:00.000Z'],
            ])('is total: %s is neither lagging nor current', (_label, cursor) => {
                writeState(FORWARD_KEY, cursor);
                const health = loadGitSyncHealth(db, [CONFIG], NOW);
                expect(health.lagging).toEqual([]);
                // A garbage or skewed timestamp cannot PROVE currency — it falls through.
                expect(health.current).toBe(0);
            });

            it('reports nothing lagging and nothing current on an unparseable now', () => {
                writeState(FORWARD_KEY, at(200));
                const health = loadGitSyncHealth(db, [CONFIG], 'not-a-date');
                expect(health.lagging).toEqual([]);
                expect(health.current).toBe(0);
            });

            it('reports every lagging provider in config order, ignoring orphaned cursors', () => {
                writeState('git_last_sync:bitbucket:ws-a', at(90));
                writeState('git_last_sync:github:org-b', at(60));
                writeState('git_last_sync:github:healthy-org', at(2));
                writeState('git_last_sync:github:deleted-org', at(400));

                const configs: GitProviderConfig[] = [
                    {type: 'bitbucket', workspace: 'ws-a', auth: {type: 'app_password', username: 'u', app_password: 'p'}},
                    {type: 'github', org: 'org-b', auth: {type: 'token', api_token: 't'}},
                    {type: 'github', org: 'healthy-org', auth: {type: 'token', api_token: 't'}},
                ];

                // >= 2 lagging, so a single-item happy path can't hide an accumulation or
                // ordering bug; the un-configured deleted-org cursor must not surface. The
                // healthy-org cursor (2 days back) is counted current instead.
                const health = loadGitSyncHealth(db, configs, NOW);
                expect(health.lagging).toEqual([
                    {type: 'bitbucket', identifier: 'ws-a', cursor: at(90), daysBehind: 90},
                    {type: 'github', identifier: 'org-b', cursor: at(60), daysBehind: 60},
                ]);
                expect(health.current).toBe(1);
            });
        });

        // #248: the positive currency check — a provider is current iff it has a cursor
        // within one cap-width of now with no open streak. Counted, never inferred.
        describe('current / neverSynced', () => {
            it('counts a provider synced within one cap-width as current', () => {
                writeState(FORWARD_KEY, at(1));
                const health = loadGitSyncHealth(db, [CONFIG], NOW);
                expect(health.current).toBe(1);
                expect(health.neverSynced).toBe(0);
                expect(health.stalled).toEqual([]);
                expect(health.lagging).toEqual([]);
            });

            it('counts a provider exactly at the cap boundary as current, not lagging', () => {
                // behindMs === capMs: the next run reaches the present, so it is current.
                writeState(FORWARD_KEY, at(GIT_CATCHUP_WINDOW_MAX_DAYS));
                const health = loadGitSyncHealth(db, [CONFIG], NOW);
                expect(health.current).toBe(1);
                expect(health.lagging).toEqual([]);
            });

            it('counts a never-synced provider under neverSynced, not current', () => {
                const health = loadGitSyncHealth(db, [CONFIG], NOW);
                expect(health.neverSynced).toBe(1);
                expect(health.current).toBe(0);
            });

            it('classifies a mixed set — current, lagging, never-synced, and stalled all at once', () => {
                writeState('git_last_sync:github:fresh', at(3)); // current
                writeState('git_last_sync:github:behind', at(120)); // lagging
                writeState(
                    'git_stall:github:stuck',
                    JSON.stringify({runs: 7, since: '2026-01-01T00:00:00.000Z'}),
                ); // stalled, no cursor
                // github:pending has neither cursor nor stall → never synced.

                const configs: GitProviderConfig[] = [
                    {type: 'github', org: 'fresh', auth: {type: 'token', api_token: 't'}},
                    {type: 'github', org: 'behind', auth: {type: 'token', api_token: 't'}},
                    {type: 'github', org: 'stuck', auth: {type: 'token', api_token: 't'}},
                    {type: 'github', org: 'pending', auth: {type: 'token', api_token: 't'}},
                ];

                const health = loadGitSyncHealth(db, configs, NOW);
                expect(health.current).toBe(1);
                expect(health.lagging.map((l) => l.identifier)).toEqual(['behind']);
                expect(health.stalled.map((s) => s.identifier)).toEqual(['stuck']);
                expect(health.neverSynced).toBe(1);
            });

            it('does not count a future-dated cursor as current (clock skew is not currency)', () => {
                // Cursor ahead of now: behindMs < 0. Not lagging, not current — clamped
                // out so a skewed row can never render a false "current".
                writeState(FORWARD_KEY, at(-5));
                const health = loadGitSyncHealth(db, [CONFIG], NOW);
                expect(health.current).toBe(0);
                expect(health.lagging).toEqual([]);
            });
        });
    });

    describe('catch-up window cap', () => {
        const DAY_MS = 86_400_000;
        const CAP_MS = GIT_CATCHUP_WINDOW_MAX_DAYS * DAY_MS;

        it('returns `now` when the cursor is within the cap', () => {
            const now = '2026-07-15T00:00:00.000Z';
            const since = new Date(Date.parse(now) - 5 * DAY_MS).toISOString();
            expect(catchUpUntil(since, now)).toBe(now);
        });

        it('returns `now` exactly AT the cap boundary, and caps one ms past it', () => {
            const now = '2026-07-15T00:00:00.000Z';
            const atCap = new Date(Date.parse(now) - CAP_MS).toISOString();
            const pastCap = new Date(Date.parse(now) - CAP_MS - 1).toISOString();

            expect(catchUpUntil(atCap, now)).toBe(now);
            expect(catchUpUntil(pastCap, now)).toBe(
                new Date(Date.parse(pastCap) + CAP_MS).toISOString(),
            );
        });

        it('caps to since + cap when the cursor is far behind', () => {
            expect(catchUpUntil('2026-01-01T00:00:00.000Z', '2026-07-15T00:00:00.000Z')).toBe(
                '2026-01-31T00:00:00.000Z',
            );
        });

        it.each([
            ['unparseable since', 'not-a-date', '2026-07-15T00:00:00.000Z'],
            ['unparseable now', '2026-01-01T00:00:00.000Z', 'not-a-date'],
            ['an empty since', '', '2026-07-15T00:00:00.000Z'],
        ])('degrades to `now` on %s', (_label, since, now) => {
            expect(catchUpUntil(since, now)).toBe(now);
        });

        it('never returns an instant after `now` for a future-dated cursor', () => {
            // A skewed or hand-edited cursor must not push the window past the present.
            expect(catchUpUntil('2027-01-01T00:00:00.000Z', '2026-07-15T00:00:00.000Z')).toBe(
                '2026-07-15T00:00:00.000Z',
            );
        });

        describe('prWithinFetchWindow (PR fan-out bound, #247)', () => {
            const UNTIL = '2026-07-15T00:00:00.000Z';

            it('keeps a PR updated before `until`', () => {
                expect(prWithinFetchWindow('2026-07-10T00:00:00.000Z', UNTIL)).toBe(true);
            });

            it('keeps a PR updated exactly AT `until` (inclusive boundary)', () => {
                // Inclusive: the boundary PR is processed this run AND re-listed next run
                // (next `since` === this `until`); an idempotent re-delivery, never a gap.
                expect(prWithinFetchWindow(UNTIL, UNTIL)).toBe(true);
            });

            it('drops a PR updated after `until`', () => {
                expect(prWithinFetchWindow('2026-07-20T00:00:00.000Z', UNTIL)).toBe(false);
            });

            it('compares parsed instants, not strings (no-millis updatedAt equals millis until)', () => {
                // Provider timestamps arrive without millis (github `...:00Z`); `until` is a
                // toISOString() value (`...:00.000Z`). A lexical `<=` would call the shorter
                // string "less" and mis-handle the equal-instant boundary — parse both.
                expect(prWithinFetchWindow('2026-07-15T00:00:00Z', UNTIL)).toBe(true);
                expect(prWithinFetchWindow('2026-07-15T00:00:00.001Z', '2026-07-15T00:00:00Z')).toBe(
                    false,
                );
            });

            it('fails OPEN on an unparseable `until` (no usable bound → keep the PR)', () => {
                expect(prWithinFetchWindow('2026-07-20T00:00:00.000Z', 'not-a-date')).toBe(true);
            });

            it('fails OPEN on an unparseable `updatedAt` (can\'t place the PR → fetch it)', () => {
                // A bounded extra fetch is strictly safer than silently dropping a PR whose
                // activity time we can't read.
                expect(prWithinFetchWindow('garbage', UNTIL)).toBe(true);
            });
        });

        it('caps the fetch window AND the cursor advance when the cursor is far behind', async () => {
            seedDev(db, 'alice');
            const cursor = new Date(Date.now() - 90 * DAY_MS).toISOString();
            writeState(FORWARD_KEY, cursor);
            const expectedUntil = new Date(Date.parse(cursor) + CAP_MS).toISOString();

            const getCommits = vi.fn().mockResolvedValue([makeProviderCommit('alice')]);
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    getCommits,
                }),
            );

            const result = await new GitSync({enabled: false}).syncProviders(db, [CONFIG]);

            // The commit walk (and its per-commit diff fetches) is bounded to one cap
            // width instead of the full 90 days — the point of the cap.
            // Trailing args: the optional #270 progress listener (absent here, this caller
            // observes nothing) and the #275 drop listener, which is ALWAYS supplied — it is
            // the only record that a commit was lost, so it must exist on the observer-free
            // path too.
            expect(getCommits).toHaveBeenCalledWith(
                'repo1',
                cursor,
                expectedUntil,
                undefined,
                expect.any(Function),
            );
            // …and CRUCIALLY the cursor advances only to what was actually covered.
            // Advancing to `now` here would silently skip the remaining 60 days — the
            // permanent gap #231 exists to prevent, reintroduced by the cap itself.
            expect(readState(FORWARD_KEY)).toBe(expectedUntil);
            expect(readState(FORWARD_KEY)).not.toBe(result.lastSyncTime);
        });

        it('leaves a healthy provider completely uncapped (cursor advances to now)', async () => {
            seedDev(db, 'alice');
            const cursor = new Date(Date.now() - DAY_MS).toISOString();
            writeState(FORWARD_KEY, cursor);

            const getCommits = vi.fn().mockResolvedValue([makeProviderCommit('alice')]);
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    getCommits,
                }),
            );

            const result = await new GitSync({enabled: false}).syncProviders(db, [CONFIG]);

            // The normal daily path must be exactly what it was before the cap existed.
            // Trailing args: the optional #270 progress listener (absent here, this caller
            // observes nothing) and the #275 drop listener, which is ALWAYS supplied — it is
            // the only record that a commit was lost, so it must exist on the observer-free
            // path too.
            expect(getCommits).toHaveBeenCalledWith(
                'repo1',
                cursor,
                result.lastSyncTime,
                undefined,
                expect.any(Function),
            );
            expect(readState(FORWARD_KEY)).toBe(result.lastSyncTime);
        });

        it('does NOT cap a FIRST sync — its window is bounded by firstSyncWindowMonths instead', async () => {
            seedDev(db, 'alice');
            const getCommits = vi.fn().mockResolvedValue([makeProviderCommit('alice')]);
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    getCommits,
                }),
            );

            const result = await new GitSync({enabled: false}).syncProviders(db, [CONFIG], undefined, {
                firstSyncWindowMonths: 6,
            });

            // A 6-month first sync must import 6 months. Capping `until` here would
            // silently turn the admin's requested window into a 30-day one.
            const [, since, until] = getCommits.mock.calls[0] as [string, string, string];
            expect(since).toBe(subtractUtcMonths(result.lastSyncTime as string, 6));
            expect(until).toBe(result.lastSyncTime);
            expect(readState(FORWARD_KEY)).toBe(result.lastSyncTime);
        });

        it('chunks a long catch-up into contiguous, gap-free windows across runs', async () => {
            const cursor = new Date(Date.now() - 90 * DAY_MS).toISOString();
            writeState(FORWARD_KEY, cursor);

            const windows: Array<[string, string]> = [];
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockImplementation(() =>
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    getCommits: vi.fn(async (_repo: string, since: string, until: string) => {
                        windows.push([since, until]);
                        return [];
                    }),
                }),
            );

            const sync = new GitSync({enabled: false});
            await sync.syncProviders(db, [CONFIG]);
            await sync.syncProviders(db, [CONFIG]);
            await sync.syncProviders(db, [CONFIG]);

            // Each run resumes EXACTLY where the previous stopped: chunked, never skipped.
            // A gap between two windows is a permanently lost span of history.
            expect(windows[0][0]).toBe(cursor);
            expect(windows[1][0]).toBe(windows[0][1]);
            expect(windows[2][0]).toBe(windows[1][1]);
            // Each chunk is one cap wide, so the per-run cost is constant, not growing.
            for (const [since, until] of windows) {
                expect(Date.parse(until) - Date.parse(since)).toBe(CAP_MS);
            }
        });

        it('holds a STALLED provider to a constant COMMIT window rather than an ever-growing one', async () => {
            const cursor = new Date(Date.now() - 200 * DAY_MS).toISOString();
            writeState(FORWARD_KEY, cursor);

            const windows: Array<[string, string]> = [];
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockImplementation(() =>
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('broken-repo')]),
                    getCommits: vi.fn(async (_repo: string, since: string, until: string) => {
                        windows.push([since, until]);
                        throw new Error('GitHub API error 500');
                    }),
                }),
            );

            const sync = new GitSync({enabled: false});
            await sync.syncProviders(db, [CONFIG]);
            await sync.syncProviders(db, [CONFIG]);

            // While stalled the cursor is held, so `since` is pinned — and with `until`
            // capped the COMMIT re-fetch span no longer widens by a run's worth of
            // wall-clock every run. Two identical windows prove the commit walk (and its
            // per-commit diff fan-out) is constant per run.
            //
            // Since #247 the per-PR review fan-out is bounded to this same window too
            // (see the "bounds the per-PR review fan-out" test below). The PR LIST paging
            // still grows (getPullRequests takes no `until` and github/bitbucket sort
            // newest-first), but that is one list call per ~50–100 PRs, not the 2-per-PR
            // fan-out — see GIT_CATCHUP_WINDOW_MAX_DAYS for the full scope.
            expect(windows).toHaveLength(2);
            expect(windows[1]).toEqual(windows[0]);
            expect(Date.parse(windows[0][1]) - Date.parse(windows[0][0])).toBe(CAP_MS);
        });

        it('sums a UTC day split across a chunk boundary — no gap, no double-count', async () => {
            // The cap makes chunk boundaries routine, and a boundary lands at an
            // arbitrary time-of-day — so it SPLITS a UTC calendar day: run N writes
            // (dev, D) with the morning's commits, run N+1 writes (dev, D) again with
            // the afternoon's. git_snapshots merges `commits` ADDITIVELY across runs
            // (remergeStoredSnapshot), and the project rule from #205 is that an
            // additive merge may only sum genuinely-disjoint deltas. The window tests
            // above prove the boundary ARITHMETIC; this proves the DATA lands exactly
            // once — the invariant the arithmetic exists to protect.
            const devId = seedDev(db, 'alice');
            // Clock frozen at midday: the day offsets below are exact multiples of 24h,
            // so `boundary` inherits the WALL-CLOCK TIME-OF-DAY of the run. On the real
            // clock, a suite running within an hour of UTC midnight pushes `morning` or
            // `afternoon` onto an adjacent UTC day and the split never happens — the
            // test then fails for a reason that has nothing to do with the merge. Midday
            // keeps both commits on the same UTC day by construction.
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'));
            // Cursor 45d back → run 1 covers [c, c+30d], run 2 covers [c+30d, now].
            const cursor = new Date(Date.now() - 45 * DAY_MS).toISOString();
            writeState(FORWARD_KEY, cursor);
            const boundary = new Date(Date.parse(cursor) + CAP_MS);
            const splitDay = boundary.toISOString().slice(0, 10);
            const morning = new Date(boundary.getTime() - 3_600_000).toISOString();
            const afternoon = new Date(boundary.getTime() + 3_600_000).toISOString();

            const createGitProvider = await getCreateGitProvider();
            // Each run returns only the commits inside ITS window — what a correctly
            // server-side-bounded provider does, so the assertion measures the merge,
            // not the mock.
            createGitProvider.mockImplementation(() =>
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    getCommits: vi.fn(async (_repo: string, since: string, until: string) =>
                        [
                            makeProviderCommit('alice', morning, 'c-morning'),
                            makeProviderCommit('alice', afternoon, 'c-afternoon'),
                        ].filter((c) => c.date >= since && c.date <= until),
                    ),
                }),
            );

            const sync = new GitSync({enabled: false});
            await sync.syncProviders(db, [CONFIG]);
            await sync.syncProviders(db, [CONFIG]);

            // Exactly 2: 1 would mean the second chunk clobbered the first half of the
            // day (a REPLACE, not a merge — a permanent gap); 3+ would mean a commit was
            // delivered in both windows and additively re-counted.
            const row = db
                .prepare('SELECT commits FROM git_snapshots WHERE developer_id = ? AND date = ?')
                .get(devId, splitDay) as {commits: number} | undefined;
            expect(row?.commits).toBe(2);
        });

        it('bounds the per-PR review fan-out to the capped catch-up window (#247)', async () => {
            seedDev(db, 'alice');
            const cursor = new Date(Date.now() - 90 * DAY_MS).toISOString();
            writeState(FORWARD_KEY, cursor);
            // until = cursor + 30d. One PR updated inside [cursor, until], one after it.
            const inWindow = {
                ...makeProviderPR('alice'),
                id: 'in',
                updatedAt: new Date(Date.parse(cursor) + 10 * DAY_MS).toISOString(),
            };
            const outWindow = {
                ...makeProviderPR('alice'),
                id: 'out',
                updatedAt: new Date(Date.parse(cursor) + 50 * DAY_MS).toISOString(),
            };
            const getReviewComments = vi.fn().mockResolvedValue([]);
            const getPRReviews = vi.fn().mockResolvedValue([]);
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    getCommits: vi.fn().mockResolvedValue([]),
                    getPullRequests: vi.fn().mockResolvedValue([inWindow, outWindow]),
                    getReviewComments,
                    getPRReviews,
                }),
            );

            await new GitSync({enabled: false}).syncProviders(db, [CONFIG]);

            // The out-of-window PR is NOT fanned out (2 API calls per PR saved). It gets
            // re-listed on the next chunk (whose `since` IS this `until`), so lossless.
            expect(getReviewComments.mock.calls.map((c) => c[1])).toEqual(['in']);
            expect(getPRReviews.mock.calls.map((c) => c[1])).toEqual(['in']);
        });

        it('re-fans a window-deferred PR on the NEXT chunk — lossless (#247)', async () => {
            seedDev(db, 'alice');
            const cursor = new Date(Date.now() - 90 * DAY_MS).toISOString();
            writeState(FORWARD_KEY, cursor);
            // Updated 50d past the cursor: after run-1's until (cursor+30d), inside
            // run-2's window ([cursor+30d, cursor+60d]).
            const pr = {
                ...makeProviderPR('alice'),
                id: 'deferred',
                updatedAt: new Date(Date.parse(cursor) + 50 * DAY_MS).toISOString(),
            };
            const getReviewComments = vi.fn().mockResolvedValue([]);
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockImplementation(() =>
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    getCommits: vi.fn().mockResolvedValue([]),
                    getPullRequests: vi.fn().mockResolvedValue([pr]),
                    getReviewComments,
                }),
            );

            const sync = new GitSync({enabled: false});
            await sync.syncProviders(db, [CONFIG]); // run 1: deferred (updated > until)
            expect(getReviewComments).not.toHaveBeenCalled();
            await sync.syncProviders(db, [CONFIG]); // run 2: since advanced, PR now in window
            expect(getReviewComments.mock.calls.map((c) => c[1])).toEqual(['deferred']);
        });

        it('fans out EVERY PR on a healthy uncapped run (until === now) (#247)', async () => {
            seedDev(db, 'alice');
            const cursor = new Date(Date.now() - DAY_MS).toISOString();
            writeState(FORWARD_KEY, cursor);
            const p1 = {
                ...makeProviderPR('alice'),
                id: 'p1',
                updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
            };
            const p2 = {
                ...makeProviderPR('alice'),
                id: 'p2',
                updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
            };
            const getReviewComments = vi.fn().mockResolvedValue([]);
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    getCommits: vi.fn().mockResolvedValue([]),
                    getPullRequests: vi.fn().mockResolvedValue([p1, p2]),
                    getReviewComments,
                }),
            );

            await new GitSync({enabled: false}).syncProviders(db, [CONFIG]);

            // Uncapped: nothing dropped — the normal daily path is unchanged by #247.
            expect(getReviewComments.mock.calls.map((c) => c[1]).sort()).toEqual(['p1', 'p2']);
        });

        it('keeps prs_opened whole when a day\'s PRs straddle a chunk boundary (#247 SO-1)', async () => {
            const devId = seedDev(db, 'alice');
            const cursor = new Date(Date.now() - 90 * DAY_MS).toISOString();
            writeState(FORWARD_KEY, cursor);
            const createdAt = new Date(Date.parse(cursor) + 5 * DAY_MS).toISOString();
            const day = createdAt.slice(0, 10);
            // Two PRs opened the SAME day; their updatedAt lands in different 30d chunks:
            // `early` in chunk 1 [cursor, cursor+30d], `late` in chunk 2 [cursor+30d, +60d].
            const early = {
                ...makeProviderPR('alice'),
                id: 'pr-early',
                state: 'open',
                mergedAt: null,
                closedAt: null,
                createdAt,
                updatedAt: new Date(Date.parse(cursor) + 5 * DAY_MS).toISOString(),
            };
            const late = {
                ...makeProviderPR('alice'),
                id: 'pr-late',
                state: 'open',
                mergedAt: null,
                closedAt: null,
                createdAt,
                updatedAt: new Date(Date.parse(cursor) + 50 * DAY_MS).toISOString(),
            };
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockImplementation(() =>
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    getCommits: vi.fn().mockResolvedValue([]),
                    // Mirror a real provider's `since` cutoff: lists PRs updated >= since.
                    getPullRequests: vi.fn(async (_repo: string, _state: string, since: string) =>
                        [early, late].filter((pr) => Date.parse(pr.updatedAt) >= Date.parse(since)),
                    ),
                }),
            );

            const sync = new GitSync({enabled: false});
            await sync.syncProviders(db, [CONFIG]); // chunk 1: lists both → prs_opened = 2
            await sync.syncProviders(db, [CONFIG]); // chunk 2: lists only `late` → prs_opened = 1

            // Both PRs opened that day must survive the max()-merge. Bounding the LIST row
            // (not just the fan-out) would leave each chunk seeing one → max(1,1)=1, a
            // silent undercount — the SO-1 regression this guards.
            const row = db
                .prepare('SELECT prs_opened FROM git_snapshots WHERE developer_id = ? AND date = ?')
                .get(devId, day) as {prs_opened: number} | undefined;
            expect(row?.prs_opened).toBe(2);
        });

        it('bounds the fan-out on a backfill run too (until = watermark) (#247)', async () => {
            seedDev(db, 'alice');
            writeState(FORWARD_KEY, new Date(Date.now() - 90 * DAY_MS).toISOString());
            const backfill = {since: '2024-01-01T00:00:00.000Z', until: '2024-07-01T00:00:00.000Z'};
            const inWindow = {
                ...makeProviderPR('alice'),
                id: 'bf-in',
                updatedAt: '2024-03-01T00:00:00.000Z',
            };
            const afterWatermark = {
                ...makeProviderPR('alice'),
                id: 'bf-after',
                updatedAt: '2024-09-01T00:00:00.000Z',
            };
            const getReviewComments = vi.fn().mockResolvedValue([]);
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    getCommits: vi.fn().mockResolvedValue([]),
                    getPullRequests: vi.fn().mockResolvedValue([inWindow, afterWatermark]),
                    getReviewComments,
                    getPRReviews: vi.fn().mockResolvedValue([]),
                }),
            );

            await new GitSync({enabled: false}).syncProviders(db, [CONFIG], undefined, {backfill});

            // On backfill `until` is the earliest watermark, so a PR updated after it is
            // already covered by the forward window and its fan-out is skipped.
            expect(getReviewComments.mock.calls.map((c) => c[1])).toEqual(['bf-in']);
        });

        it('does NOT cap a backfill — its window is the validated slice the caller passed', async () => {
            writeState(FORWARD_KEY, new Date(Date.now() - 90 * DAY_MS).toISOString());
            const backfill = {since: '2024-01-01T00:00:00.000Z', until: '2024-07-01T00:00:00.000Z'};

            const getCommits = vi.fn().mockResolvedValue([]);
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValue(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    getCommits,
                }),
            );

            await new GitSync({enabled: false}).syncProviders(db, [CONFIG], undefined, {backfill});

            // The backfill route already computed and overlap-guarded this exact slice;
            // narrowing it here would silently import less than the guard cleared.
            // Trailing args: the optional #270 progress listener (absent here, this caller
            // observes nothing) and the #275 drop listener, which is ALWAYS supplied — it is
            // the only record that a commit was lost, so it must exist on the observer-free
            // path too.
            expect(getCommits).toHaveBeenCalledWith(
                'repo1',
                backfill.since,
                backfill.until,
                undefined,
                expect.any(Function),
            );
        });
    });
});

// DO1.3 (#253): the sync run now RETAINS every author's daily facts under their raw
// identity and DERIVES git_snapshots from them. The 165 tests above are the golden
// regression — they assert the pre-change additive output and all still pass through the
// projection unchanged. These add what only the new design can be asked.
describe('GitSync — raw authorship retention + projection (#253)', () => {
    let db: Database.Database;

    const CONFIG: GitProviderConfig = {
        type: 'github',
        org: 'test-org',
        auth: {type: 'token', api_token: 't'},
    };

    beforeEach(() => {
        db = makeDb();
        vi.resetAllMocks();
    });

    afterEach(() => {
        db.close();
        vi.restoreAllMocks();
    });

    function countRaw(): number {
        return (db.prepare('SELECT COUNT(*) AS n FROM raw_author_daily').get() as {n: number}).n;
    }

    function readCell(developerId: string, date: string): {commits: number} | undefined {
        return db
            .prepare('SELECT commits FROM git_snapshots WHERE developer_id = ? AND date = ?')
            .get(developerId, date) as {commits: number} | undefined;
    }

    async function syncCommits(commits: GitCommit[], prs: GitPR[] = []): Promise<SyncResult> {
        const createGitProvider = await getCreateGitProvider();
        createGitProvider.mockReturnValueOnce(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                getCommits: vi.fn().mockResolvedValue(commits),
                getPullRequests: vi.fn().mockResolvedValue(prs),
            }),
        );
        return new GitSync({enabled: false}).syncProviders(db, [CONFIG]);
    }

    it('retains EVERY unmatched author on a fresh DB: 0 snapshots, N raw rows, advisory names them', async () => {
        const result = await syncCommits([
            makeProviderCommit('nobody-one', '2024-01-15T10:00:00Z', 'c1'),
            makeProviderCommit('nobody-two', '2024-01-15T11:00:00Z', 'c2'),
            makeProviderCommit('nobody-one', '2024-01-16T10:00:00Z', 'c3'),
        ]);

        // Nothing attributes — there is no developer registry at all.
        expect(countSnapshots(db)).toBe(0);
        // …but nothing is LOST either: 2 authors × the days they were active.
        expect(countRaw()).toBe(3);
        const advisory = result.errors.find((e) => e.startsWith(UNMATCHED_AUTHORS_PREFIX))!;
        expect(advisory).toContain('github:nobody-one');
        expect(advisory).toContain('github:nobody-two');
    });

    it('keys an email-only author (no provider username) by their EMAIL, not a login-shaped key', async () => {
        await syncCommits([
            {
                sha: 'e1',
                author: {name: 'Erin Example', email: 'Erin@Example.COM', username: ''},
                date: '2024-01-15T10:00:00Z',
                message: 'feat: x',
                additions: 5,
                deletions: 1,
                diffs: [{path: 'src/x.ts', additions: 5, deletions: 1, status: 'modified'}],
            },
        ]);

        const row = db
            .prepare('SELECT raw_author_key, author_email, author_display_name FROM raw_author_daily')
            .get() as {raw_author_key: string; author_email: string; author_display_name: string};
        // A username-less author must not be filed under `github:login:<an email>` — that
        // identity shape exists nowhere else and would never match a promoted developer.
        expect(row.raw_author_key).toBe('github:email:erin@example.com');
        expect(row.author_email).toBe('erin@example.com');
        // Display name is retained for candidate pre-fill (DO1.4), never for resolution.
        expect(row.author_display_name).toBe('Erin Example');
    });

    it('git_snapshots is DERIVABLE: wiping it and re-projecting reproduces the synced rows exactly', async () => {
        seedDev(db, 'alice');
        await syncCommits([makeProviderCommit('alice', '2024-01-15T09:00:00Z', 'c1')], [makeProviderPR('alice')]);
        // A second incremental run, so the stored rows are an ACCUMULATED total rather
        // than one run's output — the case a naive rebuild would get wrong.
        await syncCommits([makeProviderCommit('alice', '2024-01-15T15:00:00Z', 'c2')]);

        const before = db
            .prepare(
                `SELECT developer_id, date, commits, lines_added, lines_removed, files_changed,
                        prs_opened, prs_merged, review_comments_given, avg_time_to_merge_hours,
                        code_churn_rate, ai_signature_score, avg_commit_size, commit_burst_count, data_source
                 FROM git_snapshots ORDER BY date, developer_id`,
            )
            .all();
        expect(before.length).toBeGreaterThan(0);

        // Destroy the derived table entirely and rebuild it from the retained facts alone.
        db.exec('DELETE FROM git_snapshots');
        const dates = (db.prepare('SELECT DISTINCT date FROM raw_author_daily').all() as {date: string}[]).map(
            (r) => r.date,
        );
        projectSnapshots(db, {dates});

        const after = db
            .prepare(
                `SELECT developer_id, date, commits, lines_added, lines_removed, files_changed,
                        prs_opened, prs_merged, review_comments_given, avg_time_to_merge_hours,
                        code_churn_rate, ai_signature_score, avg_commit_size, commit_burst_count, data_source
                 FROM git_snapshots ORDER BY date, developer_id`,
            )
            .all();
        expect(after).toEqual(before);
    });

    it('HEAD-TO-HEAD: create-then-replay equals developer-existed-then-sync (no double-count, no undercount)', async () => {
        const commits = [
            makeProviderCommit('frank', '2024-01-15T09:00:00Z', 'f1'),
            makeProviderCommit('frank', '2024-01-15T20:00:00Z', 'f2'),
            makeProviderCommit('frank', '2024-01-16T09:00:00Z', 'f3'),
        ];
        const prs = [makeProviderPR('frank')];

        // Branch A — the ONBOARDING path: sync first (frank is unmatched and retained),
        // create the developer afterwards, then replay.
        await syncCommits(commits, prs);
        expect(countSnapshots(db)).toBe(0);
        const lateId = seedDev(db, 'frank');
        replayDeveloper(db, lateId);
        const replayed = db
            .prepare(
                `SELECT date, commits, lines_added, lines_removed, files_changed, prs_opened, prs_merged,
                        review_comments_given, avg_time_to_merge_hours, code_churn_rate, ai_signature_score,
                        avg_commit_size, commit_burst_count, data_source
                 FROM git_snapshots WHERE developer_id = ? ORDER BY date`,
            )
            .all(lateId);

        // Branch B — the CONTROL: a pristine DB where frank existed before the sync ran.
        const control = makeDb();
        try {
            addTeam(control, 'eng');
            const earlyDev = addDeveloper(control, 'frank', 'eng', 'frank@example.com', 'frank');
            control
                .prepare(`UPDATE developers SET external_ids = '{"github":"frank"}' WHERE id = ?`)
                .run(earlyDev.id);
            const createGitProvider = await getCreateGitProvider();
            createGitProvider.mockReturnValueOnce(
                makeMockProvider({
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    getCommits: vi.fn().mockResolvedValue(commits),
                    getPullRequests: vi.fn().mockResolvedValue(prs),
                }),
            );
            await new GitSync({enabled: false}).syncProviders(control, [CONFIG]);

            const direct = control
                .prepare(
                    `SELECT date, commits, lines_added, lines_removed, files_changed, prs_opened, prs_merged,
                            review_comments_given, avg_time_to_merge_hours, code_churn_rate, ai_signature_score,
                            avg_commit_size, commit_burst_count, data_source
                     FROM git_snapshots WHERE developer_id = ? ORDER BY date`,
                )
                .all(earlyDev.id);

            expect(direct.length).toBeGreaterThan(0);
            // Every metric column, every date — a double-count or an undercount anywhere
            // in the replay path fails this.
            expect(replayed).toEqual(direct);
        } finally {
            control.close();
        }
    });

    it('rolls back the RAW rows too when the write transaction fails — no cursor, no facts, no snapshots', async () => {
        seedDev(db, 'alice');
        const createGitProvider = await getCreateGitProvider();
        createGitProvider.mockReturnValueOnce(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                getCommits: vi.fn().mockResolvedValue([makeProviderCommit('alice', '2024-01-15T09:00:00Z', 'c1')]),
                // A PR forces the tx to reach upsertPRRecord AFTER the raw rows and the
                // projection have already been written inside it.
                getPullRequests: vi.fn().mockResolvedValue([makeProviderPR('alice')]),
            }),
        );
        db.exec('DROP TABLE pr_records');

        const result = await new GitSync({enabled: false}).syncProviders(db, [CONFIG]);

        expect(result.errors.some((e) => e.includes('transaction rolled back'))).toBe(true);
        expect(result.snapshotsWritten).toBe(0);
        // Retention is inside the SAME transaction: a rolled-back run retains nothing,
        // so the next run re-covers the window with no double-count.
        expect(countRaw()).toBe(0);
        expect(countSnapshots(db)).toBe(0);
        expect(
            db.prepare('SELECT value FROM sync_state WHERE key = ?').get(syncStateKey('github', 'test-org')),
        ).toBeUndefined();
    });

    it('attributes a developer created WHILE the run was fetching — the cursor never advances past unprojected work', async () => {
        const createGitProvider = await getCreateGitProvider();
        let lateId = '';
        createGitProvider.mockReturnValueOnce(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                // The fetch is where a real run spends minutes. An admin promoting a
                // candidate right here must not be missed by a lookup map that was read
                // before the fetch started.
                getCommits: vi.fn().mockImplementation(async () => {
                    lateId = seedDev(db, 'grace');
                    return [makeProviderCommit('grace', '2024-01-15T10:00:00Z', 'g1')];
                }),
            }),
        );

        const result = await new GitSync({enabled: false}).syncProviders(db, [CONFIG]);

        expect(readCell(lateId, '2024-01-15')?.commits).toBe(1);
        // …and she is not simultaneously reported as an unmatched author.
        expect(result.errors.some((e) => e.startsWith(UNMATCHED_AUTHORS_PREFIX))).toBe(false);
    });

    it('a scoped single-provider run projects the FULL multi-provider cell, not just its own share', async () => {
        try { addTeam(db, 'eng'); } catch { /* already present */ }
        const dev = addDeveloper(db, 'Alice', 'eng', 'alice@example.com', 'alice');
        db.prepare(`UPDATE developers SET external_ids = '{"github":"alice","bitbucket":"alice-bb"}' WHERE id = ?`)
            .run(dev.id);

        await syncCommits([makeProviderCommit('alice', '2024-01-15T10:00:00Z', 'gh-1')]);

        const createGitProvider = await getCreateGitProvider();
        createGitProvider.mockReturnValueOnce(
            makeMockProvider({
                name: 'bitbucket',
                listRepos: vi.fn().mockResolvedValue([makeRepo('bb-repo')]),
                getCommits: vi.fn().mockResolvedValue([{
                    sha: 'bb-1',
                    author: {name: 'Alice', email: 'alice@example.com', username: 'alice-bb'},
                    date: '2024-01-15T14:00:00Z',
                    message: 'fix: bug',
                    additions: 20,
                    deletions: 3,
                    diffs: [{path: 'src/y.ts', additions: 20, deletions: 3, status: 'modified'}],
                }]),
            }),
        );
        await new GitSync({enabled: false}).syncProviders(db, [
            {type: 'bitbucket', workspace: 'bb-ws', auth: {type: 'app_password', username: 'u', app_password: 'p'}},
        ]);

        // The bitbucket-scoped run never fetched the github commit, yet the rebuilt cell
        // still carries it — because the projection reads the RETAINED github raw row.
        const row = db
            .prepare(`SELECT commits, data_source, is_projected FROM git_snapshots WHERE developer_id = ? AND date = '2024-01-15'`)
            .get(dev.id) as {commits: number; data_source: string; is_projected: number};
        expect(row.commits).toBe(2);
        expect(row.data_source).toBe('multi');
        expect(row.is_projected).toBe(1);
        // Two disjoint raw identities, one derived cell.
        expect(countRaw()).toBe(2);
        expect(countSnapshots(db)).toBe(1);
    });
});

/**
 * #280 — the `GitCommit.diffs` reuse path is what this suite exercises, and taking the
 * `getCommitDiff` fallback instead is SAID rather than merely felt.
 *
 * Every in-tree provider supplies `diffs` (#271), so the fallback is a branch no production
 * code path reaches — which is exactly why it needs pinning from both sides: the mainstream
 * fixtures must be provably ON the reuse path (otherwise the 200 tests above are all measuring
 * dead code), and a provider that stops supplying the field must be diagnosable from a run's
 * output instead of only from its wall time.
 */
describe('GitCommit.diffs reuse vs the getCommitDiff fallback (#280)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        vi.resetAllMocks();
    });

    afterEach(() => {
        db.close();
        vi.restoreAllMocks();
    });

    const CONFIG: GitProviderConfig = {
        type: 'github',
        org: 'test-org',
        auth: {type: 'token', api_token: 'test-token'},
    };

    async function syncWith(provider: GitProvider): Promise<SyncResult> {
        (await getCreateGitProvider()).mockReturnValue(provider);
        return new GitSync({enabled: false}).syncProviders(db, [CONFIG]);
    }

    const diffAdvisories = (result: SyncResult): string[] =>
        result.errors.filter((e) => e.startsWith(DIFFS_NOT_SUPPLIED_PREFIX));

    /**
     * The counters are per-`fetchProviderData` locals, and the `[type]` tag is the only thing
     * that tells an operator WHICH provider broke the contract. Nothing pinned that: every other
     * fixture here runs one provider, so a regression that hoisted the counters to run scope
     * (the same per-provider-scoping class of bug as #192) would merge two providers' counts
     * into one line tagged with whichever formatted last, and stay green.
     *
     * A multi-provider deployment is the realistic one, and it is exactly where the tag has to
     * be right — "some provider fell back 4000 times" is not actionable.
     */
    it('reports only the non-conformant provider, tagged, in a mixed multi-provider run', async () => {
        seedDev(db, 'alice');
        const createGitProvider = await getCreateGitProvider();
        // github is diff-less; bitbucket honours the contract.
        createGitProvider
            .mockReturnValueOnce(
                makeMockProvider({
                    name: 'github',
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                    getCommits: vi.fn().mockResolvedValue([
                        makeProviderCommit('alice', '2024-01-15T10:00:00Z', 's1', NO_PROVIDER_DIFFS),
                        makeProviderCommit('alice', '2024-01-15T11:00:00Z', 's2', NO_PROVIDER_DIFFS),
                    ]),
                    getCommitDiff: vi.fn().mockResolvedValue(makeProviderDiffs()),
                }),
            )
            .mockReturnValueOnce(
                makeMockProvider({
                    name: 'bitbucket',
                    listRepos: vi.fn().mockResolvedValue([makeRepo('repo9')]),
                    getCommits: vi
                        .fn()
                        .mockResolvedValue([
                            makeProviderCommit('alice', '2024-01-15T12:00:00Z', 's9'),
                        ]),
                }),
            );

        const result = await new GitSync({enabled: false}).syncProviders(db, [
            CONFIG,
            {
                type: 'bitbucket',
                workspace: 'test-ws',
                auth: {type: 'token', api_token: 'test-token'},
            } as GitProviderConfig,
        ]);

        const advisories = diffAdvisories(result);
        // ONE line, for the ONE provider that fell back — not one merged line, and not one per
        // provider in the run.
        expect(advisories).toHaveLength(1);
        expect(advisories[0]).toContain('[github]');
        expect(advisories[0]).not.toContain('[bitbucket]');
        // …and the count is github's two commits only, not three. This is the assertion that
        // fails if the counters stop being per-provider.
        expect(advisories[0]).toContain('2 commit(s)');
        // Positive control: bitbucket's commit really was imported in the same run, so the
        // absence of a bitbucket line is suppression, not a run that skipped it.
        const row = db
            .prepare(`SELECT commits FROM git_snapshots WHERE date = '2024-01-15'`)
            .get() as {commits: number};
        expect(row.commits).toBe(3);
    });

    /**
     * AC1's guarantee, stated once rather than left implicit in 200 fixtures: a commit built by
     * `makeProviderCommit` carries `diffs`, so the sync loop never re-requests it. If this fails,
     * the whole suite above has silently slid back onto the fallback branch.
     */
    it('never calls getCommitDiff for commits that carry diffs', async () => {
        seedDev(db, 'alice');
        const getCommitDiff = vi.fn().mockResolvedValue(makeProviderDiffs());
        const result = await syncWith(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                getCommits: vi.fn().mockResolvedValue([
                    makeProviderCommit('alice', '2024-01-15T10:00:00Z', 's1'),
                    makeProviderCommit('alice', '2024-01-15T11:00:00Z', 's2'),
                ]),
                getCommitDiff,
            }),
        );

        expect(getCommitDiff).not.toHaveBeenCalled();
        // …and the commits really were imported WITH their diffs, so the assertion above is
        // about the reuse path and not about a run that quietly processed nothing (or that
        // reached `toAnalysisCommit` with `[]` instead of `rawCommit.diffs`).
        expect(countSnapshots(db)).toBe(1);
        const row = db
            .prepare(`SELECT files_changed FROM git_snapshots WHERE date = '2024-01-15'`)
            .get() as {files_changed: number};
        expect(row.files_changed).toBe(4);
        expect(diffAdvisories(result)).toEqual([]);
    });

    /**
     * The retained FALLBACK fixture. The branch is legal — `GitCommit.diffs` is optional so a
     * provider that cannot pre-fetch can say "I have none" — so it must keep working, not just
     * keep being reported.
     */
    it('falls back to getCommitDiff, once per commit, for a provider that supplies none', async () => {
        seedDev(db, 'alice');
        const getCommitDiff = vi.fn().mockResolvedValue(makeProviderDiffs());
        await syncWith(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                getCommits: vi.fn().mockResolvedValue([
                    makeProviderCommit('alice', '2024-01-15T10:00:00Z', 's1', NO_PROVIDER_DIFFS),
                    makeProviderCommit('alice', '2024-01-15T11:00:00Z', 's2', NO_PROVIDER_DIFFS),
                ]),
                getCommitDiff,
            }),
        );

        expect(getCommitDiff.mock.calls).toEqual([
            ['repo1', 's1'],
            ['repo1', 's2'],
        ]);
        // The columns asserted here are only the ones the FALLBACK RESULT can move. Be precise
        // about which those are, because two of the three obvious candidates cannot:
        // `lines_added`/`lines_removed` come from `commit.additions`/`deletions` (the analyzer
        // reads the commit, not the diff), which `makeProviderCommit` hardcodes — they would hold
        // at 100/20 even if `getCommitDiff` returned nothing at all, so asserting them here would
        // read as proof of something it cannot prove.
        //
        // `files_changed` counts the diff entries, and `code_churn_rate` is derived from their
        // paths and line counts — both are zero if the fallback result is dropped. Two commits ×
        // two entries → 4; both commits touch the SAME two paths, so the second is rework and the
        // churn rate is above zero.
        const row = db
            .prepare(
                `SELECT files_changed, code_churn_rate FROM git_snapshots WHERE date = '2024-01-15'`,
            )
            .get() as {files_changed: number; code_churn_rate: number};
        expect(row.files_changed).toBe(4);
        expect(row.code_churn_rate).toBeGreaterThan(0);
    });

    /** AC3: the fallback is visible in the run's own output, with a usable count. */
    it('reports the fallback as an advisory naming the commit and repo counts', async () => {
        seedDev(db, 'alice');
        const result = await syncWith(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1'), makeRepo('repo2')]),
                getCommits: vi
                    .fn()
                    .mockResolvedValueOnce([
                        makeProviderCommit('alice', '2024-01-15T10:00:00Z', 's1', NO_PROVIDER_DIFFS),
                        makeProviderCommit('alice', '2024-01-15T11:00:00Z', 's2', NO_PROVIDER_DIFFS),
                    ])
                    .mockResolvedValueOnce([
                        makeProviderCommit('alice', '2024-01-16T10:00:00Z', 's3', NO_PROVIDER_DIFFS),
                    ]),
                getCommitDiff: vi.fn().mockResolvedValue(makeProviderDiffs()),
            }),
        );

        const advisories = diffAdvisories(result);
        expect(advisories).toHaveLength(1);
        // One line for the whole provider, not one per repo or per commit — a diff-less
        // provider is diff-less everywhere, and thousands of copies of one sentence is not a
        // report. Both numbers are asserted because only their PAIR distinguishes "one odd
        // repo" from "this provider never supplies diffs".
        expect(advisories[0]).toContain('3 commit(s)');
        expect(advisories[0]).toContain('2 repo(s)');
        expect(advisories[0]).toContain('[github]');
        // Every fallback request SUCCEEDED here, which is the only condition under which the line
        // is allowed to reassure the operator about the data. Pinned as the positive control for
        // the failure case below: without it, a regression that emitted the reassuring sentence
        // unconditionally would still pass that test.
        expect(advisories[0]).toContain('no metric is wrong');
        // An ADVISORY, not a failure: the fallback fetched the same diff, so classifying it as an
        // error would redden the provider and make the pipeline re-run the whole connector.
        expect(isAdvisoryError(advisories[0])).toBe(true);
    });

    /**
     * The count is of commits that TOOK the fallback, not of fallbacks that succeeded — and the
     * two populations must be reported differently.
     *
     * A failed fallback keeps the commit with EMPTY diffs (#271's preserved semantics: one bad
     * diff must not fail the repo), which means its file-level metrics are computed from nothing
     * while the cursor advances past it. Nothing else in the run mentions that — the fault is
     * swallowed — so this line is the only output about those commits, and it must not tell the
     * operator that nothing is wrong.
     */
    it('states the permanent loss, not "no metric is wrong", when a fallback fetch fails', async () => {
        seedDev(db, 'alice');
        // THREE diff-less commits, ONE failing fetch. The three numbers the report interpolates
        // — commits that fell back (3), repos they came from (1), and requests that failed (1) —
        // must be pairwise distinguishable, or a refactor that swapped `fallbackDiffCommits` for
        // `fallbackDiffFailures` would ship green while telling the operator the wrong recovery
        // scope: "3 commits are permanently understated" and "1 is" are different incidents.
        const result = await syncWith(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                getCommits: vi.fn().mockResolvedValue([
                    makeProviderCommit('alice', '2024-01-15T10:00:00Z', 's1', NO_PROVIDER_DIFFS),
                    makeProviderCommit('alice', '2024-01-15T11:00:00Z', 's2', NO_PROVIDER_DIFFS),
                    makeProviderCommit('alice', '2024-01-15T12:00:00Z', 's3', NO_PROVIDER_DIFFS),
                ]),
                getCommitDiff: vi
                    .fn()
                    .mockImplementation(async (_repo: string, sha: string) =>
                        sha === 's2'
                            ? Promise.reject(new Error('502 from the diff endpoint'))
                            : makeProviderDiffs(),
                    ),
            }),
        );

        // TWO lines now, and the split is the point (#280): request volume is true the moment
        // the requests are made, permanence is only true once the window is recorded as covered.
        const [volume, loss] = diffAdvisories(result);
        expect(diffAdvisories(result)).toHaveLength(2);

        expect(volume).toContain('3 commit(s)');
        expect(volume).toContain('1 repo(s)');
        // The failure count is named, and the reassuring sentence is NOT emitted.
        expect(volume).toContain('1 of those requests FAILED');
        expect(volume).not.toContain('no metric is wrong');
        // …and the volume line no longer makes the permanence claim itself.
        expect(volume).not.toContain('PERMANENT');

        // The claim about persisted state, on its own line, keyed to the FAILURE count.
        expect(loss).toContain('the 1 commit(s) whose fallback diff request failed');
        expect(loss).toContain('PERMANENT');
        // It must name the SAFE remedy. A bare cursor reset re-imports over surviving
        // raw_author_daily rows, which additively double every commit metric in the span (#262)
        // — a far larger corruption than the understatement being repaired.
        expect(loss).toContain('delete cascade');
        expect(loss).toContain('do NOT simply purge this provider\'s cursors');
        // The remedy is only reachable for a DB-registered provider: the admin delete route
        // refuses a config-file provider, and the cascade is skipped while the YAML entry still
        // owns the container — so a line that named it unconditionally would send half the
        // deployments to a no-op that looks like a repair.
        expect(loss).toContain('CONFIG-FILE provider cannot be deleted');
        // …and re-adding restores only the first-sync window, so the backfill step is part of
        // the remedy, not an optional extra.
        expect(loss).toContain('sync older history');

        // Still advisories: turning them red buys no recovery (the window is already recorded as
        // covered) and costs a full re-fetch of the connector.
        expect(isAdvisoryError(volume)).toBe(true);
        expect(isAdvisoryError(loss)).toBe(true);

        // The commits still count — a failed diff fetch degrades to empty diffs, it does not
        // drop the commit. The two that SUCCEEDED contribute 2 file entries each; s2 contributes
        // nothing, which is exactly the loss the second advisory states.
        const row = db
            .prepare(`SELECT commits, files_changed FROM git_snapshots WHERE date = '2024-01-15'`)
            .get() as {commits: number; files_changed: number};
        expect(row.commits).toBe(3);
        expect(row.files_changed).toBe(4);
    });

    /**
     * The blocker this split exists for. "The understatement is PERMANENT, nothing re-asks
     * them" is a claim about persisted state, and it is FALSE on every path that discards the
     * run's window — the commits are re-fetched intact next run and the zeros never land.
     *
     * Emitting it anyway is not a cosmetic overstatement: the remedy it names is destructive, so
     * a phantom loss report sends the operator to rebuild a span that was fine. That is why the
     * line is staged onto the cursor advance like the #275 drop advisories rather than pushed
     * where it is formatted.
     */
    it('does NOT claim permanent loss when the run\'s write is rolled back', async () => {
        seedDev(db, 'alice');
        db.exec('DROP TABLE pr_records');
        const result = await syncWith(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                getCommits: vi
                    .fn()
                    .mockResolvedValue([
                        makeProviderCommit('alice', '2024-01-15T10:00:00Z', 's1', NO_PROVIDER_DIFFS),
                    ]),
                getPullRequests: vi.fn().mockResolvedValue([makeProviderPR('alice')]),
                getCommitDiff: vi.fn().mockRejectedValue(new Error('502 from the diff endpoint')),
            }),
        );

        // Positive control: the write really did roll back, so no cursor advanced and the window
        // is intact.
        expect(result.errors.some((e) => e.includes('transaction rolled back'))).toBe(true);
        expect(countSnapshots(db)).toBe(0);

        const advisories = diffAdvisories(result);
        // The request-volume line still fires — those requests were really made and really
        // failed, whatever happened to the window afterwards.
        expect(advisories).toHaveLength(1);
        expect(advisories[0]).toContain('1 commit(s)');
        expect(advisories[0]).toContain('1 of those requests FAILED');
        // …but nothing claims the loss is permanent, and nothing sends the operator to a
        // destructive rebuild of a span that will be re-fetched next run.
        expect(advisories.some((a) => a.includes('PERMANENT'))).toBe(false);
        expect(advisories.some((a) => a.includes('delete cascade'))).toBe(false);
    });

    /**
     * The second discard path (#231): one repo's `getCommits` throws, so the provider is
     * incomplete and `syncProviders` skips it entirely — no snapshot write, no cursor advance,
     * whole window re-covered next run. The diff-less commits from the EARLIER repo already
     * incremented the counters, which is exactly how an unstaged permanence claim would leak out.
     */
    it('does NOT claim permanent loss when the provider\'s fetch was incomplete', async () => {
        seedDev(db, 'alice');
        const result = await syncWith(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1'), makeRepo('repo2')]),
                getCommits: vi
                    .fn()
                    .mockResolvedValueOnce([
                        makeProviderCommit('alice', '2024-01-15T10:00:00Z', 's1', NO_PROVIDER_DIFFS),
                    ])
                    .mockRejectedValueOnce(new Error('repo2 exploded')),
                getCommitDiff: vi.fn().mockRejectedValue(new Error('502 from the diff endpoint')),
            }),
        );

        // Positive control: the provider really was held, so its window is intact.
        expect(countSnapshots(db)).toBe(0);

        const advisories = diffAdvisories(result);
        expect(advisories).toHaveLength(1);
        expect(advisories[0]).toContain('1 of those requests FAILED');
        expect(advisories.some((a) => a.includes('PERMANENT'))).toBe(false);
    });

    /**
     * A run whose write was ROLLED BACK still reports the REQUEST-VOLUME half of the fallback
     * report. Those requests were really made against the provider's rate limit, and a run that
     * both took the slow path and threw its window away is if anything more worth saying.
     *
     * This is the opposite face of the "does NOT claim permanent loss when the run's write is
     * rolled back" test above: the two together pin the seam. Volume survives a discard; the
     * permanence claim does not. Untested in this direction, a "consistency" refactor that moved
     * the WHOLE report into the staging closure would be green and the slow path would go silent
     * on exactly the runs that are hardest to diagnose.
     */
    it('reports the fallback even when the run\'s write is rolled back', async () => {
        seedDev(db, 'alice');
        // Break a table the write transaction touches, so the whole run's data is discarded. A PR
        // is required to make the transaction reach `upsertPRRecord` at all — same fixture shape
        // as the #253 rollback tests above.
        db.exec('DROP TABLE pr_records');
        const result = await syncWith(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                getCommits: vi
                    .fn()
                    .mockResolvedValue([
                        makeProviderCommit('alice', '2024-01-15T10:00:00Z', 's1', NO_PROVIDER_DIFFS),
                    ]),
                getPullRequests: vi.fn().mockResolvedValue([makeProviderPR('alice')]),
                getCommitDiff: vi.fn().mockResolvedValue(makeProviderDiffs()),
            }),
        );

        // Positive control: the write really did roll back, so this is not a run that quietly
        // succeeded.
        expect(result.errors.some((e) => e.includes('transaction rolled back'))).toBe(true);
        expect(countSnapshots(db)).toBe(0);
        expect(diffAdvisories(result)[0]).toContain('1 commit(s)');
    });

    /**
     * The grain that matters for a REFACTOR that drops the field from one code path rather than
     * from a whole provider: the count is per commit, so a provider supplying diffs on some
     * commits and not others reports only the ones that fell back.
     */
    it('counts only the diff-less commits when a provider supplies diffs on some', async () => {
        seedDev(db, 'alice');
        const getCommitDiff = vi.fn().mockResolvedValue(makeProviderDiffs());
        const result = await syncWith(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                getCommits: vi.fn().mockResolvedValue([
                    makeProviderCommit('alice', '2024-01-15T10:00:00Z', 's1'),
                    makeProviderCommit('alice', '2024-01-15T11:00:00Z', 's2', NO_PROVIDER_DIFFS),
                    makeProviderCommit('alice', '2024-01-15T12:00:00Z', 's3'),
                ]),
                getCommitDiff,
            }),
        );

        expect(getCommitDiff.mock.calls).toEqual([['repo1', 's2']]);
        expect(diffAdvisories(result)[0]).toContain('1 commit(s)');
        expect(diffAdvisories(result)[0]).toContain('1 repo(s)');
    });

    /**
     * `[]` is an ANSWER, not an absence: Bitbucket and GitLab return it for a commit whose
     * diffstat 404s, and re-asking the endpoint that just refused is the duplicate request
     * #271 removed. So an empty array must NOT be counted as a fallback — otherwise the
     * advisory fires on a perfectly conformant provider and stops meaning anything.
     */
    it('treats an empty diffs array as supplied — no fallback, no advisory', async () => {
        seedDev(db, 'alice');
        const getCommitDiff = vi.fn().mockResolvedValue(makeProviderDiffs());
        const result = await syncWith(
            makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo1')]),
                getCommits: vi
                    .fn()
                    .mockResolvedValue([makeProviderCommit('alice', '2024-01-15T10:00:00Z', 's1', [])]),
                getCommitDiff,
            }),
        );

        expect(getCommitDiff).not.toHaveBeenCalled();
        expect(diffAdvisories(result)).toEqual([]);
    });
});
