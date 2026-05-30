import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {registerDashboardStatic} from '../../src/dashboard/static';
import {registerSessionAuth} from '../../src/auth/middleware';
import {makeTestDb} from './fixtures';
import {createUser} from '../../src/auth/users';
import {createSession} from '../../src/auth/sessions';
import {hashPassword} from '../../src/auth/password';

function makeDist(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'govproxy-dash-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="root">SPA</div>');
    return dir;
}

// Browsers send this on document navigations (deep links) but not on
// script/style/fetch requests.
const HTML_ACCEPT = {accept: 'text/html,application/xhtml+xml'};

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

    it('falls back to index.html for client-side deep links (HTML navigation)', async () => {
        const res = await app.inject({method: 'GET', url: '/dashboard/manager', headers: HTML_ACCEPT});
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('id="root"');
    });

    it('returns a real 404 for missing assets instead of HTML', async () => {
        const res = await app.inject({method: 'GET', url: '/dashboard/assets/missing.js'});
        expect(res.statusCode).toBe(404);
        expect(res.headers['content-type']).toContain('application/json');
        expect(res.json()).toMatchObject({statusCode: 404, error: 'Not Found'});
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

    it('returns a consistent JSON 404 shape even with no build present', async () => {
        const noBuildApp = Fastify({logger: false});
        const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'govproxy-empty-'));
        try {
            registerDashboardStatic(noBuildApp, emptyDir);
            await noBuildApp.ready();
            const res = await noBuildApp.inject({method: 'GET', url: '/api/missing'});
            expect(res.statusCode).toBe(404);
            expect(res.json()).toMatchObject({statusCode: 404, error: 'Not Found'});
            // No build → /dashboard paths get the same JSON 404, not HTML.
            const dash = await noBuildApp.inject({method: 'GET', url: '/dashboard/manager', headers: HTML_ACCEPT});
            expect(dash.statusCode).toBe(404);
            expect(dash.headers['content-type']).toContain('application/json');
        } finally {
            await noBuildApp.close();
            fs.rmSync(emptyDir, {recursive: true, force: true});
        }
    });
});

describe('Dashboard static serving under session auth', () => {
    let app: FastifyInstance;
    let distDir: string;
    let db: Database.Database;
    let token: string;

    beforeAll(async () => {
        distDir = makeDist();
        db = makeTestDb();
        const user = createUser(db, {
            email: 'admin@test.com',
            passwordHash: await hashPassword('correct-horse'),
            role: 'admin',
        });
        token = createSession(db, user.id).id;

        app = Fastify({logger: false});
        registerSessionAuth(app, db);
        app.get('/api/overview', async () => ({data: {ok: true}}));
        registerDashboardStatic(app, distDir);
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
        db.close();
        fs.rmSync(distDir, {recursive: true, force: true});
    });

    it('serves the dashboard shell without credentials', async () => {
        const res = await app.inject({method: 'GET', url: '/dashboard/'});
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('id="root"');
    });

    it('serves SPA deep links without credentials', async () => {
        const res = await app.inject({method: 'GET', url: '/dashboard/manager', headers: HTML_ACCEPT});
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('id="root"');
    });

    it('still gates the data API behind a session', async () => {
        const res = await app.inject({method: 'GET', url: '/api/overview'});
        expect(res.statusCode).toBe(401);
    });

    it('allows the data API with a valid session', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/overview',
            headers: {authorization: `Bearer ${token}`},
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({data: {ok: true}});
    });
});
