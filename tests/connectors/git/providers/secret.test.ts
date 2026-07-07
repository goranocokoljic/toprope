import {describe, it, expect} from 'vitest';
import {randomBytes} from 'crypto';
import {
    loadServerKey,
    encryptSecret,
    decryptSecret,
    SecretCryptoError,
    SECRET_ALGO,
    SECRET_KEY_BYTES,
    SECRET_KEY_ENV,
    type ServerKey,
    type SecretMeta,
} from '../../../../src/connectors/git/providers/secret';

// A known-good 32-byte key, base64-encoded, for env-based tests.
const VALID_KEY_B64 = randomBytes(SECRET_KEY_BYTES).toString('base64');

// Load a key from a synthetic env, asserting success, for the crypto tests.
function keyFrom(b64: string): ServerKey {
    const result = loadServerKey({[SECRET_KEY_ENV]: b64});
    if (!result.ok) throw new Error(`expected a valid key, got ${result.status}`);
    return result.key;
}

describe('loadServerKey — fail-closed key loading (#194)', () => {
    it('loads a valid base64 32-byte key and derives a stable key_id', () => {
        const a = loadServerKey({[SECRET_KEY_ENV]: VALID_KEY_B64});
        const b = loadServerKey({[SECRET_KEY_ENV]: VALID_KEY_B64});
        expect(a.ok).toBe(true);
        expect(b.ok).toBe(true);
        if (!a.ok || !b.ok) return;
        expect(a.key.key.length).toBe(SECRET_KEY_BYTES);
        // key_id is a non-secret fingerprint, stable for the same key material,
        // and never contains the raw key bytes.
        expect(a.key.keyId).toBe(b.key.keyId);
        expect(a.key.keyId).toMatch(/^sk_[0-9a-f]{16}$/);
        expect(a.key.keyId).not.toContain(a.key.key.toString('base64'));
    });

    it('returns not_configured when the env var is unset', () => {
        const result = loadServerKey({});
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.status).toBe('not_configured');
        // Fail-closed: there is no key property to fall back to.
        expect('key' in result).toBe(false);
    });

    it('returns not_configured when the env var is blank/whitespace', () => {
        for (const blank of ['', '   ', '\t\n']) {
            const result = loadServerKey({[SECRET_KEY_ENV]: blank});
            expect(result.ok).toBe(false);
            if (result.ok) continue;
            expect(result.status).toBe('not_configured');
        }
    });

    it('returns invalid when the value is not base64', () => {
        const result = loadServerKey({[SECRET_KEY_ENV]: 'not valid base64 !!!@@@'});
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.status).toBe('invalid');
    });

    it('returns invalid when the decoded key is too short', () => {
        const short = randomBytes(16).toString('base64'); // 16 bytes, not 32
        const result = loadServerKey({[SECRET_KEY_ENV]: short});
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.status).toBe('invalid');
        expect(result.message).toContain(String(SECRET_KEY_BYTES));
    });

    it('returns invalid when the decoded key is too long', () => {
        const long = randomBytes(48).toString('base64'); // 48 bytes, not 32
        const result = loadServerKey({[SECRET_KEY_ENV]: long});
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.status).toBe('invalid');
    });

    it('tolerates surrounding whitespace on an otherwise valid key', () => {
        const result = loadServerKey({[SECRET_KEY_ENV]: `  ${VALID_KEY_B64}\n`});
        expect(result.ok).toBe(true);
    });

    it('accepts a valid key supplied without base64 padding', () => {
        // A 32-byte key encodes to 44 chars with a single '=' pad; strip it and the
        // loader must still normalize the padding back and accept the key.
        const unpadded = VALID_KEY_B64.replace(/=+$/, '');
        expect(unpadded.endsWith('=')).toBe(false);
        const result = loadServerKey({[SECRET_KEY_ENV]: unpadded});
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.key.key.length).toBe(SECRET_KEY_BYTES);
    });
});

describe('encryptSecret / decryptSecret — round-trip + integrity (#194)', () => {
    const TOKEN = 'ghp_supersecrettoken1234567890';

    it('round-trips a token through encrypt → decrypt', () => {
        const key = keyFrom(VALID_KEY_B64);
        const {ciphertext, meta} = encryptSecret(TOKEN, key);
        expect(decryptSecret(ciphertext, meta, key)).toBe(TOKEN);
    });

    it('records algo and the key_id in meta', () => {
        const key = keyFrom(VALID_KEY_B64);
        const {meta} = encryptSecret(TOKEN, key);
        expect(meta.algo).toBe(SECRET_ALGO);
        expect(meta.key_id).toBe(key.keyId);
        expect(meta.iv).toBeTruthy();
        expect(meta.auth_tag).toBeTruthy();
    });

    it('draws a fresh IV every call — same plaintext yields different ciphertext', () => {
        const key = keyFrom(VALID_KEY_B64);
        const a = encryptSecret(TOKEN, key);
        const b = encryptSecret(TOKEN, key);
        expect(a.meta.iv).not.toBe(b.meta.iv);
        expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
        // ...yet both decrypt back to the same plaintext.
        expect(decryptSecret(a.ciphertext, a.meta, key)).toBe(TOKEN);
        expect(decryptSecret(b.ciphertext, b.meta, key)).toBe(TOKEN);
    });

    it('never leaves the plaintext token recoverable in the ciphertext blob', () => {
        const key = keyFrom(VALID_KEY_B64);
        const {ciphertext} = encryptSecret(TOKEN, key);
        // Decode the BLOB to strings before scanning — JSON.stringify would turn a
        // Buffer into an integer array and hide a plaintext leak (KB #133/#155).
        expect(ciphertext.toString('utf8')).not.toContain(TOKEN);
        expect(ciphertext.toString('latin1')).not.toContain(TOKEN);
        // Positive control: the scan CAN find the token when it is actually present,
        // so a passing negative assertion above is meaningful.
        expect(Buffer.from(TOKEN, 'utf8').toString('latin1')).toContain(TOKEN);
    });

    it('throws (not garbage) when decrypted with the wrong key', () => {
        const key = keyFrom(VALID_KEY_B64);
        const otherKey = keyFrom(randomBytes(SECRET_KEY_BYTES).toString('base64'));
        const {ciphertext, meta} = encryptSecret(TOKEN, key);
        expect(() => decryptSecret(ciphertext, meta, otherKey)).toThrow(SecretCryptoError);
    });

    it('throws when the auth_tag is flipped', () => {
        const key = keyFrom(VALID_KEY_B64);
        const {ciphertext, meta} = encryptSecret(TOKEN, key);
        const tag = Buffer.from(meta.auth_tag, 'base64');
        tag[0] ^= 0xff;
        const tampered: SecretMeta = {...meta, auth_tag: tag.toString('base64')};
        expect(() => decryptSecret(ciphertext, tampered, key)).toThrow(SecretCryptoError);
    });

    it('throws when the ciphertext is tampered with', () => {
        const key = keyFrom(VALID_KEY_B64);
        const {ciphertext, meta} = encryptSecret(TOKEN, key);
        const tampered = Buffer.from(ciphertext);
        tampered[0] ^= 0xff;
        expect(() => decryptSecret(tampered, meta, key)).toThrow(SecretCryptoError);
    });

    it('throws when the IV is tampered with', () => {
        const key = keyFrom(VALID_KEY_B64);
        const {ciphertext, meta} = encryptSecret(TOKEN, key);
        const iv = Buffer.from(meta.iv, 'base64');
        iv[0] ^= 0xff;
        const tampered: SecretMeta = {...meta, iv: iv.toString('base64')};
        expect(() => decryptSecret(ciphertext, tampered, key)).toThrow(SecretCryptoError);
    });

    it('throws the typed error (not a raw TypeError) when the stored auth_tag is a wrong length', () => {
        const key = keyFrom(VALID_KEY_B64);
        const {ciphertext, meta} = encryptSecret(TOKEN, key);
        // A corrupted row whose auth_tag decodes to fewer than 16 bytes must still
        // surface SecretCryptoError, since createDecipheriv/setAuthTag would
        // otherwise throw a raw TypeError that callers don't catch.
        const short: SecretMeta = {...meta, auth_tag: Buffer.from([1, 2, 3]).toString('base64')};
        expect(() => decryptSecret(ciphertext, short, key)).toThrow(SecretCryptoError);
    });

    it('throws the typed error when the stored IV is a wrong length', () => {
        const key = keyFrom(VALID_KEY_B64);
        const {ciphertext, meta} = encryptSecret(TOKEN, key);
        const emptyIv: SecretMeta = {...meta, iv: ''};
        expect(() => decryptSecret(ciphertext, emptyIv, key)).toThrow(SecretCryptoError);
    });

    it('rejects an unsupported algorithm in meta', () => {
        const key = keyFrom(VALID_KEY_B64);
        const {ciphertext, meta} = encryptSecret(TOKEN, key);
        const wrongAlgo: SecretMeta = {...meta, algo: 'AES-128-CBC'};
        expect(() => decryptSecret(ciphertext, wrongAlgo, key)).toThrow(SecretCryptoError);
    });

    it('rejects an empty secret', () => {
        const key = keyFrom(VALID_KEY_B64);
        expect(() => encryptSecret('', key)).toThrow(SecretCryptoError);
    });

    it('rejects a key of the wrong byte length (defense in depth)', () => {
        const badKey: ServerKey = {key: randomBytes(16), keyId: 'sk_bad'};
        expect(() => encryptSecret(TOKEN, badKey)).toThrow(SecretCryptoError);
        const good = encryptSecret(TOKEN, keyFrom(VALID_KEY_B64));
        expect(() => decryptSecret(good.ciphertext, good.meta, badKey)).toThrow(SecretCryptoError);
    });
});
