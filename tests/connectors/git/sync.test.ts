import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper} from '../../../src/registry/developers';
import {GitSync} from '../../../src/connectors/git/sync';
import type {GitConnectorConfig} from '../../../src/config/types';
import type {GitProvider, GitRepo, GitCommit, GitPR, GitReviewComment, GitFileDiff} from '../../../src/connectors/git/providers/types';

vi.mock('../../../src/connectors/git/providers/factory', () => ({
    createGitProvider: vi.fn(),
}));

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
            review_event_count: number;
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

        it('persists the observed review_event_count and carries it forward on a failed re-sync', async () => {
            seedDev(db, 'alice');
            const createGitProvider = await getCreateGitProvider();
            // Two verdict events, neither a send-back (e.g. two approvals): the
            // observed event count is 2, but changes_requested_count is 0 and
            // review_rounds is 1. Reverse-engineering the event count from
            // review_rounds would wrongly recover 1, not 2 — so persist it.
            const goodProvider = makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a')]),
                getPullRequests: vi.fn().mockResolvedValue([makeProviderPR('alice')]),
                getPRReviews: vi.fn().mockResolvedValue([
                    {author: {name: '', email: '', username: 'bob'}, state: 'approved', submittedAt: '2024-01-15T12:00:00Z', prId: '1'},
                    {author: {name: '', email: '', username: 'carol'}, state: 'approved', submittedAt: '2024-01-16T09:00:00Z', prId: '1'},
                ]),
            });
            createGitProvider.mockReturnValue(goodProvider);
            await new GitSync(makeGithubConfig()).sync(db);
            expect(getPRRecords()[0].review_event_count).toBe(2);
            expect(getPRRecords()[0].changes_requested_count).toBe(0);

            // Re-sync with the verdict fetch failing: the observed count must be
            // preserved, not reset to zero or inferred from review_rounds.
            const badProvider = makeMockProvider({
                listRepos: vi.fn().mockResolvedValue([makeRepo('repo-a')]),
                getPullRequests: vi.fn().mockResolvedValue([makeProviderPR('alice')]),
                getPRReviews: vi.fn().mockRejectedValue(new Error('rate limited')),
            });
            createGitProvider.mockReturnValue(badProvider);
            await new GitSync(makeGithubConfig()).sync(db);
            expect(getPRRecords()[0].review_event_count).toBe(2);
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
