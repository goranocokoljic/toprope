import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import {isAdvisoryError} from '../connectors/git/sync';

export interface SyncLog {
    id: string;
    connector: string;
    started_at: string;
    finished_at: string | null;
    records_written: number;
    records_skipped: number;
    error_count: number;
    errors: string[] | null;
    status: 'running' | 'success' | 'error';
}

interface SyncLogRow {
    id: string;
    connector: string;
    started_at: string;
    finished_at: string | null;
    records_written: number;
    records_skipped: number;
    error_count: number;
    errors: string | null;
    status: string;
}

export function startSyncLog(db: Database.Database, connector: string): string {
    const id = randomUUID();
    const started_at = new Date().toISOString();
    db.prepare(
        `INSERT INTO sync_logs (id, connector, started_at, records_written, records_skipped, error_count, status)
         VALUES (?, ?, ?, 0, 0, 0, 'running')`,
    ).run(id, connector, started_at);
    return id;
}

export function finishSyncLog(
    db: Database.Database,
    id: string,
    opts: {records_written: number; records_skipped: number; errors: string[]},
): void {
    const finished_at = new Date().toISOString();
    // Advisories are recorded but do NOT make the run red. `errors` carries both advisories
    // and failures; unmatched CI bots and external contributors are the steady state of a
    // healthy repo, so keying status off the raw length reported every scheduled sync of
    // essentially every real deployment as an error, forever. Same classifier the retry
    // gate and the provider red/green surface use, so the three cannot disagree.
    const status = opts.errors.some((e) => !isAdvisoryError(e)) ? 'error' : 'success';
    db.prepare(
        `UPDATE sync_logs
         SET finished_at = ?, records_written = ?, records_skipped = ?, error_count = ?, errors = ?, status = ?
         WHERE id = ?`,
    ).run(
        finished_at,
        opts.records_written,
        opts.records_skipped,
        opts.errors.length,
        opts.errors.length > 0 ? JSON.stringify(opts.errors) : null,
        status,
        id,
    );
}

export function getRecentSyncLogs(db: Database.Database, limit = 50): SyncLog[] {
    const rows = db
        .prepare('SELECT * FROM sync_logs ORDER BY started_at DESC, rowid DESC LIMIT ?')
        .all(limit) as SyncLogRow[];
    return rows.map((r) => ({
        ...r,
        errors: r.errors ? (JSON.parse(r.errors) as string[]) : null,
        status: r.status as SyncLog['status'],
    }));
}

export function getLastSuccessfulSync(db: Database.Database, connector: string): SyncLog | null {
    const row = db
        .prepare(
            `SELECT * FROM sync_logs WHERE connector = ? AND status = 'success'
             ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
        )
        .get(connector) as SyncLogRow | undefined;
    if (!row) return null;
    return {
        ...row,
        errors: null,
        status: 'success',
    };
}
