import {Command} from 'commander';
import path from 'path';
import {loadConfig} from './config/loader';
import {buildServer} from './server';
import {openDb} from './storage/db';
import {runMigrations, getMigrationStatus} from './storage/migrator';
import {addTeam, listTeams, teamExists} from './registry/teams';
import {addDeveloper, listDevelopers, getDeveloperById, linkDeveloper, findByGithubUsername} from './registry/developers';
import {discoverOrgMembers} from './registry/discovery';
import {seedTeamsFromConfig} from './registry/config-seeder';
import {CopilotSync} from './connectors/copilot/sync';
import {ClaudeCodeSync} from './connectors/claude-code/sync';
import {WindsurfSync} from './connectors/windsurf/sync';

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
    .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
    .action(
        (options: {name: string; team: string; email?: string; github?: string; config: string}) => {
            const configPath = path.resolve(process.cwd(), options.config);
            const db = openRegistryDb(configPath);
            try {
                if (!teamExists(db, options.team)) {
                    console.error(`Error: team '${options.team}' does not exist.`);
                    process.exit(1);
                }
                if (options.github) {
                    const duplicate = findByGithubUsername(db, options.github);
                    if (duplicate) {
                        console.warn(
                            `Warning: developer with GitHub username '${options.github}' already exists (id: ${duplicate.id}, name: ${duplicate.name}).`,
                        );
                        return;
                    }
                }
                const dev = addDeveloper(db, options.name, options.team, options.email, options.github);
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
                const gh = d.external_ids.github ? `  github: ${d.external_ids.github}` : '';
                console.log(`  [${d.id}] ${d.name}${email}  team: ${d.team}${gh}`);
            }
        } finally {
            db.close();
        }
    });

devCommand
    .command('link')
    .description('Link developer to external tool identities')
    .requiredOption('--id <dev-id>', 'Developer ID')
    .option('--copilot <username>', 'GitHub Copilot username')
    .option('--claude <email>', 'Claude Code email')
    .option('--windsurf <email>', 'Windsurf email')
    .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
    .action(
        (options: {id: string; copilot?: string; claude?: string; windsurf?: string; config: string}) => {
            const configPath = path.resolve(process.cwd(), options.config);
            const db = openRegistryDb(configPath);
            try {
                if (!options.copilot && !options.claude && !options.windsurf) {
                    console.error('Error: at least one of --copilot, --claude, or --windsurf must be provided.');
                    process.exit(1);
                }
                const dev = linkDeveloper(db, options.id, {
                    copilot: options.copilot,
                    claude: options.claude,
                    windsurf: options.windsurf,
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

const syncCommand = program.command('sync').description('Sync data from connectors');

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

program.parseAsync().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
