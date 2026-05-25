import crypto from 'crypto';
import type {FastifyRequest, FastifyReply, FastifyInstance} from 'fastify';

export function registerAuthMiddleware(app: FastifyInstance, adminPassword: string | undefined): void {
    if (!adminPassword) {
        app.log.warn('No dashboard.auth.admin_password configured — all API endpoints are publicly accessible');
        return;
    }

    const expectedBuf = Buffer.from(adminPassword);

    app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
        if (request.url === '/health' || request.url.startsWith('/health?') || request.url.startsWith('/health/')) {
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
        const password = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : decoded;

        const candidateBuf = Buffer.from(password);
        const lengthsMatch = candidateBuf.length === expectedBuf.length;
        const compareBuf = lengthsMatch ? candidateBuf : Buffer.alloc(expectedBuf.length);
        const equal = crypto.timingSafeEqual(compareBuf, expectedBuf) && lengthsMatch;

        if (!equal) {
            return reply.status(401).send({error: 'Unauthorized', message: 'Invalid credentials'});
        }
    });
}
