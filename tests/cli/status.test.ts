import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {addTeam} from '../../src/registry/teams';
import {addDeveloper} from '../../src/registry/developers';
import {printStatus} from '../../src/cli/status';
import type {TopropeConfig} from '../../src/config/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function baseConfig(): TopropeConfig {
    return {
        server: {port: 8080, host: '0.0.0.0'},
        storage: {type: 'sqlite', sqlite_path: ':memory:'},
        connectors: {
            copilot: {enabled: true},
            claude_code: {enabled: true},
            windsurf: {enabled: false},
            cursor: {enabled: false},
            git: {enabled: true},
        },
        expenses: {},
        aggregation: {},
        summaries: {},
        alerts: {},
        dashboard: {},
        teams: [],
    } as unknown as TopropeConfig;
}

function daysAgo(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
}

describe('printStatus', () => {
    let db: Database.Database;
    let output: string[];
    let errors: string[];

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
    });

    afterEach(() => {
        db.close();
        vi.restoreAllMocks();
    });

    it('works on empty database (first run)', () => {
        expect(() => printStatus(db, baseConfig())).not.toThrow();
        const combined = output.join('\n');
        expect(combined).toContain('Toprope Status');
        expect(combined).toContain('Developers:');
        expect(combined).toContain('0 registered');
    });

    it('shows registered developer count', () => {
        addTeam(db, 'engineering');
        addDeveloper(db, 'Alice', 'engineering', 'alice@example.com');
        addDeveloper(db, 'Bob', 'engineering', 'bob@example.com');

        printStatus(db, baseConfig());

        const combined = output.join('\n');
        expect(combined).toContain('2 registered');
    });

    it('shows active developer count from recent snapshots', () => {
        addTeam(db, 'engineering');
        const alice = addDeveloper(db, 'Alice', 'engineering', 'alice@example.com');
        addDeveloper(db, 'Bob', 'engineering', 'bob@example.com');

        db.prepare(
            `INSERT INTO tool_snapshots (id, developer_id, date, tool, data_source, data_quality, is_active)
             VALUES (?, ?, ?, 'copilot', 'api', 'high', 1)`,
        ).run('snap-1', alice.id, daysAgo(1));

        printStatus(db, baseConfig());

        const combined = output.join('\n');
        expect(combined).toContain('2 registered (1 active)');
    });

    it('shows team count', () => {
        addTeam(db, 'engineering');
        addTeam(db, 'product');

        printStatus(db, baseConfig());

        const combined = output.join('\n');
        expect(combined).toContain('Teams:');
        expect(combined).toContain('2');
    });

    it('shows connector sync state when never synced', () => {
        printStatus(db, baseConfig());

        const combined = output.join('\n');
        expect(combined).toContain('○ not synced');
    });

    it('shows connector sync state when synced', () => {
        db.prepare(
            `INSERT INTO sync_state (key, value) VALUES ('copilot_last_sync', ?)`,
        ).run(new Date().toISOString());

        printStatus(db, baseConfig());

        const combined = output.join('\n');
        expect(combined).toContain('✓ connected');
        expect(combined).toContain('just now');
    });

    it('shows disabled connectors', () => {
        const config = baseConfig();
        (config.connectors.copilot as {enabled: boolean}).enabled = false;

        printStatus(db, config);

        const combined = output.join('\n');
        expect(combined).toContain('disabled');
    });

    it('shows subscription count and cost', () => {
        addTeam(db, 'engineering');
        const dev = addDeveloper(db, 'Alice', 'engineering', 'alice@example.com');
        db.prepare(
            `INSERT INTO subscriptions (id, developer_id, tool, plan, billing_model, monthly_cost, data_source)
             VALUES ('sub-1', ?, 'copilot', 'business', 'company_managed', 19, 'api')`,
        ).run(dev.id);

        printStatus(db, baseConfig());

        const combined = output.join('\n');
        expect(combined).toContain('1 active');
        expect(combined).toContain('$19');
    });

    it('shows waste alerts when present', () => {
        addTeam(db, 'engineering');
        const dev = addDeveloper(db, 'Alice', 'engineering', 'alice@example.com');
        db.prepare(
            `INSERT INTO waste_alerts (id, alert_type, developer_id, team, tool, monthly_waste, details, detected_at)
             VALUES ('alert-1', 'unused_seat', ?, 'engineering', 'copilot', 19.0, '{}', ?)`,
        ).run(dev.id, new Date().toISOString());

        printStatus(db, baseConfig());

        const combined = output.join('\n');
        expect(combined).toContain('1 alerts');
        expect(combined).toContain('$19');
    });

    it('shows no waste when none', () => {
        printStatus(db, baseConfig());
        const combined = output.join('\n');
        expect(combined).toContain('Waste detected:');
        expect(combined).toContain('none');
    });

    it('shows data coverage breakdown', () => {
        addTeam(db, 'engineering');
        const dev = addDeveloper(db, 'Alice', 'engineering', 'alice@example.com');
        db.prepare(
            `INSERT INTO tool_snapshots (id, developer_id, date, tool, data_source, data_quality, is_active)
             VALUES (?, ?, ?, 'copilot', 'api', 'high', 1)`,
        ).run('snap-1', dev.id, daysAgo(1));

        printStatus(db, baseConfig());

        const combined = output.join('\n');
        expect(combined).toContain('HIGH:');
        expect(combined).toContain('MEDIUM:');
        expect(combined).toContain('LOW:');
    });

    it('shows configured repo count for git connector, not developer count', () => {
        addTeam(db, 'engineering');
        const dev = addDeveloper(db, 'Alice', 'engineering', 'alice@example.com');
        addDeveloper(db, 'Bob', 'engineering', 'bob@example.com');
        db.prepare(
            `INSERT INTO git_snapshots
             (id, developer_id, date, commits, lines_added, lines_removed, files_changed,
              prs_opened, prs_merged, review_comments_given, avg_time_to_merge_hours,
              code_churn_rate, ai_signature_score, avg_commit_size, commit_burst_count)
             VALUES ('gs-1', ?, ?, 2, 50, 10, 3, 1, 0, 0, NULL, 0.1, 0.5, 25, 0)`,
        ).run(dev.id, daysAgo(1));
        db.prepare(
            `INSERT INTO sync_state (key, value) VALUES ('git_last_sync', ?)`,
        ).run(new Date().toISOString());

        const configWithRepos = baseConfig();
        (configWithRepos.connectors.git as {enabled: boolean; repos: string[]}).repos = [
            'org/repo1',
            'org/repo2',
        ];
        printStatus(db, configWithRepos);

        const combined = output.join('\n');
        expect(combined).toContain('2 repos');
        expect(combined).not.toContain('1 repos');
    });

    // #235: neither a stalled nor a catching-up provider is visible on the Git
    // connector line — that line is per-CONNECTOR, and these states are per-PROVIDER.
    describe('stalled and lagging git providers (#235)', () => {
        function gitConfig(orgs: string[] = ['acme']): TopropeConfig {
            const config = baseConfig();
            (config.connectors.git as {enabled: boolean; providers: unknown[]}).providers = orgs.map(
                (org) => ({type: 'github', org, auth: {type: 'token', api_token: 't'}}),
            );
            return config;
        }

        function seedStall(key: string, runs: number, since: string): void {
            db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
                key,
                JSON.stringify({runs, since}),
            );
        }

        function seedCursor(key: string, daysAgoN: number): void {
            db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
                key,
                new Date(Date.now() - daysAgoN * 86_400_000).toISOString(),
            );
        }

        it('warns, naming the provider and the streak, once a provider is stalled', () => {
            seedStall('git_stall:github:acme', 7, new Date(Date.now() - 3 * 86_400_000).toISOString());

            printStatus(db, gitConfig());

            const combined = output.join('\n');
            expect(combined).toContain('github:acme stalled');
            expect(combined).toContain('7 consecutive runs');
            expect(combined).toContain('3d ago');
            expect(combined).toContain('toprope doctor');
        });

        it('says nothing when no provider is stalled (negative control)', () => {
            printStatus(db, gitConfig());

            expect(output.join('\n')).not.toContain('stalled');
        });

        it('stays silent below the alert threshold', () => {
            seedStall('git_stall:github:acme', 1, new Date().toISOString());

            printStatus(db, gitConfig());

            // One held run is the ordinary self-healing case, not a stall.
            expect(output.join('\n')).not.toContain('stalled');
        });

        it('does not report stalls when the git connector is disabled', () => {
            seedStall('git_stall:github:acme', 9, new Date().toISOString());
            const config = gitConfig();
            (config.connectors.git as {enabled: boolean}).enabled = false;

            printStatus(db, config);

            expect(output.join('\n')).not.toContain('stalled');
        });

        it('reports EVERY stalled provider, and the doctor hint exactly once', () => {
            seedStall('git_stall:github:acme', 4, new Date().toISOString());
            seedStall('git_stall:github:beta', 6, new Date().toISOString());

            printStatus(db, gitConfig(['acme', 'beta', 'healthy']));

            const combined = output.join('\n');
            // >= 2 stalled, so an accumulation bug (printing only gitStalls[0]) or a
            // per-item hint line cannot ship green.
            expect(combined).toContain('github:acme stalled');
            expect(combined).toContain('github:beta stalled');
            expect(combined).not.toContain('github:healthy stalled');
            expect(combined.match(/Run "toprope doctor" for the fix\./g)).toHaveLength(1);
        });

        it('reports a provider that is advancing but months behind — without calling it stalled', () => {
            // The state the catch-up cap creates: nothing is held, the streak is clear,
            // and yet the data is 170 days old. Reporting nothing here would read as
            // "current" — the false all-clear right after fixing a stall.
            seedCursor('git_last_sync:github:acme', 170);

            printStatus(db, gitConfig());

            const combined = output.join('\n');
            expect(combined).toContain('github:acme catching up');
            expect(combined).toContain('170 days behind');
            expect(combined).not.toContain('stalled');
        });

        it('reports every lagging provider, and says nothing about a current one', () => {
            seedCursor('git_last_sync:github:acme', 90);
            seedCursor('git_last_sync:github:beta', 60);
            seedCursor('git_last_sync:github:healthy', 1);

            printStatus(db, gitConfig(['acme', 'beta', 'healthy']));

            const combined = output.join('\n');
            expect(combined).toContain('github:acme catching up');
            expect(combined).toContain('github:beta catching up');
            expect(combined).not.toContain('github:healthy catching up');
        });

        it('reports a stalled provider as stalled only — never also as catching up', () => {
            seedStall('git_stall:github:acme', 5, new Date().toISOString());
            seedCursor('git_last_sync:github:acme', 200);

            printStatus(db, gitConfig());

            const combined = output.join('\n');
            // A held cursor falls behind by definition; reporting both would be noise
            // under two headings for one problem.
            expect(combined).toContain('github:acme stalled');
            expect(combined).not.toContain('catching up');
        });

        it('says nothing when every provider is current (negative control)', () => {
            seedCursor('git_last_sync:github:acme', 1);

            printStatus(db, gitConfig());

            const combined = output.join('\n');
            expect(combined).not.toContain('stalled');
            expect(combined).not.toContain('catching up');
        });
    });
});
