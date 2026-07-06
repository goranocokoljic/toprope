import cron from 'node-cron';
import path from 'path';
import type {TopropeConfig} from '../config/types';
import {openDb} from '../storage/db';
import {runMigrations} from '../storage/migrator';
import {CopilotSync} from '../connectors/copilot/sync';
import {ClaudeCodeSync} from '../connectors/claude-code/sync';
import {WindsurfSync} from '../connectors/windsurf/sync';
import {CursorSync} from '../connectors/cursor/sync';
import {GitSync} from '../connectors/git/sync';
import {runPipeline} from './sync-pipeline';
import {evaluatePlanRoi} from '../expenses/plan-roi';

const MIGRATIONS_DIR = path.resolve(__dirname, '../storage/migrations');

export function parseSyncTimeToCron(syncTime: string): string {
    const [hour, minute] = syncTime.split(':');
    return `${minute ?? '0'} ${hour ?? '0'} * * *`;
}

interface ScheduledConnector {
    name: string;
    enabled: boolean;
    syncTime: string;
    makeConnector: () => ReturnType<typeof makeCopilotSync>;
}

type AnySync = CopilotSync | ClaudeCodeSync | WindsurfSync | CursorSync | GitSync;
function makeCopilotSync(config: TopropeConfig): AnySync {
    return new CopilotSync(config.connectors.copilot);
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

export function startScheduler(
    config: TopropeConfig,
    dbPath: string,
): ReturnType<typeof cron.schedule>[] {
    const schedule = buildConnectorSchedule(config);
    const tasks: ReturnType<typeof cron.schedule>[] = [];

    for (const entry of schedule) {
        if (!entry.enabled) continue;

        const cronExpr = parseSyncTimeToCron(entry.syncTime);

        const task = cron.schedule(
            cronExpr,
            async () => {
                const db = openDb(dbPath);
                try {
                    runMigrations(db, MIGRATIONS_DIR);
                    await runPipeline(db, [entry.makeConnector()]);
                    // New snapshots may push a pending plan upgrade past its settling
                    // period; evaluate ROI here so flagged upgrades surface daily. The
                    // sync result is already persisted before this runs, so even if ROI
                    // throws (caught by the shared catch below) no connector data is lost.
                    evaluatePlanRoi(db);
                } catch (err) {
                    console.error(`[scheduler] ${entry.name} unhandled error:`, err);
                } finally {
                    db.close();
                }
            },
            {timezone: 'UTC'},
        );
        tasks.push(task);
    }

    return tasks;
}
