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

    registerOverviewRoutes(app, db);
    registerTeamRoutes(app, db);
    registerDeveloperRoutes(app, db);
    registerWasteRoutes(app, db);
    registerSnapshotRoutes(app, db);
    registerExportRoutes(app, db);

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
