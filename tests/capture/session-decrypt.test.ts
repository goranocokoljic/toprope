import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import {insertCapture} from '../../src/capture/store';
import {buildCapturePayload} from '../../src/capture/client';
import {generateDeveloperKey} from '../../src/capture/encryption';
import {decryptSessionToText, SessionDecryptError} from '../../src/capture/session-decrypt';

const NOW = '2026-06-13T00:00:00.000Z';
const SESSION = 'sess-1';

function seedDeveloper(db: Database.Database, id: string, team: string): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, `${id} Dev`, `${id}@test.com`, team, NOW);
}

function seedCapture(
    db: Database.Database,
    developerId: string,
    key: Buffer,
    plaintext: string,
    capturedAt: string,
): void {
    const payload = buildCapturePayload(
        {key, keyId: 'k1', mechanism: 'local_agent'},
        {sessionId: SESSION, plaintext, capturedAt, tool: 'claude_code', promptCount: 1},
    );
    insertCapture(db, {
        developerId,
        sessionId: payload.session_id,
        capturedAt: payload.captured_at,
        tool: payload.tool ?? null,
        ciphertext: Buffer.from(payload.ciphertext, 'base64'),
        encryptionMeta: payload.encryption_meta as unknown as Record<string, unknown>,
        mechanism: 'local_agent',
        promptCount: 1,
    });
}

describe('decryptSessionToText (shared transient session-decrypt)', () => {
    let db: Database.Database;
    let key: Buffer;

    beforeEach(() => {
        db = makeTestDb();
        db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run('eng', NOW);
        seedDeveloper(db, 'alice', 'eng');
        key = generateDeveloperKey();
    });

    afterEach(() => {
        db.close();
    });

    it('decrypts and concatenates a session’s captures in chronological order', () => {
        seedCapture(db, 'alice', key, 'first prompt', '2026-06-13T00:00:00.000Z');
        seedCapture(db, 'alice', key, 'second prompt', '2026-06-13T00:01:00.000Z');
        const {plaintext, captureCount} = decryptSessionToText(db, 'alice', SESSION, key);
        expect(captureCount).toBe(2);
        expect(plaintext).toBe('first prompt\nsecond prompt');
    });

    it('throws no_captures for an empty session', () => {
        try {
            decryptSessionToText(db, 'alice', 'nope', key);
            throw new Error('expected throw');
        } catch (err) {
            expect(err).toBeInstanceOf(SessionDecryptError);
            expect((err as SessionDecryptError).code).toBe('no_captures');
        }
    });

    it('throws decrypt_failed for a wrong key, leaking no bytes', () => {
        seedCapture(db, 'alice', key, 'SUPERSECRET', NOW);
        const wrong = generateDeveloperKey();
        try {
            decryptSessionToText(db, 'alice', SESSION, wrong);
            throw new Error('expected throw');
        } catch (err) {
            expect((err as SessionDecryptError).code).toBe('decrypt_failed');
            expect((err as SessionDecryptError).message).not.toContain('SUPERSECRET');
        }
    });

    it('is owner-scoped — another developer cannot reach the session (treated as empty)', () => {
        seedCapture(db, 'alice', key, 'private', NOW);
        seedDeveloper(db, 'bob', 'eng');
        try {
            decryptSessionToText(db, 'bob', SESSION, key);
            throw new Error('expected throw');
        } catch (err) {
            expect((err as SessionDecryptError).code).toBe('no_captures');
        }
    });
});
