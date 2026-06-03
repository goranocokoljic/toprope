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
import {registerTrendRoutes} from './dashboard/api/trends';
import {registerToolsRoutes} from './dashboard/api/tools';
import {registerCoverageRoutes} from './dashboard/api/coverage';
import {registerProviderRoutes} from './dashboard/api/providers';
import {registerSnapshotRoutes} from './dashboard/api/snapshots';
import {registerExportRoutes} from './dashboard/api/export';
import {registerSettingsRoutes} from './dashboard/api/settings';
import {registerLeaderboardRoutes} from './dashboard/api/leaderboard';
import {registerAdminRoutes} from './dashboard/api/admin';
import {registerDashboardStatic} from './dashboard/static';
import {startScheduler} from './scheduler/scheduler';
import {startAggregationScheduler} from './aggregation/scheduler';

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
    registerTrendRoutes(app, db);
    registerToolsRoutes(app, db);
    registerCoverageRoutes(app, db);
    registerProviderRoutes(app, db);
    registerSnapshotRoutes(app, db);
    registerExportRoutes(app, db);
    registerSettingsRoutes(app, db);
    registerLeaderboardRoutes(app, db);
    registerAdminRoutes(app, db);

    // Serve the built React dashboard (Phase 2) at /dashboard, if present.
    registerDashboardStatic(app);

    if (dbPath !== ':memory:') {
        // Connector syncs only run when a connectors block is configured.
        const connectorTasks = config.connectors
            ? startScheduler(config as GovProxyConfig, dbPath)
            : [];
        // Aggregation rollups run on their own period boundaries (04:00+ UTC),
        // deliberately after the connector syncs so each rollup folds a
        // daily-snapshot table the day's sync has already populated. They are
        // gated only on a persistent DB, NOT on connector presence: rollups fold
        // whatever daily snapshots exist (git-only/expense-only deployments
        // included), so coupling them to a connectors block would silently
        // starve the trend tables.
        const aggregationTasks = startAggregationScheduler(dbPath);
        app.addHook('onClose', () => {
            for (const task of [...connectorTasks, ...aggregationTasks]) task.stop();
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
