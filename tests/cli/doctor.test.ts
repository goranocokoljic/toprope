import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {runMigrations} from '../../src/storage/migrator';
import {runDoctor, exactConfiguredRepos, findMissingRepos} from '../../src/cli/doctor';
import {createProvider} from '../../src/connectors/git/providers/store';
import {loadServerKey} from '../../src/connectors/git/providers/secret';
import type {TopropeConfig} from '../../src/config/types';
import type {GitProvider, GitProviderConfig} from '../../src/connectors/git/providers/types';

// Keep createGitProvider real by default (so the invalid-config test still sees
// the factory throw), but wrap it in a spy so the DB-provider test can stub one
// call and avoid a live network probe.
vi.mock('../../src/connectors/git/providers/factory', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/connectors/git/providers/factory')>();
    return {...actual, createGitProvider: vi.fn(actual.createGitProvider)};
});

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');
const DOCTOR_TEST_KEY = Buffer.alloc(32, 5).toString('base64');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function disabledConfig(): TopropeConfig {
    return {
        server: {port: 8080, host: '0.0.0.0'},
        storage: {type: 'sqlite', sqlite_path: ':memory:'},
        connectors: {
            copilot: {enabled: false},
            claude_code: {enabled: false},
            windsurf: {enabled: false},
            cursor: {enabled: false},
            git: {enabled: false},
        },
        expenses: {},
        aggregation: {},
        summaries: {enabled: false},
        alerts: {},
        dashboard: {},
        teams: [],
    } as unknown as TopropeConfig;
}

describe('runDoctor', () => {
    let db: Database.Database;
    let output: string[];
    let errors: string[];
    let tmpConfigPath: string;

    beforeEach(() => {
        db = makeDb();
        output = [];
        errors = [];
        vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
            output.push(args.join(' '));
        });
        vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
            errors.push(args.join(' '));
        });

        tmpConfigPath = path.join(os.tmpdir(), `toprope-test-${Date.now()}.yaml`);
        fs.writeFileSync(tmpConfigPath, 'server:\n  port: 8080\n');
    });

    afterEach(() => {
        db.close();
        vi.restoreAllMocks();
        if (fs.existsSync(tmpConfigPath)) {
            fs.unlinkSync(tmpConfigPath);
        }
    });

    it('passes all checks when config exists and all connectors disabled', async () => {
        const result = await runDoctor(db, disabledConfig(), tmpConfigPath, MIGRATIONS_DIR);
        expect(result).toBe(true);
        const combined = output.join('\n');
        expect(combined).toContain('Toprope Doctor');
        expect(combined).toContain('All checks passed');
    });

    it('fails config check when config file missing', async () => {
        const nonExistentPath = path.join(os.tmpdir(), 'toprope-missing-12345.yaml');
        const result = await runDoctor(db, disabledConfig(), nonExistentPath, MIGRATIONS_DIR);
        expect(result).toBe(false);
        const allOutput = [...output, ...errors].join('\n');
        expect(allOutput).toContain('✗');
        expect(allOutput).toContain('Config file');
    });

    it('passes database check when all migrations applied', async () => {
        const result = await runDoctor(db, disabledConfig(), tmpConfigPath, MIGRATIONS_DIR);
        expect(result).toBe(true);
        const combined = output.join('\n');
        expect(combined).toContain('✓');
    });

    it('fails database check when pending migrations exist', async () => {
        const fakeMigrationsDir = path.join(os.tmpdir(), `toprope-migrations-${Date.now()}`);
        fs.mkdirSync(fakeMigrationsDir, {recursive: true});
        fs.writeFileSync(
            path.join(fakeMigrationsDir, '999_pending.sql'),
            'CREATE TABLE pending_test (id TEXT PRIMARY KEY);',
        );

        const bareDb = new Database(':memory:');
        bareDb.pragma('foreign_keys = ON');

        try {
            const result = await runDoctor(
                bareDb,
                disabledConfig(),
                tmpConfigPath,
                fakeMigrationsDir,
            );
            expect(result).toBe(false);
            const allOutput = [...output, ...errors].join('\n');
            expect(allOutput).toContain('pending');
        } finally {
            bareDb.close();
            fs.rmSync(fakeMigrationsDir, {recursive: true});
        }
    });

    it('skips GitHub token check when copilot disabled', async () => {
        const result = await runDoctor(db, disabledConfig(), tmpConfigPath, MIGRATIONS_DIR);
        expect(result).toBe(true);
        const combined = output.join('\n');
        expect(combined).toContain('disabled — skipped');
    });

    it('fails GitHub token check when copilot enabled but no token', async () => {
        const config = disabledConfig();
        (config.connectors.copilot as {enabled: boolean; github_org: string}).enabled = true;
        (config.connectors.copilot as {enabled: boolean; github_org: string}).github_org = 'myorg';

        const savedToken = process.env.GITHUB_TOKEN;
        delete process.env.GITHUB_TOKEN;

        try {
            const result = await runDoctor(db, config, tmpConfigPath, MIGRATIONS_DIR);
            expect(result).toBe(false);
            const allOutput = [...output, ...errors].join('\n');
            expect(allOutput).toContain('GitHub API token');
            expect(allOutput).toContain('No token');
        } finally {
            if (savedToken !== undefined) process.env.GITHUB_TOKEN = savedToken;
        }
    });

    it('fails Anthropic key check when claude_code enabled but no key', async () => {
        const config = disabledConfig();
        (config.connectors.claude_code as {enabled: boolean; org_id: string}).enabled = true;
        (config.connectors.claude_code as {enabled: boolean; org_id: string}).org_id = 'org-123';

        const savedKey = process.env.ANTHROPIC_ADMIN_API_KEY;
        delete process.env.ANTHROPIC_ADMIN_API_KEY;

        try {
            const result = await runDoctor(db, config, tmpConfigPath, MIGRATIONS_DIR);
            expect(result).toBe(false);
            const allOutput = [...output, ...errors].join('\n');
            expect(allOutput).toContain('Anthropic API key');
            expect(allOutput).toContain('No API key');
        } finally {
            if (savedKey !== undefined) process.env.ANTHROPIC_ADMIN_API_KEY = savedKey;
        }
    });

    it('fails Windsurf key check when windsurf enabled but no key', async () => {
        const config = disabledConfig();
        (config.connectors.windsurf as {enabled: boolean}).enabled = true;

        const savedKey = process.env.WINDSURF_SERVICE_KEY;
        delete process.env.WINDSURF_SERVICE_KEY;

        try {
            const result = await runDoctor(db, config, tmpConfigPath, MIGRATIONS_DIR);
            expect(result).toBe(false);
            const allOutput = [...output, ...errors].join('\n');
            expect(allOutput).toContain('Windsurf service key');
            expect(allOutput).toContain('No service key');
        } finally {
            if (savedKey !== undefined) process.env.WINDSURF_SERVICE_KEY = savedKey;
        }
    });

    it('fails git providers check when nothing is configured', async () => {
        const config = disabledConfig();
        (config.connectors.git as {enabled: boolean}).enabled = true;

        const savedToken = process.env.GITHUB_TOKEN;
        delete process.env.GITHUB_TOKEN;

        try {
            const result = await runDoctor(db, config, tmpConfigPath, MIGRATIONS_DIR);
            expect(result).toBe(false);
            const allOutput = [...output, ...errors].join('\n');
            expect(allOutput).toContain('Git providers');
            expect(allOutput).toContain('No git providers configured');
        } finally {
            if (savedToken !== undefined) process.env.GITHUB_TOKEN = savedToken;
        }
    });

    it('fails git providers check when github shorthand has org but no token', async () => {
        const config = disabledConfig();
        (config.connectors.git as {enabled: boolean; org: string; api_token?: string}).enabled = true;
        (config.connectors.git as {enabled: boolean; org: string; api_token?: string}).org = 'myorg';
        (config.connectors.git as {enabled: boolean; org: string; api_token?: string}).api_token =
            undefined;

        const savedToken = process.env.GITHUB_TOKEN;
        delete process.env.GITHUB_TOKEN;

        try {
            const result = await runDoctor(db, config, tmpConfigPath, MIGRATIONS_DIR);
            expect(result).toBe(false);
            const allOutput = [...output, ...errors].join('\n');
            expect(allOutput).toContain('Git providers');
            expect(allOutput).toContain('no API token');
        } finally {
            if (savedToken !== undefined) process.env.GITHUB_TOKEN = savedToken;
        }
    });

    it('fails per-provider git check when a providers[] entry is missing required fields', async () => {
        const config = disabledConfig();
        // Bitbucket entry without a workspace — factory validation rejects it
        // synchronously, so this exercises the provider-aware path with no network.
        (config.connectors.git as {enabled: boolean; providers: unknown[]}).enabled = true;
        (config.connectors.git as {enabled: boolean; providers: unknown[]}).providers = [
            {type: 'bitbucket', auth: {type: 'app_password', username: 'u', app_password: 'p'}},
        ];

        const result = await runDoctor(db, config, tmpConfigPath, MIGRATIONS_DIR);
        expect(result).toBe(false);
        const allOutput = [...output, ...errors].join('\n');
        expect(allOutput).toContain('Git: bitbucket');
        expect(allOutput).toContain('workspace');
    });

    it('validates an enabled DB-connected provider even with no config providers (#196)', async () => {
        const savedKey = process.env.TOPROPE_SECRET_KEY;
        process.env.TOPROPE_SECRET_KEY = DOCTOR_TEST_KEY;
        try {
            // A UI-connected provider lives only in the DB, not in the config file.
            createProvider(db, loadServerKey(), {
                config: {type: 'github', org: 'db-org', auth: {type: 'token', api_token: 'db-token'}},
                enabled: true,
            });

            const {createGitProvider} = await import('../../src/connectors/git/providers/factory');
            const mockProvider = {
                name: 'github',
                checkAccess: vi.fn().mockResolvedValue(undefined),
                listRepos: vi.fn().mockResolvedValue([]),
                getCommits: vi.fn(),
                getPullRequests: vi.fn(),
                getReviewComments: vi.fn(),
                getPRReviews: vi.fn(),
                getCommitDiff: vi.fn(),
            } as unknown as GitProvider;
            (createGitProvider as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockProvider);

            const config = disabledConfig();
            (config.connectors.git as {enabled: boolean}).enabled = true;

            const result = await runDoctor(db, config, tmpConfigPath, MIGRATIONS_DIR);

            const allOutput = [...output, ...errors].join('\n');
            // The DB provider was picked up and checked — not reported as "none configured".
            expect(allOutput).toContain('Git: github');
            expect(allOutput).not.toContain('No git providers configured');
            expect(createGitProvider).toHaveBeenCalledWith(
                expect.objectContaining({type: 'github', org: 'db-org'}),
            );
            expect(result).toBe(true);
        } finally {
            if (savedKey === undefined) delete process.env.TOPROPE_SECRET_KEY;
            else process.env.TOPROPE_SECRET_KEY = savedKey;
        }
    });

    it('reports "no valid git providers" when a providers[] array has only malformed entries', async () => {
        const config = disabledConfig();
        // providers array present (non-empty) but every entry lacks a "type", so
        // the resolver yields nothing → the array-specific diagnostic fires.
        (config.connectors.git as {enabled: boolean; providers: unknown[]}).enabled = true;
        (config.connectors.git as {enabled: boolean; providers: unknown[]}).providers = [{nope: true}];

        const result = await runDoctor(db, config, tmpConfigPath, MIGRATIONS_DIR);

        expect(result).toBe(false);
        const allOutput = [...output, ...errors].join('\n');
        expect(allOutput).toContain('No valid git providers configured');
    });

    it('skips summary model check when summaries disabled', async () => {
        const result = await runDoctor(db, disabledConfig(), tmpConfigPath, MIGRATIONS_DIR);
        expect(result).toBe(true);
        const combined = output.join('\n');
        expect(combined).toContain('Summary model');
        expect(combined).toContain('skipped');
    });

    it('outputs fix suggestions for failed checks', async () => {
        const nonExistentPath = path.join(os.tmpdir(), 'toprope-missing-99999.yaml');
        await runDoctor(db, disabledConfig(), nonExistentPath, MIGRATIONS_DIR);
        const allOutput = [...output, ...errors].join('\n');
        expect(allOutput).toContain('Fix:');
    });

    it('returns true when all connectors disabled and config valid', async () => {
        const result = await runDoctor(db, disabledConfig(), tmpConfigPath, MIGRATIONS_DIR);
        expect(result).toBe(true);
    });
});

describe('configured repo verification helpers', () => {
    function bitbucket(repos?: string[]): GitProviderConfig {
        return {
            type: 'bitbucket',
            workspace: 'ws',
            auth: {type: 'app_password', username: 'u', app_password: 'p'},
            repos,
        };
    }

    it('extracts exact include slugs, skipping globs and exclude entries', () => {
        expect(exactConfiguredRepos(bitbucket(['a', 'team-*', 'include:b', 'exclude:c']))).toEqual([
            'a',
            'b',
        ]);
    });

    it('returns empty when no repos configured', () => {
        expect(exactConfiguredRepos(bitbucket())).toEqual([]);
        expect(findMissingRepos([], ['anything'])).toEqual([]);
    });

    it('flags configured slugs absent from the repo list', () => {
        expect(findMissingRepos(['good', 'typo'], ['good', 'other'])).toEqual(['typo']);
    });

    it('matches a short slug against a namespaced repo name (GitLab)', () => {
        expect(findMissingRepos(['myrepo'], ['group/myrepo'])).toEqual([]);
    });
});
