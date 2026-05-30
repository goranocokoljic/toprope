import Fastify, {type FastifyInstance} from 'fastify';
import path from 'path';
import {loadConfig} from './config/loader';
import type {GovProxyConfig} from './config/types';
import {openDb} from './storage/db';
import {runMigrations} from './storage/migrator';
import {registerSessionAuth} from './auth/middleware';
import {DEFAULT_SESSION_TTL_HOURS, pruneExpiredSessions} from './auth/sessions';
import {registerAuthRoutes} from './dashboard/api/auth-routes';
import {registerMeRoutes} from './dashboard/api/me';
import {registerOverviewRoutes} from './dashboard/api/overview';
import {registerTeamRoutes} from './dashboard/api/teams';
import {registerDeveloperRoutes} from './dashboard/api/developers';
import {registerWasteRoutes} from './dashboard/api/waste';
import {registerSnapshotRoutes} from './dashboard/api/snapshots';
import {registerExportRoutes} from './dashboard/api/export';
import {registerDashboardStatic} from './dashboard/static';
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

    // Sweep dead session rows on startup so the table doesn't accumulate
    // never-looked-up expired sessions over the life of the deployment.
    pruneExpiredSessions(db);

    // Per-user session auth (Task 2.2): the onRequest hook guards every /api/*
    // route except login; developers are confined to /api/me/* and /api/auth/*.
    registerSessionAuth(app, db);

    app.get('/health', async () => {
        return {status: 'ok'};
    });

    app.addHook('onClose', () => db.close());

    const cookieSecure = config.dashboard?.auth?.cookie_secure ?? false;
    const host = config.server?.host;
    const isLoopback = host === undefined || host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (!cookieSecure && !isLoopback) {
        app.log.warn(
            `Server is binding non-loopback host '${host}' with dashboard.auth.cookie_secure=false — ` +
                'session cookies will be sent over plaintext HTTP. Enable cookie_secure behind HTTPS.',
        );
    }

    const authOptions = {
        sessionTtlHours: config.dashboard?.auth?.session_ttl_hours ?? DEFAULT_SESSION_TTL_HOURS,
        cookieSecure,
    };
    registerAuthRoutes(app, db, authOptions);
    registerMeRoutes(app, db);
    registerOverviewRoutes(app, db);
    registerTeamRoutes(app, db);
    registerDeveloperRoutes(app, db);
    registerWasteRoutes(app, db);
    registerSnapshotRoutes(app, db);
    registerExportRoutes(app, db);

    // Serve the built React dashboard (Phase 2) at /dashboard, if present.
    registerDashboardStatic(app);

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
