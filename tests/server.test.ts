import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';

describe('Server', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = buildServer();
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
    });

    it('GET /health returns {"status": "ok"}', async () => {
        const res = await app.inject({ method: 'GET', url: '/health' });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ status: 'ok' });
    });
});
