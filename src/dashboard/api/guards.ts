import type {FastifyReply, FastifyRequest} from 'fastify';

/**
 * Admin-role guard for the manager-facing API (Task 2.3 / #38).
 *
 * The PRIMARY enforcement is the session middleware (src/auth/middleware.ts),
 * which confines the only non-admin role (`developer`) to /api/me and /api/auth
 * — so any request reaching a manager endpoint is already an admin. These
 * helpers are deliberate defense-in-depth, mirroring the pattern in settings.ts:
 * a backstop if the middleware allowlist ever changes, and the seam where a
 * future manager role would be authorized.
 */
export function isAdmin(request: FastifyRequest): boolean {
    return request.authUser?.role === 'admin';
}

export function forbidden(reply: FastifyReply, message = 'Admin privileges required'): void {
    reply.status(403).send({error: 'Forbidden', message});
}
