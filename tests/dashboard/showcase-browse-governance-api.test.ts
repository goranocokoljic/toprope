import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import {Writable} from 'stream';
import type Database from 'better-sqlite3';
import {makeTestDb} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerShowcaseRoutes} from '../../src/dashboard/api/showcase';
import {registerShowcaseAdminRoutes} from '../../src/dashboard/api/showcase-admin';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';
import {insertShowcaseExample} from '../../src/showcase/store';
import type {ShowcaseExample, ShowcasePublishRecord} from '../../src/showcase/types';

const PASSWORD = 'correct-horse-battery';
const NOW = '2026-06-13T00:00:00.000Z';

function seedDeveloper(db: Database.Database, id: string, team: string): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, `${id} Dev`, `${id}@test.com`, team, NOW);
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

function pub(db: Database.Database, overrides: Partial<ShowcasePublishRecord> = {}): ShowcaseExample {
    return insertShowcaseExample(db, {
        authorDeveloperId: 'alice',
        publishedAt: NOW,
        scope: 'team',
        scopeTarget: 'eng',
        title: 'example',
        taskType: 'refactor',
        tool: 'claude_code',
        content: 'redacted content',
        authorNote: 'why good',
        ...overrides,
    });
}

describe('Showcase browse + governance API (Task 5.9)', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let logs: string;
    let aliceToken: string;
    let bobToken: string;
    let adminToken: string;

    async function boot(): Promise<void> {
        logs = '';
        const stream = new Writable({
            write(chunk, _enc, cb): void {
                logs += chunk.toString();
                cb();
            },
        });
        app = Fastify({logger: {level: 'trace', stream}});
        registerSessionAuth(app, db);
        registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
        registerShowcaseRoutes(app, db);
        registerShowcaseAdminRoutes(app, db);
        await app.ready();

        const login = async (email: string): Promise<string> =>
            cookieToken(await app.inject({method: 'POST', url: '/api/auth/login', payload: {email, password: PASSWORD}}));
        aliceToken = await login('alice@test.com');
        bobToken = await login('bob@test.com');
        adminToken = await login('admin@test.com');
    }

    beforeEach(async () => {
        db = makeTestDb();
        const hash = await hashPassword(PASSWORD);
        for (const t of ['eng', 'design']) {
            db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run(t, NOW);
        }
        seedDeveloper(db, 'alice', 'eng');
        seedDeveloper(db, 'bob', 'eng');
        seedDeveloper(db, 'carol', 'design');
        createUser(db, {email: 'alice@test.com', passwordHash: hash, role: 'developer', developerId: 'alice'});
        createUser(db, {email: 'bob@test.com', passwordHash: hash, role: 'developer', developerId: 'bob'});
        createUser(db, {email: 'carol@test.com', passwordHash: hash, role: 'developer', developerId: 'carol'});
        createUser(db, {email: 'admin@test.com', passwordHash: hash, role: 'admin'});
    });

    afterEach(async () => {
        await app.close();
        db.close();
    });

    // --- Browse / discovery ------------------------------------------------

    it('browse shows published examples within the viewer’s access scope', async () => {
        pub(db, {authorDeveloperId: 'alice', scope: 'team', scopeTarget: 'eng', title: 'eng-team'});
        pub(db, {authorDeveloperId: 'carol', scope: 'team', scopeTarget: 'design', title: 'design-team'});
        pub(db, {authorDeveloperId: 'alice', scope: 'org', scopeTarget: null, title: 'org-wide'});
        await boot();

        const eng = await app.inject({method: 'GET', url: '/api/me/showcase/browse', headers: auth(bobToken)});
        expect(eng.statusCode).toBe(200);
        expect(eng.json().data.map((e: ShowcaseExample) => e.title).sort()).toEqual(['eng-team', 'org-wide']);

        // Team-scoped 'design-team' is NOT visible to an eng viewer.
        expect(eng.json().data.map((e: ShowcaseExample) => e.title)).not.toContain('design-team');
    });

    it('filters work (task_type, tool, team, scope)', async () => {
        pub(db, {scope: 'org', scopeTarget: null, title: 'org-debug-claude', taskType: 'debugging', tool: 'claude_code'});
        pub(db, {scope: 'org', scopeTarget: null, title: 'org-refactor-copilot', taskType: 'refactor', tool: 'copilot'});
        pub(db, {scope: 'team', scopeTarget: 'eng', title: 'eng-debug-copilot', taskType: 'debugging', tool: 'copilot'});
        await boot();

        const byTask = await app.inject({method: 'GET', url: '/api/me/showcase/browse?task_type=debugging', headers: auth(aliceToken)});
        expect(byTask.json().data.map((e: ShowcaseExample) => e.title).sort()).toEqual(['eng-debug-copilot', 'org-debug-claude']);

        const byTool = await app.inject({method: 'GET', url: '/api/me/showcase/browse?tool=copilot', headers: auth(aliceToken)});
        expect(byTool.json().data.map((e: ShowcaseExample) => e.title).sort()).toEqual(['eng-debug-copilot', 'org-refactor-copilot']);

        const byScope = await app.inject({method: 'GET', url: '/api/me/showcase/browse?scope=org', headers: auth(aliceToken)});
        expect(byScope.json().data.map((e: ShowcaseExample) => e.title).sort()).toEqual(['org-debug-claude', 'org-refactor-copilot']);

        const byTeam = await app.inject({method: 'GET', url: '/api/me/showcase/browse?team=eng', headers: auth(aliceToken)});
        expect(byTeam.json().data.map((e: ShowcaseExample) => e.title)).toEqual(['eng-debug-copilot']);

        const badScope = await app.inject({method: 'GET', url: '/api/me/showcase/browse?scope=everyone', headers: auth(aliceToken)});
        expect(badScope.statusCode).toBe(400);
    });

    it('team-scoped examples are NOT visible outside the team, even when filtered for', async () => {
        pub(db, {authorDeveloperId: 'carol', scope: 'team', scopeTarget: 'design', title: 'design-only'});
        await boot();
        const res = await app.inject({method: 'GET', url: '/api/me/showcase/browse?team=design', headers: auth(aliceToken)});
        expect(res.json().data).toHaveLength(0);
    });

    it('example detail respects access scope', async () => {
        const engEx = pub(db, {scope: 'team', scopeTarget: 'eng', title: 'eng-detail'});
        const designEx = pub(db, {authorDeveloperId: 'carol', scope: 'team', scopeTarget: 'design', title: 'design-detail'});
        await boot();

        const visible = await app.inject({method: 'GET', url: `/api/me/showcase/browse/${engEx.id}`, headers: auth(bobToken)});
        expect(visible.statusCode).toBe(200);
        expect(visible.json().data.title).toBe('eng-detail');
        expect(visible.json().data.content).toBe('redacted content');
        expect(visible.json().data.authorNote).toBe('why good');

        // Out-of-team example is 404 — indistinguishable from missing.
        const hidden = await app.inject({method: 'GET', url: `/api/me/showcase/browse/${designEx.id}`, headers: auth(bobToken)});
        expect(hidden.statusCode).toBe(404);
    });

    // --- Owner unpublish ---------------------------------------------------

    it('owner can unpublish their own example; it then disappears from browse', async () => {
        const ex = pub(db, {authorDeveloperId: 'alice', scope: 'org', scopeTarget: null, title: 'mine'});
        await boot();

        const res = await app.inject({method: 'POST', url: `/api/me/showcase/${ex.id}/unpublish`, headers: auth(aliceToken)});
        expect(res.statusCode).toBe(200);
        expect(res.json().data.status).toBe('unpublished');

        const browse = await app.inject({method: 'GET', url: '/api/me/showcase/browse', headers: auth(bobToken)});
        expect(browse.json().data).toHaveLength(0);
    });

    it('a developer cannot unpublish someone else’s example (404)', async () => {
        const ex = pub(db, {authorDeveloperId: 'alice', scope: 'org', scopeTarget: null});
        await boot();
        const res = await app.inject({method: 'POST', url: `/api/me/showcase/${ex.id}/unpublish`, headers: auth(bobToken)});
        expect(res.statusCode).toBe(404);
        // Still published.
        expect((db.prepare("SELECT status FROM showcase_examples WHERE id = ?").get(ex.id) as {status: string}).status).toBe('published');
    });

    // --- Governance: team-lead removal ------------------------------------

    it('a team lead can remove an example from their team’s showcase; the author is notified', async () => {
        const ex = pub(db, {authorDeveloperId: 'alice', scope: 'team', scopeTarget: 'eng', title: 'eng-ex'});
        await boot();

        const res = await app.inject({
            method: 'POST',
            url: `/api/admin/showcase/${ex.id}/remove`,
            headers: auth(adminToken),
            payload: {team: 'eng', reason: 'duplicate'},
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().data.example.status).toBe('removed');

        // Gone from browse.
        expect((await app.inject({method: 'GET', url: '/api/me/showcase/browse', headers: auth(bobToken)})).json().data).toHaveLength(0);

        // The author is notified — their removal feed shows it.
        const feed = await app.inject({method: 'GET', url: '/api/me/showcase/removals', headers: auth(aliceToken)});
        expect(feed.json().data).toHaveLength(1);
        expect(feed.json().data[0]).toMatchObject({exampleTitle: 'eng-ex', removedByEmail: 'admin@test.com', team: 'eng', reason: 'duplicate'});

        // The author can acknowledge it.
        const ack = await app.inject({
            method: 'POST',
            url: `/api/me/showcase/removals/${feed.json().data[0].id}/acknowledge`,
            headers: auth(aliceToken),
        });
        expect(ack.statusCode).toBe(200);
    });

    it('a team lead CANNOT remove another team’s example (403)', async () => {
        const ex = pub(db, {authorDeveloperId: 'carol', scope: 'team', scopeTarget: 'design', title: 'design-ex'});
        await boot();
        const res = await app.inject({
            method: 'POST',
            url: `/api/admin/showcase/${ex.id}/remove`,
            headers: auth(adminToken),
            payload: {team: 'eng'},
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('not_team_showcase');
    });

    it('removal requires a team in the body', async () => {
        const ex = pub(db, {scope: 'org', scopeTarget: null});
        await boot();
        const res = await app.inject({
            method: 'POST',
            url: `/api/admin/showcase/${ex.id}/remove`,
            headers: auth(adminToken),
            payload: {reason: 'x'},
        });
        expect(res.statusCode).toBe(400);
    });

    it('a developer cannot reach the governance surface (confined to /api/me)', async () => {
        const ex = pub(db, {scope: 'org', scopeTarget: null});
        await boot();
        // Developer role is blocked from /api/admin by the session middleware.
        expect((await app.inject({method: 'GET', url: '/api/admin/showcase', headers: auth(aliceToken)})).statusCode).toBe(403);
        const remove = await app.inject({
            method: 'POST',
            url: `/api/admin/showcase/${ex.id}/remove`,
            headers: auth(aliceToken),
            payload: {team: 'eng'},
        });
        expect(remove.statusCode).toBe(403);
    });

    it('the governance surface offers NO route to publish/create on a developer’s behalf', async () => {
        await boot();
        // There is no create/publish admin route — only list + remove. A POST to the
        // collection (no :id/remove) is unrouted (404), and an admin has no developer
        // profile, so the developer-owned publish path is 404 for them too.
        expect((await app.inject({method: 'POST', url: '/api/admin/showcase', headers: auth(adminToken), payload: {}})).statusCode).toBe(404);
        const adminPublish = await app.inject({
            method: 'POST',
            url: '/api/me/showcase',
            headers: auth(adminToken),
            payload: {retrospective_id: 'x', scope: 'team', title: 'T', content: 'c', redaction_acknowledged: true},
        });
        expect(adminPublish.statusCode).toBe(404);
    });

    // --- Moderation list ---------------------------------------------------

    it('the moderation list shows a lead exactly their team’s examples when scoped by team', async () => {
        pub(db, {authorDeveloperId: 'alice', scope: 'team', scopeTarget: 'eng', title: 'eng-ex'});
        pub(db, {authorDeveloperId: 'carol', scope: 'team', scopeTarget: 'design', title: 'design-ex'});
        pub(db, {authorDeveloperId: 'alice', scope: 'org', scopeTarget: null, title: 'alice-org'});
        await boot();

        const all = await app.inject({method: 'GET', url: '/api/admin/showcase', headers: auth(adminToken)});
        expect(all.json().data.map((e: ShowcaseExample) => e.title).sort()).toEqual(['alice-org', 'design-ex', 'eng-ex']);

        const engOnly = await app.inject({method: 'GET', url: '/api/admin/showcase?team=eng', headers: auth(adminToken)});
        // eng-ex (team-scoped to eng) + alice-org (alice is on eng) — not design-ex.
        expect(engOnly.json().data.map((e: ShowcaseExample) => e.title).sort()).toEqual(['alice-org', 'eng-ex']);
    });

    // --- No leak from the showcase back into private captures --------------

    it('no path from the showcase leaks private captures — browse returns only redacted showcase rows', async () => {
        pub(db, {scope: 'org', scopeTarget: null, content: 'redacted only', title: 't'});
        await boot();
        const res = await app.inject({method: 'GET', url: '/api/me/showcase/browse', headers: auth(aliceToken)});
        const row = res.json().data[0];
        // The payload carries only the showcase shape — no ciphertext / capture pointer.
        expect(Object.keys(row).sort()).toEqual(
            ['authorDeveloperId', 'authorNote', 'content', 'createdAt', 'id', 'publishedAt', 'scope', 'scopeTarget', 'status', 'taskType', 'title', 'tool'].sort(),
        );
        expect(JSON.stringify(row)).not.toContain('ciphertext');
        // No capture was ever read; the captures table is untouched/empty.
        expect((db.prepare('SELECT COUNT(*) AS n FROM prompt_captures').get() as {n: number}).n).toBe(0);
        expect(logs).not.toContain('ciphertext');
    });
});
