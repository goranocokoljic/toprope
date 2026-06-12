import {describe, it, expect} from 'vitest';
import {
    encryptCapture,
    decryptCapture,
    generateDeveloperKey,
    CAPTURE_ALGO,
    CAPTURE_KEY_BYTES,
} from '../../src/capture/encryption';

const PLAINTEXT = 'prompt: refactor the auth module\nresponse: here is a diff ...';
const KEY_ID = 'key-1';

describe('capture encryption (Task 5.4)', () => {
    it('round-trips plaintext through encrypt/decrypt with the developer key', () => {
        const key = generateDeveloperKey();
        const {ciphertext, meta} = encryptCapture(PLAINTEXT, key, KEY_ID);
        expect(decryptCapture(ciphertext, meta, key)).toBe(PLAINTEXT);
    });

    it('produces ciphertext that does not contain the plaintext, and records only public meta', () => {
        const key = generateDeveloperKey();
        const {ciphertext, meta} = encryptCapture(PLAINTEXT, key, KEY_ID);
        // The opaque blob must not leak the plaintext (utf8 or otherwise).
        expect(ciphertext.toString('utf8')).not.toContain('refactor');
        expect(ciphertext.toString('latin1')).not.toContain('refactor');
        // Meta carries the algorithm, an IV, a tag and a key REFERENCE — never the key.
        expect(meta.algo).toBe(CAPTURE_ALGO);
        expect(meta.iv.length).toBeGreaterThan(0);
        expect(meta.auth_tag.length).toBeGreaterThan(0);
        expect(meta.key_id).toBe(KEY_ID);
        const serialized = JSON.stringify(meta);
        expect(serialized).not.toContain(key.toString('base64'));
        expect(serialized).not.toContain(key.toString('hex'));
    });

    it('uses a fresh IV per call so identical plaintext yields different ciphertext', () => {
        const key = generateDeveloperKey();
        const a = encryptCapture(PLAINTEXT, key, KEY_ID);
        const b = encryptCapture(PLAINTEXT, key, KEY_ID);
        expect(a.meta.iv).not.toBe(b.meta.iv);
        expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
        // Both still decrypt back to the same plaintext.
        expect(decryptCapture(a.ciphertext, a.meta, key)).toBe(PLAINTEXT);
        expect(decryptCapture(b.ciphertext, b.meta, key)).toBe(PLAINTEXT);
    });

    it('fails to decrypt with the wrong key (GCM auth)', () => {
        const key = generateDeveloperKey();
        const wrong = generateDeveloperKey();
        const {ciphertext, meta} = encryptCapture(PLAINTEXT, key, KEY_ID);
        expect(() => decryptCapture(ciphertext, meta, wrong)).toThrow();
    });

    it('fails to decrypt when the ciphertext is tampered with (GCM integrity)', () => {
        const key = generateDeveloperKey();
        const {ciphertext, meta} = encryptCapture(PLAINTEXT, key, KEY_ID);
        const tampered = Buffer.from(ciphertext);
        tampered[0] ^= 0xff;
        expect(() => decryptCapture(tampered, meta, key)).toThrow();
    });

    it('rejects keys that are not exactly AES-256 length', () => {
        const shortKey = Buffer.alloc(CAPTURE_KEY_BYTES - 1);
        expect(() => encryptCapture(PLAINTEXT, shortKey, KEY_ID)).toThrow();
    });
});
