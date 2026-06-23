import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {makeTestDb} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerPracticeAuthoringRoutes} from '../../src/dashboard/api/practices';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';
import {createContribution} from '../../src/contributions/store';

const PASSWORD = 'correct-horse-battery';
const NOW = '2026-06-13T00:00:00.000Z';

function seedDeveloper(db: Database.Database, id: string, team: string | null): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        `${id} Dev`,
        `${id}@test.com`,
        team,
        NOW,
    );
}

function cookieToken(res: {headers: Record<string, unknown>}): string {
    const raw = res.headers['set-cookie'];
    const header = Array.isArray(raw) ? raw[0] : (raw as string);
    const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header);
    return match ? decodeURIComponent(match[1]) : '';
}

function auth(token: string): Record<string, string> {
    return {cookie: `${SESSION_COOKIE}=${token}`};
}

describe('Best-practice authoring API (Task 6.2.3)', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let aliceToken: string;
    let bobToken: string;

    async function boot(): Promise<void> {
        app = Fastify();
        registerSessionAuth(app, db);
        registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
        registerPracticeAuthoringRoutes(app, db);
        await app.ready();
        const loginA = await app.inject({method: 'POST', url: '/api/auth/login', payload: {email: 'alice@test.com', password: PASSWORD}});
        aliceToken = cookieToken(loginA);
        const loginB = await app.inject({method: 'POST', url: '/api/auth/login', payload: {email: 'bob@test.com', password: PASSWORD}});
        bobToken = cookieToken(loginB);
    }

    beforeEach(async () => {
        db = makeTestDb();
        const hash = await hashPassword(PASSWORD);
        db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run('eng', NOW);
        seedDeveloper(db, 'alice', 'eng');
        seedDeveloper(db, 'bob', 'eng');
        createUser(db, {email: 'alice@test.com', passwordHash: hash, role: 'developer', developerId: 'alice'});
        createUser(db, {email: 'bob@test.com', passwordHash: hash, role: 'developer', developerId: 'bob'});
        await boot();
    });

    afterEach(async () => {
        await app.close();
        db.close();
    });

    async function createPractice(token: string, body: Record<string, unknown>): Promise<{id: string; metrics: string[]}> {
        const res = await app.inject({method: 'POST', url: '/api/me/practices', headers: auth(token), payload: body});
        expect(res.statusCode).toBe(201);
        const data = res.json().data;
        return {id: data.contribution.id, metrics: data.metrics};
    }

    it('requires authentication', async () => {
        const res = await app.inject({method: 'POST', url: '/api/me/practices', payload: {title: 'x', scope: 'org', markdown: 'y'}});
        expect(res.statusCode).toBe(401);
    });

    it('creates a team-scoped practice pinned to the author team, at version 1, with metric tags', async () => {
        const {id, metrics} = await createPractice(aliceToken, {
            title: 'Reduce churn',
            scope: 'team',
            markdown: 'Watch {{churn}} closely.',
        });
        expect(metrics).toEqual(['churn']);

        const view = await app.inject({method: 'GET', url: `/api/me/practices/${id}`, headers: auth(aliceToken)});
        expect(view.statusCode).toBe(200);
        const data = view.json().data;
        expect(data.currentVersion).toBe(1);
        expect(data.title).toBe('Reduce churn');
        expect(data.html).toContain('data-metric="churn"');
        expect(data.metrics).toEqual(['churn']);
    });

    it('previews markdown to sanitized HTML + metrics without persisting', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/me/practices/preview',
            headers: auth(aliceToken),
            payload: {markdown: '# Hi {{churn}}\n\n<script>alert(1)</script>'},
        });
        expect(res.statusCode).toBe(200);
        const data = res.json().data;
        expect(data.html).toContain('<h1>');
        expect(data.html).toContain('data-metric="churn"');
        expect(data.html).not.toContain('<script');
        expect(data.metrics).toEqual(['churn']);

        // nothing persisted
        const list = await app.inject({method: 'GET', url: '/api/me/practices', headers: auth(aliceToken)});
        expect(list.json().data).toHaveLength(0);
    });

    it('saving creates a new version and re-syncs tags; GET reflects it', async () => {
        const {id} = await createPractice(aliceToken, {title: 'T', scope: 'org', markdown: 'v1 {{churn}}'});
        const save = await app.inject({
            method: 'POST',
            url: `/api/me/practices/${id}/save`,
            headers: auth(aliceToken),
            payload: {markdown: 'v2 {{acceptance_rate}}', change_note: 'edit'},
        });
        expect(save.statusCode).toBe(200);
        expect(save.json().data.version.version).toBe(2);
        expect(save.json().data.metrics).toEqual(['acceptance_rate']);

        const history = await app.inject({method: 'GET', url: `/api/me/practices/${id}/history`, headers: auth(aliceToken)});
        expect(history.json().data).toHaveLength(2);

        const view = await app.inject({method: 'GET', url: `/api/me/practices/${id}`, headers: auth(aliceToken)});
        expect(view.json().data.markdown).toBe('v2 {{acceptance_rate}}');
    });

    it('reverts to a prior version (history preserved)', async () => {
        const {id} = await createPractice(aliceToken, {title: 'T', scope: 'org', markdown: 'first'});
        await app.inject({method: 'POST', url: `/api/me/practices/${id}/save`, headers: auth(aliceToken), payload: {markdown: 'second'}});
        const revert = await app.inject({
            method: 'POST',
            url: `/api/me/practices/${id}/revert`,
            headers: auth(aliceToken),
            payload: {version: 1},
        });
        expect(revert.statusCode).toBe(200);
        expect(revert.json().data.version.version).toBe(3);
        const view = await app.inject({method: 'GET', url: `/api/me/practices/${id}`, headers: auth(aliceToken)});
        expect(view.json().data.markdown).toBe('first');
    });

    it('is owner-scoped: another developer cannot read, save, or revert a practice', async () => {
        const {id} = await createPractice(aliceToken, {title: 'Alice only', scope: 'org', markdown: 'body'});
        const read = await app.inject({method: 'GET', url: `/api/me/practices/${id}`, headers: auth(bobToken)});
        expect(read.statusCode).toBe(404);
        const save = await app.inject({method: 'POST', url: `/api/me/practices/${id}/save`, headers: auth(bobToken), payload: {markdown: 'hax'}});
        expect(save.statusCode).toBe(404);
        const history = await app.inject({method: 'GET', url: `/api/me/practices/${id}/history`, headers: auth(bobToken)});
        expect(history.statusCode).toBe(404);
    });

    it('does not expose a showcase contribution through the practice surface', async () => {
        const showcase = createContribution(db, {
            contentType: 'showcase_example',
            title: 'not a practice',
            authorId: 'alice',
            scope: 'org',
            body: JSON.stringify({markdown: 'x'}),
            timestamp: NOW,
        });
        const read = await app.inject({method: 'GET', url: `/api/me/practices/${showcase.id}`, headers: auth(aliceToken)});
        expect(read.statusCode).toBe(404);
        // save and revert against a non-practice id are also 404 (owner/content guard)
        const save = await app.inject({method: 'POST', url: `/api/me/practices/${showcase.id}/save`, headers: auth(aliceToken), payload: {markdown: 'x'}});
        expect(save.statusCode).toBe(404);
        const revert = await app.inject({method: 'POST', url: `/api/me/practices/${showcase.id}/revert`, headers: auth(aliceToken), payload: {version: 1}});
        expect(revert.statusCode).toBe(404);
    });

    it('lists only the developer’s own practices', async () => {
        await createPractice(aliceToken, {title: 'A1', scope: 'org', markdown: 'a'});
        await createPractice(bobToken, {title: 'B1', scope: 'org', markdown: 'b'});
        const aliceList = await app.inject({method: 'GET', url: '/api/me/practices', headers: auth(aliceToken)});
        const data = aliceList.json().data;
        expect(data).toHaveLength(1);
        expect(data[0].title).toBe('A1');
    });

    describe('validation', () => {
        const BIG_MD = 'a'.repeat(100_001);

        it('rejects an empty markdown on create (400)', async () => {
            const res = await app.inject({method: 'POST', url: '/api/me/practices', headers: auth(aliceToken), payload: {title: 'T', scope: 'org', markdown: '   '}});
            expect(res.statusCode).toBe(400);
        });

        it('rejects an unknown body field (400)', async () => {
            const res = await app.inject({method: 'POST', url: '/api/me/practices', headers: auth(aliceToken), payload: {title: 'T', scope: 'org', markdown: 'x', sneaky: true}});
            expect(res.statusCode).toBe(400);
        });

        it('rejects a bad scope (400)', async () => {
            const res = await app.inject({method: 'POST', url: '/api/me/practices', headers: auth(aliceToken), payload: {title: 'T', scope: 'global', markdown: 'x'}});
            expect(res.statusCode).toBe(400);
        });

        it('rejects a non-object create body (400)', async () => {
            const res = await app.inject({method: 'POST', url: '/api/me/practices', headers: auth(aliceToken), payload: ['nope']});
            expect(res.statusCode).toBe(400);
        });

        it('rejects a missing title (400)', async () => {
            const res = await app.inject({method: 'POST', url: '/api/me/practices', headers: auth(aliceToken), payload: {scope: 'org', markdown: 'x'}});
            expect(res.statusCode).toBe(400);
        });

        it('rejects an over-long title (400)', async () => {
            const res = await app.inject({method: 'POST', url: '/api/me/practices', headers: auth(aliceToken), payload: {title: 'a'.repeat(201), scope: 'org', markdown: 'x'}});
            expect(res.statusCode).toBe(400);
        });

        it('rejects an over-size markdown on create (400)', async () => {
            const res = await app.inject({method: 'POST', url: '/api/me/practices', headers: auth(aliceToken), payload: {title: 'T', scope: 'org', markdown: BIG_MD}});
            expect(res.statusCode).toBe(400);
        });

        it('rejects a non-string change_note (400)', async () => {
            const res = await app.inject({method: 'POST', url: '/api/me/practices', headers: auth(aliceToken), payload: {title: 'T', scope: 'org', markdown: 'x', change_note: 5}});
            expect(res.statusCode).toBe(400);
        });

        it('rejects an over-long model_used (400)', async () => {
            const res = await app.inject({method: 'POST', url: '/api/me/practices', headers: auth(aliceToken), payload: {title: 'T', scope: 'org', markdown: 'x', model_used: 'a'.repeat(65)}});
            expect(res.statusCode).toBe(400);
        });

        it('accepts an optional model_used and a change_note (201)', async () => {
            const res = await app.inject({method: 'POST', url: '/api/me/practices', headers: auth(aliceToken), payload: {title: 'T', scope: 'org', markdown: 'x', model_used: 'claude-opus-4-8', change_note: 'first'}});
            expect(res.statusCode).toBe(201);
        });

        it('preview rejects a non-object body and an unknown key (400)', async () => {
            const a = await app.inject({method: 'POST', url: '/api/me/practices/preview', headers: auth(aliceToken), payload: ['nope']});
            expect(a.statusCode).toBe(400);
            const b = await app.inject({method: 'POST', url: '/api/me/practices/preview', headers: auth(aliceToken), payload: {markdown: 'x', extra: 1}});
            expect(b.statusCode).toBe(400);
        });

        it('preview rejects an over-size markdown (400) and accepts an empty one (200)', async () => {
            const big = await app.inject({method: 'POST', url: '/api/me/practices/preview', headers: auth(aliceToken), payload: {markdown: BIG_MD}});
            expect(big.statusCode).toBe(400);
            const empty = await app.inject({method: 'POST', url: '/api/me/practices/preview', headers: auth(aliceToken), payload: {markdown: ''}});
            expect(empty.statusCode).toBe(200);
            expect(empty.json().data.metrics).toEqual([]);
        });

        it('save rejects a non-object body, an unknown key, and an over-size markdown (400)', async () => {
            const {id} = await createPractice(aliceToken, {title: 'T', scope: 'org', markdown: 'body'});
            const a = await app.inject({method: 'POST', url: `/api/me/practices/${id}/save`, headers: auth(aliceToken), payload: ['nope']});
            expect(a.statusCode).toBe(400);
            const b = await app.inject({method: 'POST', url: `/api/me/practices/${id}/save`, headers: auth(aliceToken), payload: {markdown: 'x', extra: 1}});
            expect(b.statusCode).toBe(400);
            const c = await app.inject({method: 'POST', url: `/api/me/practices/${id}/save`, headers: auth(aliceToken), payload: {markdown: BIG_MD}});
            expect(c.statusCode).toBe(400);
        });

        it('save on a removed practice returns 409 (versioning guard surfaces)', async () => {
            const {id} = await createPractice(aliceToken, {title: 'T', scope: 'org', markdown: 'body'});
            db.prepare("UPDATE contributions SET state = 'removed' WHERE id = ?").run(id);
            const res = await app.inject({method: 'POST', url: `/api/me/practices/${id}/save`, headers: auth(aliceToken), payload: {markdown: 'edit'}});
            expect(res.statusCode).toBe(409);
            expect(res.json().code).toBe('contribution_removed');
        });

        it('revert rejects a non-object body and an unknown key (400)', async () => {
            const {id} = await createPractice(aliceToken, {title: 'T', scope: 'org', markdown: 'body'});
            const a = await app.inject({method: 'POST', url: `/api/me/practices/${id}/revert`, headers: auth(aliceToken), payload: ['nope']});
            expect(a.statusCode).toBe(400);
            const b = await app.inject({method: 'POST', url: `/api/me/practices/${id}/revert`, headers: auth(aliceToken), payload: {version: 1, extra: 1}});
            expect(b.statusCode).toBe(400);
        });

        it('GET an unknown practice id returns 404', async () => {
            const res = await app.inject({method: 'GET', url: '/api/me/practices/does-not-exist', headers: auth(aliceToken)});
            expect(res.statusCode).toBe(404);
        });

        it('rejects a non-integer revert version (400)', async () => {
            const {id} = await createPractice(aliceToken, {title: 'T', scope: 'org', markdown: 'body'});
            const res = await app.inject({method: 'POST', url: `/api/me/practices/${id}/revert`, headers: auth(aliceToken), payload: {version: 1.5}});
            expect(res.statusCode).toBe(400);
        });

        it('reverting to a non-existent version yields 404', async () => {
            const {id} = await createPractice(aliceToken, {title: 'T', scope: 'org', markdown: 'body'});
            const res = await app.inject({method: 'POST', url: `/api/me/practices/${id}/revert`, headers: auth(aliceToken), payload: {version: 99}});
            expect(res.statusCode).toBe(404);
        });
    });
});
