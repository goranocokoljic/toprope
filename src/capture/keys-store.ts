/**
 * Persistence for capture-key metadata + recovery audit (Task 5.5 / #126).
 *
 * Like the capture store, the server here is BLIND to anything it could use to
 * decrypt a developer's captures. It persists:
 *   - a key REFERENCE (`key_id`) and the developer's recovery posture,
 *   - for `recovery_path`, the opaque client-wrapped `recovery_blob` + public
 *     `recovery_meta` (KDF/cipher params) — never the recovery secret, the
 *     wrapping key, or the capture key,
 *   - an append-only audit (`key_recovery_log`) of every recovery action.
 *
 * Every function is scoped to a `developerId` supplied by the route from the
 * session (never request input), so one developer can never reach another's key
 * record or recovery log. The recovery-log writer ALWAYS records the event as
 * visible to the developer — there is no code path that hides a recovery, which
 * is what makes "no silent recovery" structural rather than a convention.
 */

import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';

/** The two recovery postures a developer can choose at opt-in. */
export type RecoveryChoice = 'no_recovery' | 'recovery_path';

/** The lifecycle events of a recovery attempt, all audited and developer-visible. */
export type RecoveryEvent = 'recovery_initiated' | 'recovery_completed' | 'recovery_failed';

/** Input to register/replace a developer's key record. */
export interface RegisterKeyInput {
    developerId: string;
    keyId: string;
    recoveryChoice: RecoveryChoice;
    /** recovery_path only: the client-wrapped capture key. Null for no_recovery. */
    recoveryBlob: Buffer | null;
    /** recovery_path only: public KDF/cipher params (JSON-serializable). Null otherwise. */
    recoveryMeta: Record<string, unknown> | null;
}

/** A developer's key record as read back — metadata only, never key material. */
export interface CaptureKeyRecord {
    developerId: string;
    keyId: string;
    recoveryChoice: RecoveryChoice;
    /** True when a wrapped recovery blob exists (recovery_path). Never the blob itself here. */
    hasRecoveryBlob: boolean;
    recoveryMeta: Record<string, unknown> | null;
    createdAt: string;
    updatedAt: string;
}

/** One developer-visible recovery audit entry. */
export interface RecoveryLogEntry {
    id: string;
    event: RecoveryEvent;
    initiatedBy: string;
    occurredAt: string;
}

interface CaptureKeyRow {
    developer_id: string;
    key_id: string;
    recovery_choice: string;
    recovery_blob: Buffer | null;
    recovery_meta: string | null;
    created_at: string;
    updated_at: string;
}

interface RecoveryLogRow {
    id: string;
    event: string;
    initiated_by: string;
    occurred_at: string;
}

function nowIso(): string {
    return new Date().toISOString();
}

function parseMeta(raw: string | null): Record<string, unknown> | null {
    if (raw === null) {
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // fall through
    }
    return null;
}

function rowToRecord(row: CaptureKeyRow): CaptureKeyRecord {
    return {
        developerId: row.developer_id,
        keyId: row.key_id,
        // The column is constrained to the two postures, but normalize defensively
        // so a corrupt/future value reads as the safe posture rather than leaking
        // a recovery_path UI affordance the row can't honor.
        recoveryChoice: row.recovery_choice === 'recovery_path' ? 'recovery_path' : 'no_recovery',
        hasRecoveryBlob: row.recovery_blob !== null,
        recoveryMeta: parseMeta(row.recovery_meta),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/**
 * Register (or replace) a developer's key record. Idempotent per developer:
 * re-registering updates the existing row (the developer may re-key or change
 * their recovery posture), preserving the original created_at. The schema CHECK
 * enforces that recovery_blob/recovery_meta are present iff recovery_path and
 * absent for no_recovery, so a malformed pairing is rejected at the DB boundary.
 */
export function registerKey(db: Database.Database, input: RegisterKeyInput): CaptureKeyRecord {
    const now = nowIso();
    const blob = input.recoveryChoice === 'recovery_path' ? input.recoveryBlob : null;
    const metaJson =
        input.recoveryChoice === 'recovery_path' && input.recoveryMeta !== null
            ? JSON.stringify(input.recoveryMeta)
            : null;
    db.prepare(
        `INSERT INTO capture_keys (developer_id, key_id, recovery_choice, recovery_blob, recovery_meta, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(developer_id) DO UPDATE SET
            key_id = excluded.key_id,
            recovery_choice = excluded.recovery_choice,
            recovery_blob = excluded.recovery_blob,
            recovery_meta = excluded.recovery_meta,
            updated_at = excluded.updated_at`,
    ).run(input.developerId, input.keyId, input.recoveryChoice, blob, metaJson, now, now);
    return getKeyRecord(db, input.developerId)!;
}

/** A developer's key record (metadata only — never the wrapped blob), or undefined. */
export function getKeyRecord(db: Database.Database, developerId: string): CaptureKeyRecord | undefined {
    const row = db
        .prepare('SELECT * FROM capture_keys WHERE developer_id = ?')
        .get(developerId) as CaptureKeyRow | undefined;
    return row ? rowToRecord(row) : undefined;
}

/**
 * Fetch the wrapped recovery blob + meta for the owning developer, for the client
 * to unwrap locally. Returns undefined when there is no record or the posture is
 * no_recovery (no blob exists, by design). The blob is opaque to the server.
 */
export function getRecoveryMaterial(
    db: Database.Database,
    developerId: string,
): {recoveryBlob: Buffer; recoveryMeta: Record<string, unknown>} | undefined {
    const row = db
        .prepare('SELECT recovery_blob, recovery_meta FROM capture_keys WHERE developer_id = ?')
        .get(developerId) as {recovery_blob: Buffer | null; recovery_meta: string | null} | undefined;
    if (!row || row.recovery_blob === null) {
        return undefined;
    }
    const meta = parseMeta(row.recovery_meta);
    if (meta === null) {
        return undefined;
    }
    return {recoveryBlob: Buffer.from(row.recovery_blob), recoveryMeta: meta};
}

/**
 * Append one recovery event to the audit log. ALWAYS written as visible to the
 * developer — there is intentionally no parameter to hide it, so every recovery
 * action surfaces in the developer's own view. `initiatedBy` is recorded so the
 * developer can see who triggered it (their own session id under this design).
 */
export function logRecoveryEvent(
    db: Database.Database,
    developerId: string,
    event: RecoveryEvent,
    initiatedBy: string,
): RecoveryLogEntry {
    const id = randomUUID();
    const occurredAt = nowIso();
    db.prepare(
        `INSERT INTO key_recovery_log (id, developer_id, event, initiated_by, occurred_at, visible_to_developer)
         VALUES (?, ?, ?, ?, ?, 1)`,
    ).run(id, developerId, event, initiatedBy, occurredAt);
    return {id, event, initiatedBy, occurredAt};
}

/**
 * True when the developer has an OPEN recovery attempt — i.e. their most recent
 * recovery event is `recovery_initiated`, not yet followed by a terminal
 * completed/failed. Used to gate `recovery/complete` so an outcome can only be
 * recorded against a recovery that was actually initiated: without this a
 * developer could append a `recovery_completed` with no preceding initiate,
 * making their own audit no longer a faithful record of real flows. The latest
 * event is taken by (occurred_at, rowid) — the same monotonic ordering the log
 * view uses — so a same-millisecond initiate is still recognized as the latest.
 *
 * This deliberately does NOT re-check the current recovery posture: the append-only
 * log can retain a stale `recovery_initiated` from before a developer re-keyed to
 * `no_recovery`. Every caller (the complete route) gates on the live
 * `recovery_path` posture FIRST, so a re-keyed no_recovery developer is rejected
 * before reaching here — the guard ORDER is load-bearing; don't reorder it.
 */
export function hasOpenRecovery(db: Database.Database, developerId: string): boolean {
    const row = db
        .prepare(
            `SELECT event FROM key_recovery_log
             WHERE developer_id = ?
             ORDER BY occurred_at DESC, rowid DESC
             LIMIT 1`,
        )
        .get(developerId) as {event: string} | undefined;
    return row?.event === 'recovery_initiated';
}

/**
 * The developer's own recovery audit, newest first. Filtered to their id AND to
 * visible_to_developer = 1 — so this view structurally shows every recovery
 * event (the writer always sets it to 1) and never another developer's.
 */
export function listRecoveryLog(db: Database.Database, developerId: string): RecoveryLogEntry[] {
    const rows = db
        .prepare(
            // Tie-break on the implicit rowid (monotonic with insertion order) rather
            // than the random-UUID id: two events in the same millisecond — e.g. an
            // initiate immediately followed by a fast client-reported outcome — must
            // not sort in a misleading order in the developer's audit view.
            `SELECT id, event, initiated_by, occurred_at
             FROM key_recovery_log
             WHERE developer_id = ? AND visible_to_developer = 1
             ORDER BY occurred_at DESC, rowid DESC`,
        )
        .all(developerId) as RecoveryLogRow[];
    return rows.map((row) => ({
        id: row.id,
        event: row.event as RecoveryEvent,
        initiatedBy: row.initiated_by,
        occurredAt: row.occurred_at,
    }));
}
