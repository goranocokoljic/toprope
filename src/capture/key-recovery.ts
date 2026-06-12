/**
 * Client-side key wrapping for capture-key recovery (Task 5.5 / #126).
 *
 * This is the CLIENT half of the recovery model, the sibling of `encryption.ts`:
 * it runs on the developer's machine, never on the server. When a developer picks
 * the `recovery_path` posture, their AES-256 capture key is WRAPPED here by a key
 * derived from a recovery secret only the developer holds, producing the opaque
 * `recovery_blob` the blind server stores. Recovery is the inverse: the server
 * hands back the blob, and the client unwraps it with the same recovery secret to
 * get the capture key back.
 *
 * The server never sees the recovery secret, the derived wrapping key, or the
 * unwrapped capture key — exactly mirroring how `encryption.ts` keeps the capture
 * key client-only. So the server can never decrypt captures, and for the
 * `no_recovery` posture there is no blob at all: key loss is unrecoverable, by
 * design.
 *
 * Construction:
 *  - scrypt derives a 256-bit wrapping key from (recovery secret, random salt).
 *    A KDF is essential because a human-chosen recovery secret is low-entropy;
 *    scrypt's memory-hardness raises the cost of brute-forcing it from a stolen
 *    blob.
 *  - AES-256-GCM wraps the capture key under that wrapping key. The GCM auth tag
 *    makes a wrong recovery secret (or a tampered blob) fail loudly rather than
 *    return a garbage "key", so a successful unwrap is also an integrity proof.
 */

import {createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual} from 'crypto';
import {CAPTURE_KEY_BYTES} from './encryption';

/** The wrapping algorithm; recorded in meta for forward-compat. */
export const RECOVERY_WRAP_ALGO = 'AES-256-GCM';

/** The KDF that turns the recovery secret into a wrapping key. */
export const RECOVERY_KDF = 'scrypt';

/** GCM standard IV length (96 bits). */
const IV_BYTES = 12;

/** Salt length for the KDF — 128 bits of randomness per wrap. */
const SALT_BYTES = 16;

/**
 * scrypt cost parameters. N must be a power of two; 2^15 is a sensible
 * interactive-but-hardened cost. `maxmem` is raised because Node's default
 * (32 MiB) is below what these parameters need (~128 * N * r bytes ≈ 256 MiB
 * headroom keeps it comfortable).
 */
const SCRYPT_PARAMS = {N: 1 << 15, r: 8, p: 1, maxmem: 256 * 1024 * 1024} as const;

/**
 * Public KDF + cipher parameters stored next to `recovery_blob`. Everything here
 * is needed to unwrap WITH the recovery secret and nothing here can unwrap
 * WITHOUT it — there is no secret and no derived key in this descriptor.
 */
export interface RecoveryMeta {
    algo: string;
    kdf: string;
    /** base64-encoded scrypt salt. */
    salt: string;
    /** base64-encoded initialization vector (unique per wrap). */
    iv: string;
    /** base64-encoded GCM authentication tag. */
    auth_tag: string;
}

/** The output of a wrap: exactly what the server persists for a recovery_path key. */
export interface WrappedKey {
    /** The opaque wrapped capture key — stored verbatim in `recovery_blob`. */
    recovery_blob: Buffer;
    meta: RecoveryMeta;
}

function assertCaptureKey(key: Buffer): void {
    if (!Buffer.isBuffer(key) || key.length !== CAPTURE_KEY_BYTES) {
        throw new Error(`Capture key must be a ${CAPTURE_KEY_BYTES}-byte Buffer (AES-256)`);
    }
}

function assertRecoverySecret(secret: string): void {
    // A recovery secret is the one thing standing between a stolen blob and the
    // capture key, so an empty/whitespace secret is refused outright rather than
    // silently producing a guessable wrap.
    if (typeof secret !== 'string' || secret.trim().length === 0) {
        throw new Error('Recovery secret must be a non-empty string');
    }
}

function deriveWrappingKey(secret: string, salt: Buffer): Buffer {
    return scryptSync(secret.normalize('NFKC'), salt, CAPTURE_KEY_BYTES, SCRYPT_PARAMS);
}

/**
 * Wrap a developer's capture key under a key derived from their recovery secret.
 * A fresh random salt and IV are drawn every call. Returns the opaque blob plus
 * the public meta the server stores beside it — never the secret or capture key.
 */
export function wrapCaptureKey(captureKey: Buffer, recoverySecret: string): WrappedKey {
    assertCaptureKey(captureKey);
    assertRecoverySecret(recoverySecret);
    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    const wrappingKey = deriveWrappingKey(recoverySecret, salt);
    const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv);
    const blob = Buffer.concat([cipher.update(captureKey), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
        recovery_blob: blob,
        meta: {
            algo: RECOVERY_WRAP_ALGO,
            kdf: RECOVERY_KDF,
            salt: salt.toString('base64'),
            iv: iv.toString('base64'),
            auth_tag: authTag.toString('base64'),
        },
    };
}

/**
 * Unwrap a capture key from its recovery blob using the developer's recovery
 * secret. A wrong secret (or any tampering with blob/meta) makes GCM verification
 * throw, so a successful return is also an integrity guarantee and proves the
 * caller held the real secret. The recovered Buffer is verified to be a valid
 * AES-256 key length before being handed back.
 */
export function unwrapCaptureKey(recoveryBlob: Buffer, meta: RecoveryMeta, recoverySecret: string): Buffer {
    assertRecoverySecret(recoverySecret);
    if (meta.algo !== RECOVERY_WRAP_ALGO) {
        throw new Error(`Unsupported recovery wrap algorithm: ${meta.algo}`);
    }
    if (meta.kdf !== RECOVERY_KDF) {
        throw new Error(`Unsupported recovery KDF: ${meta.kdf}`);
    }
    const salt = Buffer.from(meta.salt, 'base64');
    const iv = Buffer.from(meta.iv, 'base64');
    const wrappingKey = deriveWrappingKey(recoverySecret, salt);
    const decipher = createDecipheriv('aes-256-gcm', wrappingKey, iv);
    decipher.setAuthTag(Buffer.from(meta.auth_tag, 'base64'));
    const key = Buffer.concat([decipher.update(recoveryBlob), decipher.final()]);
    if (key.length !== CAPTURE_KEY_BYTES) {
        throw new Error('Recovered key is not a valid AES-256 key');
    }
    return key;
}

/**
 * Constant-time equality for two keys — a test/verification helper so a recovery
 * round-trip can prove "the unwrapped key equals the original" without leaking
 * timing on the comparison.
 */
export function keysEqual(a: Buffer, b: Buffer): boolean {
    return a.length === b.length && timingSafeEqual(a, b);
}
