import type {FastifyRequest, FastifyReply, FastifyInstance} from 'fastify';

export function registerAuthMiddleware(app: FastifyInstance, adminPassword: string | undefined): void {
    if (!adminPassword) {
        return;
    }

    app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
        if (request.url === '/health') {
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

        if (password !== adminPassword) {
            return reply.status(401).send({error: 'Unauthorized', message: 'Invalid credentials'});
        }
    });
}
