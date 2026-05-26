import Fastify, {type FastifyInstance} from 'fastify';
import path from 'path';
import {loadConfig} from './config/loader';
import type {GovProxyConfig} from './config/types';
import {openDb} from './storage/db';
import {runMigrations} from './storage/migrator';
import {registerAuthMiddleware} from './dashboard/api/auth';
import {registerOverviewRoutes} from './dashboard/api/overview';
import {registerTeamRoutes} from './dashboard/api/teams';
import {registerDeveloperRoutes} from './dashboard/api/developers';
import {registerWasteRoutes} from './dashboard/api/waste';
import {registerSnapshotRoutes} from './dashboard/api/snapshots';
import {registerExportRoutes} from './dashboard/api/export';
import {startScheduler} from './scheduler/scheduler';

const MIGRATIONS_DIR = path.resolve(__dirname, './storage/migrations');

export function buildServer(_config?: Partial<GovProxyConfig>): FastifyInstance {
    const app = Fastify({
        logger: process.env.NODE_ENV !== 'test',
    });

    app.get('/health', async () => {
        return {status: 'ok'};
    });

    return app;
}

export function buildServerWithDb(config: Partial<GovProxyConfig>): FastifyInstance {
    const app = Fastify({
        logger: process.env.NODE_ENV !== 'test',
    });

    const dbPath = config.storage?.sqlite_path ?? ':memory:';
    const db = openDb(dbPath);
    runMigrations(db, MIGRATIONS_DIR);

    const adminPassword = config.dashboard?.auth?.admin_password;
    registerAuthMiddleware(app, adminPassword);

    app.get('/health', async () => {
        return {status: 'ok'};
    });

    app.addHook('onClose', () => db.close());

    registerOverviewRoutes(app, db);
    registerTeamRoutes(app, db);
    registerDeveloperRoutes(app, db);
    registerWasteRoutes(app, db);
    registerSnapshotRoutes(app, db);
    registerExportRoutes(app, db);

    if (config.connectors && dbPath !== ':memory:') {
        const tasks = startScheduler(config as GovProxyConfig, dbPath);
        app.addHook('onClose', () => {
            for (const task of tasks) task.stop();
        });
    }

    return app;
}

async function main(): Promise<void> {
    const configPath = process.env.GOVPROXY_CONFIG ?? path.resolve(process.cwd(), 'govproxy.config.yaml');
    const config = loadConfig(configPath);

    const app = buildServerWithDb(config);

    try {
        await app.listen({port: config.server.port, host: config.server.host});
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}

if (require.main === module) {
    void main();
}
