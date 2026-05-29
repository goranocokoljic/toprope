import fs from 'fs';
import path from 'path';
import fastifyStatic from '@fastify/static';
import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import {matchesPathPrefix} from './paths';

const DASHBOARD_PREFIX = '/dashboard';

/**
 * Candidate locations for the built frontend, in priority order. This module is
 * src/dashboard/static.ts in dev (tsx, __dirname = src/dashboard) and
 * dist/dashboard/static.js in prod (__dirname = dist/dashboard). `frontend/dist`
 * relative to __dirname resolves the Vite output in both: in dev it is
 * src/dashboard/frontend/dist; in prod the build copies that output to
 * dist/dashboard/frontend/dist so the dist/ tree is self-contained (the Docker
 * runtime ships only dist/). The second candidate is a fallback for running the
 * compiled backend against an un-copied source tree.
 */
function frontendDistCandidates(): string[] {
    return [
        path.resolve(__dirname, 'frontend/dist'), // dev + self-contained prod
        path.resolve(__dirname, '../../src/dashboard/frontend/dist'), // fallback: source tree
    ];
}

function resolveFrontendDist(override?: string): string | undefined {
    const candidates = override ? [override] : frontendDistCandidates();
    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, 'index.html'))) {
            return candidate;
        }
    }
    return undefined;
}

// A document navigation (deep link) the SPA should handle vs. a missing asset.
// Browsers send `Accept: text/html` for navigations but not for script/style/
// fetch requests, so only HTML-accepting GET/HEAD requests fall back to the
// SPA; a missing /dashboard/assets/*.js returns a real 404 instead of HTML
// (which would otherwise surface as a confusing MIME-type error in the browser).
function isSpaNavigation(request: FastifyRequest): boolean {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return false;
    }
    if (!matchesPathPrefix(request.url, DASHBOARD_PREFIX)) {
        return false;
    }
    return (request.headers.accept ?? '').includes('text/html');
}

/**
 * Serves the built React dashboard as static files under /dashboard, with an
 * SPA fallback so client-side routes (e.g. /dashboard/manager) resolve to
 * index.html. If the frontend has not been built (e.g. backend-only dev or
 * tests), static serving is skipped and the function returns false — but the
 * not-found handler is always installed so the API's JSON 404 contract is
 * identical whether or not the frontend has been built. Returns whether the
 * static frontend was registered.
 */
export function registerDashboardStatic(app: FastifyInstance, distDirOverride?: string): boolean {
    const distDir = resolveFrontendDist(distDirOverride);

    if (distDir) {
        void app.register(fastifyStatic, {
            root: distDir,
            prefix: `${DASHBOARD_PREFIX}/`,
            redirect: true,
            wildcard: false,
        });
    } else {
        app.log.warn(
            'Dashboard frontend build not found (run `npm run build:web`) — /dashboard will not be served',
        );
    }

    // Registered unconditionally so the 404 contract does not depend on whether
    // the frontend was built. For unmatched GET /dashboard/* requests, fall back
    // to the SPA's index.html (when built) so client-side routing handles deep
    // links; everything else gets Fastify's standard JSON 404 shape.
    app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
        if (distDir && isSpaNavigation(request)) {
            return reply.type('text/html').sendFile('index.html');
        }
        return reply.status(404).send({
            statusCode: 404,
            error: 'Not Found',
            message: `Route ${request.method}:${request.url} not found`,
        });
    });

    return distDir !== undefined;
}
