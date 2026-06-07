import type Database from 'better-sqlite3';
import {CursorClient} from './client';
import {transformMetrics} from './transformer';
import type {ToolSnapshot} from './transformer';
import type {ConnectorInterface, SyncResult} from '../types';
import type {CursorConnectorConfig} from '../../config/types';

const CONNECTOR_NAME = 'cursor';
const SYNC_STATE_KEY = 'cursor_last_sync';
const DEFAULT_LOOKBACK_DAYS = 30;

interface SyncStateRow {
    value: string;
}

interface DeveloperRow {
    id: string;
    email: string | null;
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
             ON CONFLICT(developer_id, date, tool) DO NOTHING`,
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
    const rows = db
        .prepare('SELECT id, email, external_ids FROM developers')
        .all() as DeveloperRow[];
    const map = new Map<string, string>();
    for (const row of rows) {
        if (row.external_ids) {
            try {
                const ext = JSON.parse(row.external_ids) as Record<string, string | undefined>;
                if (ext.cursor) {
                    if (!map.has(ext.cursor)) {
                        map.set(ext.cursor, row.id);
                    }
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

export class CursorSync implements ConnectorInterface {
    private readonly config: CursorConnectorConfig;

    constructor(config: CursorConnectorConfig) {
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

        const serviceKey = this.config.service_key ?? process.env.CURSOR_SERVICE_KEY ?? '';

        if (!serviceKey) {
            return {
                connector: CONNECTOR_NAME,
                snapshotsWritten: 0,
                snapshotsSkipped: 0,
                errors: ['Missing required config: service_key (or CURSOR_SERVICE_KEY env)'],
                lastSyncTime: now,
            };
        }

        const client = new CursorClient({serviceKey});
        const emailToDevId = buildEmailToDevIdMap(db);
        const storeRawData = true;

        // Re-fetch from the last sync DAY so an in-progress day gets picked up
        // again. Note: because upsertSnapshot uses ON CONFLICT DO NOTHING, the
        // first snapshot written for a given day wins permanently — a mid-day
        // manual `sync cursor` freezes that day's partial counts until the date
        // rolls over. The 03:15 scheduled run sits before meaningful daily
        // activity, so this is benign for the normal path.
        const sinceRaw = getLastSyncTime(db);
        const startDate = sinceRaw ? sinceRaw.slice(0, 10) : defaultSinceDate();
        const endDate = toDateStr(new Date());

        let metrics;
        try {
            metrics = await client.getUserMetrics(startDate, endDate);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Include the date window so a mid-pagination failure (which discards
            // all pages and writes nothing) is diagnosable from the log alone.
            if (message.includes('permission denied')) {
                errors.push(
                    `[cursor] Permission error: ${message}. Check that your service key has analytics access.`,
                );
            } else {
                errors.push(`Failed to fetch metrics for ${startDate}..${endDate}: ${message}`);
            }
            return {
                connector: CONNECTOR_NAME,
                snapshotsWritten,
                snapshotsSkipped,
                errors,
                lastSyncTime: now,
            };
        }

        const snapshots = transformMetrics(metrics, emailToDevId, storeRawData);

        const insertMany = db.transaction((snaps: ToolSnapshot[]): {written: number; skipped: number} => {
            let written = 0;
            let skipped = 0;
            for (const snap of snaps) {
                const outcome = upsertSnapshot(db, snap);
                if (outcome === 'written') written++;
                else skipped++;
            }
            return {written, skipped};
        });

        let snapshotWriteFailed = false;
        try {
            const counts = insertMany(snapshots);
            snapshotsWritten = counts.written;
            snapshotsSkipped = counts.skipped;
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
