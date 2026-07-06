/**
 * Server-side authenticated encryption for git-provider tokens (GC1.2 / #194).
 *
 * This is the SERVER side of the secret model, and is deliberately NOT
 * `capture/encryption.ts`: capture is the *blind-server* model where the key
 * lives on the developer's client and the server can never read the payload.
 * Git-provider tokens are the opposite — the server must decrypt them to call
 * the provider APIs, so the key is held BY THE SERVER (env `TOPROPE_SECRET_KEY`).
 * Overloading the client module would blur those two trust boundaries, so this
 * is a separate module that shares only the AES-256-GCM primitive.
 *
 * AES-256-GCM gives confidentiality AND integrity: the auth tag makes a tampered
 * ciphertext (or a wrong key) fail decryption loudly rather than return garbage.
 * A fresh random 96-bit IV per call is the GCM contract — reusing an IV under the
 * same key is catastrophic, so {@link encryptSecret} always generates its own and
 * an IV is never caller-supplied.
 *
 * Fail-closed key loading is the security core: {@link loadServerKey} returns a
 * TYPED result, and when the env key is missing/short/invalid it returns a
 * `not_configured`/`invalid` status rather than any key. Callers must treat that
 * as a hard refusal to store a token — there is no plaintext-at-rest fallback.
 */

import {createCipheriv, createDecipheriv, createHash, randomBytes} from 'crypto';

/** The only algorithm this layer emits/accepts. Recorded in meta for forward-compat. */
export const SECRET_ALGO = 'AES-256-GCM';

/** AES-256 key length in bytes. The server key MUST decode to exactly this long. */
export const SECRET_KEY_BYTES = 32;

/** GCM standard IV length (96 bits) — the recommended size for AES-GCM. */
const IV_BYTES = 12;

/** The environment variable that holds the base64-encoded server master key. */
export const SECRET_KEY_ENV = 'TOPROPE_SECRET_KEY';

/**
 * Public crypto parameters stored next to the ciphertext (the `token_meta`
 * column). Everything here is needed to decrypt WITH the server key, and nothing
 * here is the key itself: `key_id` is a non-secret fingerprint identifying WHICH
 * key encrypted this, so multiple keys can coexist (rotation-ready — rotation
 * itself is out of scope here).
 */
export interface SecretMeta {
    algo: string;
    /** base64-encoded initialization vector (unique per ciphertext). */
    iv: string;
    /** base64-encoded GCM authentication tag. */
    auth_tag: string;
    /** Non-secret fingerprint of the key that encrypted this — NOT the key itself. */
    key_id: string;
}

/** The output of a server-side encryption: exactly what the store persists. */
export interface EncryptedSecret {
    /** The opaque encrypted bytes — stored verbatim in the token_ciphertext BLOB. */
    ciphertext: Buffer;
    meta: SecretMeta;
}

/**
 * A loaded, validated server key: the 32-byte material plus its stable non-secret
 * fingerprint. Produced only by {@link loadServerKey} on success; passed to
 * {@link encryptSecret}/{@link decryptSecret}.
 */
export interface ServerKey {
    key: Buffer;
    /** Stable, non-secret fingerprint of the key material, recorded as `key_id`. */
    keyId: string;
}

/** Why {@link loadServerKey} refused to produce a key — both are fail-closed. */
export type ServerKeyFailure = 'not_configured' | 'invalid';

/**
 * The typed result of loading the server key. On failure the caller gets a
 * discriminated `not_configured`/`invalid` status and MUST fail closed — there is
 * intentionally no key and no plaintext fallback.
 */
export type ServerKeyResult =
    | {ok: true; key: ServerKey}
    | {ok: false; status: ServerKeyFailure; message: string};

/** A wrong key, tampered ciphertext/meta, or unsupported algorithm on decrypt. */
export class SecretCryptoError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SecretCryptoError';
    }
}

/**
 * Derive a stable, non-secret fingerprint of the key material. Using a hash (not
 * the key) means `key_id` can sit in cleartext meta and still identify which key
 * was used, without ever exposing key bytes. The truncated SHA-256 is ample for
 * distinguishing a handful of coexisting keys.
 */
function fingerprintKey(key: Buffer): string {
    return `sk_${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

/**
 * Load the server master key from {@link SECRET_KEY_ENV}, fail-closed.
 *
 * - Unset/blank → `{ok: false, status: 'not_configured'}`.
 * - Present but not valid base64, or not exactly {@link SECRET_KEY_BYTES} bytes
 *   once decoded → `{ok: false, status: 'invalid'}`.
 * - Otherwise → `{ok: true, key}` with a derived `keyId`.
 *
 * Never throws for a missing/bad key and never returns a partial/fallback key:
 * callers branch on `ok` and refuse the write when it is false.
 */
export function loadServerKey(env: NodeJS.ProcessEnv = process.env): ServerKeyResult {
    const raw = env[SECRET_KEY_ENV];
    if (raw === undefined || raw.trim() === '') {
        return {
            ok: false,
            status: 'not_configured',
            message: `${SECRET_KEY_ENV} is not set — configure a base64-encoded ${SECRET_KEY_BYTES}-byte key to store provider tokens.`,
        };
    }

    // Base64 must round-trip exactly: Buffer.from(...,'base64') silently drops
    // invalid characters, so re-encoding and comparing catches non-base64 input
    // rather than accepting a truncated key.
    const trimmed = raw.trim();
    const decoded = Buffer.from(trimmed, 'base64');
    if (decoded.toString('base64') !== normalizeBase64(trimmed)) {
        return {
            ok: false,
            status: 'invalid',
            message: `${SECRET_KEY_ENV} is not valid base64.`,
        };
    }
    if (decoded.length !== SECRET_KEY_BYTES) {
        return {
            ok: false,
            status: 'invalid',
            message: `${SECRET_KEY_ENV} must decode to exactly ${SECRET_KEY_BYTES} bytes (got ${decoded.length}).`,
        };
    }

    return {ok: true, key: {key: decoded, keyId: fingerprintKey(decoded)}};
}

// Canonicalize a base64 string for the round-trip equality check: strip
// whitespace and normalize padding so a valid-but-unpadded key still compares
// equal to Buffer's always-padded re-encoding.
function normalizeBase64(value: string): string {
    const compact = value.replace(/\s+/g, '');
    const pad = compact.length % 4;
    return pad === 0 ? compact : compact + '='.repeat(4 - pad);
}

function assertKeyLength(key: Buffer): void {
    if (!Buffer.isBuffer(key) || key.length !== SECRET_KEY_BYTES) {
        throw new SecretCryptoError(`Server key must be a ${SECRET_KEY_BYTES}-byte Buffer (AES-256)`);
    }
}

/**
 * Encrypt a provider token with the server key. A new random IV is drawn for
 * every call (never caller-supplied) to honor the GCM uniqueness contract. The
 * returned `meta.key_id` records which key was used, so a later rotation can tell
 * which ciphertexts belong to which key. Returns the ciphertext blob plus the
 * meta the store persists alongside it.
 */
export function encryptSecret(plaintext: string, serverKey: ServerKey): EncryptedSecret {
    assertKeyLength(serverKey.key);
    // Reject an empty token in the reusable core, not just at the HTTP edge: an
    // empty secret is meaningless and would otherwise produce a 0-byte ciphertext.
    if (plaintext.length === 0) {
        throw new SecretCryptoError('Cannot encrypt an empty secret');
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', serverKey.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
        ciphertext,
        meta: {
            algo: SECRET_ALGO,
            iv: iv.toString('base64'),
            auth_tag: authTag.toString('base64'),
            key_id: serverKey.keyId,
        },
    };
}

/**
 * Decrypt a stored provider token with the server key. A wrong key or any
 * tampering with the ciphertext or meta (iv/auth_tag) makes GCM verification
 * throw {@link SecretCryptoError}, so a successful return is also an integrity
 * guarantee — never garbage. An unsupported `meta.algo` is rejected up front.
 */
export function decryptSecret(ciphertext: Buffer, meta: SecretMeta, serverKey: ServerKey): string {
    assertKeyLength(serverKey.key);
    if (meta.algo !== SECRET_ALGO) {
        throw new SecretCryptoError(`Unsupported secret algorithm: ${meta.algo}`);
    }
    const iv = Buffer.from(meta.iv, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', serverKey.key, iv);
    decipher.setAuthTag(Buffer.from(meta.auth_tag, 'base64'));
    try {
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
        // GCM auth failure (wrong key / tampered ciphertext / tampered tag) surfaces
        // as a generic error — re-throw as our typed error so callers can catch it.
        throw new SecretCryptoError('Secret decryption failed: wrong key or tampered ciphertext');
    }
}

/**
 * Generate a fresh AES-256 server key, base64-encoded for {@link SECRET_KEY_ENV}.
 * A setup/reference helper (e.g. for `doctor` or docs) so operators can mint a
 * valid key without hand-rolling `openssl`.
 */
export function generateServerKeyBase64(): string {
    return randomBytes(SECRET_KEY_BYTES).toString('base64');
}
