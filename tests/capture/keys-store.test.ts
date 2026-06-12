import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import {generateDeveloperKey} from '../../src/capture/encryption';
import {wrapCaptureKey} from '../../src/capture/key-recovery';
import {
    registerKey,
    getKeyRecord,
    getRecoveryMaterial,
    logRecoveryEvent,
    listRecoveryLog,
} from '../../src/capture/keys-store';

const NOW = '2026-06-15T00:00:00.000Z';

function seedDeveloper(db: Database.Database, id: string): void {
    db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)')
        .run(`team-${id}`, NOW);
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, `${id} Dev`, `${id}@test.com`, `team-${id}`, NOW);
}

describe('Capture keys store (Task 5.5)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        seedDeveloper(db, 'alice');
        seedDeveloper(db, 'bob');
    });

    afterEach(() => db.close());

    it('no_recovery stores NO recovery material (blob + meta null)', () => {
        const rec = registerKey(db, {
            developerId: 'alice',
            keyId: 'k1',
            recoveryChoice: 'no_recovery',
            recoveryBlob: null,
            recoveryMeta: null,
        });
        expect(rec.recoveryChoice).toBe('no_recovery');
        expect(rec.hasRecoveryBlob).toBe(false);
        expect(rec.recoveryMeta).toBeNull();

        const row = db.prepare('SELECT recovery_blob, recovery_meta FROM capture_keys WHERE developer_id = ?').get('alice') as {
            recovery_blob: Buffer | null;
            recovery_meta: string | null;
        };
        expect(row.recovery_blob).toBeNull();
        expect(row.recovery_meta).toBeNull();
        // And nothing recoverable can be fetched.
        expect(getRecoveryMaterial(db, 'alice')).toBeUndefined();
    });

    it('recovery_path stores the opaque wrapped blob + public meta, and the server stores NO plaintext key', () => {
        const key = generateDeveloperKey();
        const {recovery_blob, meta} = wrapCaptureKey(key, 'my secret phrase');
        registerKey(db, {
            developerId: 'alice',
            keyId: 'k1',
            recoveryChoice: 'recovery_path',
            recoveryBlob: recovery_blob,
            recoveryMeta: meta,
        });

        const rec = getKeyRecord(db, 'alice')!;
        expect(rec.recoveryChoice).toBe('recovery_path');
        expect(rec.hasRecoveryBlob).toBe(true);
        expect(rec.recoveryMeta).toMatchObject({algo: meta.algo, kdf: meta.kdf});

        // The raw key never appears anywhere in the row (only the wrapped blob does).
        const row = db.prepare('SELECT * FROM capture_keys WHERE developer_id = ?').get('alice') as Record<string, unknown>;
        const serialized = JSON.stringify(row) + (row.recovery_blob as Buffer).toString('latin1');
        expect(serialized).not.toContain(key.toString('latin1'));

        const material = getRecoveryMaterial(db, 'alice')!;
        expect(material.recoveryBlob.equals(recovery_blob)).toBe(true);
    });

    it('registerKey is idempotent per developer and can switch posture, preserving created_at', () => {
        const first = registerKey(db, {developerId: 'alice', keyId: 'k1', recoveryChoice: 'no_recovery', recoveryBlob: null, recoveryMeta: null});
        const {recovery_blob, meta} = wrapCaptureKey(generateDeveloperKey(), 'phrase');
        const second = registerKey(db, {developerId: 'alice', keyId: 'k2', recoveryChoice: 'recovery_path', recoveryBlob: recovery_blob, recoveryMeta: meta});

        expect(db.prepare('SELECT COUNT(*) c FROM capture_keys WHERE developer_id = ?').get('alice')).toMatchObject({c: 1});
        expect(second.keyId).toBe('k2');
        expect(second.recoveryChoice).toBe('recovery_path');
        expect(second.createdAt).toBe(first.createdAt);
    });

    it('the DB CHECK rejects a posture/material mismatch (no_recovery with a blob)', () => {
        // Bypass the store helper to prove the schema itself forbids the mismatch.
        expect(() =>
            db.prepare(
                `INSERT INTO capture_keys (developer_id, key_id, recovery_choice, recovery_blob, recovery_meta, created_at, updated_at)
                 VALUES (?, ?, 'no_recovery', ?, NULL, ?, ?)`,
            ).run('alice', 'k1', Buffer.from('x'), NOW, NOW),
        ).toThrow();
    });

    it('logs every recovery event as visible to the developer, newest first', () => {
        logRecoveryEvent(db, 'alice', 'recovery_initiated', 'alice');
        logRecoveryEvent(db, 'alice', 'recovery_completed', 'alice');

        // Every row is visible_to_developer = 1 (no silent recovery possible).
        const visible = db.prepare('SELECT COUNT(*) c FROM key_recovery_log WHERE visible_to_developer = 1').get() as {c: number};
        const total = db.prepare('SELECT COUNT(*) c FROM key_recovery_log').get() as {c: number};
        expect(visible.c).toBe(total.c);

        const log = listRecoveryLog(db, 'alice');
        expect(log.map((e) => e.event)).toEqual(['recovery_completed', 'recovery_initiated']);
        expect(log.every((e) => e.initiatedBy === 'alice')).toBe(true);
    });

    it('scopes the recovery log to its developer — one developer never sees another\'s', () => {
        logRecoveryEvent(db, 'alice', 'recovery_initiated', 'alice');
        expect(listRecoveryLog(db, 'bob')).toHaveLength(0);
        expect(listRecoveryLog(db, 'alice')).toHaveLength(1);
    });
});
