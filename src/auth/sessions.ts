import type Database from 'better-sqlite3';
import {randomBytes} from 'crypto';
import type {Session} from './types';

export const DEFAULT_SESSION_TTL_HOURS = 168; // 7 days

interface SessionRow {
    id: string;
    user_id: string;
    created_at: string;
    expires_at: string;
}

/**
 * Create a new session for a user. The session id is a 256-bit random token —
 * it IS the credential the client presents (via cookie or bearer header), so it
 * must be unguessable. Returns the full session including the token.
 */
export function createSession(
    db: Database.Database,
    userId: string,
    ttlHours: number = DEFAULT_SESSION_TTL_HOURS,
): Session {
    const id = randomBytes(32).toString('base64url');
    const now = new Date();
    const expires = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
    const createdAt = now.toISOString();
    const expiresAt = expires.toISOString();

    db.prepare(
        'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ).run(id, userId, createdAt, expiresAt);

    return {id, user_id: userId, created_at: createdAt, expires_at: expiresAt};
}

/**
 * Return a session by token only if it exists and has not expired. Expired
 * sessions are deleted lazily on lookup so they can't be reused.
 */
export function getValidSession(db: Database.Database, id: string): Session | null {
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    if (!row) {
        return null;
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
        return null;
    }
    return row;
}

export function deleteSession(db: Database.Database, id: string): boolean {
    const res = db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return res.changes > 0;
}

export function deleteSessionsForUser(db: Database.Database, userId: string): number {
    const res = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    return res.changes;
}

export function pruneExpiredSessions(db: Database.Database): number {
    const res = db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
    return res.changes;
}
