import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import {
    insertCapture,
    listCapturesForDeveloper,
    getCaptureForDeveloper,
    deleteCaptureForDeveloper,
} from '../../src/capture/store';
import type {CaptureIngestInput} from '../../src/capture/types';

const NOW = '2026-06-15T00:00:00.000Z';

function seedDeveloper(db: Database.Database, id: string): void {
    db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)')
        .run(`team-${id}`, NOW);
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, `${id} Dev`, `${id}@test.com`, `team-${id}`, NOW);
}

function ingest(developerId: string, overrides: Partial<CaptureIngestInput> = {}): CaptureIngestInput {
    return {
        developerId,
        sessionId: 'sess-1',
        capturedAt: NOW,
        tool: 'claude_code',
        ciphertext: Buffer.from([1, 2, 3, 4]),
        encryptionMeta: {algo: 'AES-256-GCM', iv: 'aXY=', auth_tag: 'dGFn', key_id: 'k1'},
        mechanism: 'local_agent',
        promptCount: 3,
        ...overrides,
    };
}

describe('capture store (Task 5.4)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        seedDeveloper(db, 'alice');
        seedDeveloper(db, 'bob');
    });

    afterEach(() => db.close());

    it('inserts a capture and reads it back with ciphertext for the owner', () => {
        const summary = insertCapture(db, ingest('alice'));
        expect(summary.id).toBeTruthy();
        expect(summary.mechanism).toBe('local_agent');

        const full = getCaptureForDeveloper(db, 'alice', summary.id);
        expect(full).toBeDefined();
        expect(Buffer.from(full!.ciphertext, 'base64').equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
        expect(full!.encryptionMeta.key_id).toBe('k1');
        expect(full!.promptCount).toBe(3);
    });

    it('lists only the owner\'s captures, newest first, without ciphertext', () => {
        insertCapture(db, ingest('alice', {capturedAt: '2026-06-01T00:00:00.000Z'}));
        insertCapture(db, ingest('alice', {capturedAt: '2026-06-10T00:00:00.000Z'}));
        insertCapture(db, ingest('bob'));

        const list = listCapturesForDeveloper(db, 'alice');
        expect(list).toHaveLength(2);
        expect(list[0].capturedAt).toBe('2026-06-10T00:00:00.000Z');
        // The listing view carries no ciphertext field at all.
        expect('ciphertext' in list[0]).toBe(false);
    });

    it('scopes reads to the owner — another developer cannot fetch the capture by id', () => {
        const summary = insertCapture(db, ingest('alice'));
        // bob, even with alice's capture id, gets nothing.
        expect(getCaptureForDeveloper(db, 'bob', summary.id)).toBeUndefined();
        expect(listCapturesForDeveloper(db, 'bob')).toHaveLength(0);
    });

    it('records the mechanism per capture (both mechanisms stored verbatim)', () => {
        const a = insertCapture(db, ingest('alice', {mechanism: 'local_agent'}));
        const b = insertCapture(db, ingest('alice', {mechanism: 'editor_extension'}));
        expect(getCaptureForDeveloper(db, 'alice', a.id)!.mechanism).toBe('local_agent');
        expect(getCaptureForDeveloper(db, 'alice', b.id)!.mechanism).toBe('editor_extension');
    });

    it('deletes only the owner\'s capture', () => {
        const summary = insertCapture(db, ingest('alice'));
        // bob cannot delete alice's capture.
        expect(deleteCaptureForDeveloper(db, 'bob', summary.id)).toBe(false);
        expect(getCaptureForDeveloper(db, 'alice', summary.id)).toBeDefined();
        // alice can.
        expect(deleteCaptureForDeveloper(db, 'alice', summary.id)).toBe(true);
        expect(getCaptureForDeveloper(db, 'alice', summary.id)).toBeUndefined();
    });
});
