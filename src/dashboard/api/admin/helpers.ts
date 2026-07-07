import type {FastifyReply, FastifyRequest} from 'fastify';

/**
 * Shared helpers for the admin API (Task 2.13 / #48).
 *
 * Permission model mirrors settings.ts and guards.ts: the PRIMARY gate is the
 * session middleware, which confines the only non-admin role (`developer`) to
 * /api/me and /api/auth — so any request reaching /api/admin/* is already an
 * admin. The per-route isAdmin checks are deliberate defense-in-depth: a
 * backstop if the middleware allowlist ever changes, and the seam where a future
 * manager role would be authorized.
 */
export function isAdmin(request: FastifyRequest): boolean {
    return request.authUser?.role === 'admin';
}

export function forbidden(reply: FastifyReply, message = 'Admin privileges required'): void {
    reply.status(403).send({error: 'Forbidden', message});
}

export function badRequest(reply: FastifyReply, message: string): void {
    reply.status(400).send({error: 'Bad Request', message});
}

export function notFound(reply: FastifyReply, message: string): void {
    reply.status(404).send({error: 'Not Found', message});
}

export function conflict(reply: FastifyReply, message: string): void {
    reply.status(409).send({error: 'Conflict', message});
}

/**
 * A server-side misconfiguration the client cannot fix by changing its request —
 * e.g. the git-provider secret key is unset (fail-closed). Deliberately 503, NOT
 * 500: it is a known, recoverable operator condition with a clear remediation
 * message, not an unhandled crash.
 */
export function serviceUnavailable(reply: FastifyReply, message: string): void {
    reply.status(503).send({error: 'Service Unavailable', message});
}

/** Narrow an unknown request body to a plain key→value object, or null. */
export function asObject(body: unknown): Record<string, unknown> | null {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return null;
    }
    return body as Record<string, unknown>;
}

/**
 * Shared sentinel returned by validation helpers that have ALREADY sent an
 * error response (via badRequest/conflict). The caller checks for it and bails
 * without sending a second reply. One sentinel across all admin routes so the
 * "did a helper already reply?" check is uniform.
 */
export const FIELD_INVALID = Symbol('field-invalid');

/**
 * Coerce an optional string field from a request body:
 *   undefined → undefined (omit), null or blank → null (clear),
 *   non-string → 400 + FIELD_INVALID, else the trimmed value.
 */
export function optionalStringField(
    value: unknown,
    field: string,
    reply: FastifyReply,
): string | null | undefined | typeof FIELD_INVALID {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'string') {
        badRequest(reply, `${field} must be a string`);
        return FIELD_INVALID;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}
