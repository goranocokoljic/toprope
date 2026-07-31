import cron from 'node-cron';
import path from 'path';
import type Database from 'better-sqlite3';
import type {TopropeConfig} from '../config/types';
import {openDb} from '../storage/db';
import {runMigrations} from '../storage/migrator';
import {CopilotSync} from '../connectors/copilot/sync';
import {ClaudeCodeSync} from '../connectors/claude-code/sync';
import {WindsurfSync} from '../connectors/windsurf/sync';
import {CursorSync} from '../connectors/cursor/sync';
import {GitSync} from '../connectors/git/sync';
import type {ConnectorInterface} from '../connectors/types';
import {runPipeline} from './sync-pipeline';
import {evaluatePlanRoi} from '../expenses/plan-roi';

const MIGRATIONS_DIR = path.resolve(__dirname, '../storage/migrations');

export function parseSyncTimeToCron(syncTime: string): string {
    const [hour, minute] = syncTime.split(':');
    return `${minute ?? '0'} ${hour ?? '0'} * * *`;
}

export interface ScheduledConnector {
    name: string;
    enabled: boolean;
    syncTime: string;
    // Typed as what `runPipeline` actually consumes rather than as the union of the five
    // concrete classes: the schedule never touches a connector-specific member, and the
    // narrower type is what lets `createConnectorTick` be tested with a stub (#283).
    makeConnector: () => ConnectorInterface;
}

export function buildConnectorSchedule(config: TopropeConfig): ScheduledConnector[] {
    return [
        {
            name: 'copilot',
            enabled: config.connectors.copilot?.enabled ?? false,
            syncTime: config.connectors.copilot?.sync_time ?? '02:00',
            makeConnector: () => new CopilotSync(config.connectors.copilot),
        },
        {
            name: 'claude_code',
            enabled: config.connectors.claude_code?.enabled ?? false,
            syncTime: config.connectors.claude_code?.sync_time ?? '02:30',
            makeConnector: () => new ClaudeCodeSync(config.connectors.claude_code),
        },
        {
            name: 'windsurf',
            enabled: config.connectors.windsurf?.enabled ?? false,
            syncTime: config.connectors.windsurf?.sync_time ?? '03:00',
            makeConnector: () => new WindsurfSync(config.connectors.windsurf),
        },
        {
            name: 'cursor',
            enabled: config.connectors.cursor?.enabled ?? false,
            syncTime: config.connectors.cursor?.sync_time ?? '03:15',
            makeConnector: () => new CursorSync(config.connectors.cursor),
        },
        {
            name: 'git',
            enabled: config.connectors.git?.enabled ?? false,
            syncTime: config.connectors.git?.sync_time ?? '03:30',
            makeConnector: () => new GitSync(config.connectors.git),
        },
    ];
}

/**
 * The cron callback for one connector, with an IN-FLIGHT GUARD (#283).
 *
 * `node-cron` fires on the wall clock and does not care whether the previous firing has
 * returned, so before this a run that outlasted its period simply overlapped the next one.
 * For git that is not a latency problem but a DATA-INTEGRITY one: two overlapping runs read
 * the same forward cursor, fetch non-disjoint `[since, until]` windows, and
 * `mergeDailyAcrossRuns` ADDS commits/lines/files on the stated premise that the windows are
 * disjoint — `upsertRawAuthorDaily` has no dedup guard, so the overlap is a permanent
 * double-count in `raw_author_daily` and in the `git_snapshots` projection over it (see
 * `sync-log.ts`). A git run can legitimately take hours, so this is not a remote case; it is
 * the shape of a slow first import.
 *
 * SKIP, never queue. The runs are idempotent-by-window, not by count: the skipped tick's work
 * is exactly what the in-flight run is already doing, and the next tick picks up whatever it
 * left. Queueing would preserve the overlap it exists to prevent, one period later.
 *
 * SCOPE — this guards THIS process's cron against itself. It is not a lock: a second `toprope`
 * process, or the admin "Sync now" route, can still start a concurrent git run. The route has
 * its own `activeSyncs` registry against itself, and #283's run deadline bounds how long a run
 * can stay in flight at all; a cross-process lock is neither in scope here nor implied by it.
 *
 * Exported for the test — the guard's whole behaviour is what happens when the callback is
 * re-entered, which cannot be exercised through `cron.schedule`.
 */
export function createConnectorTick(
    entry: ScheduledConnector,
    dbPath: string,
): () => Promise<void> {
    let inFlight = false;
    return async () => {
        if (inFlight) {
            console.warn(
                `[scheduler] ${entry.name} skipped — the previous run is still in flight`,
            );
            return;
        }
        inFlight = true;
        // Opened INSIDE the try, unlike before: a failure here (a bad path, a locked file) used
        // to escape the handler entirely, which was harmless when the tick held no state but
        // would now wedge the connector into "permanently in flight" and silently stop every
        // future tick. Declared outside so `finally` can still close it.
        let db: Database.Database | undefined;
        try {
            db = openDb(dbPath);
            runMigrations(db, MIGRATIONS_DIR);
            await runPipeline(db, [entry.makeConnector()]);
            // New snapshots may push a pending plan upgrade past its settling
            // period; evaluate ROI here so flagged upgrades surface daily. The
            // sync result is already persisted before this runs, so even if ROI
            // throws (caught by the shared catch above) no connector data is lost.
            evaluatePlanRoi(db);
        } catch (err) {
            console.error(`[scheduler] ${entry.name} unhandled error:`, err);
        } finally {
            // Released BEFORE the close, so even a throwing `close()` cannot leave the guard
            // latched. A leaked handle costs one file descriptor; a latched guard costs every
            // subsequent sync, with nothing in the log to say why.
            inFlight = false;
            db?.close();
        }
    };
}

export function startScheduler(
    config: TopropeConfig,
    dbPath: string,
): ReturnType<typeof cron.schedule>[] {
    const schedule = buildConnectorSchedule(config);
    const tasks: ReturnType<typeof cron.schedule>[] = [];

    for (const entry of schedule) {
        if (!entry.enabled) continue;

        const cronExpr = parseSyncTimeToCron(entry.syncTime);

        // One tick closure PER connector, so the guard is per connector: a long git run must
        // not suppress the copilot tick, which touches different tables entirely.
        const task = cron.schedule(cronExpr, createConnectorTick(entry, dbPath), {
            timezone: 'UTC',
        });
        tasks.push(task);
    }

    return tasks;
}
