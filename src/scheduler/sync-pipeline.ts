import type Database from 'better-sqlite3';
import type {ConnectorInterface, SyncResult} from '../connectors/types';
import {startSyncLog, finishSyncLog} from './sync-log';
import {isAdvisoryError} from '../connectors/git/sync';

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
    // A throw is an outcome, not an escape: it becomes an error-carrying SyncResult so the
    // caller below can always finalize the log row.
    const attempt = async (): Promise<SyncResult> => {
        try {
            return await connector.sync(db);
        } catch (err) {
            return {
                connector: connector.getName(),
                snapshotsWritten: 0,
                snapshotsSkipped: 0,
                errors: [err instanceof Error ? err.message : String(err)],
                lastSyncTime: new Date().toISOString(),
            };
        }
    };

    /**
     * One attempt, wrapped in its OWN sync_logs row (#272).
     *
     * The row used to span both attempts, so it stayed `running` across the first fetch, the
     * retry pause and the second fetch — for a git sync that walks a full history, hours. If
     * the process ended anywhere in there the first attempt's collected errors were lost even
     * though the attempt had finished and reported them. One row per attempt makes each
     * attempt's outcome durable the moment it is known, and makes `retried` visible in the
     * log as two rows rather than being inferable only from the pipeline's return value.
     */
    const runLogged = async (): Promise<SyncResult> => {
        const logId = startSyncLog(db, connector.getName());
        const result = await attempt();
        finishSyncLog(db, logId, {
            records_written: result.snapshotsWritten,
            records_skipped: result.snapshotsSkipped,
            errors: result.errors,
        });
        return result;
    };

    let result = await runLogged();
    let retried = false;

    // Retry on genuine FAILURES only. `errors` also carries advisories — unmatched CI bots
    // and external contributors are the steady state of a healthy repo, so a run reporting
    // them synced fine. Retrying on those meant every scheduled sync of a repo with one bot
    // author did a second complete network fetch and was logged as an error, forever.
    if (result.errors.some((e) => !isAdvisoryError(e))) {
        await sleep(retryDelayMs);
        retried = true;
        result = await runLogged();
    }

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
