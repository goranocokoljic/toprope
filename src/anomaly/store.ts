/**
 * Persistence for detected anomalies (Task 4.7 / #102).
 *
 * Owns the `anomalies` table: the idempotent upsert the scan layer uses, the
 * "no longer anomalous → clear the open row" path, and the read/status helpers
 * the surfacing work (Task 4.8) and CLI build on.
 *
 * Idempotency. A (scope, scope_id, metric, period) coordinate maps to at most
 * one row (UNIQUE index from migration 023). Re-running a period UPSERTs that one
 * row instead of inserting a duplicate, so a scheduled retry or a manual re-scan
 * is safe. Crucially, `status` AND `detected_at` are preserved across
 * re-detection: an acknowledged anomaly that re-fires with identical data stays
 * acknowledged, and detected_at keeps its FIRST-detection time (a retry/re-scan
 * never bumps it) so "how long has this been open" stays answerable. Only the
 * recomputed measurement fields (method/observed/expected/deviation/severity/
 * basis) refresh on conflict.
 */

import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import type {
    AnomalyBasis,
    AnomalyMethod,
    AnomalyMetric,
    AnomalyRecord,
    AnomalyScope,
    AnomalySeverity,
    AnomalyStatus,
} from './types';

/** The fields a detection produces for one anomalous (scope, metric, period). */
export interface UpsertAnomalyInput {
    scope: AnomalyScope;
    scopeId: string;
    metric: AnomalyMetric;
    period: string;
    method: AnomalyMethod;
    observedValue: number;
    expectedValue: number;
    deviation: number;
    severity: AnomalySeverity;
    basis: AnomalyBasis;
}

function nowIso(): string {
    return new Date().toISOString();
}

// Severity tiebreak ranking used by every "newest first" read below. severity is
// a text enum, so a lexical `severity DESC` would order it high < info < notable
// and sink the most severe band; this CASE ranks it high > notable > info so a
// same-timestamp tie surfaces the worst first.
const SEVERITY_RANK_SQL = `CASE severity WHEN 'high' THEN 3 WHEN 'notable' THEN 2 ELSE 1 END`;

/**
 * Insert or refresh the single anomaly row for its coordinate. On conflict the
 * measurement fields (method/observed/expected/deviation/severity/basis) are
 * updated, but `status` and `detected_at` are left untouched so prior human
 * triage and the original first-detection time survive re-detection. The row id
 * is a fresh UUID only on first insert; a re-detection keeps the original id.
 */
export function upsertAnomaly(db: Database.Database, input: UpsertAnomalyInput): void {
    db.prepare(
        `INSERT INTO anomalies
           (id, scope, scope_id, metric, period, method, observed_value, expected_value,
            deviation, severity, basis, status, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
         ON CONFLICT(scope, scope_id, metric, period) DO UPDATE SET
            method = excluded.method,
            observed_value = excluded.observed_value,
            expected_value = excluded.expected_value,
            deviation = excluded.deviation,
            severity = excluded.severity,
            basis = excluded.basis`,
    ).run(
        randomUUID(),
        input.scope,
        input.scopeId,
        input.metric,
        input.period,
        input.method,
        input.observedValue,
        input.expectedValue,
        input.deviation,
        input.severity,
        input.basis,
        nowIso(),
    );
}

/**
 * Remove the OPEN anomaly for a coordinate, if one exists — used when a re-scan
 * finds the metric is no longer anomalous (e.g. late data corrected it), so the
 * open set stays accurate. Acknowledged/resolved rows are human-owned and left
 * in place. Returns whether a row was deleted.
 */
export function clearOpenAnomaly(
    db: Database.Database,
    scope: AnomalyScope,
    scopeId: string,
    metric: AnomalyMetric,
    period: string,
): boolean {
    const result = db
        .prepare(
            `DELETE FROM anomalies
             WHERE scope = ? AND scope_id = ? AND metric = ? AND period = ? AND status = 'open'`,
        )
        .run(scope, scopeId, metric, period);
    return result.changes > 0;
}

export interface AnomalyListFilter {
    scope?: AnomalyScope;
    scopeId?: string;
    status?: AnomalyStatus;
    period?: string;
    limit?: number;
}

/**
 * List anomalies, most recent first, filtered by the given coordinates.
 *
 * PRIVACY CONTRACT: a developer-scope anomaly is individual data, visible only
 * to that developer (managers see team aggregates only). This function does NOT
 * enforce that on its own — `{scope: 'developer'}` with no `scopeId` returns
 * every developer's anomalies, which is correct for the admin/operator CLI but a
 * cross-developer leak if exposed over HTTP. Any request-facing caller (Task 4.8
 * surfacing) MUST pin `scopeId` to the authenticated developer for developer-scope
 * reads, or restrict the route to admins.
 */
export function listAnomalies(db: Database.Database, filter: AnomalyListFilter = {}): AnomalyRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.scope) {
        clauses.push('scope = ?');
        params.push(filter.scope);
    }
    if (filter.scopeId) {
        clauses.push('scope_id = ?');
        params.push(filter.scopeId);
    }
    if (filter.status) {
        clauses.push('status = ?');
        params.push(filter.status);
    }
    if (filter.period) {
        clauses.push('period = ?');
        params.push(filter.period);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    // Newest first, with the shared severity rank as the same-timestamp tiebreak.
    let sql = `SELECT * FROM anomalies ${where}
               ORDER BY detected_at DESC, ${SEVERITY_RANK_SQL} DESC`;
    if (filter.limit !== undefined && Number.isInteger(filter.limit) && filter.limit > 0) {
        sql += ' LIMIT ?';
        params.push(filter.limit);
    }
    return db.prepare(sql).all(...params) as AnomalyRecord[];
}

/**
 * Transition an anomaly's status (open → acknowledged → resolved, or back).
 * Returns false if no such anomaly exists. The id is the row's primary key.
 */
export function setAnomalyStatus(db: Database.Database, id: string, status: AnomalyStatus): boolean {
    const result = db.prepare('UPDATE anomalies SET status = ? WHERE id = ?').run(status, id);
    return result.changes > 0;
}

/** Fetch one anomaly by its primary key, or undefined if it doesn't exist. */
export function getAnomalyById(db: Database.Database, id: string): AnomalyRecord | undefined {
    return db.prepare('SELECT * FROM anomalies WHERE id = ?').get(id) as AnomalyRecord | undefined;
}

/**
 * Open, surfaceable (notable/high), not-yet-announced TEAM anomalies — the work
 * list for the Slack notifier (Task 4.8). Scoped to team anomalies only: a
 * developer-scope anomaly is individual data (privacy model), so it is never
 * pushed to a manager alert channel. Most severe / most recent first.
 */
export function listUnnotifiedTeamAnomalies(db: Database.Database): AnomalyRecord[] {
    return db
        .prepare(
            `SELECT * FROM anomalies
             WHERE scope = 'team' AND status = 'open'
               AND severity IN ('notable', 'high') AND notified_at IS NULL
             ORDER BY ${SEVERITY_RANK_SQL} DESC, detected_at DESC`,
        )
        .all() as AnomalyRecord[];
}

/** Stamp an anomaly as announced to Slack at `at` (ISO). Idempotent on the id. */
export function markAnomalyNotified(db: Database.Database, id: string, at: string): void {
    db.prepare('UPDATE anomalies SET notified_at = ? WHERE id = ?').run(at, id);
}

/**
 * Surfaceable (notable/high) TEAM anomalies whose week falls in an inclusive
 * period range — the source the summary input builder folds in (Task 4.8). Team
 * scope only, for the same privacy reason as the notifier: a summary is a
 * manager-facing team/org narrative. `team` pins one team; null spans every team
 * (the org summary). Resolved anomalies are excluded — a summary narrates what
 * was anomalous in the period, not what a manager has already closed out.
 */
export function listSurfaceableTeamAnomalies(
    db: Database.Database,
    team: string | null,
    startPeriod: string,
    endPeriod: string,
): AnomalyRecord[] {
    const params: unknown[] = [startPeriod, endPeriod];
    let teamClause = '';
    if (team !== null) {
        teamClause = ' AND scope_id = ?';
        params.push(team);
    }
    return db
        .prepare(
            `SELECT * FROM anomalies
             WHERE scope = 'team' AND severity IN ('notable', 'high') AND status != 'resolved'
               AND period >= ? AND period <= ?${teamClause}
             ORDER BY ${SEVERITY_RANK_SQL} DESC, detected_at DESC`,
        )
        .all(...params) as AnomalyRecord[];
}
