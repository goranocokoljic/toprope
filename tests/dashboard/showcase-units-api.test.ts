import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {makeTestDb} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerShowcaseBrowseRoutes} from '../../src/dashboard/api/showcase-browse';
import {registerShowcaseAdminRoutes} from '../../src/dashboard/api/showcase-admin';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';
import {createContribution, getContribution} from '../../src/contributions/store';
import {
    approveAsDeveloper,
    draftSelfPublish,
    publishShowcase,
    submitForReview,
} from '../../src/showcase/publishPaths';
import {confirmManualReview} from '../../src/showcase/manualReview';

const PASSWORD = 'correct-horse-battery';
const NOW = '2026-06-20T00:00:00.000Z';
const CONVERSATION = '[{"id":"t0","role":"user","text":"hi"},{"id":"t1","role":"assistant","text":"yo"}]';

function seedTeam(db: Database.Database, name: string): void {
    db.prepare('INSERT INTO teams (name, created_at) VALUES (?, ?)').run(name, NOW);
}

function seedDeveloper(db: Database.Database, id: string, team: string | null): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        `${id} Dev`,
        `${id}@test.com`,
        team,
        NOW,
    );
}

interface PublishOpts {
    developerId?: string;
    title?: string;
    scope?: 'org' | 'team';
    scopeTarget?: string | null;
}

function publishShowcaseFixture(db: Database.Database, opts: PublishOpts = {}): string {
    const developerId = opts.developerId ?? 'alice';
    const scope = opts.scope ?? 'org';
    const {contribution} = draftSelfPublish(db, {
        developerId,
        title: opts.title ?? 'Session',
        conversation: CONVERSATION,
        curatorsNote: 'note',
        scope,
        scopeTarget: opts.scopeTarget ?? null,
    });
    submitForReview(db, {contributionId: contribution.id, actorId: developerId});
    approveAsDeveloper(db, {contributionId: contribution.id, developerId, visibilityScope: scope});
    confirmManualReview(db, {contributionId: contribution.id, actorId: developerId});
    publishShowcase(db, {contributionId: contribution.id, actorId: developerId});
    return contribution.id;
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

describe('Showcase browse/governance API (6.3.9 / #172)', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let aliceToken: string; // developer, team eng, author
    let bobToken: string; // developer, team data
    let adminToken: string; // admin/manager

    async function boot(): Promise<void> {
        app = Fastify();
        registerSessionAuth(app, db);
        registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
        registerShowcaseBrowseRoutes(app, db);
        registerShowcaseAdminRoutes(app, db);
        await app.ready();
        const login = async (email: string): Promise<string> =>
            cookieToken(
                await app.inject({method: 'POST', url: '/api/auth/login', payload: {email, password: PASSWORD}}),
            );
        aliceToken = await login('alice@test.com');
        bobToken = await login('bob@test.com');
        adminToken = await login('admin@test.com');
    }

    beforeEach(async () => {
        db = makeTestDb();
        const hash = await hashPassword(PASSWORD);
        seedTeam(db, 'eng');
        seedTeam(db, 'data');
        seedDeveloper(db, 'alice', 'eng');
        seedDeveloper(db, 'bob', 'data');
        createUser(db, {email: 'alice@test.com', passwordHash: hash, role: 'developer', developerId: 'alice'});
        createUser(db, {email: 'bob@test.com', passwordHash: hash, role: 'developer', developerId: 'bob'});
        createUser(db, {email: 'admin@test.com', passwordHash: hash, role: 'admin', developerId: null});
        await boot();
    });

    afterEach(async () => {
        await app.close();
        db.close();
    });

    // --- browse ----------------------------------------------------------------

    it('requires authentication for the gallery', async () => {
        const res = await app.inject({method: 'GET', url: '/api/me/showcase-units/browse'});
        expect(res.statusCode).toBe(401);
    });

    it('lists the published showcases the viewer may see', async () => {
        publishShowcaseFixture(db, {title: 'Org tip'});
        const res = await app.inject({method: 'GET', url: '/api/me/showcase-units/browse', headers: auth(aliceToken)});
        expect(res.statusCode).toBe(200);
        expect(res.json().data.showcases.map((s: {title: string}) => s.title)).toEqual(['Org tip']);
    });

    it('rejects an unknown scope filter with 400', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/me/showcase-units/browse?scope=galaxy',
            headers: auth(aliceToken),
        });
        expect(res.statusCode).toBe(400);
    });

    it('rejects an out-of-range limit with 400', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/me/showcase-units/browse?limit=9999',
            headers: auth(aliceToken),
        });
        expect(res.statusCode).toBe(400);
    });

    it('a team-scoped showcase is not visible to another team (no leak)', async () => {
        publishShowcaseFixture(db, {title: 'Eng only', scope: 'team', scopeTarget: 'eng'});
        const bob = await app.inject({method: 'GET', url: '/api/me/showcase-units/browse', headers: auth(bobToken)});
        expect(bob.json().data.showcases).toEqual([]);
        // positive control
        const alice = await app.inject({method: 'GET', url: '/api/me/showcase-units/browse', headers: auth(aliceToken)});
        expect(alice.json().data.showcases.map((s: {title: string}) => s.title)).toEqual(['Eng only']);
    });

    // --- detail ----------------------------------------------------------------

    it('returns the full unit detail for a visible showcase', async () => {
        const id = publishShowcaseFixture(db, {title: 'Detail me'});
        const res = await app.inject({
            method: 'GET',
            url: `/api/me/showcase-units/${id}`,
            headers: auth(aliceToken),
        });
        expect(res.statusCode).toBe(200);
        const d = res.json().data;
        expect(d.title).toBe('Detail me');
        expect(d.curatorsNote).toBe('note');
        expect(d.display).toBeDefined();
        expect(d.aiAnnotation).toBeDefined();
        expect(d.canUnpublish).toBe(true);
    });

    it('detail 404s uniformly for an out-of-scope showcase', async () => {
        const id = publishShowcaseFixture(db, {title: 'Eng only', scope: 'team', scopeTarget: 'eng'});
        const res = await app.inject({
            method: 'GET',
            url: `/api/me/showcase-units/${id}`,
            headers: auth(bobToken),
        });
        expect(res.statusCode).toBe(404);
    });

    // --- owner unpublish -------------------------------------------------------

    it('the author unpublishes their own showcase', async () => {
        const id = publishShowcaseFixture(db, {developerId: 'alice'});
        const res = await app.inject({
            method: 'POST',
            url: `/api/me/showcase-units/${id}/unpublish`,
            headers: auth(aliceToken),
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().data.state).toBe('unpublished');
    });

    it('a non-author gets a uniform 404 when trying to unpublish (no leak of existence)', async () => {
        const id = publishShowcaseFixture(db, {developerId: 'alice'});
        const res = await app.inject({
            method: 'POST',
            url: `/api/me/showcase-units/${id}/unpublish`,
            headers: auth(bobToken),
        });
        expect(res.statusCode).toBe(404);
        // Untouched.
        expect(getContribution(db, id)?.state).toBe('published');
    });

    // --- admin lead remove -----------------------------------------------------

    it('an admin removes a showcase from a team gallery; author can never publish via admin', async () => {
        const id = publishShowcaseFixture(db, {developerId: 'alice', scope: 'team', scopeTarget: 'eng'});
        const res = await app.inject({
            method: 'POST',
            url: `/api/admin/showcase-units/${id}/remove`,
            headers: auth(adminToken),
            payload: {team: 'eng', reason: 'off-topic'},
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().data.showcase.state).toBe('removed');
        // There is no admin route that could publish — only remove. Confirm the verb set.
        const publishAttempt = await app.inject({
            method: 'POST',
            url: `/api/admin/showcase-units/${id}/publish`,
            headers: auth(adminToken),
            payload: {},
        });
        expect(publishAttempt.statusCode).toBe(404); // no such route exists
    });

    it('admin remove requires a team and rejects a foreign-team scope (403)', async () => {
        const id = publishShowcaseFixture(db, {developerId: 'bob', scope: 'team', scopeTarget: 'data'});
        const noTeam = await app.inject({
            method: 'POST',
            url: `/api/admin/showcase-units/${id}/remove`,
            headers: auth(adminToken),
            payload: {},
        });
        expect(noTeam.statusCode).toBe(400);
        const wrongTeam = await app.inject({
            method: 'POST',
            url: `/api/admin/showcase-units/${id}/remove`,
            headers: auth(adminToken),
            payload: {team: 'eng'},
        });
        expect(wrongTeam.statusCode).toBe(403);
    });

    it('admin remove 404s for a missing id and for a non-showcase id', async () => {
        const missing = await app.inject({
            method: 'POST',
            url: '/api/admin/showcase-units/no-such-id/remove',
            headers: auth(adminToken),
            payload: {team: 'eng'},
        });
        expect(missing.statusCode).toBe(404);

        const practice = createContribution(db, {
            contentType: 'best_practice',
            title: 'not a showcase',
            authorId: 'alice',
            scope: 'org',
            scopeTarget: null,
            state: 'published',
            body: '{}',
        });
        const notShowcase = await app.inject({
            method: 'POST',
            url: `/api/admin/showcase-units/${practice.id}/remove`,
            headers: auth(adminToken),
            payload: {team: 'eng'},
        });
        expect(notShowcase.statusCode).toBe(404);
    });

    it('admin remove 409s when the showcase is not in a removable state (e.g. already removed)', async () => {
        const id = publishShowcaseFixture(db, {developerId: 'alice', scope: 'team', scopeTarget: 'eng'});
        await app.inject({
            method: 'POST',
            url: `/api/admin/showcase-units/${id}/remove`,
            headers: auth(adminToken),
            payload: {team: 'eng'},
        });
        const again = await app.inject({
            method: 'POST',
            url: `/api/admin/showcase-units/${id}/remove`,
            headers: auth(adminToken),
            payload: {team: 'eng'},
        });
        expect(again.statusCode).toBe(409);
    });

    it('admin remove validates the body shape (non-object, unknown key, bad reason)', async () => {
        const id = publishShowcaseFixture(db, {developerId: 'alice', scope: 'team', scopeTarget: 'eng'});
        const base = `/api/admin/showcase-units/${id}/remove`;
        // A JSON array is valid JSON but not an object — reaches the handler, where
        // asObject rejects it (400), unlike a raw string which Fastify 415s first.
        const notObject = await app.inject({method: 'POST', url: base, headers: auth(adminToken), payload: []});
        expect(notObject.statusCode).toBe(400);
        const unknownKey = await app.inject({
            method: 'POST',
            url: base,
            headers: auth(adminToken),
            payload: {team: 'eng', surprise: 1},
        });
        expect(unknownKey.statusCode).toBe(400);
        const badReason = await app.inject({
            method: 'POST',
            url: base,
            headers: auth(adminToken),
            payload: {team: 'eng', reason: 42},
        });
        expect(badReason.statusCode).toBe(400);
        const longReason = await app.inject({
            method: 'POST',
            url: base,
            headers: auth(adminToken),
            payload: {team: 'eng', reason: 'x'.repeat(1001)},
        });
        expect(longReason.statusCode).toBe(400);
    });

    it('a developer cannot reach the admin remove route (403)', async () => {
        const id = publishShowcaseFixture(db, {developerId: 'alice', scope: 'team', scopeTarget: 'eng'});
        const res = await app.inject({
            method: 'POST',
            url: `/api/admin/showcase-units/${id}/remove`,
            headers: auth(aliceToken),
            payload: {team: 'eng'},
        });
        // Developers are confined to /api/me by the session middleware.
        expect([401, 403]).toContain(res.statusCode);
    });

    // --- author removal feed ---------------------------------------------------

    it('the author is notified: removal feed lists the lead removal', async () => {
        const id = publishShowcaseFixture(db, {developerId: 'alice', scope: 'team', scopeTarget: 'eng'});
        await app.inject({
            method: 'POST',
            url: `/api/admin/showcase-units/${id}/remove`,
            headers: auth(adminToken),
            payload: {team: 'eng', reason: 'cleanup'},
        });
        const feed = await app.inject({
            method: 'GET',
            url: '/api/me/showcase-units/removals',
            headers: auth(aliceToken),
        });
        expect(feed.statusCode).toBe(200);
        const notices = feed.json().data;
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({showcaseId: id, reason: 'cleanup'});
    });
});
