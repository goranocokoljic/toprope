import type Database from 'better-sqlite3';
import {ClaudeCodeClient} from './client';
import {transformUsage} from './transformer';
import type {ToolSnapshot} from './transformer';
import type {ConnectorInterface, SyncResult} from '../types';
import type {ClaudeCodeConnectorConfig} from '../../config/types';

const CONNECTOR_NAME = 'claude_code';
const SYNC_STATE_KEY = 'claude_code_last_sync';
const DEFAULT_LOOKBACK_DAYS = 30;

interface SyncStateRow {
    value: string;
}

interface DeveloperRow {
    id: string;
    external_ids: string | null;
}

function toDateStr(d: Date): string {
    return d.toISOString().slice(0, 10);
}

function defaultSinceDate(): string {
    const d = new Date();
    d.setDate(d.getDate() - DEFAULT_LOOKBACK_DAYS);
    return toDateStr(d);
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

function buildEmailToDevIdMap(db: Database.Database): Map<string, string> {
    const rows = db.prepare('SELECT id, external_ids, email FROM developers').all() as (DeveloperRow & {email: string | null})[];
    const map = new Map<string, string>();
    for (const row of rows) {
        // Prefer explicit claude link; fall back to developer email
        if (row.external_ids) {
            try {
                const ext = JSON.parse(row.external_ids) as Record<string, string | undefined>;
                if (ext.claude) {
                    map.set(ext.claude, row.id);
                    continue;
                }
            } catch {
                // malformed external_ids — fall through to email
            }
        }
        if (row.email && !map.has(row.email)) map.set(row.email, row.id);
    }
    return map;
}

export class ClaudeCodeSync implements ConnectorInterface {
    private readonly config: ClaudeCodeConnectorConfig;

    constructor(config: ClaudeCodeConnectorConfig) {
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

        const apiKey = this.config.api_key ?? process.env.ANTHROPIC_ADMIN_API_KEY ?? '';
        const orgId = this.config.org_id ?? '';

        if (!apiKey || !orgId) {
            return {
                connector: CONNECTOR_NAME,
                snapshotsWritten: 0,
                snapshotsSkipped: 0,
                errors: ['Missing required config: org_id and api_key (or ANTHROPIC_ADMIN_API_KEY env)'],
                lastSyncTime: now,
            };
        }

        const client = new ClaudeCodeClient({orgId, apiKey});
        const emailToDevId = buildEmailToDevIdMap(db);
        const storeRawData = true;

        const sinceRaw = getLastSyncTime(db);
        const dateFrom = sinceRaw ? sinceRaw.slice(0, 10) : defaultSinceDate();
        const dateTo = toDateStr(new Date());

        let entries;
        try {
            entries = await client.getUsage(dateFrom, dateTo);
        } catch (err) {
            errors.push(
                `Failed to fetch usage: ${err instanceof Error ? err.message : String(err)}`,
            );
            return {
                connector: CONNECTOR_NAME,
                snapshotsWritten,
                snapshotsSkipped,
                errors,
                lastSyncTime: now,
            };
        }

        const snapshots = transformUsage(entries, emailToDevId, storeRawData);

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
