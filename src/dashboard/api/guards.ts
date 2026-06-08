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

/**
 * Resolve the session's developer id for a /api/me/* route, or send the
 * appropriate error and return null. 401 when unauthenticated (defence-in-depth
 * behind the middleware), 404 when the account has no linked developer (the
 * linked developer was removed → FK SET NULL) — a 404 rather than a leak of
 * anyone's data.
 *
 * This is the single home for the "developer id comes ONLY from the session,
 * never from a request param/body" rule, shared by every self-service route so
 * the privacy-critical logic lives in exactly one place.
 */
export function requireDeveloperId(request: FastifyRequest, reply: FastifyReply): string | null {
    if (!request.authUser) {
        reply.status(401).send({error: 'Unauthorized', message: 'Authentication required'});
        return null;
    }
    const developerId = request.authUser.developerId;
    if (!developerId) {
        reply
            .status(404)
            .send({error: 'Not Found', message: 'No developer profile linked to this account'});
        return null;
    }
    return developerId;
}
