import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import {createUser} from '../../src/auth/users';
import {
    createSession,
    getValidSession,
    deleteSession,
    deleteSessionsForUser,
    pruneExpiredSessions,
} from '../../src/auth/sessions';

async function seedUser(db: Database.Database): Promise<string> {
    const user = createUser(db, {
        email: 'sess@test.com',
        passwordHash: 'hash',
        role: 'admin',
    });
    return user.id;
}

describe('session lifecycle', () => {
    let db: Database.Database;
    let userId: string;

    beforeEach(async () => {
        db = makeTestDb();
        userId = await seedUser(db);
    });

    afterEach(() => {
        db.close();
    });

    it('creates a session with an unguessable token and future expiry', () => {
        const session = createSession(db, userId, 1);
        expect(session.id.length).toBeGreaterThanOrEqual(32);
        expect(new Date(session.expires_at).getTime()).toBeGreaterThan(Date.now());
    });

    it('returns a valid session by token', () => {
        const session = createSession(db, userId, 1);
        const found = getValidSession(db, session.id);
        expect(found?.user_id).toBe(userId);
    });

    it('returns null for an unknown token', () => {
        expect(getValidSession(db, 'nope')).toBeNull();
    });

    it('treats an expired session as invalid and deletes it', () => {
        const session = createSession(db, userId, -1); // already expired
        expect(getValidSession(db, session.id)).toBeNull();
        // Row should have been pruned on lookup.
        const row = db.prepare('SELECT id FROM sessions WHERE id = ?').get(session.id);
        expect(row).toBeUndefined();
    });

    it('deletes a single session (logout)', () => {
        const session = createSession(db, userId, 1);
        expect(deleteSession(db, session.id)).toBe(true);
        expect(getValidSession(db, session.id)).toBeNull();
    });

    it('deletes all sessions for a user (rotation / forced logout)', () => {
        createSession(db, userId, 1);
        createSession(db, userId, 1);
        expect(deleteSessionsForUser(db, userId)).toBe(2);
    });

    it('prunes only expired sessions', () => {
        createSession(db, userId, 1);
        createSession(db, userId, -1);
        expect(pruneExpiredSessions(db)).toBe(1);
    });
});
