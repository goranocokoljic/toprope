/**
 * Anomaly surfacing endpoints — the manager dashboard panel (Task 4.8 / #103).
 *
 *   GET  /api/anomalies?status=open       — list anomalies (default: open)
 *   POST /api/anomalies/:id/acknowledge   — mark acknowledged (drops from open)
 *   POST /api/anomalies/:id/resolve       — mark resolved (drops from open)
 *
 * TEAM SCOPE ONLY. A developer-scope anomaly is individual data (privacy model:
 * individual data is visible only to the developer; managers see team
 * aggregates), so this manager-facing API never lists or mutates one — the list
 * is pinned to `scope = 'team'` and the mutation routes 404 a non-team id. Every
 * row is enriched with the honest basis label ("git-based estimate" at launch)
 * and a plain-language description so the panel and its inline metric flags label
 * the anomaly consistently with the Slack alert and the AI summary.
 *
 * Admin-gated like the rest of the manager API.
 */

import type {FastifyInstance, FastifyReply} from 'fastify';
import type Database from 'better-sqlite3';
import {isAdmin, forbidden} from './guards';
import {getAnomalyById, listAnomalies, setAnomalyStatus} from '../../anomaly/store';
import type {AnomalyRecord, AnomalyStatus} from '../../anomaly/types';
import {anomalyDirection, basisLabel, changePercent, describeAnomaly, metricLabel} from '../../anomaly/surface';

const STATUSES: ReadonlySet<string> = new Set(['open', 'acknowledged', 'resolved']);

/** Shape one team anomaly into the panel response: row + honest labels + phrasing. */
function toItem(record: AnomalyRecord): Record<string, unknown> {
    return {
        id: record.id,
        scope: record.scope,
        scope_id: record.scope_id,
        // `team` is an alias for scope_id, kept explicit so the panel/inline flags
        // can match by team without knowing the scope encoding.
        team: record.scope_id,
        metric: record.metric,
        metric_label: metricLabel(record.metric),
        period: record.period,
        method: record.method,
        observed_value: record.observed_value,
        expected_value: record.expected_value,
        deviation: record.deviation,
        change_pct: changePercent(record.observed_value, record.expected_value),
        direction: anomalyDirection(record.observed_value, record.expected_value),
        severity: record.severity,
        basis: record.basis,
        basis_label: basisLabel(record.basis),
        status: record.status,
        detected_at: record.detected_at,
        description: describeAnomaly(record),
    };
}

/**
 * Apply a status transition to a team anomaly, returning the HTTP response. 404s
 * a missing id OR a developer-scope id (not visible on this manager surface).
 */
function transition(
    db: Database.Database,
    id: string,
    status: AnomalyStatus,
    reply: FastifyReply,
): unknown {
    const record = getAnomalyById(db, id);
    if (!record || record.scope !== 'team') {
        return reply.status(404).send({error: 'Not Found', message: `Anomaly '${id}' not found`});
    }
    setAnomalyStatus(db, id, status);
    const updated = getAnomalyById(db, id);
    return {data: updated ? toItem(updated) : null};
}

export function registerAnomalyRoutes(app: FastifyInstance, db: Database.Database): void {
    // ── list ──────────────────────────────────────────────────────────────────
    app.get<{Querystring: {status?: string}}>('/api/anomalies', async (request, reply) => {
        if (!isAdmin(request)) {
            return forbidden(reply);
        }
        const {status} = request.query;
        if (status !== undefined && !STATUSES.has(status)) {
            return reply.status(400).send({
                error: 'Bad Request',
                message: `Unknown status '${status}' (expected open|acknowledged|resolved)`,
            });
        }
        // Default to the open set — the manager's actionable list. An explicit
        // status surfaces the acknowledged/resolved audit views.
        const effective = (status ?? 'open') as AnomalyStatus;
        const items = listAnomalies(db, {scope: 'team', status: effective}).map(toItem);
        return {data: items};
    });

    // ── acknowledge ─────────────────────────────────────────────────────────────
    app.post<{Params: {id: string}}>('/api/anomalies/:id/acknowledge', async (request, reply) => {
        if (!isAdmin(request)) {
            return forbidden(reply);
        }
        return transition(db, request.params.id, 'acknowledged', reply);
    });

    // ── resolve ───────────────────────────────────────────────────────────────
    app.post<{Params: {id: string}}>('/api/anomalies/:id/resolve', async (request, reply) => {
        if (!isAdmin(request)) {
            return forbidden(reply);
        }
        return transition(db, request.params.id, 'resolved', reply);
    });
}
