import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {registerDashboardStatic} from '../../src/dashboard/static';

describe('Dashboard static serving', () => {
    let app: FastifyInstance;
    let distDir: string;

    beforeAll(async () => {
        distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'govproxy-dash-'));
        fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><div id="root">SPA</div>');
        fs.mkdirSync(path.join(distDir, 'assets'));
        fs.writeFileSync(path.join(distDir, 'assets', 'app.js'), 'console.log("hi");');

        app = Fastify({logger: false});
        app.get('/api/overview', async () => ({data: {ok: true}}));
        registerDashboardStatic(app, distDir);
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
        fs.rmSync(distDir, {recursive: true, force: true});
    });

    it('serves index.html at /dashboard/', async () => {
        const res = await app.inject({method: 'GET', url: '/dashboard/'});
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/html');
        expect(res.body).toContain('id="root"');
    });

    it('serves built assets', async () => {
        const res = await app.inject({method: 'GET', url: '/dashboard/assets/app.js'});
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('console.log');
    });

    it('falls back to index.html for client-side deep links', async () => {
        const res = await app.inject({method: 'GET', url: '/dashboard/manager'});
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('id="root"');
    });

    it('still returns JSON 404 for unknown non-dashboard routes', async () => {
        const res = await app.inject({method: 'GET', url: '/api/does-not-exist'});
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({error: 'Not Found'});
    });

    it('does not intercept real API routes', async () => {
        const res = await app.inject({method: 'GET', url: '/api/overview'});
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({data: {ok: true}});
    });

    it('returns false when no build is present', () => {
        const emptyApp = Fastify({logger: false});
        const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'govproxy-empty-'));
        try {
            expect(registerDashboardStatic(emptyApp, emptyDir)).toBe(false);
        } finally {
            void emptyApp.close();
            fs.rmSync(emptyDir, {recursive: true, force: true});
        }
    });
});
