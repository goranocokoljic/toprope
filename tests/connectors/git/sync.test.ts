import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper, linkDeveloper} from '../../../src/registry/developers';
import {GitSync} from '../../../src/connectors/git/sync';
import type {GitConnectorConfig} from '../../../src/config/types';
import type {GitCommit, GitPullRequest, GitRepo} from '../../../src/connectors/git/client';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function makeConfig(overrides: Partial<GitConnectorConfig> = {}): GitConnectorConfig {
    return {
        enabled: true,
        org: 'test-org',
        api_token: 'test-token',
        repos: [],
        ...overrides,
    };
}

function makeRepo(name: string): GitRepo {
    return {
        full_name: `test-org/${name}`,
        name,
        default_branch: 'main',
        pushed_at: '2024-01-15T12:00:00Z',
    };
}

function makeCommit(login: string, date = '2024-01-15T10:00:00Z'): GitCommit {
    return {
        sha: `sha-${Date.now()}-${Math.random()}`,
        author_login: login,
        author_email: `${login}@example.com`,
        author_date: date,
        message: 'feat: add feature',
        additions: 50,
        deletions: 10,
        files_changed: 2,
        files: [
            {filename: 'src/foo.ts', additions: 30, deletions: 5, changes: 35, status: 'modified'},
            {filename: 'src/bar.ts', additions: 20, deletions: 5, changes: 25, status: 'modified'},
        ],
    };
}

function makePR(login: string): GitPullRequest {
    return {
        number: 1,
        title: 'feat: add feature',
        state: 'merged',
        author_login: login,
        created_at: '2024-01-15T08:00:00Z',
        merged_at: '2024-01-16T10:00:00Z',
        closed_at: '2024-01-16T10:00:00Z',
        additions: 50,
        deletions: 10,
        changed_files: 2,
        review_comments: 3,
    };
}

function seedDev(db: Database.Database, login: string): string {
    try {
        addTeam(db, 'eng');
    } catch {
        // team may already exist
    }
    const dev = addDeveloper(db, login, 'eng', `${login}@test.com`, login);
    linkDeveloper(db, dev.id, {});
    // Manually set github external_id
    db.prepare(`UPDATE developers SET external_ids = '{"github":"${login}"}' WHERE id = ?`).run(dev.id);
    return dev.id;
}

function countSnapshots(db: Database.Database): number {
    const row = db.prepare('SELECT COUNT(*) as n FROM git_snapshots').get() as {n: number};
    return row.n;
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

    it('returns error when org or token is missing', async () => {
        const syncer = new GitSync({enabled: true});
        const result = await syncer.sync(db);

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toMatch(/Missing required config/);
        expect(result.snapshotsWritten).toBe(0);
    });

    it('writes git_snapshots for known developer', async () => {
        const devLogin = 'alice';
        seedDev(db, devLogin);

        const {GitClient} = await import('../../../src/connectors/git/client');
        vi.spyOn(GitClient.prototype, 'listRepos').mockResolvedValue([makeRepo('myrepo')]);
        vi.spyOn(GitClient.prototype, 'getCommits').mockResolvedValue([makeCommit(devLogin)]);
        vi.spyOn(GitClient.prototype, 'getPullRequests').mockResolvedValue([]);

        const syncer = new GitSync(makeConfig());
        const result = await syncer.sync(db);

        expect(result.errors).toHaveLength(0);
        expect(result.snapshotsWritten).toBeGreaterThan(0);
        expect(countSnapshots(db)).toBeGreaterThan(0);
    });

    it('skips commits from unknown developers', async () => {
        // Developer not in registry
        const {GitClient} = await import('../../../src/connectors/git/client');
        vi.spyOn(GitClient.prototype, 'listRepos').mockResolvedValue([makeRepo('myrepo')]);
        vi.spyOn(GitClient.prototype, 'getCommits').mockResolvedValue([makeCommit('unknown-user')]);
        vi.spyOn(GitClient.prototype, 'getPullRequests').mockResolvedValue([]);

        const syncer = new GitSync(makeConfig());
        const result = await syncer.sync(db);

        expect(result.errors).toHaveLength(0);
        expect(countSnapshots(db)).toBe(0);
    });

    it('handles empty repo gracefully (no errors, no snapshots)', async () => {
        const {GitClient} = await import('../../../src/connectors/git/client');
        vi.spyOn(GitClient.prototype, 'listRepos').mockResolvedValue([makeRepo('empty-repo')]);
        vi.spyOn(GitClient.prototype, 'getCommits').mockResolvedValue([]);
        vi.spyOn(GitClient.prototype, 'getPullRequests').mockResolvedValue([]);

        const syncer = new GitSync(makeConfig());
        const result = await syncer.sync(db);

        expect(result.errors).toHaveLength(0);
        expect(countSnapshots(db)).toBe(0);
    });

    it('respects include repo list', async () => {
        const {GitClient} = await import('../../../src/connectors/git/client');
        vi.spyOn(GitClient.prototype, 'listRepos').mockResolvedValue([
            makeRepo('included'),
            makeRepo('excluded'),
        ]);
        const getCommitsSpy = vi
            .spyOn(GitClient.prototype, 'getCommits')
            .mockResolvedValue([]);
        vi.spyOn(GitClient.prototype, 'getPullRequests').mockResolvedValue([]);

        const syncer = new GitSync(makeConfig({repos: ['included']}));
        await syncer.sync(db);

        const calledRepos = getCommitsSpy.mock.calls.map((c) => c[0]);
        expect(calledRepos).toContain('included');
        expect(calledRepos).not.toContain('excluded');
    });

    it('respects exclude repo list', async () => {
        const {GitClient} = await import('../../../src/connectors/git/client');
        vi.spyOn(GitClient.prototype, 'listRepos').mockResolvedValue([
            makeRepo('keep'),
            makeRepo('skip'),
        ]);
        const getCommitsSpy = vi
            .spyOn(GitClient.prototype, 'getCommits')
            .mockResolvedValue([]);
        vi.spyOn(GitClient.prototype, 'getPullRequests').mockResolvedValue([]);

        const syncer = new GitSync(makeConfig({repos: ['exclude:skip']}));
        await syncer.sync(db);

        const calledRepos = getCommitsSpy.mock.calls.map((c) => c[0]);
        expect(calledRepos).toContain('keep');
        expect(calledRepos).not.toContain('skip');
    });

    it('advances sync state cursor after successful sync', async () => {
        const {GitClient} = await import('../../../src/connectors/git/client');
        vi.spyOn(GitClient.prototype, 'listRepos').mockResolvedValue([]);

        const syncer = new GitSync(makeConfig());
        expect(syncer.getLastSyncTime(db)).toBeNull();

        await syncer.sync(db);

        expect(syncer.getLastSyncTime(db)).not.toBeNull();
    });

    it('writes PR metrics alongside commit metrics', async () => {
        const devLogin = 'alice';
        seedDev(db, devLogin);

        const {GitClient} = await import('../../../src/connectors/git/client');
        vi.spyOn(GitClient.prototype, 'listRepos').mockResolvedValue([makeRepo('myrepo')]);
        vi.spyOn(GitClient.prototype, 'getCommits').mockResolvedValue([]);
        vi.spyOn(GitClient.prototype, 'getPullRequests').mockResolvedValue([makePR(devLogin)]);

        const syncer = new GitSync(makeConfig());
        await syncer.sync(db);

        const row = db
            .prepare(
                `SELECT prs_opened, prs_merged FROM git_snapshots WHERE date = '2024-01-15'`,
            )
            .get() as {prs_opened: number; prs_merged: number} | undefined;

        expect(row).toBeDefined();
        expect(row!.prs_opened).toBe(1);
    });

    it('records error when listRepos fails and returns early', async () => {
        const {GitClient} = await import('../../../src/connectors/git/client');
        vi.spyOn(GitClient.prototype, 'listRepos').mockRejectedValue(
            new Error('network failure'),
        );

        const syncer = new GitSync(makeConfig());
        const result = await syncer.sync(db);

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toMatch(/network failure/);
    });

    it('stores correct churn_rate when same file changed twice within window', async () => {
        const devLogin = 'alice';
        seedDev(db, devLogin);

        const commits: GitCommit[] = [
            {
                sha: 'c1',
                author_login: devLogin,
                author_email: 'alice@example.com',
                author_date: '2024-01-15T08:00:00Z',
                message: 'first touch',
                additions: 100,
                deletions: 0,
                files_changed: 1,
                files: [{filename: 'src/foo.ts', additions: 100, deletions: 0, changes: 100, status: 'modified'}],
            },
            {
                sha: 'c2',
                author_login: devLogin,
                author_email: 'alice@example.com',
                author_date: '2024-01-15T12:00:00Z', // 4 hours later — within 48h window
                message: 'second touch',
                additions: 50,
                deletions: 50,
                files_changed: 1,
                files: [{filename: 'src/foo.ts', additions: 50, deletions: 50, changes: 100, status: 'modified'}],
            },
        ];

        const {GitClient} = await import('../../../src/connectors/git/client');
        vi.spyOn(GitClient.prototype, 'listRepos').mockResolvedValue([makeRepo('myrepo')]);
        vi.spyOn(GitClient.prototype, 'getCommits').mockResolvedValue(commits);
        vi.spyOn(GitClient.prototype, 'getPullRequests').mockResolvedValue([]);

        const syncer = new GitSync(makeConfig());
        await syncer.sync(db);

        const row = db
            .prepare(`SELECT code_churn_rate FROM git_snapshots WHERE date = '2024-01-15'`)
            .get() as {code_churn_rate: number} | undefined;

        expect(row).toBeDefined();
        expect(row!.code_churn_rate).toBeGreaterThan(0);
    });
});
