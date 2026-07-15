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
    getEarliestSyncedWatermark,
    EARLIEST_SYNC_EPOCH,
    FIRST_SYNC_WINDOW_MIN_MONTHS,
    FIRST_SYNC_WINDOW_MAX_MONTHS,
    FIRST_SYNC_WINDOW_DEFAULT_MONTHS,
    type GitSyncProgress,
    type GitSyncStage,
} from '../../../src/connectors/git/sync';
import {createProvider} from '../../../src/connectors/git/providers/store';
import {loadServerKey} from '../../../src/connectors/git/providers/secret';
import type {GitConnectorConfig} from '../../../src/config/types';
import type {GitProvider, GitProviderConfig, GitRepo, GitCommit, GitPR, GitReviewComment, GitFileDiff} from '../../../src/connectors/git/providers/types';

// Stub createGitProvider (so no network) but keep validateGitProviderConfig real,
// so the store/codec that seed DB providers in the integration tests below work.
vi.mock('../../../src/connectors/git/providers/factory', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/connectors/git/providers/factory')>();
    return {...actual, createGitProvider: vi.fn()};
});

// A valid base64-encoded 32-byte key so loadServerKey() succeeds for DB providers.
const TEST_SECRET_KEY = Buffer.alloc(32, 9).toString('base64');

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');

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

function makeProviderCommit(username: string, date = '2024-01-15T10:00:00Z', sha?: string): GitCommit {
    return {
        sha: sha ?? `sha-${Date.now()}-${Math.random()}`,
        author: {name: username, email: `${username}@example.com`, username},
        date,
        message: 'feat: add feature',
        additions: 50,
        deletions: 10,
        filesChanged: ['src/foo.ts', 'src/bar.ts'],
    };
}

function makeProviderDiffs(repoPrefix = ''): GitFileDiff[] {
    return [
        {path: `${repoPrefix}src/foo.ts`, additions: 30, deletions: 5, status: 'modified'},
        {path: `${repoPrefix}src/bar.ts`, additions: 20, deletions: 5, status: 'modified'},
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

        expect(createGitProvider).toHaveBeenCalledWith(expect.objectContaining({type: 'github', org: 'myorg'}));
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
            getCommitDiff: vi.fn().mockResolvedValue(makeProviderDiffs()),
        });
        createGitProvider.mockReturnValue(provider);

        const syncer = new GitSync(makeGithubConfig());
        const result = await syncer.sync(db);

        expect(result.errors.filter((e) => !e.includes('Unmatched'))).toHaveLength(0);
        expect(result.snapshotsWritten).toBeGreaterThan(0);
        expect(countSnapshots(db)).toBeGreaterThan(0);
    });

    it('skips commits from unknown developers (no matching record)', async () => {
        const createGitProvider = await getCreateGitProvider();
        const commit = makeProviderCommit('unknown-user');
        const provider = makeMockProvider({
            listRepos: vi.fn().mockResolvedValue([makeRepo('myrepo')]),
            getCommits: vi.fn().mockResolvedValue([commit]),
            getCommitDiff: vi.fn().mockResolvedValue([]),
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
            getCommitDiff: vi.fn().mockResolvedValue(makeProviderDiffs()),
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
        const commit1 = makeProviderCommit(devLogin, '2024-01-15T08:00:00Z', 'c1');
        const commit2 = makeProviderCommit(devLogin, '2024-01-15T12:00:00Z', 'c2');
        const provider = makeMockProvider({
            listRepos: vi.fn().mockResolvedValue([makeRepo('myrepo')]),
            getCommits: vi.fn().mockResolvedValue([commit1, commit2]),
            getCommitDiff: vi.fn().mockResolvedValue([
                {path: 'myrepo/src/foo.ts', additions: 100, deletions: 0, status: 'modified'},
            ]),
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
            filesChanged: ['src/x.ts'],
        };
        const provider = makeMockProvider({
            listRepos: vi.fn().mockResolvedValue([makeRepo('myrepo')]),
            getCommits: vi.fn().mockResolvedValue([commit]),
            getCommitDiff: vi.fn().mockResolvedValue([{path: 'src/x.ts', additions: 20, deletions: 5, status: 'modified'}]),
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
            filesChanged: ['src/a.ts'],
        };
        const provider = makeMockProvider({
            listRepos: vi.fn().mockResolvedValue([makeRepo('myrepo')]),
            getCommits: vi.fn().mockResolvedValue([commit]),
            getCommitDiff: vi
                .fn()
                .mockResolvedValue([{path: 'src/a.ts', additions: 10, deletions: 2, status: 'modified'}]),
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
            getCommitDiff: vi.fn().mockResolvedValue(makeProviderDiffs()),
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
            filesChanged: ['src/y.ts'],
        };

        const githubProvider = makeMockProvider({
            name: 'github',
            listRepos: vi.fn().mockResolvedValue([makeRepo('gh-repo')]),
            getCommits: vi.fn().mockResolvedValue([githubCommit]),
            getCommitDiff: vi.fn().mockResolvedValue([{path: 'src/x.ts', additions: 50, deletions: 10, status: 'modified'}]),
        });
        const bitbucketProvider = makeMockProvider({
            name: 'bitbucket',
            listRepos: vi.fn().mockResolvedValue([makeRepo('bb-repo')]),
            getCommits: vi.fn().mockResolvedValue([bitbucketCommit]),
            getCommitDiff: vi.fn().mockResolvedValue([{path: 'src/y.ts', additions: 30, deletions: 5, status: 'modified'}]),
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
            getCommitDiff: vi.fn().mockResolvedValue(makeProviderDiffs()),
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
                filesChanged: ['src/y.ts'],
            }]),
            getCommitDiff: vi.fn().mockResolvedValue([{path: 'src/y.ts', additions: 20, deletions: 3, status: 'modified'}]),
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
            getCommitDiff: vi.fn().mockResolvedValue(makeProviderDiffs()),
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
            getCommitDiff: vi.fn().mockResolvedValue(makeProviderDiffs()),
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
                filesChanged: ['src/y.ts'],
            }]),
            getCommitDiff: vi.fn().mockResolvedValue([{path: 'src/y.ts', additions: 10, deletions: 2, status: 'modified'}]),
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
            filesChanged: ['src/a.ts'],
        });
        createGitProvider.mockReturnValueOnce(makeMockProvider({
            name: 'github',
            listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a')]),
            getCommits: vi.fn().mockResolvedValue([bigCommit('b1'), bigCommit('b2')]),
            getCommitDiff: vi.fn().mockResolvedValue([]),
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
                filesChanged: ['src/a.ts'],
            }]),
            getCommitDiff: vi.fn().mockResolvedValue([]),
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
            getCommitDiff: vi.fn().mockResolvedValue(makeProviderDiffs()),
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
            getCommitDiff: vi.fn().mockResolvedValue(makeProviderDiffs()),
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
        expect(createGitProvider).toHaveBeenCalledWith(expect.objectContaining({org: 'only-org'}));
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
                    getCommitDiff: vi.fn().mockResolvedValue(makeProviderDiffs()),
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
                    getCommitDiff: vi.fn().mockResolvedValue(makeProviderDiffs()),
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

describe('getEarliestSyncedWatermark — lazy default (#229)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });

    afterEach(() => {
        db.close();
    });

    it('defaults to now − default window when no watermark is stored', () => {
        const now = '2026-03-15T12:00:00.000Z';
        expect(getEarliestSyncedWatermark(db, 'github', 'test-org', now)).toBe(
            firstSyncSince(now, FIRST_SYNC_WINDOW_DEFAULT_MONTHS),
        );
    });

    it('returns the stored watermark verbatim once set', () => {
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
            earliestSyncStateKey('github', 'test-org'),
            '2024-01-01T00:00:00.000Z',
        );
        expect(
            getEarliestSyncedWatermark(db, 'github', 'test-org', '2026-03-15T12:00:00.000Z'),
        ).toBe('2024-01-01T00:00:00.000Z');
    });

    it('falls back to now (a zero-width window the guard rejects) when now is unparseable and unset', () => {
        expect(getEarliestSyncedWatermark(db, 'github', 'test-org', 'not-a-date')).toBe('not-a-date');
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
                getCommitDiff: vi.fn().mockResolvedValue(makeProviderDiffs('repo1/')),
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
        expect(getCommits).toHaveBeenCalledWith('repo1', backfill.since, backfill.until);
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
                getCommitDiff: vi.fn().mockResolvedValue(makeProviderDiffs('repo1/')),
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
        expect(target >= getEarliestSyncedWatermark(db, 'github', 'test-org', '2026-03-15T12:00:00.000Z')).toBe(
            true,
        );
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
                    getCommitDiff: vi.fn().mockResolvedValue(makeProviderDiffs()),
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
                    getCommitDiff: vi.fn().mockResolvedValue(makeProviderDiffs()),
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
                    getCommitDiff: vi.fn().mockResolvedValue(makeProviderDiffs()),
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
                    getCommitDiff: vi.fn().mockResolvedValue(makeProviderDiffs()),
                }),
            );

            const backfill = {since: '2024-01-01T00:00:00.000Z', until: '2024-07-01T00:00:00.000Z'};
            await new GitSync({enabled: false}).syncProviders(db, [CONFIG], undefined, {backfill});

            // The older slice was not fully fetched, so the watermark must NOT drop to
            // `since` — else the un-fetched span below the old watermark is lost.
            expect(readState(EARLIEST_KEY)).toBeUndefined();
        });
    });
});
