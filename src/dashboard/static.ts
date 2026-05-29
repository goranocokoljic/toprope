import fs from 'fs';
import path from 'path';
import fastifyStatic from '@fastify/static';
import type {FastifyInstance} from 'fastify';

const DASHBOARD_PREFIX = '/dashboard';

/**
 * Candidate locations for the built frontend, in priority order. This module
 * lives at src/dashboard/static.ts in dev (tsx, __dirname = src/dashboard) and
 * at dist/dashboard/static.js in prod (__dirname = dist/dashboard); the Vite
 * output always lands in src/dashboard/frontend/dist, so we resolve both.
 */
function frontendDistCandidates(): string[] {
    return [
        path.resolve(__dirname, 'frontend/dist'),
        path.resolve(__dirname, '../../src/dashboard/frontend/dist'),
        path.resolve(process.cwd(), 'src/dashboard/frontend/dist'),
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

/**
 * Serves the built React dashboard as static files under /dashboard, with an
 * SPA fallback so client-side routes (e.g. /dashboard/manager) resolve to
 * index.html. If the frontend has not been built (e.g. backend-only dev or
 * tests), registration is skipped so the server still boots.
 */
export function registerDashboardStatic(app: FastifyInstance, distDirOverride?: string): boolean {
    const distDir = resolveFrontendDist(distDirOverride);
    if (!distDir) {
        app.log.warn(
            'Dashboard frontend build not found (run `npm run build:web`) — /dashboard will not be served',
        );
        return false;
    }

    void app.register(fastifyStatic, {
        root: distDir,
        prefix: `${DASHBOARD_PREFIX}/`,
        redirect: true,
        wildcard: false,
    });

    // SPA deep-link fallback: any unmatched /dashboard/* path returns index.html
    // so the client router can handle it. API and other 404s stay JSON.
    app.setNotFoundHandler((request, reply) => {
        if (request.method === 'GET' && request.url.startsWith(DASHBOARD_PREFIX)) {
            return reply.type('text/html').sendFile('index.html');
        }
        return reply.status(404).send({error: 'Not Found', message: `Route ${request.url} not found`});
    });

    return true;
}
