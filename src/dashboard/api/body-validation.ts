/**
 * Shared request-body validation primitives for the /api/me capture surfaces
 * (Task 5.5 / #126).
 *
 * The capture-ingestion route (Task 5.4) and the capture-key route (Task 5.5)
 * both accept an untrusted JSON body carrying base64 ciphertext/blobs and a
 * small public "meta" object that must be allowlisted to a fixed set of
 * non-empty string fields and bounded in size. These helpers are the one home
 * for that shared shape so the two routes can't drift apart in how they reject
 * malformed input.
 */

import type {FastifyReply} from 'fastify';
import {CAPTURE_KEY_BYTES} from '../../capture/encryption';

/** Send a 400 with `message` and return undefined (so callers can `return badRequest(...)`). */
export function badRequest(reply: FastifyReply, message: string): undefined {
    reply.status(400).send({error: 'Bad Request', message});
    return undefined;
}

/** Narrow an unknown to a plain object (not an array), or null. */
export function asObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

/** Strict base64 (no interior whitespace / non-base64 chars). Pair with a `length % 4 === 0` check. */
export const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Validate a base64-encoded developer key and decode it to exactly the AES-256
 * key length, or send a 400 and return null. The one home for "decode the
 * transient capture key off a request body", shared by every /api/me surface that
 * accepts the developer's key for an in-memory decrypt (capture key recovery,
 * retrospectives, showcase promote) so they reject malformed keys identically.
 */
export function decodeCaptureKey(raw: unknown, reply: FastifyReply): Buffer | null {
    if (typeof raw !== 'string' || raw.length === 0 || !BASE64_RE.test(raw) || raw.length % 4 !== 0) {
        badRequest(reply, 'key must be a non-empty base64 string');
        return null;
    }
    const key = Buffer.from(raw, 'base64');
    if (key.length !== CAPTURE_KEY_BYTES) {
        badRequest(reply, `key must decode to exactly ${CAPTURE_KEY_BYTES} bytes (AES-256)`);
        return null;
    }
    return key;
}

/**
 * Reject any body key outside `allowed`: sends a 400 and returns false on the
 * first unknown key, true when every key is allowlisted. The one home for the
 * allowlist sweep shared by the showcase routes (publish, governance remove) so
 * they reject unexpected fields with one identical message.
 */
export function rejectUnknownKeys(
    obj: Record<string, unknown>,
    allowed: readonly string[],
    reply: FastifyReply,
): boolean {
    for (const key of Object.keys(obj)) {
        if (!allowed.includes(key)) {
            badRequest(reply, `Field '${key}' is not accepted; this route accepts exactly ${allowed.join(', ')}`);
            return false;
        }
    }
    return true;
}

/**
 * A MANDATORY, non-blank, bounded string field: its trimmed value, or 400 (returns
 * null). Trims because these feed titles/notes where surrounding whitespace is noise.
 * Companion to {@link optionalString}, colocated here so an /api/me route reaching for
 * "required bounded string" finds one home rather than hand-rolling a copy.
 */
export function requireString(value: unknown, field: string, maxLen: number, reply: FastifyReply): string | null {
    if (typeof value !== 'string' || value.trim().length === 0) {
        badRequest(reply, `${field} is required`);
        return null;
    }
    const trimmed = value.trim();
    if (trimmed.length > maxLen) {
        badRequest(reply, `${field} exceeds the ${maxLen}-character limit`);
        return null;
    }
    return trimmed;
}

/**
 * An OPTIONAL bounded string field: absent/null/blank → null; a non-empty string
 * within `maxLen` → its trimmed value; anything else → 400 (returns false). The single
 * home for this shape, shared by every /api/me authoring route (practices, the Phase 5
 * showcase publish form, and the 6.3 showcase authoring surface) so they can't drift.
 */
export function optionalString(value: unknown, field: string, maxLen: number, reply: FastifyReply): string | null | false {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'string') {
        badRequest(reply, `${field} must be a string`);
        return false;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return null;
    }
    if (trimmed.length > maxLen) {
        badRequest(reply, `${field} exceeds the ${maxLen}-character limit`);
        return false;
    }
    return trimmed;
}

/** Read an optional querystring filter: a non-empty trimmed string, or undefined when absent/blank. */
export function optionalQueryString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Validate a public "meta" object: exactly the allowed keys (no unknown/nested
 * field can smuggle in a secret), each a non-empty string, and the serialized
 * size bounded. Sends a 400 and returns false on any failure; returns true when
 * the meta is well-formed. `metaField` names the field in error messages so each
 * route reads naturally (e.g. `encryption_meta` vs `recovery_meta`).
 */
export function validateMetaAllowlist(
    meta: Record<string, unknown>,
    allowedKeys: readonly string[],
    metaField: string,
    maxBytes: number,
    reply: FastifyReply,
): boolean {
    for (const k of Object.keys(meta)) {
        if (!allowedKeys.includes(k)) {
            badRequest(reply, `${metaField} has an unexpected field '${k}'; only ${allowedKeys.join(', ')} are allowed`);
            return false;
        }
    }
    for (const field of allowedKeys) {
        if (typeof meta[field] !== 'string' || (meta[field] as string).length === 0) {
            badRequest(reply, `${metaField}.${field} is required`);
            return false;
        }
    }
    if (JSON.stringify(meta).length > maxBytes) {
        badRequest(reply, `${metaField} exceeds the ${maxBytes}-byte limit`);
        return false;
    }
    return true;
}
