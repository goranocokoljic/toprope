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

/**
 * Paths reachable without a session:
 * - /health: liveness probe.
 * - /dashboard: the static SPA shell (login page is served from it).
 * - /api/auth/login: the entry point to obtain a session.
 */
function isPublicPath(url: string): boolean {
    return (
        matchesPathPrefix(url, '/health') ||
        matchesPathPrefix(url, '/dashboard') ||
        url === '/api/auth/login' ||
        url.startsWith('/api/auth/login?')
    );
}

// Developer-role sessions may only reach their own self-service area and the
// shared auth endpoints. Everything else under /api is admin-only.
function isDeveloperAllowedPath(url: string): boolean {
    return matchesPathPrefix(url, '/api/me') || matchesPathPrefix(url, '/api/auth');
}

// Until a user changes a forced-reset password, only these endpoints work.
function isPasswordChangeAllowedPath(url: string): boolean {
    return (
        url === '/api/auth/change-password' ||
        url === '/api/auth/logout' ||
        url === '/api/auth/me'
    );
}

function unauthorized(reply: FastifyReply, message: string): void {
    reply.status(401).send({error: 'Unauthorized', message});
}

export function registerSessionAuth(app: FastifyInstance, db: Database.Database): void {
    app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
        const url = request.url;
        if (isPublicPath(url)) {
            return;
        }

        // Only API routes are guarded; anything else (unknown paths) falls
        // through to the normal 404 handling.
        if (!matchesPathPrefix(url, '/api')) {
            return;
        }

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
        if (user.must_change_password && !isPasswordChangeAllowedPath(url)) {
            return reply.status(403).send({
                error: 'Forbidden',
                code: 'password_change_required',
                message: 'Password change required before continuing',
            });
        }

        // Role enforcement: developers are confined to their own area.
        if (user.role === 'developer' && !isDeveloperAllowedPath(url)) {
            return reply.status(403).send({
                error: 'Forbidden',
                message: 'Admin privileges required',
            });
        }
    });
}

/**
 * preHandler guard for endpoints that must reject developer-role sessions even
 * if they were somehow reachable. Defence-in-depth alongside the central rule.
 */
export function requireAdmin(request: FastifyRequest, reply: FastifyReply): void {
    if (!request.authUser) {
        reply.status(401).send({error: 'Unauthorized', message: 'Authentication required'});
        return;
    }
    if (request.authUser.role !== 'admin') {
        reply.status(403).send({error: 'Forbidden', message: 'Admin privileges required'});
    }
}
