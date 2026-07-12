import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper} from '../../../src/registry/developers';
import {GitSync} from '../../../src/connectors/git/sync';
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
            .prepare(`SELECT commits, lines_added FROM git_snapshots WHERE date = '2024-01-15'`)
            .get() as {commits: number; lines_added: number};
        expect(after1.commits).toBe(1);
        expect(after1.lines_added).toBe(50);

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
            .prepare(`SELECT commits, lines_added, data_source FROM git_snapshots WHERE date = '2024-01-15'`)
            .get() as {commits: number; lines_added: number; data_source: string};
        expect(after2.commits).toBe(2); // c1 + c2, not just c2
        expect(after2.lines_added).toBe(100); // 50 + 50
        expect(after2.data_source).toBe('github'); // same provider on both runs
        expect(countSnapshots(db)).toBe(1);
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
});
