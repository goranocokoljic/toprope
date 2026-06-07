import type Database from 'better-sqlite3';
import {CopilotClient} from './client';
import {transformMetrics, detectInactiveSeats} from './transformer';
import type {ToolSnapshot, InactiveSeat} from './transformer';
import type {ConnectorInterface, SyncResult} from '../types';
import type {CopilotConnectorConfig} from '../../config/types';

const CONNECTOR_NAME = 'copilot';
const SYNC_STATE_KEY = 'copilot_last_sync';

interface SyncStateRow {
    value: string;
}

interface DeveloperRow {
    id: string;
    external_ids: string | null;
}

function getLastSyncTime(db: Database.Database): string | null {
    const row = db
        .prepare('SELECT value FROM sync_state WHERE key = ?')
        .get(SYNC_STATE_KEY) as SyncStateRow | undefined;
    return row?.value ?? null;
}

function setLastSyncTime(db: Database.Database, time: string): void {
    db.prepare(
        'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(SYNC_STATE_KEY, time);
}

function upsertSnapshot(db: Database.Database, snap: ToolSnapshot): 'written' | 'skipped' {
    const result = db
        .prepare(
            `INSERT INTO tool_snapshots
             (id, developer_id, date, tool, data_source, data_quality, is_active,
              interaction_count, acceptance_count, acceptance_rate, features_used,
              models_used, estimated_cost, tokens_consumed, raw_data)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(developer_id, date, tool) DO UPDATE SET
               data_source = excluded.data_source,
               data_quality = excluded.data_quality,
               is_active = excluded.is_active,
               interaction_count = excluded.interaction_count,
               acceptance_count = excluded.acceptance_count,
               acceptance_rate = excluded.acceptance_rate,
               features_used = excluded.features_used,
               models_used = excluded.models_used,
               estimated_cost = excluded.estimated_cost,
               tokens_consumed = excluded.tokens_consumed,
               raw_data = excluded.raw_data`,
        )
        .run(
            snap.id,
            snap.developer_id,
            snap.date,
            snap.tool,
            snap.data_source,
            snap.data_quality,
            snap.is_active,
            snap.interaction_count,
            snap.acceptance_count,
            snap.acceptance_rate,
            snap.features_used,
            snap.models_used,
            snap.estimated_cost,
            snap.tokens_consumed,
            snap.raw_data,
        );

    return result.changes > 0 ? 'written' : 'skipped';
}

function buildLoginToDevIdMap(db: Database.Database): Map<string, string> {
    const rows = db.prepare('SELECT id, external_ids FROM developers').all() as DeveloperRow[];
    const map = new Map<string, string>();
    for (const row of rows) {
        if (!row.external_ids) continue;
        try {
            const ext = JSON.parse(row.external_ids) as Record<string, string | undefined>;
            if (ext.copilot) map.set(ext.copilot, row.id);
            // Only add github key if it won't overwrite an explicit copilot mapping
            if (ext.github && !map.has(ext.github)) map.set(ext.github, row.id);
        } catch {
            // malformed external_ids — skip
        }
    }
    return map;
}

export class CopilotSync implements ConnectorInterface {
    private readonly config: CopilotConnectorConfig;

    constructor(config: CopilotConnectorConfig) {
        this.config = config;
    }

    getName(): string {
        return CONNECTOR_NAME;
    }

    getLastSyncTime(db: Database.Database): string | null {
        return getLastSyncTime(db);
    }

    async sync(db: Database.Database): Promise<SyncResult> {
        const errors: string[] = [];
        let snapshotsWritten = 0;
        let snapshotsSkipped = 0;
        const now = new Date().toISOString();

        const token = this.config.api_token ?? process.env.GITHUB_TOKEN ?? '';
        const org = this.config.github_org ?? '';

        if (!token || !org) {
            return {
                connector: CONNECTOR_NAME,
                snapshotsWritten: 0,
                snapshotsSkipped: 0,
                errors: ['Missing required config: github_org and api_token (or GITHUB_TOKEN env)'],
                lastSyncTime: now,
            };
        }

        const client = new CopilotClient({org, token});
        const loginToDevId = buildLoginToDevIdMap(db);
        const storeRawData = true;

        let inactiveSeats: InactiveSeat[] = [];

        try {
            const seats = await client.getSeats();
            inactiveSeats = detectInactiveSeats(seats);
        } catch (err) {
            errors.push(`Failed to fetch seats: ${err instanceof Error ? err.message : String(err)}`);
        }

        const sinceRaw = getLastSyncTime(db);
        // GitHub Copilot Metrics API expects YYYY-MM-DD, not a full ISO timestamp
        const since = sinceRaw ? sinceRaw.slice(0, 10) : undefined;

        let metrics;
        try {
            metrics = await client.getMetrics(since);
        } catch (err) {
            errors.push(
                `Failed to fetch metrics: ${err instanceof Error ? err.message : String(err)}`,
            );
            return {
                connector: CONNECTOR_NAME,
                snapshotsWritten,
                snapshotsSkipped,
                errors,
                lastSyncTime: now,
            };
        }

        const snapshots = transformMetrics(metrics, loginToDevId, storeRawData);

        const insertMany = db.transaction((snaps: ToolSnapshot[]) => {
            for (const snap of snaps) {
                const outcome = upsertSnapshot(db, snap);
                if (outcome === 'written') snapshotsWritten++;
                else snapshotsSkipped++;
            }
        });

        let snapshotWriteFailed = false;
        try {
            insertMany(snapshots);
        } catch (err) {
            snapshotWriteFailed = true;
            errors.push(
                `Failed to write snapshots: ${err instanceof Error ? err.message : String(err)}`,
            );
        }

        if (inactiveSeats.length > 0) {
            console.log(
                `[copilot] ${inactiveSeats.length} inactive seat(s) detected:`,
                inactiveSeats.map((s) => `${s.login} (${s.days_inactive}d inactive)`).join(', '),
            );
        }

        // Only advance the cursor when snapshots were fully written; a failed write
        // would otherwise permanently skip that window on the next sync.
        if (!snapshotWriteFailed) {
            try {
                setLastSyncTime(db, now);
            } catch (err) {
                errors.push(
                    `Failed to update sync state: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }

        return {
            connector: CONNECTOR_NAME,
            snapshotsWritten,
            snapshotsSkipped,
            errors,
            lastSyncTime: now,
        };
    }
}
