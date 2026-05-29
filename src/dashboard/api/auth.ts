import crypto from 'crypto';
import type {FastifyRequest, FastifyReply, FastifyInstance} from 'fastify';
import {matchesPathPrefix} from '../paths';

/**
 * Paths reachable without the admin password.
 * - /health: liveness probe.
 * - /dashboard: the static SPA shell (HTML/JS/CSS/fonts). It carries no data;
 *   the dashboard's data still comes from the auth-gated /api/* endpoints. The
 *   shell must load unauthenticated so a future login page (Task 2.2) can be
 *   served from it. Per-user session auth replaces this in Task 2.2 (#37).
 */
function isPublicPath(url: string): boolean {
    return matchesPathPrefix(url, '/health') || matchesPathPrefix(url, '/dashboard');
}

export function registerAuthMiddleware(app: FastifyInstance, adminPassword: string | undefined): void {
    if (!adminPassword) {
        app.log.warn('No dashboard.auth.admin_password configured — all API endpoints are publicly accessible');
        return;
    }

    const expectedBuf = Buffer.from(adminPassword);

    app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
        if (isPublicPath(request.url)) {
            return;
        }

        const auth = request.headers.authorization;
        if (!auth) {
            return reply.status(401).send({error: 'Unauthorized', message: 'Authorization header required'});
        }

        const [scheme, credentials] = auth.split(' ');
        if (scheme?.toLowerCase() !== 'basic' || !credentials) {
            return reply.status(401).send({error: 'Unauthorized', message: 'Basic authentication required'});
        }

        const decoded = Buffer.from(credentials, 'base64').toString('utf-8');
        const colonIdx = decoded.indexOf(':');
        if (colonIdx < 0) {
            return reply.status(401).send({error: 'Unauthorized', message: 'Basic authentication required'});
        }
        const password = decoded.slice(colonIdx + 1);

        const candidateBuf = Buffer.from(password);
        const lengthsMatch = candidateBuf.length === expectedBuf.length;
        const compareBuf = lengthsMatch ? candidateBuf : Buffer.alloc(expectedBuf.length);
        const equal = crypto.timingSafeEqual(compareBuf, expectedBuf) && lengthsMatch;

        if (!equal) {
            return reply.status(401).send({error: 'Unauthorized', message: 'Invalid credentials'});
        }
    });
}
