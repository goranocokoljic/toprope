/**
 * Server-side persistence for loop/nudge events (Task 5.6 / #127).
 *
 * The server stores ONLY non-sensitive metadata: a loop's similar-prompt count, a
 * nudge's type, timestamps, and a dismissal flag. There is no column — and no code
 * path here — for prompt content. Every read/write is scoped to a developer_id the
 * route derives from the session (never request input), so one developer can never
 * reach another's events, and there is no manager/aggregate path over these tables.
 */

import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import {isNudgeType, type LoopEvent, type LoopEventMeta, type NudgeEvent, type NudgeEventMeta, type NudgeType} from './types';

interface LoopRow {
    id: string;
    developer_id: string;
    session_id: string;
    detected_at: string;
    similar_prompt_count: number;
    created_at: string;
}

interface NudgeRow {
    id: string;
    developer_id: string;
    session_id: string;
    nudge_type: string;
    delivered_at: string;
    dismissed: number;
    created_at: string;
}

function nowIso(): string {
    return new Date().toISOString();
}

/**
 * Decode the nudge_type column. The write path only stores a validated enum value
 * (and the DB CHECK enforces it), so an unrecognized value means corruption or a
 * future enum migration; warn (mirroring the capture/settings decoders) and fall
 * back to the most generic type rather than crash a private listing.
 */
function decodeNudgeType(raw: string): NudgeType {
    if (isNudgeType(raw)) {
        return raw;
    }
    console.warn(`[realtime-coaching] unrecognized nudge_type '${raw}' in nudge_events; defaulting to short_prompt`);
    return 'short_prompt';
}

function rowToLoopEvent(row: LoopRow): LoopEvent {
    return {
        id: row.id,
        developerId: row.developer_id,
        sessionId: row.session_id,
        detectedAt: row.detected_at,
        similarPromptCount: row.similar_prompt_count,
        createdAt: row.created_at,
    };
}

function rowToNudgeEvent(row: NudgeRow): NudgeEvent {
    return {
        id: row.id,
        developerId: row.developer_id,
        sessionId: row.session_id,
        nudgeType: decodeNudgeType(row.nudge_type),
        deliveredAt: row.delivered_at,
        dismissed: row.dismissed === 1,
        createdAt: row.created_at,
    };
}

/** Persist one loop-detection metadata event for a developer. */
export function insertLoopEvent(db: Database.Database, developerId: string, meta: LoopEventMeta): LoopEvent {
    const id = randomUUID();
    const createdAt = nowIso();
    db.prepare(
        `INSERT INTO loop_events (id, developer_id, session_id, detected_at, similar_prompt_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, developerId, meta.sessionId, meta.detectedAt, meta.similarPromptCount, createdAt);
    return {
        id,
        developerId,
        sessionId: meta.sessionId,
        detectedAt: meta.detectedAt,
        similarPromptCount: meta.similarPromptCount,
        createdAt,
    };
}

/** Persist one nudge-delivery metadata event for a developer (starts un-dismissed). */
export function insertNudgeEvent(db: Database.Database, developerId: string, meta: NudgeEventMeta): NudgeEvent {
    const id = randomUUID();
    const createdAt = nowIso();
    db.prepare(
        `INSERT INTO nudge_events (id, developer_id, session_id, nudge_type, delivered_at, dismissed, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
    ).run(id, developerId, meta.sessionId, meta.nudgeType, meta.deliveredAt, createdAt);
    return {
        id,
        developerId,
        sessionId: meta.sessionId,
        nudgeType: meta.nudgeType,
        deliveredAt: meta.deliveredAt,
        dismissed: false,
        createdAt,
    };
}

/** Every loop event owned by a developer, newest first. */
export function listLoopEventsForDeveloper(db: Database.Database, developerId: string): LoopEvent[] {
    const rows = db
        .prepare(
            `SELECT id, developer_id, session_id, detected_at, similar_prompt_count, created_at
             FROM loop_events WHERE developer_id = ?
             ORDER BY detected_at DESC, created_at DESC`,
        )
        .all(developerId) as LoopRow[];
    return rows.map(rowToLoopEvent);
}

/**
 * Every loop event for ONE session owned by a developer, newest first. Scoped on
 * developer_id AND session_id at the SQL boundary (the table is indexed on
 * developer_id) so a session-level consumer — e.g. the retrospective generator
 * (Task 5.7) — reads only that session's events instead of loading all of a
 * developer's and filtering in memory.
 */
export function listLoopEventsForSession(
    db: Database.Database,
    developerId: string,
    sessionId: string,
): LoopEvent[] {
    const rows = db
        .prepare(
            `SELECT id, developer_id, session_id, detected_at, similar_prompt_count, created_at
             FROM loop_events WHERE developer_id = ? AND session_id = ?
             ORDER BY detected_at DESC, created_at DESC`,
        )
        .all(developerId, sessionId) as LoopRow[];
    return rows.map(rowToLoopEvent);
}

/** Every nudge event owned by a developer, newest first. */
export function listNudgeEventsForDeveloper(db: Database.Database, developerId: string): NudgeEvent[] {
    const rows = db
        .prepare(
            `SELECT id, developer_id, session_id, nudge_type, delivered_at, dismissed, created_at
             FROM nudge_events WHERE developer_id = ?
             ORDER BY delivered_at DESC, created_at DESC`,
        )
        .all(developerId) as NudgeRow[];
    return rows.map(rowToNudgeEvent);
}

/**
 * Mark one of the developer's own nudge events dismissed. Owner-scoped: the
 * developer_id is part of the WHERE clause, so a guessed/leaked id belonging to
 * another developer changes nothing. Returns true when a row was updated.
 */
export function dismissNudgeEvent(db: Database.Database, developerId: string, eventId: string): boolean {
    const result = db
        .prepare('UPDATE nudge_events SET dismissed = 1 WHERE id = ? AND developer_id = ?')
        .run(eventId, developerId);
    return result.changes > 0;
}
