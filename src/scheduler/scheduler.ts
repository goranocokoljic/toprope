import cron from 'node-cron';
import path from 'path';
import type {GovProxyConfig} from '../config/types';
import {openDb} from '../storage/db';
import {runMigrations} from '../storage/migrator';
import {CopilotSync} from '../connectors/copilot/sync';
import {ClaudeCodeSync} from '../connectors/claude-code/sync';
import {WindsurfSync} from '../connectors/windsurf/sync';
import {GitSync} from '../connectors/git/sync';
import {runPipeline} from './sync-pipeline';

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

type AnySync = CopilotSync | ClaudeCodeSync | WindsurfSync | GitSync;
function makeCopilotSync(config: GovProxyConfig): AnySync {
    return new CopilotSync(config.connectors.copilot);
}

export function buildConnectorSchedule(config: GovProxyConfig): ScheduledConnector[] {
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
            name: 'git',
            enabled: config.connectors.git?.enabled ?? false,
            syncTime: config.connectors.git?.sync_time ?? '03:30',
            makeConnector: () => new GitSync(config.connectors.git),
        },
    ];
}

export function startScheduler(
    config: GovProxyConfig,
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
