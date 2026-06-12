import {describe, it, expect} from 'vitest';
import {generateDeveloperKey, CAPTURE_KEY_BYTES} from '../../src/capture/encryption';
import {
    wrapCaptureKey,
    unwrapCaptureKey,
    RECOVERY_WRAP_ALGO,
    RECOVERY_KDF,
} from '../../src/capture/key-recovery';

const SECRET = 'correct horse battery staple — my recovery phrase';

/** Local assertion helper — the round-trip owns both buffers in plaintext. */
function keysEqual(a: Buffer, b: Buffer): boolean {
    return a.equals(b);
}

describe('Capture key recovery wrapping (Task 5.5)', () => {
    it('round-trips: a key wrapped with a recovery secret unwraps to the SAME key', () => {
        const key = generateDeveloperKey();
        const {recovery_blob, meta} = wrapCaptureKey(key, SECRET);
        const recovered = unwrapCaptureKey(recovery_blob, meta, SECRET);
        expect(keysEqual(recovered, key)).toBe(true);
        expect(meta.algo).toBe(RECOVERY_WRAP_ALGO);
        expect(meta.kdf).toBe(RECOVERY_KDF);
    });

    it('the wrapped blob is opaque — it does not contain the raw key bytes', () => {
        const key = generateDeveloperKey();
        const {recovery_blob} = wrapCaptureKey(key, SECRET);
        // The wrapped blob must not equal the key, and the key must not appear inside it.
        expect(recovery_blob.equals(key)).toBe(false);
        expect(recovery_blob.toString('latin1')).not.toContain(key.toString('latin1'));
    });

    it('uses a fresh salt + IV every call, so wrapping the same key twice differs', () => {
        const key = generateDeveloperKey();
        const a = wrapCaptureKey(key, SECRET);
        const b = wrapCaptureKey(key, SECRET);
        expect(a.meta.salt).not.toBe(b.meta.salt);
        expect(a.meta.iv).not.toBe(b.meta.iv);
        expect(a.recovery_blob.equals(b.recovery_blob)).toBe(false);
        // Both still unwrap to the original key.
        expect(keysEqual(unwrapCaptureKey(a.recovery_blob, a.meta, SECRET), key)).toBe(true);
        expect(keysEqual(unwrapCaptureKey(b.recovery_blob, b.meta, SECRET), key)).toBe(true);
    });

    it('the WRONG recovery secret cannot unwrap the key (GCM auth fails loudly)', () => {
        const key = generateDeveloperKey();
        const {recovery_blob, meta} = wrapCaptureKey(key, SECRET);
        expect(() => unwrapCaptureKey(recovery_blob, meta, 'a different phrase')).toThrow();
    });

    it('tampering with the blob or auth_tag makes unwrap throw', () => {
        const key = generateDeveloperKey();
        const {recovery_blob, meta} = wrapCaptureKey(key, SECRET);
        const tamperedBlob = Buffer.from(recovery_blob);
        tamperedBlob[0] ^= 0xff;
        expect(() => unwrapCaptureKey(tamperedBlob, meta, SECRET)).toThrow();

        const badTag = Buffer.from(meta.auth_tag, 'base64');
        badTag[0] ^= 0xff;
        expect(() => unwrapCaptureKey(recovery_blob, {...meta, auth_tag: badTag.toString('base64')}, SECRET)).toThrow();
    });

    it('rejects an empty recovery secret on both wrap and unwrap', () => {
        const key = generateDeveloperKey();
        expect(() => wrapCaptureKey(key, '')).toThrow();
        expect(() => wrapCaptureKey(key, '   ')).toThrow();
        const {recovery_blob, meta} = wrapCaptureKey(key, SECRET);
        expect(() => unwrapCaptureKey(recovery_blob, meta, '')).toThrow();
    });

    it('rejects a non-AES-256 key on wrap', () => {
        expect(() => wrapCaptureKey(Buffer.alloc(16, 1), SECRET)).toThrow();
        expect(() => wrapCaptureKey(Buffer.alloc(CAPTURE_KEY_BYTES + 1, 1), SECRET)).toThrow();
    });

    it('rejects unknown algo/kdf in meta on unwrap', () => {
        const key = generateDeveloperKey();
        const {recovery_blob, meta} = wrapCaptureKey(key, SECRET);
        expect(() => unwrapCaptureKey(recovery_blob, {...meta, algo: 'rot13'}, SECRET)).toThrow();
        expect(() => unwrapCaptureKey(recovery_blob, {...meta, kdf: 'md5'}, SECRET)).toThrow();
    });
});
