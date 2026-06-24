import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {makeTestDb} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerPracticeBrowseRoutes} from '../../src/dashboard/api/practices-browse';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';
import {addContributionTag, createContribution} from '../../src/contributions/store';
import {getFeedback} from '../../src/practices/store';
import type {NewContribution} from '../../src/contributions/types';

const PASSWORD = 'correct-horse-battery';
const NOW = '2026-06-13T00:00:00.000Z';

function seedTeam(db: Database.Database, name: string): void {
    db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run(name, NOW);
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

interface MakeOpts {
    scope?: 'org' | 'team';
    scopeTarget?: string | null;
    state?: NewContribution['state'];
    tags?: string[];
    authorId?: string;
}

function make(db: Database.Database, title: string, opts: MakeOpts = {}): string {
    const id = createContribution(db, {
        contentType: 'best_practice',
        title,
        authorId: opts.authorId ?? 'alice',
        scope: opts.scope ?? 'org',
        scopeTarget: opts.scopeTarget ?? null,
        state: opts.state ?? 'published',
        body: JSON.stringify({markdown: title}),
        timestamp: NOW,
    }).id;
    for (const tag of opts.tags ?? []) {
        addContributionTag(db, id, tag);
    }
    return id;
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

describe('Best-practice browse API (Task 6.2.8 / #163)', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let aliceToken: string; // team eng, author of most practices
    let bobToken: string; // team data (different scope)

    async function boot(): Promise<void> {
        app = Fastify();
        registerSessionAuth(app, db);
        registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
        registerPracticeBrowseRoutes(app, db);
        await app.ready();
        const a = await app.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: {email: 'alice@test.com', password: PASSWORD},
        });
        aliceToken = cookieToken(a);
        const b = await app.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: {email: 'bob@test.com', password: PASSWORD},
        });
        bobToken = cookieToken(b);
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
        await boot();
    });

    afterEach(async () => {
        await app.close();
        db.close();
    });

    // --- list / search / filter (AC1) --------------------------------------

    it('requires authentication', async () => {
        const res = await app.inject({method: 'GET', url: '/api/me/practices/browse'});
        expect(res.statusCode).toBe(401);
    });

    it('lists visible practices with the active model and canContribute', async () => {
        make(db, 'Org tip', {});
        const res = await app.inject({method: 'GET', url: '/api/me/practices/browse', headers: auth(aliceToken)});
        expect(res.statusCode).toBe(200);
        const data = res.json().data;
        expect(data.model).toBe('top_down');
        expect(data.canContribute).toBe(true);
        expect(data.practices.map((p: {title: string}) => p.title)).toEqual(['Org tip']);
    });

    it('the tag filter narrows the list', async () => {
        make(db, 'Churn tip', {tags: ['churn']});
        make(db, 'Acceptance tip', {tags: ['acceptance_rate']});
        const res = await app.inject({
            method: 'GET',
            url: '/api/me/practices/browse?tag=churn',
            headers: auth(aliceToken),
        });
        expect(res.json().data.practices.map((p: {title: string}) => p.title)).toEqual(['Churn tip']);
    });

    it('a free-text query filters by title', async () => {
        make(db, 'Review AI suggestions', {});
        make(db, 'Tighten prompts', {});
        const res = await app.inject({
            method: 'GET',
            url: '/api/me/practices/browse?q=review',
            headers: auth(aliceToken),
        });
        expect(res.json().data.practices.map((p: {title: string}) => p.title)).toEqual(['Review AI suggestions']);
    });

    it('the team filter narrows the list and cannot widen past the viewer scope', async () => {
        make(db, 'Eng tip', {scope: 'team', scopeTarget: 'eng'});
        make(db, 'Data tip', {scope: 'team', scopeTarget: 'data', authorId: 'bob'});
        const own = await app.inject({
            method: 'GET',
            url: '/api/me/practices/browse?team=eng',
            headers: auth(aliceToken),
        });
        expect(own.json().data.practices.map((p: {title: string}) => p.title)).toEqual(['Eng tip']);
        // Alice (eng) filtering by data's team cannot surface data's practice.
        const foreign = await app.inject({
            method: 'GET',
            url: '/api/me/practices/browse?team=data',
            headers: auth(aliceToken),
        });
        expect(foreign.json().data.practices).toEqual([]);
    });

    it('caps the result set with the limit param and rejects a bad limit', async () => {
        make(db, 'Tip A', {});
        make(db, 'Tip B', {});
        make(db, 'Tip C', {});
        const capped = await app.inject({
            method: 'GET',
            url: '/api/me/practices/browse?limit=2',
            headers: auth(aliceToken),
        });
        expect(capped.json().data.practices).toHaveLength(2);
        const bad = await app.inject({
            method: 'GET',
            url: '/api/me/practices/browse?limit=abc',
            headers: auth(aliceToken),
        });
        expect(bad.statusCode).toBe(400);
    });

    it('rejects an unknown scope filter with 400', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/me/practices/browse?scope=everywhere',
            headers: auth(aliceToken),
        });
        expect(res.statusCode).toBe(400);
    });

    it('never lists a team-scoped practice to another team', async () => {
        make(db, 'Eng-only', {scope: 'team', scopeTarget: 'eng'});
        const eng = await app.inject({method: 'GET', url: '/api/me/practices/browse', headers: auth(aliceToken)});
        expect(eng.json().data.practices).toHaveLength(1);
        const data = await app.inject({method: 'GET', url: '/api/me/practices/browse', headers: auth(bobToken)});
        expect(data.json().data.practices).toEqual([]);
    });

    // --- detail (AC2) ------------------------------------------------------

    it('returns the rendered detail for a visible practice', async () => {
        const id = make(db, 'A tip', {});
        const res = await app.inject({
            method: 'GET',
            url: `/api/me/practices/browse/${id}`,
            headers: auth(aliceToken),
        });
        expect(res.statusCode).toBe(200);
        const data = res.json().data;
        expect(data.title).toBe('A tip');
        expect(data.html).toContain('<p>A tip</p>');
        expect(data.canEdit).toBe(true);
        expect(data.showcases).toEqual([]);
        expect(data.feedback.viewerSignal).toBeNull();
    });

    it('404s the detail of a practice outside the viewer scope', async () => {
        const id = make(db, 'Eng-only', {scope: 'team', scopeTarget: 'eng'});
        const res = await app.inject({
            method: 'GET',
            url: `/api/me/practices/browse/${id}`,
            headers: auth(bobToken),
        });
        expect(res.statusCode).toBe(404);
    });

    it('404s the detail of a draft and an unknown id', async () => {
        const draft = make(db, 'Draft', {state: 'draft'});
        const drafted = await app.inject({
            method: 'GET',
            url: `/api/me/practices/browse/${draft}`,
            headers: auth(aliceToken),
        });
        expect(drafted.statusCode).toBe(404);
        const missing = await app.inject({
            method: 'GET',
            url: '/api/me/practices/browse/no-such-id',
            headers: auth(aliceToken),
        });
        expect(missing.statusCode).toBe(404);
    });

    // --- history (AC2) -----------------------------------------------------

    it('returns version history for a visible practice', async () => {
        const id = make(db, 'A tip', {});
        const res = await app.inject({
            method: 'GET',
            url: `/api/me/practices/browse/${id}/history`,
            headers: auth(aliceToken),
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().data.map((h: {version: number}) => h.version)).toEqual([1]);
    });

    it('404s history for a practice outside the viewer scope', async () => {
        const id = make(db, 'Eng-only', {scope: 'team', scopeTarget: 'eng'});
        const res = await app.inject({
            method: 'GET',
            url: `/api/me/practices/browse/${id}/history`,
            headers: auth(bobToken),
        });
        expect(res.statusCode).toBe(404);
    });

    // --- feedback toggle (AC2, 6.2.4) --------------------------------------

    it('records a helpful vote and returns fresh counts', async () => {
        const id = make(db, 'A tip', {});
        const res = await app.inject({
            method: 'POST',
            url: `/api/me/practices/browse/${id}/feedback`,
            headers: auth(aliceToken),
            payload: {signal: 'helpful'},
        });
        expect(res.statusCode).toBe(200);
        const data = res.json().data;
        expect(data.signal).toBe('helpful');
        expect(data.removed).toBe(false);
        expect(data.feedback.helpful).toBe(1);
        // The session developer is recorded, never request input.
        expect(getFeedback(db, id, 'alice')?.signal).toBe('helpful');
    });

    it('pressing the held signal again toggles it off', async () => {
        const id = make(db, 'A tip', {});
        await app.inject({
            method: 'POST',
            url: `/api/me/practices/browse/${id}/feedback`,
            headers: auth(aliceToken),
            payload: {signal: 'helpful'},
        });
        const off = await app.inject({
            method: 'POST',
            url: `/api/me/practices/browse/${id}/feedback`,
            headers: auth(aliceToken),
            payload: {signal: 'helpful'},
        });
        const data = off.json().data;
        expect(data.signal).toBeNull();
        expect(data.removed).toBe(true);
        expect(data.feedback.helpful).toBe(0);
        expect(getFeedback(db, id, 'alice')).toBeUndefined();
    });

    it('rejects an unknown feedback signal with 400', async () => {
        const id = make(db, 'A tip', {});
        const res = await app.inject({
            method: 'POST',
            url: `/api/me/practices/browse/${id}/feedback`,
            headers: auth(aliceToken),
            payload: {signal: 'meh'},
        });
        expect(res.statusCode).toBe(400);
    });

    it('rejects an unknown body key with 400', async () => {
        const id = make(db, 'A tip', {});
        const res = await app.inject({
            method: 'POST',
            url: `/api/me/practices/browse/${id}/feedback`,
            headers: auth(aliceToken),
            payload: {signal: 'helpful', extra: 'x'},
        });
        expect(res.statusCode).toBe(400);
    });

    it('404s feedback on a practice outside the viewer scope and records nothing', async () => {
        const id = make(db, 'Eng-only', {scope: 'team', scopeTarget: 'eng'});
        const res = await app.inject({
            method: 'POST',
            url: `/api/me/practices/browse/${id}/feedback`,
            headers: auth(bobToken),
            payload: {signal: 'helpful'},
        });
        expect(res.statusCode).toBe(404);
        expect(getFeedback(db, id, 'bob')).toBeUndefined();
    });
});
