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
