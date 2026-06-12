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
import {registerAggregateRoutes} from './dashboard/api/aggregates';
import {registerMaturityRoutes} from './dashboard/api/maturity';
import {registerCompareRoutes} from './dashboard/api/compare';
import {registerCompareTableRoutes} from './dashboard/api/compare-table';
import {registerSummaryRoutes} from './dashboard/api/summaries';
import {registerAnomalyRoutes} from './dashboard/api/anomalies';
import {registerCoachingRoutes} from './dashboard/api/coaching';
import {registerCaptureRoutes} from './dashboard/api/captures';
import {registerKeyRoutes} from './dashboard/api/keys';
import {registerRealtimeCoachingRoutes} from './dashboard/api/realtime-coaching';
import {registerRetrospectiveRoutes} from './dashboard/api/retrospectives';
import {registerDashboardStatic} from './dashboard/static';
import {createSlackClient} from './slack/client';
import {notifyNewAnomalies} from './anomaly/notify';
import {startScheduler} from './scheduler/scheduler';
import {startAggregationScheduler} from './aggregation/scheduler';
import {startSummaryScheduler} from './summaries/scheduler';
import {registerSlackRoutes} from './slack/routes';
import {startSlackDailyPrompt} from './slack/scheduler';
import {registerSurveyRoutes} from './dashboard/api/surveys';
import {createLogEmailer} from './surveys/email';
import {surveySlackClientFromConfig} from './surveys/dispatch';
import {startSurveyScheduler} from './surveys/scheduler';

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
    // Phase 3 reads: pre-computed aggregates, maturity trend, and AI summaries.
    registerAggregateRoutes(app, db);
    registerMaturityRoutes(app, db);
    registerCompareRoutes(app, db);
    registerCompareTableRoutes(app, db);
    registerSummaryRoutes(app, db, config.summaries);
    // Anomaly surfacing (Task 4.8): manager panel + acknowledge/resolve.
    registerAnomalyRoutes(app, db);
    // PR/review coaching (Task 5.3): manager-facing TEAM aggregates only. The
    // developer-private trajectory lives on /api/me (registered above).
    registerCoachingRoutes(app, db);
    // Prompt capture (Task 5.4): developer-private, opt-in, client-encrypted
    // capture ingestion + read under /api/me. The server is a blind store.
    registerCaptureRoutes(app, db);
    // Capture-key management & recovery (Task 5.5): developer-owned key metadata,
    // recovery posture (no_recovery | recovery_path), client-wrapped recovery
    // blob, and a developer-visible recovery audit. No server-side key material.
    registerKeyRoutes(app, db);
    // Real-time loop detection + nudges (Task 5.6): detection runs locally at the
    // capture layer; these /api/me routes only record/read the developer's own
    // non-sensitive event METADATA (counts, types, timestamps) and dismissals.
    registerRealtimeCoachingRoutes(app, db);
    // Session retrospectives (Task 5.7): the deep async coaching layer. Generation
    // TRANSIENTLY decrypts a captured session in memory with a key the developer
    // supplies for that one call, runs a LOCAL-default analyser (cloud only via
    // opt-in #2), and persists ONLY the narrative output — never the key/plaintext.
    // All /api/me, developer-private; no manager path.
    registerRetrospectiveRoutes(app, db);

    // Data-prompted surveys (Task 4.3): manager queue + developer self-service.
    // Survey delivery prefers the Slack bot when configured, with an email
    // fallback (a logging emailer until a real transport is wired). The Slack
    // client is constructed only when the bot is enabled with a token, so
    // delivery cleanly degrades to email otherwise.
    registerSurveyRoutes(app, db, {
        slackClient: surveySlackClientFromConfig(config as GovProxyConfig),
        emailer: createLogEmailer((line) => app.log.info(line)),
        log: (message, err) => app.log.error({err}, `[surveys] ${message}`),
    });

    // Slack self-reporting bot (Task 4.2): slash command + interactive form,
    // authenticated by Slack request signature rather than the session gate.
    // Registered only when enabled so the urlencoded parser/routes don't exist
    // on deployments that don't use Slack.
    if (config.slack?.enabled) {
        registerSlackRoutes(app, db, config.slack);
    }

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
        const aggregationTasks = startAggregationScheduler(dbPath, {
            notifier: buildAnomalyNotifier(dbPath, config as GovProxyConfig, app),
        });
        // Summary auto-generation (weekly + monthly) fires just after the matching
        // aggregation job, generating each scope's narrative for the just-completed
        // period. Gated on summaries config (a disabled level registers no task);
        // quarterly/yearly are on-demand only and never scheduled here.
        const summaryTasks = startSummaryScheduler(dbPath, config.summaries);
        // Optional end-of-day Slack prompt. startSlackDailyPrompt self-gates on
        // slack.enabled + daily_prompt.enabled + channels, returning [] otherwise.
        const slackPromptTasks = startSlackDailyPrompt(config.slack);
        // Optional daily survey trigger sweep (Task 4.3). Self-gates on
        // surveys.enabled, returning [] otherwise. Runs detection + dispatch and
        // retries stranded auto-surveys.
        const surveyTasks = startSurveyScheduler(dbPath, config as GovProxyConfig);
        app.addHook('onClose', () => {
            for (const task of [
                ...connectorTasks,
                ...aggregationTasks,
                ...summaryTasks,
                ...slackPromptTasks,
                ...surveyTasks,
            ])
                task.stop();
        });
    }

    return app;
}

/**
 * Build the anomaly Slack notifier the weekly aggregation job fires (Task 4.8),
 * or undefined when alerting can't deliver (Slack bot disabled / no token / no
 * channels). The returned callback is fire-and-forget: it opens its OWN
 * short-lived DB handle (the aggregation job's handle has already closed by the
 * time it runs) and detaches the async dispatch, logging failures rather than
 * letting them escape into the cron handler. The per-team `anomaly_alerts_enabled`
 * setting is still the final gate inside notifyNewAnomalies.
 */
function buildAnomalyNotifier(
    dbPath: string,
    config: GovProxyConfig,
    app: FastifyInstance,
): (() => void) | undefined {
    const slack = config.slack;
    if (!slack?.enabled || !slack.bot_token) return undefined;
    const channels = slack.anomaly_alerts?.channels ?? [];
    if (channels.length === 0) return undefined;

    const client = createSlackClient(slack.bot_token);
    const dashboardUrl = slack.anomaly_alerts?.dashboard_url;
    return (): void => {
        const db = openDb(dbPath);
        void notifyNewAnomalies({db, slackClient: client, channels, dashboardUrl})
            .catch((err) => app.log.error({err}, '[anomaly:notify] failed'))
            .finally(() => db.close());
    };
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
