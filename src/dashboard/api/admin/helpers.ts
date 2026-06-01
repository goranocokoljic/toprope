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

/** Narrow an unknown request body to a plain key→value object, or null. */
export function asObject(body: unknown): Record<string, unknown> | null {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return null;
    }
    return body as Record<string, unknown>;
}
