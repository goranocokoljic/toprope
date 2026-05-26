import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {runMigrations} from '../../src/storage/migrator';
import {runDoctor} from '../../src/cli/doctor';
import type {GovProxyConfig} from '../../src/config/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function disabledConfig(): GovProxyConfig {
    return {
        server: {port: 8080, host: '0.0.0.0'},
        storage: {type: 'sqlite', sqlite_path: ':memory:'},
        connectors: {
            copilot: {enabled: false},
            claude_code: {enabled: false},
            windsurf: {enabled: false},
            git: {enabled: false},
        },
        expenses: {},
        aggregation: {},
        summaries: {enabled: false},
        alerts: {},
        dashboard: {},
        teams: [],
    } as unknown as GovProxyConfig;
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

        tmpConfigPath = path.join(os.tmpdir(), `govproxy-test-${Date.now()}.yaml`);
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
        expect(combined).toContain('GovProxy Doctor');
        expect(combined).toContain('All checks passed');
    });

    it('fails config check when config file missing', async () => {
        const nonExistentPath = path.join(os.tmpdir(), 'govproxy-missing-12345.yaml');
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
        const fakeMigrationsDir = path.join(os.tmpdir(), `govproxy-migrations-${Date.now()}`);
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

    it('fails git repos check when git enabled but no repos configured', async () => {
        const config = disabledConfig();
        (config.connectors.git as {enabled: boolean; api_token: string; repos: string[]}).enabled =
            true;
        (config.connectors.git as {enabled: boolean; api_token: string; repos: string[]}).api_token =
            'ghp_fake';
        (config.connectors.git as {enabled: boolean; api_token: string; repos: string[]}).repos = [];

        const result = await runDoctor(db, config, tmpConfigPath, MIGRATIONS_DIR);
        expect(result).toBe(false);
        const allOutput = [...output, ...errors].join('\n');
        expect(allOutput).toContain('Git repos');
        expect(allOutput).toContain('No repos configured');
    });

    it('fails git repos check when git enabled but no token', async () => {
        const config = disabledConfig();
        (
            config.connectors.git as {enabled: boolean; api_token?: string; repos: string[]}
        ).enabled = true;
        (
            config.connectors.git as {enabled: boolean; api_token?: string; repos: string[]}
        ).repos = ['owner/repo'];
        (
            config.connectors.git as {enabled: boolean; api_token?: string; repos: string[]}
        ).api_token = undefined;

        const savedToken = process.env.GITHUB_TOKEN;
        delete process.env.GITHUB_TOKEN;

        try {
            const result = await runDoctor(db, config, tmpConfigPath, MIGRATIONS_DIR);
            expect(result).toBe(false);
            const allOutput = [...output, ...errors].join('\n');
            expect(allOutput).toContain('Git repos');
            expect(allOutput).toContain('No API token');
        } finally {
            if (savedToken !== undefined) process.env.GITHUB_TOKEN = savedToken;
        }
    });

    it('skips summary model check when summaries disabled', async () => {
        const result = await runDoctor(db, disabledConfig(), tmpConfigPath, MIGRATIONS_DIR);
        expect(result).toBe(true);
        const combined = output.join('\n');
        expect(combined).toContain('Summary model');
        expect(combined).toContain('skipped');
    });

    it('outputs fix suggestions for failed checks', async () => {
        const nonExistentPath = path.join(os.tmpdir(), 'govproxy-missing-99999.yaml');
        await runDoctor(db, disabledConfig(), nonExistentPath, MIGRATIONS_DIR);
        const allOutput = [...output, ...errors].join('\n');
        expect(allOutput).toContain('Fix:');
    });

    it('returns true when all connectors disabled and config valid', async () => {
        const result = await runDoctor(db, disabledConfig(), tmpConfigPath, MIGRATIONS_DIR);
        expect(result).toBe(true);
    });
});
