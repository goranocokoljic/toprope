import type Database from 'better-sqlite3';
import type {ConnectorInterface, SyncResult} from '../connectors/types';
import {startSyncLog, finishSyncLog} from './sync-log';

export interface PipelineResult {
    connector: string;
    result: SyncResult;
    retried: boolean;
}

export const DEFAULT_RETRY_DELAY_MS = 5 * 60 * 1000;

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runConnectorWithRetry(
    db: Database.Database,
    connector: ConnectorInterface,
    retryDelayMs: number,
): Promise<{result: SyncResult; retried: boolean}> {
    const logId = startSyncLog(db, connector.getName());

    let result: SyncResult;
    let retried = false;

    try {
        result = await connector.sync(db);
    } catch (err) {
        result = {
            connector: connector.getName(),
            snapshotsWritten: 0,
            snapshotsSkipped: 0,
            errors: [err instanceof Error ? err.message : String(err)],
            lastSyncTime: new Date().toISOString(),
        };
    }

    if (result.errors.length > 0) {
        await sleep(retryDelayMs);
        retried = true;
        try {
            result = await connector.sync(db);
        } catch (err) {
            result = {
                connector: connector.getName(),
                snapshotsWritten: 0,
                snapshotsSkipped: 0,
                errors: [err instanceof Error ? err.message : String(err)],
                lastSyncTime: new Date().toISOString(),
            };
        }
    }

    finishSyncLog(db, logId, {
        records_written: result.snapshotsWritten,
        records_skipped: result.snapshotsSkipped,
        errors: result.errors,
    });

    return {result, retried};
}

export async function runPipeline(
    db: Database.Database,
    connectors: ConnectorInterface[],
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
): Promise<PipelineResult[]> {
    const results: PipelineResult[] = [];

    for (const connector of connectors) {
        const name = connector.getName();
        try {
            const {result, retried} = await runConnectorWithRetry(db, connector, retryDelayMs);
            results.push({connector: name, result, retried});
        } catch (err) {
            // Unexpected throw (e.g. startSyncLog or finishSyncLog DB error) — continue pipeline
            const errorResult: SyncResult = {
                connector: name,
                snapshotsWritten: 0,
                snapshotsSkipped: 0,
                errors: [err instanceof Error ? err.message : String(err)],
                lastSyncTime: new Date().toISOString(),
            };
            results.push({connector: name, result: errorResult, retried: false});
        }
    }

    return results;
}
