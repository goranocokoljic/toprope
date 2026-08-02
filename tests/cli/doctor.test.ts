import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {runMigrations} from '../../src/storage/migrator';
import {
    runDoctor,
    exactConfiguredRepos,
    findMissingRepos,
    gitProviderFixHint,
} from '../../src/cli/doctor';
import {createProvider} from '../../src/connectors/git/providers/store';
import {createCommitDiffstatCache} from '../../src/connectors/git/diffstat-cache';
import {loadServerKey} from '../../src/connectors/git/providers/secret';
import {INTERACTIVE_REQUEST_POLICY} from '../../src/connectors/git/providers/http-retry';
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

    // #266: migration 043 resets the imported git data but NOT the derived rollups, so until a
    // resync + `aggregate backfill` have run, /api/aggregates serves pre-reset totals over zero
    // snapshots. Every other doctor check passes in that state (the providers are reachable, the
    // cursors are honestly absent), so without this the operator's only signal is a silently
    // stale dashboard — the graduated #235 rule.
    it('reports no pending git reset notice on a clean install', async () => {
        const result = await runDoctor(db, disabledConfig(), tmpConfigPath, MIGRATIONS_DIR);
        expect(result).toBe(true);
        // The label states what was MEASURED. It deliberately does NOT claim the git data is
        // current: migration 042 reset git data with no marker at all, so the marker's absence is
        // not evidence of currency (the graduated #235 rule).
        expect(output.join('\n')).toContain('Git reset notice');
        expect(output.join('\n')).toContain('none pending');
    });

    // #286: the diffstat cache grows monotonically with distinct commits ever synced, is
    // uncapped per commit, and is the first place this schema persists real source-tree paths
    // from private repos. Nothing reported its size, so an operator had no way to know a purge
    // was worth issuing — or that the table had become the largest in the database.
    it('reports the diffstat cache size, and passes at every size', async () => {
        const empty = await runDoctor(db, disabledConfig(), tmpConfigPath, MIGRATIONS_DIR);
        expect(empty).toBe(true);
        expect(output.join('\n')).toContain('commit_diffstats: 0 rows (nothing cached yet)');

        output.length = 0;
        createCommitDiffstatCache(db, 'github', 'org').put('api', 'sha1', {
            additions: 4,
            deletions: 1,
            entries: [{path: 'src/a.ts', additions: 4, deletions: 1, status: 'modified'}],
            absent: false,
        });
        createCommitDiffstatCache(db, 'github', 'org').put('api', 'sha2', {
            additions: 0,
            deletions: 0,
            entries: [],
            absent: true,
        });

        // Informational, never a failure: there is no size at which the cache is WRONG. It is
        // an immutable memo, never consulted for freshness, and emptying it costs only
        // re-fetching — so there is no threshold to fail on and no fix to prescribe.
        const populated = await runDoctor(db, disabledConfig(), tmpConfigPath, MIGRATIONS_DIR);
        expect(populated).toBe(true);
        const combined = output.join('\n');
        expect(combined).toContain('Diffstat cache');
        expect(combined).toContain('commit_diffstats: 2 rows (1 absent)');
        expect(errors.join('\n')).not.toContain('Diffstat cache');
    });

    it('FAILS while a migration reset is unacknowledged', async () => {
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
            'git_data_reset_pending',
            '043',
        );
        const result = await runDoctor(db, disabledConfig(), tmpConfigPath, MIGRATIONS_DIR);
        expect(result).toBe(false);
        const allOutput = [...output, ...errors].join('\n');
        expect(allOutput).toContain('Git reset notice');
        // The fix line must name EVERY part of the rebuild — a resync alone leaves the rollups
        // stale, and `aggregate backfill` alone leaves two projections stale, which is exactly the
        // condition the notice exists to describe.
        expect(allOutput).toContain('aggregate backfill');
        expect(allOutput).toContain('pr_review_metrics');
        expect(allOutput).toContain('clear-reset-notice');
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
                // Interactive, not the sync budget (#283). One client serves BOTH of doctor's
                // calls — the probe and the repo enumeration — so this single assertion is
                // what stops `listRepos` from parking the command for ten minutes on a `503
                // Retry-After: 3600`, or three hours on a 429. What the budget then does is
                // pinned in `providers/request-policy.test.ts`.
                {policy: INTERACTIVE_REQUEST_POLICY},
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

    // #235: the stall check is NOT redundant with the reachability probes above — a
    // stalled provider is usually perfectly reachable. One repo inside it fails every
    // run and #231 holds the whole provider's cursor rather than leave a silent gap,
    // so checkAccess() passes while nothing at all is being imported.
    describe('stalled git providers (#235)', () => {
        /** A config with reachable github providers (no network — factory stubbed). */
        async function reachableGitConfig(orgs: string[] = ['acme']): Promise<TopropeConfig> {
            const {createGitProvider} = await import('../../src/connectors/git/providers/factory');
            (createGitProvider as ReturnType<typeof vi.fn>).mockReturnValue({
                name: 'github',
                checkAccess: vi.fn().mockResolvedValue(undefined),
                listRepos: vi.fn().mockResolvedValue([]),
                getCommits: vi.fn(),
                getPullRequests: vi.fn(),
                getReviewComments: vi.fn(),
                getPRReviews: vi.fn(),
                getCommitDiff: vi.fn(),
            } as unknown as GitProvider);

            const config = disabledConfig();
            (config.connectors.git as {enabled: boolean; providers: unknown[]}).enabled = true;
            (config.connectors.git as {enabled: boolean; providers: unknown[]}).providers = orgs.map(
                (org) => ({type: 'github', org, auth: {type: 'token', api_token: 't'}}),
            );
            return config;
        }

        function seedStall(runs: number, org = 'acme'): void {
            db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
                `git_stall:github:${org}`,
                JSON.stringify({runs, since: '2026-07-01T00:00:00.000Z'}),
            );
        }

        function seedCursor(org: string, daysAgoN: number): void {
            db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
                `git_last_sync:github:${org}`,
                new Date(Date.now() - daysAgoN * 86_400_000).toISOString(),
            );
        }

        it('FAILS doctor and names the stalled provider, streak, and remedy', async () => {
            seedStall(6);

            const result = await runDoctor(db, await reachableGitConfig(), tmpConfigPath, MIGRATIONS_DIR);

            expect(result).toBe(false);
            const allOutput = [...output, ...errors].join('\n');
            // The provider is reachable — this is the ONLY check that catches the stall.
            expect(allOutput).toContain('org "acme" reachable');
            expect(allOutput).toContain('Git sync progress');
            expect(allOutput).toContain('github:acme');
            expect(allOutput).toContain('6 runs');
            expect(allOutput).toContain('2026-07-01T00:00:00.000Z');
            expect(allOutput).toContain('exclude_repos');
        });

        it('reports a positive currency claim when every provider is current (#248)', async () => {
            seedCursor('acme', 1);

            const result = await runDoctor(db, await reachableGitConfig(), tmpConfigPath, MIGRATIONS_DIR);

            expect(result).toBe(true);
            const allOutput = [...output, ...errors].join('\n');
            // #248: no longer the old "No stalled or lagging providers" inference. A
            // cursor one day back with no open streak is PROVEN current — a claim earned
            // from the data, not assumed from two readers coming back empty.
            expect(allOutput).toContain('All 1 provider(s) current');
            expect(allOutput).not.toContain('No stalled or lagging providers');
        });

        it('names the not-yet-current providers instead of a bare all-clear (#248)', async () => {
            // acme is current (cursor 1 day back); beta HAS synced (a stored cursor) but
            // is now held one run below the stall alert — its cursor is frozen, so it is
            // NOT current even though it is neither stalled nor lagging. The old inference
            // printed a green all-clear here; the positive check must count acme current
            // and name beta as held-below-the-alert.
            seedCursor('acme', 1);
            seedCursor('beta', 40);
            seedStall(1, 'beta');

            const result = await runDoctor(
                db,
                await reachableGitConfig(['acme', 'beta']),
                tmpConfigPath,
                MIGRATIONS_DIR,
            );

            expect(result).toBe(true);
            const allOutput = [...output, ...errors].join('\n');
            expect(allOutput).toContain('1 of 2 provider(s) current');
            expect(allOutput).toContain('1 not yet current');
            expect(allOutput).toContain('held below the stall alert');
        });

        it('does NOT claim anything about a never-synced provider', async () => {
            // No cursor seeded at all. The control above must depend on its seeded
            // cursor — if this printed the same all-clear line, that control could not
            // fail for the right reason, and a fresh install would get a green line
            // before a single sync had ever run.
            const result = await runDoctor(db, await reachableGitConfig(), tmpConfigPath, MIGRATIONS_DIR);

            expect(result).toBe(true);
            const allOutput = [...output, ...errors].join('\n');
            expect(allOutput).toContain('No provider has synced yet');
            expect(allOutput).not.toContain('No stalled or lagging providers');
        });

        it('counts the never-synced out of the current total (#248)', async () => {
            seedCursor('acme', 1); // current; beta has no cursor → never synced

            await runDoctor(
                db,
                await reachableGitConfig(['acme', 'beta']),
                tmpConfigPath,
                MIGRATIONS_DIR,
            );

            const allOutput = output.join('\n');
            expect(allOutput).toContain('1 of 2 provider(s) current');
            expect(allOutput).toContain('1 not yet current');
            expect(allOutput).toContain('1 never synced');
        });

        it('names BOTH remainder parts when never-synced and held coexist (#248)', async () => {
            // acme current, beta never synced, gamma held below the alert (cursor frozen).
            // Exercises the two-element parts.join(', ') and the held = notCurrent -
            // neverSynced subtraction with both terms non-zero — a regression that dropped
            // a part or mis-computed `held` when both are present would otherwise ship green.
            seedCursor('acme', 1);
            seedCursor('gamma', 45);
            seedStall(2, 'gamma');

            await runDoctor(
                db,
                await reachableGitConfig(['acme', 'beta', 'gamma']),
                tmpConfigPath,
                MIGRATIONS_DIR,
            );

            const allOutput = output.join('\n');
            expect(allOutput).toContain('1 of 3 provider(s) current');
            expect(allOutput).toContain('2 not yet current');
            expect(allOutput).toContain('1 never synced');
            expect(allOutput).toContain('1 held below the stall alert');
        });

        it('reports EVERY stalled provider, with a count matching the detail list', async () => {
            seedStall(4, 'acme');
            seedStall(6, 'beta');

            const result = await runDoctor(
                db,
                await reachableGitConfig(['acme', 'beta', 'healthy']),
                tmpConfigPath,
                MIGRATIONS_DIR,
            );

            expect(result).toBe(false);
            const allOutput = [...output, ...errors].join('\n');
            // >= 2 stalled, so a join that drops entries or a count that disagrees with
            // the rendered list cannot ship green.
            expect(allOutput).toContain('2 provider(s) stalled');
            expect(allOutput).toContain('github:acme (4 runs');
            expect(allOutput).toContain('github:beta (6 runs');
            expect(allOutput).not.toContain('github:healthy (');
        });

        it('does NOT call a months-behind provider "advancing" — reports the catch-up instead', async () => {
            // The false all-clear this guards: after excluding the repo that caused a
            // stall, the streak clears and the run completes, but the cursor is still
            // ~170 days back. Doctor must not declare victory.
            seedCursor('acme', 170);

            const result = await runDoctor(db, await reachableGitConfig(), tmpConfigPath, MIGRATIONS_DIR);

            const allOutput = [...output, ...errors].join('\n');
            expect(allOutput).toContain('Git sync progress');
            expect(allOutput).toContain('catching up — advancing, but not yet current');
            expect(allOutput).toContain('github:acme (170 days behind');
            expect(allOutput).not.toContain('0 provider(s) catching up');
            // A bounded catch-up is working as designed and self-resolves, so it is a
            // pass — it just must not claim the data is current.
            expect(result).toBe(true);
            expect(allOutput).not.toContain('No stalled or lagging providers');
        });

        it('reports a stalled provider as stalled only — never also as catching up', async () => {
            seedStall(5, 'acme');
            seedCursor('acme', 200);

            const result = await runDoctor(db, await reachableGitConfig(), tmpConfigPath, MIGRATIONS_DIR);

            expect(result).toBe(false);
            const allOutput = [...output, ...errors].join('\n');
            expect(allOutput).toContain('1 provider(s) stalled');
            expect(allOutput).not.toContain('catching up');
        });

        it('still reports a LAGGING provider when a DIFFERENT provider is stalled', async () => {
            // Doctor is the command the operator runs *after* seeing a stall, so it is
            // exactly then that it can least afford to go quiet about everything else.
            // A single early-returning check would print acme's stall and silently drop
            // beta's 170-day lag.
            seedStall(5, 'acme');
            seedCursor('acme', 200);
            seedCursor('beta', 170);

            const result = await runDoctor(
                db,
                await reachableGitConfig(['acme', 'beta']),
                tmpConfigPath,
                MIGRATIONS_DIR,
            );

            expect(result).toBe(false);
            const allOutput = [...output, ...errors].join('\n');
            expect(allOutput).toContain('1 provider(s) stalled');
            expect(allOutput).toContain('github:acme (5 runs');
            expect(allOutput).toContain('1 provider(s) catching up');
            expect(allOutput).toContain('github:beta (170 days behind');
        });

        it('names BOTH stall causes in the remedy, not just the bad-repo one', async () => {
            seedStall(6);

            await runDoctor(db, await reachableGitConfig(), tmpConfigPath, MIGRATIONS_DIR);

            // A provider-level listRepos failure also opens a streak, and exclude_repos
            // cannot fix that — a remedy naming only the bad-repo case misdirects.
            const allOutput = [...output, ...errors].join('\n');
            expect(allOutput).toContain('repo listing');
            expect(allOutput).toContain('exclude_repos');
        });

        it('passes below the alert threshold, but does not call the held provider current (#248)', async () => {
            seedStall(1);
            seedCursor('acme', 1);

            const result = await runDoctor(db, await reachableGitConfig(), tmpConfigPath, MIGRATIONS_DIR);

            // One held run is transient and self-healing; failing doctor on it would
            // train the reader to ignore the check. But its cursor IS frozen, so it is
            // not current — the positive check must report it as not-yet-current rather
            // than print the old false all-clear.
            expect(result).toBe(true);
            const allOutput = output.join('\n');
            expect(allOutput).toContain('0 of 1 provider(s) current');
            expect(allOutput).toContain('held below the stall alert');
            expect(allOutput).not.toContain('No stalled or lagging providers');
        });

        it('skips the stall check entirely when the git connector is disabled', async () => {
            seedStall(9);

            const result = await runDoctor(db, disabledConfig(), tmpConfigPath, MIGRATIONS_DIR);

            expect(result).toBe(true);
            expect([...output, ...errors].join('\n')).not.toContain('Git sync progress');
        });

        /**
         * #306 — the condition whose CURSOR looks perfect.
         *
         * A run whose author-day rows were systemically refused advanced to `now` over a window
         * it wrote almost nothing into, so every check above reads healthy: reachable, no stall
         * streak, cursor one day old. This is the surface that is not fooled — and it has to be
         * durable rather than derived from the last run, because the non-advisory error the same
         * run emits makes the scheduler retry the connector over an already-covered (empty,
         * therefore clean) window and print the RETRY's result.
         */
        describe('systemic row refusal (#306)', () => {
            function seedRefusal(org: string, skipped: number, retained: number): void {
                db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
                    `git_row_refusal:github:${org}`,
                    JSON.stringify({at: '2026-07-01T00:00:00.000Z', skipped, retained}),
                );
            }

            it('FAILS doctor even though the cursor is current and no stall is open', async () => {
                // A cursor one day old with no streak is the positive currency check passing —
                // exactly the state that printed an all-clear before this check existed.
                seedCursor('acme', 1);
                seedRefusal('acme', 40, 0);

                const result = await runDoctor(db, await reachableGitConfig(), tmpConfigPath, MIGRATIONS_DIR);

                expect(result).toBe(false);
                const allOutput = [...output, ...errors].join('\n');
                expect(allOutput).toContain('org "acme" reachable');
                expect(allOutput).toContain('1 provider(s) refused most of the rows');
                expect(allOutput).toContain('github:acme (40 of 40 rows refused');
                // The all-clear it replaces must not also be printed.
                expect(allOutput).not.toContain('All 1 provider(s) current');
            });

            it('denies the refusing provider "current" credit while still crediting a healthy one', async () => {
                seedCursor('acme', 1);
                seedCursor('beta', 1);
                seedRefusal('acme', 9, 1);

                await runDoctor(
                    db,
                    await reachableGitConfig(['acme', 'beta']),
                    tmpConfigPath,
                    MIGRATIONS_DIR,
                );

                const allOutput = [...output, ...errors].join('\n');
                // Both cursors are one day old, so a check that classified on the cursor alone
                // would say "All 2 provider(s) current".
                expect(allOutput).toContain('github:acme (9 of 10 rows refused');
                expect(allOutput).not.toContain('github:beta');
                expect(allOutput).not.toContain('All 2 provider(s) current');
            });

            it('does not prescribe purging the cursors, which would double the surviving rows', async () => {
                seedCursor('acme', 1);
                seedRefusal('acme', 40, 0);

                await runDoctor(db, await reachableGitConfig(), tmpConfigPath, MIGRATIONS_DIR);

                const allOutput = [...output, ...errors].join('\n');
                // The remedy an operator would reach for first is the one that permanently
                // doubles every commit metric on the rows that DID survive (#262). The hint
                // must name it as forbidden, not stay silent and let them find it themselves.
                expect(allOutput).toContain('Author-days skipped as unwritable');
                expect(allOutput).toMatch(/DOUBLES every commit metric/);
            });

            it('ignores a corrupt marker rather than failing on an alarm no remedy clears', async () => {
                seedCursor('acme', 1);
                db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
                    'git_row_refusal:github:acme',
                    'not json at all',
                );

                const result = await runDoctor(db, await reachableGitConfig(), tmpConfigPath, MIGRATIONS_DIR);

                expect(result).toBe(true);
                expect([...output, ...errors].join('\n')).not.toContain('refused most of the rows');
            });
        });
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

describe('gitProviderFixHint — rate limit vs credentials (#283)', () => {
    it('reads a GitHub 403 rate limit as a rate limit, NOT as missing token scopes', () => {
        // GitHub signals its PRIMARY rate limit with 403, not 429, and since #283 an
        // interactive client no longer waits one out — so this message really does reach the
        // hint. The scope rule matches on a bare ' 403'/'forbidden' substring, so without an
        // earlier rate-limit rule an admin is told to rotate a perfectly good PAT because the
        // nightly sync spent the org's quota.
        const message =
            'GitHub API forbidden (403): https://api.github.com/orgs/acme/repos: ' +
            '{"message":"API rate limit exceeded for user ID 1."}';
        const hint = gitProviderFixHint('github', message);

        expect(hint).toMatch(/rate limited/i);
        expect(hint).not.toMatch(/read scopes/);
    });

    it('reads an exhausted rate-limit budget on any provider as a rate limit', () => {
        // The wording all three throw once the budget is spent — on an interactive client that
        // is after ZERO retries, which is the new common case.
        for (const type of ['github', 'bitbucket', 'gitlab'] as const) {
            const hint = gitProviderFixHint(
                type,
                'Rate limit exceeded after 0 retries: https://api/x',
            );
            expect(hint).toMatch(/rate limited/i);
        }
    });

    it('still blames scopes for a 403 that is NOT a rate limit', () => {
        // The positive control: the pre-existing rule must keep working for the case it was
        // written for, or this fix would have traded one mis-diagnosis for another.
        const hint = gitProviderFixHint(
            'github',
            'GitHub API forbidden (403): https://api.github.com/orgs/acme/repos: ' +
                '{"message":"Resource not accessible by personal access token"}',
        );
        expect(hint).toMatch(/read scopes/);
        expect(hint).not.toMatch(/rate limited/i);
    });

    it('leaves 401 and 404 untouched', () => {
        expect(gitProviderFixHint('github', 'GitHub API error 401: bad token')).toMatch(
            /credentials invalid or expired/,
        );
        expect(gitProviderFixHint('gitlab', 'GitLab API error 404: nope')).toMatch(
            /not found/,
        );
    });
});
