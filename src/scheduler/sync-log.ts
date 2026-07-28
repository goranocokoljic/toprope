/**
 * `sync_logs` — one row per connector sync ATTEMPT.
 *
 * SCOPE NOTE (#272). Rows are written by `runConnectorWithRetry` only, i.e. by the scheduled
 * pipeline and `toprope sync all`. The two git-specific entry points — `toprope sync git` and
 * the admin per-provider "Sync now" / "Sync older history" — call `GitSync` directly and write
 * NO row here at all; they record their outcome on `git_providers.last_sync_*` instead. So an
 * empty or clean `sync_logs` is not evidence that no manual run died, and the reaping below
 * cannot repair what was never written. Widening the table to those paths would change what
 * `computeConnectors` reports as a connector's last sync, which is a separate decision.
 */
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
 * Recorded on a `running` row old enough that no live run can still own it (#272).
 * `status`/`finished_at` alone would say the run ended but not that its outcome was never
 * observed — and an operator reading a terminal row is entitled to know the difference
 * between "this failed" and "nobody ever found out".
 */
export const ABANDONED_RUN_ERROR =
    'Run did not finish: the process ended before a terminal status was recorded, so this ' +
    "run's outcome was never observed.";

/**
 * How old a `running` row must be before a later run may declare it abandoned.
 *
 * A liveness bound, not hygiene. The reaper cannot see processes, only rows, so without an
 * age gate it would close a row belonging to a run that is genuinely still fetching — and
 * overlap is reachable here, not theoretical: the scheduler's cron fires unconditionally, and
 * `toprope sync all` can run against the same SQLite file while the server's scheduler is
 * mid-sync. That would flip a live run's row to `error` with a message asserting it never
 * finished, so `toprope doctor` and `/api/coverage` report a false red until the run's own
 * `finishSyncLog` overwrites it.
 *
 * 24 h is chosen against what a run can legitimately take: a git sync walking a full
 * repository history is the longest thing in this system, measured in hours. A row older than
 * a day is not a slow run, it is a dead one. The cost is that a run which died an hour ago
 * stays `running` until the bound elapses — the guarantee is "eventually terminal, once no
 * live run can plausibly own it", which is the strongest one available to an observer that
 * cannot check for a pulse.
 */
export const ABANDONED_RUN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Close out any `running` row this connector abandoned.
 *
 * A row is only finalized by the run that opened it, so a run that never returns — the
 * process is restarted, or the machine sleeps, both routine for a git sync that walks a full
 * repository history over hours — leaves its row `running` with `finished_at: null` FOREVER.
 * Four such git rows were the entire record of the 2026-07-28 incident: the only usable error
 * was `git_providers.last_sync_error`, because the sync_logs row that should have carried the
 * collected errors was still open. Nothing but a later run can observe that, so a later run
 * is where it is repaired.
 *
 * Terminal status is `error`, not `success`: an unobserved outcome is not a green run.
 *
 * One `UPDATE`, not a read-merge-write. A `running` row cannot carry errors to preserve —
 * `startSyncLog` inserts with `errors` omitted (the column has no default, so NULL) and the
 * only other writer, `finishSyncLog`, sets a terminal `status` in the same statement. So
 * there is nothing to merge, and decoding the column here would fork the decoder
 * `getRecentSyncLogs` already owns.
 */
function reapAbandonedSyncLogs(db: Database.Database, connector: string, at: string): void {
    const cutoff = new Date(Date.parse(at) - ABANDONED_RUN_MIN_AGE_MS).toISOString();
    db.prepare(
        `UPDATE sync_logs
         SET finished_at = ?, error_count = 1, errors = ?, status = 'error'
         WHERE connector = ? AND status = 'running' AND started_at < ?`,
    ).run(at, JSON.stringify([ABANDONED_RUN_ERROR]), connector, cutoff);
}

export function startSyncLog(db: Database.Database, connector: string): string {
    const id = randomUUID();
    const started_at = new Date().toISOString();
    // Reap-then-insert in ONE transaction so a partial failure cannot leave the reap applied
    // without the row that triggered it, or vice versa. The age bound already excludes the row
    // being inserted (it is zero seconds old), so ordering is not what makes this correct —
    // atomicity is.
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

/**
 * The `errors` column as an array, or `null`.
 *
 * Tolerant on purpose: `errors` is plain TEXT with no CHECK constraint, and this is the only
 * decoder, so a single hand-edited or legacy row must not make the whole log unreadable.
 */
function decodeErrors(raw: string | null): string[] | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) return parsed.map((e) => String(e));
    } catch {
        // fall through — an unparseable blob is surfaced as-is below rather than thrown away
    }
    return [raw];
}

export function getRecentSyncLogs(db: Database.Database, limit = 50): SyncLog[] {
    const rows = db
        .prepare('SELECT * FROM sync_logs ORDER BY started_at DESC, rowid DESC LIMIT ?')
        .all(limit) as SyncLogRow[];
    return rows.map((r) => ({
        ...r,
        errors: decodeErrors(r.errors),
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
