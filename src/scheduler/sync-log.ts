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

/**
 * Recorded on a `running` row that a later run of the same connector found still open
 * (#272). `status`/`finished_at` alone would say the run ended but not that its outcome
 * was never observed — and an operator reading a terminal row is entitled to know the
 * difference between "this failed" and "nobody ever found out".
 */
export const ABANDONED_RUN_ERROR =
    'Run did not finish: no terminal status was recorded before a later run of this ' +
    'connector started (the process ended mid-run, or two runs overlapped).';

/** Already-recorded errors on a row, tolerating a malformed `errors` blob. */
function decodeErrors(raw: string | null): string[] {
    if (raw === null) return [];
    try {
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? parsed.map((e) => String(e)) : [];
    } catch {
        return [];
    }
}

/**
 * Close out any `running` row this connector left behind.
 *
 * A row is only finalized by the run that opened it, so a run that never returns — the
 * process is restarted, or the machine sleeps, both routine for a git sync that walks a
 * full repository history over hours — leaves its row `running` with `finished_at: null`
 * FOREVER. Four such git rows were the entire record of the 2026-07-28 incident: the only
 * usable error was `git_providers.last_sync_error`, because the sync_logs row that should
 * have carried the collected errors was still open. Nothing but a later run can observe
 * that, so a later run is where it is repaired.
 *
 * Terminal status is `error`, not `success`: an unobserved outcome is not a green run.
 * Already-recorded errors are preserved and the abandonment appended, so a run that
 * recorded errors before dying does not lose them.
 */
function reapAbandonedSyncLogs(db: Database.Database, connector: string, at: string): void {
    const rows = db
        .prepare(`SELECT id, errors FROM sync_logs WHERE connector = ? AND status = 'running'`)
        .all(connector) as {id: string; errors: string | null}[];
    const update = db.prepare(
        `UPDATE sync_logs
         SET finished_at = ?, error_count = ?, errors = ?, status = 'error'
         WHERE id = ?`,
    );
    for (const row of rows) {
        const errors = [...decodeErrors(row.errors), ABANDONED_RUN_ERROR];
        update.run(at, errors.length, JSON.stringify(errors), row.id);
    }
}

export function startSyncLog(db: Database.Database, connector: string): string {
    const id = randomUUID();
    const started_at = new Date().toISOString();
    // Reap-then-insert in ONE transaction: the reap's predicate is "running rows OTHER than
    // mine", which is only true before this row exists. Splitting them would let a partial
    // failure either close nothing or (on a re-entrant call) close the row just opened.
    db.transaction(() => {
        reapAbandonedSyncLogs(db, connector, started_at);
        db.prepare(
            `INSERT INTO sync_logs (id, connector, started_at, records_written, records_skipped, error_count, status)
             VALUES (?, ?, ?, 0, 0, 0, 'running')`,
        ).run(id, connector, started_at);
    })();
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
