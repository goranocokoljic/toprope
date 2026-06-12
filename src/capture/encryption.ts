/**
 * Client-side authenticated encryption for prompt capture (Task 5.4 / #125).
 *
 * This module is the CLIENT side of the capture pipeline — it runs inside the
 * local agent or the editor extension, on the developer's machine, NEVER on the
 * server. It turns a plaintext captured session into the exact pair the blind
 * server stores: an opaque `ciphertext` blob and a public `encryption_meta`
 * descriptor (algorithm, IV, GCM auth tag, key-id reference). The developer's
 * key is required to encrypt and to decrypt; it is the one thing that NEVER
 * leaves the client and is never part of the meta, so the server can store the
 * payload yet remain unable to read it.
 *
 * AES-256-GCM gives confidentiality AND integrity: the auth tag makes a tampered
 * ciphertext (or a wrong key) fail decryption loudly rather than return garbage.
 * A fresh random 96-bit IV per call is the GCM contract — reusing an IV under the
 * same key is catastrophic, so `encrypt` always generates its own.
 */

import {createCipheriv, createDecipheriv, randomBytes} from 'crypto';

/** The only algorithm this layer emits/accepts. Recorded in meta for forward-compat. */
export const CAPTURE_ALGO = 'AES-256-GCM';

/** AES-256 key length in bytes. A developer key MUST be exactly this long. */
export const CAPTURE_KEY_BYTES = 32;

/** GCM standard IV length (96 bits) — the recommended size for AES-GCM. */
const IV_BYTES = 12;

/**
 * Public crypto parameters stored next to the ciphertext. Everything here is
 * needed to decrypt WITH the developer's key, and nothing here can decrypt
 * WITHOUT it: `key_id` is a reference to which key was used (managed in Task
 * 5.5), never the key material.
 */
export interface EncryptionMeta {
    algo: string;
    /** base64-encoded initialization vector (unique per ciphertext). */
    iv: string;
    /** base64-encoded GCM authentication tag. */
    auth_tag: string;
    /** Reference to the developer key that encrypted this — NOT the key itself. */
    key_id: string;
}

/** The output of a client-side encryption: exactly what the server persists. */
export interface EncryptedPayload {
    /** The opaque encrypted bytes — stored verbatim in the BLOB column. */
    ciphertext: Buffer;
    meta: EncryptionMeta;
}

function assertKey(key: Buffer): void {
    if (!Buffer.isBuffer(key) || key.length !== CAPTURE_KEY_BYTES) {
        throw new Error(`Developer key must be a ${CAPTURE_KEY_BYTES}-byte Buffer (AES-256)`);
    }
}

/**
 * Encrypt a plaintext capture with the developer's key. A new random IV is drawn
 * for every call (never caller-supplied) to honor the GCM uniqueness contract.
 * Returns the ciphertext blob plus the meta the server stores alongside it.
 */
export function encryptCapture(plaintext: string, key: Buffer, keyId: string): EncryptedPayload {
    assertKey(key);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
        ciphertext,
        meta: {
            algo: CAPTURE_ALGO,
            iv: iv.toString('base64'),
            auth_tag: authTag.toString('base64'),
            key_id: keyId,
        },
    };
}

/**
 * Decrypt a stored capture with the developer's key. This is a CLIENT operation
 * too — the server never calls it, having no key. A wrong key or any tampering
 * with ciphertext/meta makes GCM verification throw, so a successful return is
 * also an integrity guarantee.
 */
export function decryptCapture(ciphertext: Buffer, meta: EncryptionMeta, key: Buffer): string {
    assertKey(key);
    if (meta.algo !== CAPTURE_ALGO) {
        throw new Error(`Unsupported capture algorithm: ${meta.algo}`);
    }
    const iv = Buffer.from(meta.iv, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(Buffer.from(meta.auth_tag, 'base64'));
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
}

/** Generate a fresh AES-256 developer key (test/reference helper for Task 5.5 to supersede). */
export function generateDeveloperKey(): Buffer {
    return randomBytes(CAPTURE_KEY_BYTES);
}
