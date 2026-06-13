/**
 * Shared transient session-decrypt for deep-coaching consumers (Task 5.8 / #129).
 *
 * Both the retrospective generator (Task 5.7) and the showcase promote flow
 * (Task 5.8) need the SAME operation: take one of a developer's OWN captured
 * sessions — the server's blind ciphertext — decrypt every row in memory with the
 * key the developer supplies for that one call, and concatenate the plaintext in
 * chronological order. This module is the single home for that operation so the
 * privacy-critical "captures are blind ciphertext, decrypt in memory, never
 * persist or log" invariant is enforced in exactly one place rather than cloned
 * per consumer.
 *
 * The returned plaintext is TRANSIENT: the caller analyses/redacts it and lets it
 * fall out of scope; it is never persisted or logged here. A wrong key (or any
 * tampering) makes GCM verification throw, surfaced as a typed `decrypt_failed`
 * with NO underlying crypto detail or bytes — a bad key and a tampered blob are
 * intentionally indistinguishable. An empty session is a typed `no_captures`.
 *
 * Each consumer wraps these typed failures into its own feature error
 * (RetrospectiveError / ShowcaseError) so route → HTTP mapping stays per-feature,
 * while the crypto handling lives here once.
 */

import type Database from 'better-sqlite3';
import {decryptCapture, type EncryptionMeta} from './encryption';
import {listSessionCapturesForDeveloper} from './store';

/** Stable codes for the two ways a transient session-decrypt can fail. */
export type SessionDecryptErrorCode = 'no_captures' | 'decrypt_failed';

/** A typed failure from the shared decrypt; consumers map it onto their own error type. */
export class SessionDecryptError extends Error {
    constructor(
        readonly code: SessionDecryptErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'SessionDecryptError';
    }
}

/** The transient result of decrypting a session: joined plaintext + the row count it was built from. */
export interface DecryptedSession {
    /** The decrypted prompts/responses, concatenated chronologically. Transient: never persisted/logged. */
    plaintext: string;
    /** How many capture rows were decrypted — provenance the caller may record (counts only). */
    captureCount: number;
}

/** Coerce a stored public meta object into the EncryptionMeta decryptCapture needs. */
function toEncryptionMeta(meta: Record<string, unknown>): EncryptionMeta {
    const {algo, iv, auth_tag, key_id} = meta;
    if (
        typeof algo !== 'string' ||
        typeof iv !== 'string' ||
        typeof auth_tag !== 'string' ||
        typeof key_id !== 'string'
    ) {
        throw new SessionDecryptError('decrypt_failed', 'Capture encryption metadata is malformed');
    }
    return {algo, iv, auth_tag, key_id};
}

/**
 * Decrypt every capture in one of `developerId`'s OWN sessions and concatenate the
 * plaintext in chronological order. Owner-scoped via `listSessionCapturesForDeveloper`
 * (which filters on developer_id), so it can never reach another developer's session.
 *
 * Ordering note: `captured_at` is CLIENT-supplied (it rides the capture payload and
 * is never server-stamped), so the chronological reconstruction is best-effort —
 * clock skew or ties fall back to `created_at` (server insert order).
 */
export function decryptSessionToText(
    db: Database.Database,
    developerId: string,
    sessionId: string,
    key: Buffer,
): DecryptedSession {
    const captures = listSessionCapturesForDeveloper(db, developerId, sessionId);
    if (captures.length === 0) {
        throw new SessionDecryptError('no_captures', 'No captured session found');
    }
    const parts: string[] = [];
    for (const capture of captures) {
        const meta = toEncryptionMeta(capture.encryptionMeta);
        const ciphertext = Buffer.from(capture.ciphertext, 'base64');
        try {
            parts.push(decryptCapture(ciphertext, meta, key));
        } catch {
            // Never include the underlying crypto error or any bytes.
            throw new SessionDecryptError('decrypt_failed', 'Could not decrypt the session with the provided key');
        }
    }
    return {plaintext: parts.join('\n'), captureCount: captures.length};
}
