import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import type Database from 'better-sqlite3';
import {matchesPathPrefix} from '../dashboard/paths';
import {SESSION_COOKIE, parseCookies} from './cookies';
import {getValidSession} from './sessions';
import {getUserById} from './users';
import type {AuthContext} from './types';

declare module 'fastify' {
    interface FastifyRequest {
        // Set by the session-auth onRequest hook once a request is authenticated.
        // Undefined on public routes (login, health, dashboard shell).
        authUser?: AuthContext;
    }
}

// Strip the query string so the exact-match predicates below (`=== '/api/auth/login'`,
// the change-password allowlist) compare against the pathname cleanly. The
// `matchesPathPrefix` checks already tolerate a trailing `?...`.
function pathname(url: string): string {
    const q = url.indexOf('?');
    return q < 0 ? url : url.slice(0, q);
}

/**
 * Paths reachable without a session:
 * - /health: liveness probe.
 * - /dashboard: the static SPA shell (login page is served from it).
 * - /api/auth/login: the entry point to obtain a session.
 */
function isPublicPath(path: string): boolean {
    return (
        matchesPathPrefix(path, '/health') ||
        matchesPathPrefix(path, '/dashboard') ||
        path === '/api/auth/login'
    );
}

// Developer-role sessions may only reach their own self-service area and the
// shared auth endpoints. Everything else under /api is admin-only.
function isDeveloperAllowedPath(path: string): boolean {
    return matchesPathPrefix(path, '/api/me') || matchesPathPrefix(path, '/api/auth');
}

// Until a user changes a forced-reset password, only these endpoints work.
function isPasswordChangeAllowedPath(path: string): boolean {
    return (
        path === '/api/auth/change-password' ||
        path === '/api/auth/logout' ||
        path === '/api/auth/me'
    );
}

function unauthorized(reply: FastifyReply, message: string): void {
    reply.status(401).send({error: 'Unauthorized', message});
}

export function registerSessionAuth(app: FastifyInstance, db: Database.Database): void {
    app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
        const path = pathname(request.url);
        if (isPublicPath(path)) {
            return;
        }

        // Only API routes are guarded; anything else (unknown paths) falls
        // through to the normal 404 handling.
        if (!matchesPathPrefix(path, '/api')) {
            return;
        }

        // The browser SPA authenticates via the HttpOnly session cookie. We also
        // accept the same opaque token as an `Authorization: Bearer` header so
        // it can serve as an API token for programmatic/CLI clients.
        const cookies = parseCookies(request.headers.cookie);
        let token = cookies[SESSION_COOKIE];
        if (!token) {
            const auth = request.headers.authorization;
            if (auth) {
                const [scheme, value] = auth.split(' ');
                if (scheme?.toLowerCase() === 'bearer' && value) {
                    token = value;
                }
            }
        }

        if (!token) {
            return unauthorized(reply, 'Authentication required');
        }

        const session = getValidSession(db, token);
        if (!session) {
            return unauthorized(reply, 'Invalid or expired session');
        }

        const user = getUserById(db, session.user_id);
        if (!user || user.deactivated_at) {
            return unauthorized(reply, 'Invalid or expired session');
        }

        request.authUser = {
            userId: user.id,
            email: user.email,
            role: user.role,
            developerId: user.developer_id,
            mustChangePassword: user.must_change_password,
            sessionId: session.id,
        };

        // First-login: a forced password change blocks every action until done.
        if (user.must_change_password && !isPasswordChangeAllowedPath(path)) {
            return reply.status(403).send({
                error: 'Forbidden',
                code: 'password_change_required',
                message: 'Password change required before continuing',
            });
        }

        // Role enforcement: developers are confined to their own area.
        if (user.role === 'developer' && !isDeveloperAllowedPath(path)) {
            return reply.status(403).send({
                error: 'Forbidden',
                message: 'Admin privileges required',
            });
        }
    });
}
