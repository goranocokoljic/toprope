import {Command} from 'commander';
import path from 'path';
import {loadConfig} from './config/loader';
import {buildServer} from './server';
import {openDb} from './storage/db';
import {runMigrations, getMigrationStatus} from './storage/migrator';
import {printStatus} from './cli/status';
import {runDoctor} from './cli/doctor';
import {addTeam, listTeams, teamExists} from './registry/teams';
import {addDeveloper, listDevelopers, getDeveloperById, linkDeveloper, findByExternalId, findByEmail} from './registry/developers';
import {discoverOrgMembers} from './registry/discovery';
import {seedTeamsFromConfig} from './registry/config-seeder';
import {CopilotSync} from './connectors/copilot/sync';
import {ClaudeCodeSync} from './connectors/claude-code/sync';
import {WindsurfSync} from './connectors/windsurf/sync';
import {GitSync} from './connectors/git/sync';
import {runPipeline} from './scheduler/sync-pipeline';
import {importCsv} from './expenses/importer';
import {
    listSubscriptions,
    getDeveloperCostSummaries,
    getTeamCostSummaries,
    getOrgCostSummary,
    detectDuplicates,
} from './expenses/subscription-tracker';
import {
    runWasteDetection,
    listActiveAlerts,
    getWasteSummaryByTeam,
    resolveAlert,
} from './expenses/waste-detector';
import {evaluatePlanRoi} from './expenses/plan-roi';
import {runBackfill, type BackfillProgress} from './aggregation/backfill';
import {hashPassword, validatePasswordStrength, generateTempPassword} from './auth/password';
import {createUser, getActiveUserByEmail, countAdmins} from './auth/users';

// Commander option collector for repeatable flags (e.g. --git-email).
function collectValue(value: string, previous: string[]): string[] {
    return previous.concat([value]);
}

const program = new Command();

program
    .name('govproxy')
    .description('AI adoption intelligence platform for engineering teams')
    .version('0.1.0');

program
    .command('start')
    .description('Start the GovProxy server')
    .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
    .action(async (options: {config: string}) => {
        const configPath = path.resolve(process.cwd(), options.config);
        const config = loadConfig(configPath);
        const dbPath = path.resolve(process.cwd(), config.storage.sqlite_path);
        const db = openDb(dbPath);
        try {
            runMigrations(db, path.resolve(__dirname, 'storage/migrations'));
            seedTeamsFromConfig(db, config.teams ?? []);
        } catch (err) {
            console.error('Failed to initialize database:', err);
            process.exit(1);
        } finally {
            db.close();
        }
        const app = buildServer(config);
        try {
            await app.listen({port: config.server.port, host: config.server.host});
        } catch (err) {
            console.error('Failed to start server:', err);
            process.exit(1);
        }
    });

const MIGRATIONS_DIR = path.resolve(__dirname, 'storage/migrations');

const dbCommand = program.command('db').description('Database management');

dbCommand
    .command('migrate')
    .description('Apply pending database migrations')
    .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
    .action((options: {config: string}) => {
        const configPath = path.resolve(process.cwd(), options.config);
        const config = loadConfig(configPath);
        const dbPath = path.resolve(process.cwd(), config.storage.sqlite_path);
        const db = openDb(dbPath);
        try {
            const count = runMigrations(db, MIGRATIONS_DIR);
            if (count === 0) {
                console.log('No pending migrations.');
            } else {
                console.log(`Applied ${count} migration(s).`);
            }
        } finally {
            db.close();
        }
    });

dbCommand
    .command('status')
    .description('Show migration status')
    .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
    .action((options: {config: string}) => {
        const configPath = path.resolve(process.cwd(), options.config);
        const config = loadConfig(configPath);
        const dbPath = path.resolve(process.cwd(), config.storage.sqlite_path);
        const db = openDb(dbPath);
        try {
            const statuses = getMigrationStatus(db, MIGRATIONS_DIR);
            if (statuses.length === 0) {
                console.log('No migration files found.');
                return;
            }
            console.log('Migration Status:');
            console.log('─'.repeat(60));
            for (const s of statuses) {
                const mark = s.applied ? '✓' : '✗';
                const when = s.applied_at ? `  (applied ${s.applied_at})` : '';
                console.log(`  ${mark}  ${s.name}${when}`);
            }
        } finally {
            db.close();
        }
    });

function openRegistryDb(configPath: string): ReturnType<typeof openDb> {
    const config = loadConfig(configPath);
    const dbPath = path.resolve(process.cwd(), config.storage.sqlite_path);
    const db = openDb(dbPath);
    try {
        runMigrations(db, MIGRATIONS_DIR);
    } catch (err) {
        db.close();
        throw err;
    }
    return db;
}

const teamCommand = program.command('team').description('Manage teams');

teamCommand
    .command('add')
    .description('Add a team')
    .requiredOption('--name <name>', 'Team name')
    .option('--department <dept>', 'Department')
    .option('--manager <manager>', 'Manager name or email')
    .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
    .action((options: {name: string; department?: string; manager?: string; config: string}) => {
        const configPath = path.resolve(process.cwd(), options.config);
        const db = openRegistryDb(configPath);
        try {
            if (teamExists(db, options.name)) {
                console.warn(`Warning: team '${options.name}' already exists.`);
                return;
            }
            const team = addTeam(db, options.name, options.department, options.manager);
            console.log(`Team '${team.name}' created.`);
        } finally {
            db.close();
        }
    });

teamCommand
    .command('list')
    .description('List all teams')
    .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
    .action((options: {config: string}) => {
        const configPath = path.resolve(process.cwd(), options.config);
        const db = openRegistryDb(configPath);
        try {
            const teams = listTeams(db);
            if (teams.length === 0) {
                console.log('No teams found.');
                return;
            }
            console.log('Teams:');
            console.log('─'.repeat(60));
            for (const t of teams) {
                const dept = t.department ? `  dept: ${t.department}` : '';
                const mgr = t.manager ? `  manager: ${t.manager}` : '';
                console.log(`  ${t.name}${dept}${mgr}`);
            }
        } finally {
            db.close();
        }
    });

const devCommand = program.command('dev').description('Manage developers');

devCommand
    .command('add')
    .description('Add a developer')
    .requiredOption('--name <name>', 'Developer full name')
    .requiredOption('--team <team>', 'Team name')
    .option('--email <email>', 'Email address')
    .option('--github <username>', 'GitHub username')
    .option('--bitbucket <username>', 'Bitbucket username/nickname')
    .option('--gitlab <username>', 'GitLab username')
    .option('--git-email <email>', 'Additional git commit email (repeatable)', collectValue, [])
    .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
    .action(
        (options: {
            name: string;
            team: string;
            email?: string;
            github?: string;
            bitbucket?: string;
            gitlab?: string;
            gitEmail: string[];
            config: string;
        }) => {
            const configPath = path.resolve(process.cwd(), options.config);
            const db = openRegistryDb(configPath);
            try {
                if (!teamExists(db, options.team)) {
                    console.error(`Error: team '${options.team}' does not exist.`);
                    process.exit(1);
                }
                const idChecks: Array<{provider: 'github' | 'bitbucket' | 'gitlab'; value?: string}> = [
                    {provider: 'github', value: options.github},
                    {provider: 'bitbucket', value: options.bitbucket},
                    {provider: 'gitlab', value: options.gitlab},
                ];
                for (const {provider, value} of idChecks) {
                    if (!value) continue;
                    const duplicate = findByExternalId(db, provider, value);
                    if (duplicate) {
                        console.warn(
                            `Warning: developer with ${provider} identity '${value}' already exists (id: ${duplicate.id}, name: ${duplicate.name}).`,
                        );
                        return;
                    }
                }
                const emailChecks = [options.email, ...options.gitEmail].filter(
                    (e): e is string => !!e,
                );
                for (const email of emailChecks) {
                    const duplicate = findByEmail(db, email);
                    if (duplicate) {
                        console.warn(
                            `Warning: developer with email '${email}' already exists (id: ${duplicate.id}, name: ${duplicate.name}).`,
                        );
                        return;
                    }
                }
                const dev = addDeveloper(db, options.name, options.team, options.email, options.github, {
                    bitbucket: options.bitbucket,
                    gitlab: options.gitlab,
                    gitEmails: options.gitEmail,
                });
                console.log(`Developer '${dev.name}' created with id: ${dev.id}`);
            } finally {
                db.close();
            }
        },
    );

devCommand
    .command('list')
    .description('List developers')
    .option('--team <name>', 'Filter by team name')
    .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
    .action((options: {team?: string; config: string}) => {
        const configPath = path.resolve(process.cwd(), options.config);
        const db = openRegistryDb(configPath);
        try {
            const devs = listDevelopers(db, options.team);
            if (devs.length === 0) {
                console.log('No developers found.');
                return;
            }
            console.log('Developers:');
            console.log('─'.repeat(60));
            for (const d of devs) {
                const email = d.email ? `  <${d.email}>` : '';
                const ids: string[] = [];
                if (d.external_ids.github) ids.push(`github: ${d.external_ids.github}`);
                if (d.external_ids.bitbucket) ids.push(`bitbucket: ${d.external_ids.bitbucket}`);
                if (d.external_ids.gitlab) ids.push(`gitlab: ${d.external_ids.gitlab}`);
                if (d.external_ids.git_emails) ids.push(`git-emails: ${d.external_ids.git_emails}`);
                const idStr = ids.length > 0 ? `  ${ids.join('  ')}` : '';
                console.log(`  [${d.id}] ${d.name}${email}  team: ${d.team}${idStr}`);
            }
        } finally {
            db.close();
        }
    });

devCommand
    .command('link')
    .description('Link developer to external tool and git provider identities')
    .requiredOption('--id <dev-id>', 'Developer ID')
    .option('--copilot <username>', 'GitHub Copilot username')
    .option('--claude <email>', 'Claude Code email')
    .option('--windsurf <email>', 'Windsurf email')
    .option('--github <username>', 'GitHub username')
    .option('--bitbucket <username>', 'Bitbucket username/nickname')
    .option('--gitlab <username>', 'GitLab username')
    .option('--git-email <email>', 'Additional git commit email (repeatable)', collectValue, [])
    .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
    .action(
        (options: {
            id: string;
            copilot?: string;
            claude?: string;
            windsurf?: string;
            github?: string;
            bitbucket?: string;
            gitlab?: string;
            gitEmail: string[];
            config: string;
        }) => {
            const configPath = path.resolve(process.cwd(), options.config);
            const db = openRegistryDb(configPath);
            try {
                const hasUpdate =
                    options.copilot ||
                    options.claude ||
                    options.windsurf ||
                    options.github ||
                    options.bitbucket ||
                    options.gitlab ||
                    options.gitEmail.length > 0;
                if (!hasUpdate) {
                    console.error(
                        'Error: at least one of --copilot, --claude, --windsurf, --github, --bitbucket, --gitlab, or --git-email must be provided.',
                    );
                    process.exit(1);
                }
                const conflictChecks: Array<{provider: 'github' | 'bitbucket' | 'gitlab'; value?: string}> = [
                    {provider: 'github', value: options.github},
                    {provider: 'bitbucket', value: options.bitbucket},
                    {provider: 'gitlab', value: options.gitlab},
                ];
                for (const {provider, value} of conflictChecks) {
                    if (!value) continue;
                    const conflict = findByExternalId(db, provider, value);
                    if (conflict && conflict.id !== options.id) {
                        console.error(
                            `Error: ${provider} identity '${value}' is already linked to developer '${conflict.name}' (id: ${conflict.id}).`,
                        );
                        process.exit(1);
                    }
                }
                for (const email of options.gitEmail) {
                    const conflict = findByEmail(db, email);
                    if (conflict && conflict.id !== options.id) {
                        console.error(
                            `Error: email '${email}' is already linked to developer '${conflict.name}' (id: ${conflict.id}).`,
                        );
                        process.exit(1);
                    }
                }
                const dev = linkDeveloper(db, options.id, {
                    copilot: options.copilot,
                    claude: options.claude,
                    windsurf: options.windsurf,
                    github: options.github,
                    bitbucket: options.bitbucket,
                    gitlab: options.gitlab,
                    gitEmails: options.gitEmail,
                });
                if (!dev) {
                    console.error(`Error: developer with id '${options.id}' not found.`);
                    process.exit(1);
                }
                console.log(`Developer '${dev.name}' (${dev.id}) updated.`);
                console.log('External IDs:', JSON.stringify(dev.external_ids, null, 2));
            } finally {
                db.close();
            }
        },
    );

devCommand
    .command('discover')
    .description('Auto-discover developers from GitHub org members')
    .requiredOption('--org <org>', 'GitHub organization name')
    .option('--token <token>', 'GitHub API token (or set GITHUB_TOKEN env var)')
    .option('--team <team>', 'Default team to assign discovered developers to', 'discovered')
    .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
    .action(
        async (options: {org: string; token?: string; team: string; config: string}) => {
            const token = options.token ?? process.env.GITHUB_TOKEN;
            if (!token) {
                console.error(
                    'Error: GitHub token required. Use --token or set GITHUB_TOKEN environment variable.',
                );
                process.exit(1);
            }
            const configPath = path.resolve(process.cwd(), options.config);
            const db = openRegistryDb(configPath);
            try {
                console.log(`Discovering members of GitHub org '${options.org}'...`);
                const result = await discoverOrgMembers(db, options.org, token, options.team);
                console.log(`Created ${result.created.length} developer(s).`);
                if (result.skipped.length > 0) {
                    console.log(
                        `Skipped ${result.skipped.length} duplicate(s): ${result.skipped.join(', ')}`,
                    );
                }
                for (const dev of result.created) {
                    console.log(`  + ${dev.name} (${dev.external_ids.github}) -> team: ${dev.team}`);
                }
            } finally {
                db.close();
            }
        },
    );

const userCommand = program.command('user').description('Manage user accounts and authentication');

userCommand
    .command('create-admin')
    .description('Bootstrap an admin account for dashboard login')
    .requiredOption('--email <email>', 'Admin email address')
    .option('--password <password>', 'Password (a temporary one is generated and printed if omitted)')
    .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
    .action(async (options: {email: string; password?: string; config: string}) => {
        const email = options.email.trim();
        if (!email.includes('@') || email.length > 320) {
            console.error(`Error: '${email}' is not a valid email address.`);
            process.exit(1);
        }

        const configPath = path.resolve(process.cwd(), options.config);
        const db = openRegistryDb(configPath);
        try {
            if (getActiveUserByEmail(db, email)) {
                console.error(`Error: a user with email '${email}' already exists.`);
                process.exit(1);
            }

            // When no password is supplied, generate a temporary one and force a
            // change on first login.
            const generated = !options.password;
            const password = options.password ?? generateTempPassword();

            const strength = validatePasswordStrength(password);
            if (!strength.valid) {
                console.error(`Error: ${strength.error}.`);
                process.exit(1);
            }

            const passwordHash = await hashPassword(password);
            const user = createUser(db, {
                email,
                passwordHash,
                role: 'admin',
                mustChangePassword: generated,
            });

            console.log(`Admin account created for ${user.email} (id: ${user.id}).`);
            if (generated) {
                console.log('');
                console.log(`  Temporary password: ${password}`);
                console.log('  You will be required to change it on first login.');
            }
            if (countAdmins(db) > 1) {
                console.warn('Note: more than one admin account now exists.');
            }
        } finally {
            db.close();
        }
    });

const syncCommand = program.command('sync').description('Sync data from connectors');

syncCommand
    .command('all')
    .description('Run full sync pipeline: Copilot → Claude Code → Windsurf → Git')
    .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
    .action(async (options: {config: string}) => {
        const configPath = path.resolve(process.cwd(), options.config);
        const config = loadConfig(configPath);
        const dbPath = path.resolve(process.cwd(), config.storage.sqlite_path);
        const db = openDb(dbPath);
        let hasErrors = false;
        try {
            runMigrations(db, MIGRATIONS_DIR);
            const connectors = [
                new CopilotSync(config.connectors.copilot),
                new ClaudeCodeSync(config.connectors.claude_code),
                new WindsurfSync(config.connectors.windsurf),
                new GitSync(config.connectors.git),
            ];
            const results = await runPipeline(db, connectors);
            // Fresh snapshots may settle a pending plan upgrade — evaluate ROI after
            // the pull so plan_roi alerts stay current without a separate command.
            const roi = evaluatePlanRoi(db);
            if (roi.flagged > 0) {
                console.log(`[plan-roi] ${roi.flagged} plan upgrade(s) flagged for cost/usage review`);
            }
            for (const {connector, result, retried} of results) {
                const retry = retried ? ' (retried)' : '';
                console.log(
                    `[${connector}] sync complete${retry} — ${result.snapshotsWritten} written, ${result.snapshotsSkipped} skipped`,
                );
                for (const e of result.errors) {
                    console.error(`[${connector}] error: ${e}`);
                    hasErrors = true;
                }
            }
        } finally {
            db.close();
        }
        if (hasErrors) process.exit(1);
    });

syncCommand
    .command('copilot')
    .description('Pull data from GitHub Copilot Metrics API')
    .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
    .action(async (options: {config: string}) => {
        const configPath = path.resolve(process.cwd(), options.config);
        const config = loadConfig(configPath);
        const dbPath = path.resolve(process.cwd(), config.storage.sqlite_path);
        const db = openDb(dbPath);
        let hasErrors = false;
        try {
            runMigrations(db, MIGRATIONS_DIR);
            const syncer = new CopilotSync(config.connectors.copilot);
            const result = await syncer.sync(db);
            console.log(
                `[copilot] sync complete — ${result.snapshotsWritten} written, ${result.snapshotsSkipped} skipped`,
            );
            if (result.errors.length > 0) {
                for (const e of result.errors) {
                    console.error(`[copilot] error: ${e}`);
                }
                hasErrors = true;
            }
        } finally {
            db.close();
        }
        if (hasErrors) process.exit(1);
    });

syncCommand
    .command('claude-code')
    .description('Pull data from Anthropic Enterprise Analytics API')
    .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
    .action(async (options: {config: string}) => {
        const configPath = path.resolve(process.cwd(), options.config);
        const config = loadConfig(configPath);
        const dbPath = path.resolve(process.cwd(), config.storage.sqlite_path);
        const db = openDb(dbPath);
        let hasErrors = false;
        try {
            runMigrations(db, MIGRATIONS_DIR);
            const syncer = new ClaudeCodeSync(config.connectors.claude_code);
            const result = await syncer.sync(db);
            console.log(
                `[claude-code] sync complete — ${result.snapshotsWritten} written, ${result.snapshotsSkipped} skipped`,
            );
            if (result.errors.length > 0) {
                for (const e of result.errors) {
                    console.error(`[claude-code] error: ${e}`);
                }
                hasErrors = true;
            }
        } finally {
            db.close();
        }
        if (hasErrors) process.exit(1);
    });

syncCommand
    .command('windsurf')
    .description('Pull data from Windsurf Enterprise Analytics API')
    .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
    .action(async (options: {config: string}) => {
        const configPath = path.resolve(process.cwd(), options.config);
        const config = loadConfig(configPath);
        const dbPath = path.resolve(process.cwd(), config.storage.sqlite_path);
        const db = openDb(dbPath);
        let hasErrors = false;
        try {
            runMigrations(db, MIGRATIONS_DIR);
            const syncer = new WindsurfSync(config.connectors.windsurf);
            const result = await syncer.sync(db);
            console.log(
                `[windsurf] sync complete — ${result.snapshotsWritten} written, ${result.snapshotsSkipped} skipped`,
            );
            if (result.errors.length > 0) {
                for (const e of result.errors) {
                    console.error(`[windsurf] error: ${e}`);
                }
                hasErrors = true;
            }
        } finally {
            db.close();
        }
        if (hasErrors) process.exit(1);
    });

syncCommand
    .command('git')
    .description('Pull commit and PR data from configured git providers')
    .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
    .option('--provider <type>', 'Only sync a specific provider (github, bitbucket, gitlab). Note: partial re-runs overwrite any existing multi-provider snapshot for the same developer+day.')
    .action(async (options: {config: string; provider?: string}) => {
        const configPath = path.resolve(process.cwd(), options.config);
        const config = loadConfig(configPath);
        const dbPath = path.resolve(process.cwd(), config.storage.sqlite_path);
        const db = openDb(dbPath);
        let hasErrors = false;
        try {
            runMigrations(db, MIGRATIONS_DIR);
            const syncer = new GitSync(config.connectors.git);
            const result = await syncer.sync(db, options.provider);
            console.log(
                `[git] sync complete — ${result.snapshotsWritten} written, ${result.snapshotsSkipped} skipped`,
            );
            if (result.errors.length > 0) {
                for (const e of result.errors) {
                    console.error(`[git] error: ${e}`);
                }
                hasErrors = true;
            }
        } finally {
            db.close();
        }
        if (hasErrors) process.exit(1);
    });

const expensesCommand = program.command('expenses').description('Manage expense and subscription data');

expensesCommand
    .command('import <file>')
    .description('Import subscriptions from a CSV file')
    .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
    .action((file: string, options: {config: string}) => {
        const configPath = path.resolve(process.cwd(), options.config);
        const config = loadConfig(configPath);
        const dbPath = path.resolve(process.cwd(), config.storage.sqlite_path);
        const db = openDb(dbPath);
        try {
            runMigrations(db, MIGRATIONS_DIR);
            const filePath = path.resolve(process.cwd(), file);
            const result = importCsv(db, filePath, config.expenses);
            console.log(`Import complete: ${result.imported} imported, ${result.skipped} skipped`);
            for (const warning of result.warnings) {
                console.warn(`  ⚠  ${warning}`);
            }
        } finally {
            db.close();
        }
    });

expensesCommand
    .command('show')
    .description('Show current subscriptions with costs')
    .option('--team <name>', 'Filter by team name')
    .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
    .action((options: {team?: string; config: string}) => {
        const configPath = path.resolve(process.cwd(), options.config);
        const config = loadConfig(configPath);
        const dbPath = path.resolve(process.cwd(), config.storage.sqlite_path);
        const db = openDb(dbPath);
        try {
            runMigrations(db, MIGRATIONS_DIR);
            const subs = listSubscriptions(db, options.team);

            if (subs.length === 0) {
                console.log('No active subscriptions found.');
                return;
            }

            const col = (s: string, width: number): string => s.padEnd(width).slice(0, width);
            const LINE_WIDTH = 80;

            console.log('Subscriptions:');
            console.log('─'.repeat(LINE_WIDTH));
            console.log(
                `${col('Developer', 22)}${col('Tool', 14)}${col('Plan', 12)}${col('Cost/mo', 10)}Billing`,
            );
            console.log('─'.repeat(LINE_WIDTH));

            for (const s of subs) {
                const cost = s.monthly_cost != null ? `$${s.monthly_cost.toFixed(2)}` : '—';
                console.log(
                    `${col(s.developer_name, 22)}${col(s.tool, 14)}${col(s.plan ?? '—', 12)}${col(cost, 10)}${s.billing_model}`,
                );
            }

            console.log('─'.repeat(LINE_WIDTH));

            const devSummaries = getDeveloperCostSummaries(db, options.team);
            const orgSummary = options.team
                ? {
                      total_monthly_cost: devSummaries.reduce(
                          (acc, d) => acc + d.total_monthly_cost,
                          0,
                      ),
                      developer_count: devSummaries.length,
                      subscription_count: subs.length,
                  }
                : getOrgCostSummary(db);

            console.log(
                `Total: $${orgSummary.total_monthly_cost.toFixed(2)}/month  |  ${orgSummary.subscription_count} subscriptions  |  ${orgSummary.developer_count} developers`,
            );

            if (!options.team) {
                const teamSummaries = getTeamCostSummaries(db);
                if (teamSummaries.length > 1) {
                    console.log('');
                    console.log('By Team:');
                    for (const t of teamSummaries) {
                        console.log(
                            `  ${t.team.padEnd(20)} $${t.total_monthly_cost.toFixed(2)}/mo  (${t.developer_count} devs, ${t.subscription_count} subs)`,
                        );
                    }
                }
            }

            const duplicates = detectDuplicates(db);
            const relevantDuplicates = options.team
                ? duplicates.filter((d) =>
                      subs.some((s) => s.developer_id === d.developer_id),
                  )
                : duplicates;

            if (relevantDuplicates.length > 0) {
                console.log('');
                console.log('Duplicate Tool Alerts:');
                for (const alert of relevantDuplicates) {
                    console.warn(`  ⚠  ${alert.message}`);
                }
            }
        } finally {
            db.close();
        }
    });

const wasteCommand = program.command('waste').description('Waste detection and management');

wasteCommand
    .command('show')
    .description('Run waste detection and list active alerts grouped by type')
    .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
    .action((options: {config: string}) => {
        const configPath = path.resolve(process.cwd(), options.config);
        const config = loadConfig(configPath);
        const dbPath = path.resolve(process.cwd(), config.storage.sqlite_path);
        const db = openDb(dbPath);
        try {
            runMigrations(db, MIGRATIONS_DIR);

            const wasteThreshold = config.alerts?.waste_threshold ?? 14;
            const result = runWasteDetection(db, {inactivity_threshold_days: wasteThreshold});
            evaluatePlanRoi(db);
            if (result.created > 0) {
                console.log(`Detected ${result.created} new waste alert(s).`);
            }

            const alerts = listActiveAlerts(db);
            if (alerts.length === 0) {
                console.log('No active waste alerts.');
                return;
            }

            const LINE_WIDTH = 80;
            const col = (s: string, width: number): string => s.padEnd(width).slice(0, width);

            // Group by type
            const byType = new Map<string, typeof alerts>();
            for (const alert of alerts) {
                const list = byType.get(alert.alert_type) ?? [];
                list.push(alert);
                byType.set(alert.alert_type, list);
            }

            const typeLabels: Record<string, string> = {
                unused_seat: 'Unused Seats',
                underutilized: 'Underutilized Seats',
                duplicate_tool: 'Duplicate Tools',
                cost_outlier: 'Cost Outliers',
                plan_roi: 'Plan-Change ROI (review)',
            };

            let totalWaste = 0;
            for (const [type, typeAlerts] of byType) {
                const label = typeLabels[type] ?? type;
                console.log('');
                console.log(`${label}:`);
                console.log('─'.repeat(LINE_WIDTH));
                console.log(
                    `${col('ID', 12)}${col('Developer', 22)}${col('Team', 16)}${col('Tool', 12)}Waste/mo`,
                );
                console.log('─'.repeat(LINE_WIDTH));
                for (const alert of typeAlerts) {
                    const devName = alert.developer_name ?? '(team)';
                    const tool = alert.tool ?? '—';
                    const waste =
                        alert.monthly_waste != null ? `$${alert.monthly_waste.toFixed(2)}` : '—';
                    console.log(
                        `${col(alert.id.slice(0, 8), 12)}${col(devName, 22)}${col(alert.team, 16)}${col(tool, 12)}${waste}`,
                    );
                    if (alert.details.note) {
                        console.log(`             ↳ ${alert.details.note}`);
                    }
                    totalWaste += alert.monthly_waste ?? 0;
                }
            }

            console.log('');
            console.log('─'.repeat(LINE_WIDTH));
            console.log(
                `Total: ${alerts.length} alert(s)  |  Estimated waste: $${totalWaste.toFixed(2)}/month`,
            );
            console.log('');
            console.log('Use `govproxy waste resolve <id> --reason <text>` to dismiss an alert.');
        } finally {
            db.close();
        }
    });

wasteCommand
    .command('summary')
    .description('Show waste summary grouped by team')
    .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
    .action((options: {config: string}) => {
        const configPath = path.resolve(process.cwd(), options.config);
        const config = loadConfig(configPath);
        const dbPath = path.resolve(process.cwd(), config.storage.sqlite_path);
        const db = openDb(dbPath);
        try {
            runMigrations(db, MIGRATIONS_DIR);

            const summary = getWasteSummaryByTeam(db);
            if (summary.length === 0) {
                console.log('No active waste alerts.');
                return;
            }

            const LINE_WIDTH = 80;
            const col = (s: string, width: number): string => s.padEnd(width).slice(0, width);

            console.log('Waste Summary by Team:');
            console.log('─'.repeat(LINE_WIDTH));
            console.log(`${col('Team', 22)}${col('Alerts', 10)}${col('Waste/mo', 14)}Types`);
            console.log('─'.repeat(LINE_WIDTH));

            let totalAlerts = 0;
            let totalWaste = 0;

            for (const row of summary) {
                const types = Object.keys(row.alerts_by_type).join(', ');
                console.log(
                    `${col(row.team, 22)}${col(String(row.alert_count), 10)}${col(`$${row.total_monthly_waste.toFixed(2)}`, 14)}${types}`,
                );
                totalAlerts += row.alert_count;
                totalWaste += row.total_monthly_waste;
            }

            console.log('─'.repeat(LINE_WIDTH));
            console.log(
                `${'TOTAL'.padEnd(22)}${col(String(totalAlerts), 10)}$${totalWaste.toFixed(2)}/month`,
            );
        } finally {
            db.close();
        }
    });

wasteCommand
    .command('resolve <alert-id>')
    .description('Resolve a waste alert with a reason')
    .requiredOption('--reason <text>', 'Reason for dismissing the alert')
    .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
    .action((alertId: string, options: {reason: string; config: string}) => {
        const configPath = path.resolve(process.cwd(), options.config);
        const config = loadConfig(configPath);
        const dbPath = path.resolve(process.cwd(), config.storage.sqlite_path);
        const db = openDb(dbPath);
        let exitCode = 0;
        try {
            runMigrations(db, MIGRATIONS_DIR);

            // Support partial ID (first 8 chars shown in `waste show`)
            let resolvedId = alertId;
            if (alertId.length < 36) {
                const row = db
                    .prepare(`SELECT id FROM waste_alerts WHERE id LIKE ? AND resolved_at IS NULL LIMIT 1`)
                    .get(`${alertId}%`) as {id: string} | undefined;
                if (!row) {
                    console.error(`No active alert found matching id: ${alertId}`);
                    exitCode = 1;
                } else {
                    resolvedId = row.id;
                }
            }

            if (exitCode === 0) {
                const ok = resolveAlert(db, resolvedId, options.reason);
                if (ok) {
                    console.log(`Alert ${resolvedId.slice(0, 8)} resolved: ${options.reason}`);
                } else {
                    console.error(`Alert not found or already resolved: ${alertId}`);
                    exitCode = 1;
                }
            }
        } finally {
            db.close();
        }
        if (exitCode !== 0) process.exit(exitCode);
    });

const aggregateCommand = program.command('aggregate').description('Compute trend aggregates');

aggregateCommand
    .command('backfill')
    .description(
        'Compute historical aggregates (weekly, monthly, quarterly, yearly) from existing daily snapshots. ' +
            'Backfill the oldest range first and without gaps: deltas are not cascaded, so running a later ' +
            'range before an earlier adjacent one leaves the boundary delta uncompared.',
    )
    .option('--from <date>', 'Inclusive range start (YYYY-MM-DD). Defaults to 12 months before --to')
    .option('--to <date>', 'Inclusive range end (YYYY-MM-DD). Defaults to today (UTC)')
    .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
    .action((options: {from?: string; to?: string; config: string}) => {
        const configPath = path.resolve(process.cwd(), options.config);
        const config = loadConfig(configPath);
        const dbPath = path.resolve(process.cwd(), config.storage.sqlite_path);
        const db = openDb(dbPath);
        try {
            runMigrations(db, MIGRATIONS_DIR);

            // Print a per-level running counter. On a TTY the line is rewritten in
            // place; otherwise (captured logs) print one line per level boundary so
            // the output stays readable without a stream of overwrites.
            const isTty = Boolean(process.stdout.isTTY);
            const labels: Record<BackfillProgress['level'], string> = {
                weekly: 'Weekly   ',
                monthly: 'Monthly  ',
                quarterly: 'Quarterly',
                yearly: 'Yearly   ',
            };
            const onProgress = (p: BackfillProgress): void => {
                const line = `  ${labels[p.level]}  ${p.levelIndex}/${p.levelTotal}  (overall ${p.overallIndex}/${p.overallTotal})`;
                if (isTty) {
                    process.stdout.write(`\r${line}`);
                    if (p.levelIndex === p.levelTotal) process.stdout.write('\n');
                    return;
                }
                // Non-TTY (captured logs / CI): \r can't rewrite a line in a file, so
                // print discrete milestones — first and last period of each level,
                // plus every 20th — to show liveness during a long pass without a
                // flood of one line per period.
                if (p.levelIndex === 1 || p.levelIndex === p.levelTotal || p.levelIndex % 20 === 0) {
                    console.log(line);
                }
            };

            const result = runBackfill(db, {from: options.from, to: options.to, onProgress});

            console.log(
                `Backfill complete (${result.from} → ${result.to}): ` +
                    `${result.periodsProcessed} periods processed ` +
                    `(${result.weeks} weekly, ${result.months} monthly, ${result.quarters} quarterly, ${result.years} yearly), ` +
                    `${result.rowsWritten} aggregate row(s) written.`,
            );
        } finally {
            db.close();
        }
    });

program
    .command('status')
    .description('Show a unified summary of developers, connectors, subscriptions, and waste')
    .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
    .action((options: {config: string}) => {
        const configPath = path.resolve(process.cwd(), options.config);
        const config = loadConfig(configPath);
        const dbPath = path.resolve(process.cwd(), config.storage.sqlite_path);
        const db = openDb(dbPath);
        try {
            runMigrations(db, MIGRATIONS_DIR);
            printStatus(db, config);
        } finally {
            db.close();
        }
    });

program
    .command('doctor')
    .description('Validate the entire GovProxy setup: config, database, and API tokens')
    .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
    .action(async (options: {config: string}) => {
        const configPath = path.resolve(process.cwd(), options.config);
        const config = loadConfig(configPath);
        const dbPath = path.resolve(process.cwd(), config.storage.sqlite_path);
        const db = openDb(dbPath);
        let passed = false;
        try {
            runMigrations(db, MIGRATIONS_DIR);
            passed = await runDoctor(db, config, configPath, MIGRATIONS_DIR);
        } finally {
            db.close();
        }
        if (!passed) process.exit(1);
    });

program.parseAsync().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
