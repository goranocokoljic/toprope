/**
 * Persistence for prompt captures (Task 5.4 / #125).
 *
 * The server is a BLIND store: it writes the ciphertext blob and the public
 * encryption_meta exactly as received and reads them back only for the owning
 * developer. It never decrypts (it has no key) and never sees plaintext. Every
 * read path here REQUIRES a developer_id and filters on it, so a capture can only
 * be reached by its owner — the routes pass the session's developer id, never one
 * from request input, making cross-developer access impossible by construction.
 */

import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import type {CaptureIngestInput, PromptCapture, PromptCaptureSummary} from './types';
import {isCaptureMechanism, type CaptureMechanism} from './types';

interface CaptureRow {
    id: string;
    developer_id: string;
    session_id: string;
    captured_at: string;
    tool: string | null;
    ciphertext: Buffer;
    encryption_meta: string;
    mechanism: string;
    prompt_count: number | null;
    created_at: string;
}

function nowIso(): string {
    return new Date().toISOString();
}

/**
 * Decode the mechanism column. The write path only ever stores a validated enum
 * value, so an unrecognized value means DB corruption or a future enum migration;
 * warn (mirroring the settings decoders) so it's discoverable rather than silently
 * mislabeled, then fall back to local_agent.
 */
function decodeMechanism(raw: string): CaptureMechanism {
    if (isCaptureMechanism(raw)) {
        return raw;
    }
    console.warn(`[capture] unrecognized mechanism '${raw}' in prompt_captures; defaulting to local_agent`);
    return 'local_agent';
}

function parseMeta(raw: string): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // fall through
    }
    return {};
}

function rowToSummary(row: CaptureRow): PromptCaptureSummary {
    return {
        id: row.id,
        developerId: row.developer_id,
        sessionId: row.session_id,
        capturedAt: row.captured_at,
        tool: row.tool,
        encryptionMeta: parseMeta(row.encryption_meta),
        mechanism: decodeMechanism(row.mechanism),
        promptCount: row.prompt_count,
        createdAt: row.created_at,
    };
}

function rowToCapture(row: CaptureRow): PromptCapture {
    return {
        ...rowToSummary(row),
        // better-sqlite3 returns a BLOB as a Buffer; re-encode for JSON transport.
        ciphertext: Buffer.from(row.ciphertext).toString('base64'),
    };
}

/**
 * Persist one already-encrypted capture and return its server-assigned id +
 * timestamps. The ciphertext is stored verbatim as a BLOB and encryption_meta as
 * JSON text; the server adds nothing readable.
 */
export function insertCapture(db: Database.Database, input: CaptureIngestInput): PromptCaptureSummary {
    const id = randomUUID();
    const createdAt = nowIso();
    db.prepare(
        `INSERT INTO prompt_captures
         (id, developer_id, session_id, captured_at, tool, ciphertext, encryption_meta, mechanism, prompt_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        id,
        input.developerId,
        input.sessionId,
        input.capturedAt,
        input.tool,
        input.ciphertext,
        JSON.stringify(input.encryptionMeta),
        input.mechanism,
        input.promptCount,
        createdAt,
    );
    return {
        id,
        developerId: input.developerId,
        sessionId: input.sessionId,
        capturedAt: input.capturedAt,
        tool: input.tool,
        encryptionMeta: input.encryptionMeta,
        mechanism: input.mechanism,
        promptCount: input.promptCount,
        createdAt,
    };
}

/** Every capture owned by a developer, newest first, WITHOUT ciphertext (listing). */
export function listCapturesForDeveloper(db: Database.Database, developerId: string): PromptCaptureSummary[] {
    const rows = db
        .prepare(
            `SELECT id, developer_id, session_id, captured_at, tool, encryption_meta, mechanism, prompt_count, created_at
             FROM prompt_captures
             WHERE developer_id = ?
             ORDER BY captured_at DESC, created_at DESC`,
        )
        .all(developerId) as Omit<CaptureRow, 'ciphertext'>[];
    return rows.map((row) => rowToSummary(row as CaptureRow));
}

/**
 * One capture WITH its ciphertext, scoped to the owner. The developer_id is part
 * of the WHERE clause (not just the id) so a guessed/leaked id belonging to
 * another developer returns undefined rather than their encrypted payload.
 */
export function getCaptureForDeveloper(
    db: Database.Database,
    developerId: string,
    captureId: string,
): PromptCapture | undefined {
    const row = db
        .prepare('SELECT * FROM prompt_captures WHERE id = ? AND developer_id = ?')
        .get(captureId, developerId) as CaptureRow | undefined;
    return row ? rowToCapture(row) : undefined;
}

/**
 * Every capture for one session, scoped to the owner, WITH ciphertext, oldest
 * first. Ordered chronologically (captured_at ASC) so a consumer that decrypts and
 * concatenates them — e.g. the retrospective generator (Task 5.7) — reconstructs
 * the session in the order it happened. Scoped on developer_id so one developer
 * can never read another's session, even with a guessed session_id.
 */
export function listSessionCapturesForDeveloper(
    db: Database.Database,
    developerId: string,
    sessionId: string,
): PromptCapture[] {
    const rows = db
        .prepare(
            `SELECT * FROM prompt_captures
             WHERE developer_id = ? AND session_id = ?
             ORDER BY captured_at ASC, created_at ASC`,
        )
        .all(developerId, sessionId) as CaptureRow[];
    return rows.map(rowToCapture);
}

/**
 * Delete one capture, scoped to the owner. Returns true when a row was removed.
 * Scoping the DELETE on developer_id means one developer can never delete
 * another's capture even with a valid id.
 */
export function deleteCaptureForDeveloper(
    db: Database.Database,
    developerId: string,
    captureId: string,
): boolean {
    const result = db
        .prepare('DELETE FROM prompt_captures WHERE id = ? AND developer_id = ?')
        .run(captureId, developerId);
    return result.changes > 0;
}
