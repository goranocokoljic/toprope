/**
 * Data-access layer for the Best-Practice companion tables (Task 6.2.1 / #156).
 *
 * CRUD over the four tables that hang off the contribution spine —
 * practice_details, practice_metric_pins, practice_feedback,
 * practice_usage_events. Each row references a `contributions` row by id; this
 * layer never touches the spine itself (creating the practice, its title, body,
 * and lifecycle is the spine store's job — 6.1.1). It only persists and reads the
 * best-practice-specific state the spine cannot carry.
 *
 * Two contracts callers rely on:
 *   1. Feedback is one-CURRENT-signal-per-developer — `recordFeedback` UPSERTs on
 *      (contribution_id, developer_id), so flipping a vote updates the row rather
 *      than accumulating duplicates.
 *   2. `setPracticeDetails` is an UPSERT on the 1:1 details row — calling it twice
 *      updates in place rather than failing on the PRIMARY KEY.
 */

import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import {
    isFeedbackSignal,
    isMetricPinAction,
    type FeedbackCounts,
    type MetricPin,
    type MetricPinFilters,
    type NewFeedback,
    type NewMetricPin,
    type NewUsageEvent,
    type PracticeDetails,
    type PracticeDetailsInput,
    type PracticeFeedback,
    type UsageEvent,
} from './types';

function nowIso(): string {
    return new Date().toISOString();
}

interface PracticeDetailsRow {
    contribution_id: string;
    model_used: string | null;
    endorsed: number;
}

interface MetricPinRow {
    id: string;
    contribution_id: string;
    metric: string;
    action: string;
    actor_id: string;
    created_at: string;
}

interface FeedbackRow {
    id: string;
    contribution_id: string;
    developer_id: string;
    signal: string;
    created_at: string;
}

interface UsageEventRow {
    id: string;
    contribution_id: string;
    developer_id: string;
    event: string;
    metric_context: string | null;
    occurred_at: string;
}

/**
 * Decode the pin action. The write path only stores a validated value and the DB
 * CHECK enforces it, so an unrecognized value means corruption; warn and fall back
 * to the fail-safe 'suppress' (hide rather than wrongly surface a practice).
 */
function decodeAction(raw: string): MetricPin['action'] {
    if (isMetricPinAction(raw)) {
        return raw;
    }
    console.warn(`[practices] unrecognized metric-pin action '${raw}'; defaulting to suppress`);
    return 'suppress';
}

/**
 * Decode the feedback signal with the same defensive posture; default to the
 * conservative 'not_helpful' so a corrupt row never inflates helpful counts.
 */
function decodeSignal(raw: string): PracticeFeedback['signal'] {
    if (isFeedbackSignal(raw)) {
        return raw;
    }
    console.warn(`[practices] unrecognized feedback signal '${raw}'; defaulting to not_helpful`);
    return 'not_helpful';
}

function rowToDetails(row: PracticeDetailsRow): PracticeDetails {
    return {
        contributionId: row.contribution_id,
        modelUsed: row.model_used,
        endorsed: row.endorsed !== 0,
    };
}

function rowToPin(row: MetricPinRow): MetricPin {
    return {
        id: row.id,
        contributionId: row.contribution_id,
        metric: row.metric,
        action: decodeAction(row.action),
        actorId: row.actor_id,
        createdAt: row.created_at,
    };
}

function rowToFeedback(row: FeedbackRow): PracticeFeedback {
    return {
        id: row.id,
        contributionId: row.contribution_id,
        developerId: row.developer_id,
        signal: decodeSignal(row.signal),
        createdAt: row.created_at,
    };
}

function rowToUsageEvent(row: UsageEventRow): UsageEvent {
    return {
        id: row.id,
        contributionId: row.contribution_id,
        developerId: row.developer_id,
        event: row.event,
        metricContext: row.metric_context,
        occurredAt: row.occurred_at,
    };
}

// --- Practice details -------------------------------------------------------

/**
 * Set the practice-specific fields for a contribution, UPSERTing the 1:1 details
 * row. On first call it inserts; on later calls it updates in place. Only the
 * fields present in `input` are written — an omitted field keeps its existing
 * value on update, or takes the column default (model_used NULL, endorsed false)
 * on insert. Returns the resulting details row.
 *
 * The read-of-existing and the write run in one transaction so the "omitted field
 * is preserved" merge can't lose an update to a writer that lands between the read
 * and the UPSERT — matching the spine store's transaction posture for its
 * multi-statement writes (createContribution / addContributionVersion).
 */
export function setPracticeDetails(
    db: Database.Database,
    contributionId: string,
    input: PracticeDetailsInput = {},
): PracticeDetails {
    return db.transaction((): PracticeDetails => {
        const existing = getPracticeDetails(db, contributionId);
        const modelUsed = input.modelUsed !== undefined ? input.modelUsed : (existing?.modelUsed ?? null);
        const endorsed = input.endorsed !== undefined ? input.endorsed : (existing?.endorsed ?? false);

        db.prepare(
            `INSERT INTO practice_details (contribution_id, model_used, endorsed)
             VALUES (?, ?, ?)
             ON CONFLICT(contribution_id) DO UPDATE SET
                model_used = excluded.model_used,
                endorsed = excluded.endorsed`,
        ).run(contributionId, modelUsed, endorsed ? 1 : 0);

        return {contributionId, modelUsed, endorsed};
    })();
}

/** The practice details for a contribution, or undefined when none has been set. */
export function getPracticeDetails(db: Database.Database, contributionId: string): PracticeDetails | undefined {
    const row = db.prepare('SELECT * FROM practice_details WHERE contribution_id = ?').get(contributionId) as
        | PracticeDetailsRow
        | undefined;
    return row ? rowToDetails(row) : undefined;
}

/**
 * Convenience for the hybrid contribution model (6.2.2): set just the
 * lead-endorsement flag, leaving model_used untouched (UPSERT-creates the details
 * row if absent). Returns the resulting details row.
 */
export function setPracticeEndorsed(
    db: Database.Database,
    contributionId: string,
    endorsed: boolean,
): PracticeDetails {
    return setPracticeDetails(db, contributionId, {endorsed});
}

// --- Metric pins (manual surfacing overrides) -------------------------------

/**
 * Record a manual pin/suppress override and return the stored row. Each call
 * appends its own row (keyed by a fresh id); the surfacing query (6.2.7) reduces
 * the rows per (contribution, metric) to a current decision.
 */
export function addMetricPin(db: Database.Database, input: NewMetricPin): MetricPin {
    const id = randomUUID();
    const createdAt = input.createdAt ?? nowIso();
    db.prepare(
        `INSERT INTO practice_metric_pins (id, contribution_id, metric, action, actor_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, input.contributionId, input.metric, input.action, input.actorId, createdAt);
    return {
        id,
        contributionId: input.contributionId,
        metric: input.metric,
        action: input.action,
        actorId: input.actorId,
        createdAt,
    };
}

/**
 * List metric pins, newest first, narrowed by any combination of the optional
 * filters. Every filter binds via `?` (values only), and an omitted filter isn't
 * applied — passing `{}` lists everything.
 */
export function listMetricPins(db: Database.Database, filters: MetricPinFilters = {}): MetricPin[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters.contributionId !== undefined) {
        clauses.push('contribution_id = ?');
        params.push(filters.contributionId);
    }
    if (filters.metric !== undefined) {
        clauses.push('metric = ?');
        params.push(filters.metric);
    }
    if (filters.action !== undefined) {
        clauses.push('action = ?');
        params.push(filters.action);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db
        .prepare(`SELECT * FROM practice_metric_pins ${where} ORDER BY created_at DESC, id DESC`)
        .all(...params) as MetricPinRow[];
    return rows.map(rowToPin);
}

/** Remove a metric pin by id. Returns true when a row was actually removed. */
export function removeMetricPin(db: Database.Database, id: string): boolean {
    const res = db.prepare('DELETE FROM practice_metric_pins WHERE id = ?').run(id);
    return res.changes > 0;
}

// --- Feedback (helpful / not-helpful) ---------------------------------------

/**
 * Record a developer's feedback on a practice, UPSERTing on
 * (contribution_id, developer_id). A developer has at most one CURRENT signal per
 * practice: the first call inserts, a later call flips the signal in place and
 * restamps created_at, keeping the original row id. Returns the stored feedback.
 */
export function recordFeedback(db: Database.Database, input: NewFeedback): PracticeFeedback {
    const createdAt = input.createdAt ?? nowIso();
    db.prepare(
        `INSERT INTO practice_feedback (id, contribution_id, developer_id, signal, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(contribution_id, developer_id) DO UPDATE SET
            signal = excluded.signal,
            created_at = excluded.created_at`,
    ).run(randomUUID(), input.contributionId, input.developerId, input.signal, createdAt);

    // Read back so the returned id is the canonical stored one (an UPSERT update
    // keeps the original row's id, not the one this call generated). The row was
    // just written on this synchronous connection, so it is always present; guard
    // explicitly rather than casting the uncertainty away, so a future change that
    // makes the write conditional fails loudly instead of returning a bad object.
    const stored = getFeedback(db, input.contributionId, input.developerId);
    if (stored === undefined) {
        throw new Error(
            `[practices] feedback row vanished immediately after UPSERT (contribution=${input.contributionId}, developer=${input.developerId})`,
        );
    }
    return stored;
}

/**
 * Clear a developer's current feedback on a practice — the "toggle off" half of the
 * togglable signal (6.2.4). Deletes the at-most-one current row for
 * (contribution_id, developer_id); returns true when a row was actually removed,
 * false when the developer had no current signal. Idempotent: clearing a signal
 * that isn't there is a no-op, not an error.
 */
export function removeFeedback(db: Database.Database, contributionId: string, developerId: string): boolean {
    const res = db
        .prepare('DELETE FROM practice_feedback WHERE contribution_id = ? AND developer_id = ?')
        .run(contributionId, developerId);
    return res.changes > 0;
}

/** One developer's current feedback on a practice, or undefined when none exists. */
export function getFeedback(
    db: Database.Database,
    contributionId: string,
    developerId: string,
): PracticeFeedback | undefined {
    const row = db
        .prepare('SELECT * FROM practice_feedback WHERE contribution_id = ? AND developer_id = ?')
        .get(contributionId, developerId) as FeedbackRow | undefined;
    return row ? rowToFeedback(row) : undefined;
}

/**
 * All feedback rows for a practice, newest first — a RAW PER-DEVELOPER read: each
 * row exposes an individual developer's signal. Per the privacy model, individual
 * data is visible only to that developer; this must NOT be surfaced in a manager
 * or team/aggregate response — use `getFeedbackCounts` for the aggregate path.
 */
export function listFeedback(db: Database.Database, contributionId: string): PracticeFeedback[] {
    const rows = db
        .prepare('SELECT * FROM practice_feedback WHERE contribution_id = ? ORDER BY created_at DESC, id DESC')
        .all(contributionId) as FeedbackRow[];
    return rows.map(rowToFeedback);
}

/**
 * Tally a practice's current feedback into helpful / not-helpful counts — the
 * input the feedback ranking (6.2.4) consumes. Counts current signals only
 * (one per developer, by the UPSERT contract), so a developer who flipped from
 * helpful to not_helpful is counted once, on not_helpful.
 */
export function getFeedbackCounts(db: Database.Database, contributionId: string): FeedbackCounts {
    const row = db
        .prepare(
            `SELECT
                COALESCE(SUM(CASE WHEN signal = 'helpful' THEN 1 ELSE 0 END), 0) AS helpful,
                COALESCE(SUM(CASE WHEN signal = 'not_helpful' THEN 1 ELSE 0 END), 0) AS not_helpful
             FROM practice_feedback WHERE contribution_id = ?`,
        )
        .get(contributionId) as {helpful: number; not_helpful: number};
    return {helpful: row.helpful, notHelpful: row.not_helpful};
}

// --- Usage events (for usage-signal correlation) ----------------------------

/**
 * Record a usage event (viewed | applied | …) and return the stored row. The log
 * is append-only — there is no update or delete, mirroring GovProxy's append-only
 * posture; it is the raw material the later usage-signal correlation (6.2.4)
 * joins against metric movement.
 */
export function recordUsageEvent(db: Database.Database, input: NewUsageEvent): UsageEvent {
    const id = randomUUID();
    const occurredAt = input.occurredAt ?? nowIso();
    const metricContext = input.metricContext ?? null;
    db.prepare(
        `INSERT INTO practice_usage_events (id, contribution_id, developer_id, event, metric_context, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, input.contributionId, input.developerId, input.event, metricContext, occurredAt);
    return {
        id,
        contributionId: input.contributionId,
        developerId: input.developerId,
        event: input.event,
        metricContext,
        occurredAt,
    };
}

/**
 * A practice's usage events in chronological order (oldest first). Ties on
 * `occurred_at` fall back to insertion order (rowid) so events recorded in the
 * same instant still read back in the order they were appended.
 *
 * RAW PER-DEVELOPER read: each row names the developer who engaged. Per the
 * privacy model this must NOT be surfaced in a manager or team/aggregate response;
 * the later correlation (6.2.4) consumes it server-side to produce aggregates.
 */
export function listUsageEvents(db: Database.Database, contributionId: string): UsageEvent[] {
    const rows = db
        .prepare(
            `SELECT * FROM practice_usage_events
             WHERE contribution_id = ?
             ORDER BY occurred_at ASC, rowid ASC`,
        )
        .all(contributionId) as UsageEventRow[];
    return rows.map(rowToUsageEvent);
}
