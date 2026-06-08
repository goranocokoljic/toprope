import cron from 'node-cron';
import path from 'path';
import type Database from 'better-sqlite3';
import {openDb} from '../storage/db';
import {runMigrations} from '../storage/migrator';
import {parseSyncTimeToCron} from '../scheduler/scheduler';
import type {SlackClient} from '../slack/client';
import type {GovProxyConfig} from '../config/types';
import type {Emailer} from './email';
import {buildSurveyDispatchDeps, runTriggerSweep, type SweepSummary} from './dispatch';

/**
 * Scheduled survey trigger sweep (Task 4.3 / #98).
 *
 * Mirrors the aggregation/summary schedulers: opt-in via `surveys.enabled`, a
 * single daily cron that runs detection + dispatch (and retries stranded
 * auto-surveys) against a short-lived DB handle. Without this, "auto-send" only
 * fires when an operator runs `govproxy survey run`; with it, triggered surveys
 * go out unattended and a transient delivery outage self-heals on the next tick.
 */

const DEFAULT_SWEEP_TIME = '09:00';
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../storage/migrations');

export interface SurveySchedulerOptions {
    // Inject delivery deps for testing; production builds them from config.
    slackClient?: SlackClient;
    emailer?: Emailer;
    migrationsDir?: string;
    log?: (message: string, err?: unknown) => void;
}

/**
 * Run one sweep end-to-end against `dbPath`: open a short-lived DB handle, apply
 * migrations, run the sweep, and close. Never throws — a failure is logged and
 * null is returned, so a bad fire can't escape into node-cron. Exported so the
 * production lifecycle is testable without the wall clock.
 */
export async function runScheduledSurveySweep(
    dbPath: string,
    config: GovProxyConfig,
    options: SurveySchedulerOptions = {},
): Promise<SweepSummary | null> {
    const log = options.log ?? ((m: string, e?: unknown) => console.error(`[surveys] ${m}`, e ?? ''));
    let db: Database.Database;
    try {
        db = openDb(dbPath);
    } catch (err) {
        log('survey sweep could not open the database', err);
        return null;
    }
    try {
        runMigrations(db, options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
        // `options` carries the SurveyDispatchOverrides fields (plus migrationsDir,
        // which the builder structurally ignores), so pass it straight through.
        return await runTriggerSweep(buildSurveyDispatchDeps(db, config, options));
    } catch (err) {
        log('survey sweep failed', err);
        return null;
    } finally {
        db.close();
    }
}

/**
 * Register the daily survey sweep against `dbPath` and return the node-cron task
 * (for onClose teardown). Returns [] when surveys are disabled — so a deployment
 * that hasn't opted in gets no task at all.
 */
export function startSurveyScheduler(
    dbPath: string,
    config: GovProxyConfig,
    options: SurveySchedulerOptions = {},
): Array<ReturnType<typeof cron.schedule>> {
    if (!config.surveys?.enabled) return [];

    const configured = config.surveys.sweep_time ?? DEFAULT_SWEEP_TIME;
    let time = configured;
    if (!HH_MM.test(time)) {
        console.error(
            `[surveys] invalid surveys.sweep_time '${configured}' (expected HH:MM) — falling back to ${DEFAULT_SWEEP_TIME}.`,
        );
        time = DEFAULT_SWEEP_TIME;
    }

    const task = cron.schedule(
        parseSyncTimeToCron(time),
        () => void runScheduledSurveySweep(dbPath, config, options),
        {timezone: 'UTC'},
    );
    return [task];
}
