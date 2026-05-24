import {Command} from 'commander';
import path from 'path';
import {loadConfig} from './config/loader';
import {buildServer} from './server';
import {openDb} from './storage/db';
import {runMigrations, getMigrationStatus} from './storage/migrator';

const program = new Command();

program
    .name('govproxy')
    .description('AI adoption intelligence platform for engineering teams')
    .version('0.1.0');

program
    .command('start')
    .description('Start the GovProxy server')
    .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
    .action(async (options: { config: string }) => {
        const configPath = path.resolve(process.cwd(), options.config);
        const config = loadConfig(configPath);
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

program.parse();
