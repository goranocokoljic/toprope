import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {makeTestDb} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerPracticeSurfaceRoutes} from '../../src/dashboard/api/practices-surface';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';
import {addContributionTag, createContribution} from '../../src/contributions/store';
import {addMetricPin, listUsageEvents, recordFeedback, setPracticeEndorsed} from '../../src/practices/store';
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
}

/** Create a practice (default: published, org-scoped, authored by alice). Returns its id. */
function make(db: Database.Database, title: string, opts: MakeOpts = {}): string {
    const id = createContribution(db, {
        contentType: 'best_practice',
        title,
        authorId: 'alice',
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

describe('Contextual best-practice display API (Task 6.2.7 / #162)', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let aliceToken: string; // team eng
    let bobToken: string; // team data (different scope)

    async function boot(): Promise<void> {
        app = Fastify();
        registerSessionAuth(app, db);
        registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
        registerPracticeSurfaceRoutes(app, db);
        await app.ready();
        const a = await app.inject({method: 'POST', url: '/api/auth/login', payload: {email: 'alice@test.com', password: PASSWORD}});
        aliceToken = cookieToken(a);
        const b = await app.inject({method: 'POST', url: '/api/auth/login', payload: {email: 'bob@test.com', password: PASSWORD}});
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

    // --- surfacing in context (AC1) ----------------------------------------

    it('requires authentication', async () => {
        const res = await app.inject({method: 'GET', url: '/api/me/practices/related?metric=churn'});
        expect(res.statusCode).toBe(401);
    });

    it('surfaces a practice tagged with the metric, with the encouraging intro (AC1, AC2)', async () => {
        const churn = make(db, 'Review AI suggestions before accepting', {tags: ['churn']});
        const res = await app.inject({
            method: 'GET',
            url: '/api/me/practices/related?metric=churn',
            headers: auth(aliceToken),
        });
        expect(res.statusCode).toBe(200);
        const data = res.json().data;
        expect(data.metric).toBe('churn');
        expect(data.practices.map((p: {id: string}) => p.id)).toEqual([churn]);
        expect(data.practices[0].title).toBe('Review AI suggestions before accepting');
        // Encouraging, never scolding.
        expect(data.intro.toLowerCase()).toContain('may help');
        expect(data.intro.toLowerCase()).not.toContain('bad');
    });

    it('a practice tagged for a different metric does not surface (AC1)', async () => {
        make(db, 'Tighten prompts', {tags: ['acceptance_rate']});
        const res = await app.inject({method: 'GET', url: '/api/me/practices/related?metric=churn', headers: auth(aliceToken)});
        expect(res.json().data.practices).toEqual([]);
    });

    it('an empty surfacing set is a normal 200 with an empty list (unobtrusive) (AC2)', async () => {
        const res = await app.inject({method: 'GET', url: '/api/me/practices/related?metric=churn', headers: auth(aliceToken)});
        expect(res.statusCode).toBe(200);
        expect(res.json().data.practices).toEqual([]);
    });

    it('respects viewer scope — a team-scoped practice does not surface to another team (AC1)', async () => {
        make(db, 'Eng-only churn tip', {tags: ['churn'], scope: 'team', scopeTarget: 'eng'});
        const eng = await app.inject({method: 'GET', url: '/api/me/practices/related?metric=churn', headers: auth(aliceToken)});
        expect(eng.json().data.practices).toHaveLength(1);
        const data = await app.inject({method: 'GET', url: '/api/me/practices/related?metric=churn', headers: auth(bobToken)});
        expect(data.json().data.practices).toEqual([]);
    });

    it('does not surface a suppressed practice (6.2.6)', async () => {
        const id = make(db, 'Suppressed tip', {tags: ['churn']});
        addMetricPin(db, {contributionId: id, metric: 'churn', action: 'suppress', actorId: 'lead', createdAt: NOW});
        const res = await app.inject({method: 'GET', url: '/api/me/practices/related?metric=churn', headers: auth(aliceToken)});
        expect(res.json().data.practices).toEqual([]);
    });

    it('honors the limit query param', async () => {
        for (let i = 0; i < 4; i++) make(db, `Tip ${i}`, {tags: ['churn']});
        const res = await app.inject({method: 'GET', url: '/api/me/practices/related?metric=churn&limit=2', headers: auth(aliceToken)});
        expect(res.json().data.practices).toHaveLength(2);
    });

    it('a repeated limit param uses the last value (array branch)', async () => {
        for (let i = 0; i < 4; i++) make(db, `Tip ${i}`, {tags: ['churn']});
        const res = await app.inject({method: 'GET', url: '/api/me/practices/related?metric=churn&limit=1&limit=3', headers: auth(aliceToken)});
        expect(res.statusCode).toBe(200);
        expect(res.json().data.practices).toHaveLength(3);
    });

    it('projects the pin / endorsement / helpful-ratio / scope fields onto the DTO (AC1)', async () => {
        // A team-scoped, lead-pinned, lead-endorsed practice with 3 helpful / 1 not_helpful.
        const id = make(db, 'Pinned, endorsed, voted', {tags: ['churn'], scope: 'team', scopeTarget: 'eng'});
        addMetricPin(db, {contributionId: id, metric: 'churn', action: 'pin', actorId: 'lead', createdAt: NOW});
        setPracticeEndorsed(db, id, true);
        for (let i = 0; i < 3; i++) {
            seedDeveloper(db, `voter_h_${i}`, 'eng');
            recordFeedback(db, {contributionId: id, developerId: `voter_h_${i}`, signal: 'helpful'});
        }
        seedDeveloper(db, 'voter_n', 'eng');
        recordFeedback(db, {contributionId: id, developerId: 'voter_n', signal: 'not_helpful'});

        const res = await app.inject({method: 'GET', url: '/api/me/practices/related?metric=churn', headers: auth(aliceToken)});
        expect(res.statusCode).toBe(200);
        const p = res.json().data.practices[0];
        expect(p.id).toBe(id);
        expect(p.pinned).toBe(true);
        expect(p.endorsed).toBe(true);
        expect(p.scope).toBe('team');
        expect(p.helpfulRatio).toBeCloseTo(0.75, 5);
    });

    it('an un-pinned, un-endorsed, feedback-less practice projects the neutral DTO defaults', async () => {
        const id = make(db, 'Plain', {tags: ['churn']});
        const res = await app.inject({method: 'GET', url: '/api/me/practices/related?metric=churn', headers: auth(aliceToken)});
        const p = res.json().data.practices[0];
        expect(p.id).toBe(id);
        expect(p.pinned).toBe(false);
        expect(p.endorsed).toBe(false);
        expect(p.scope).toBe('org');
        expect(p.helpfulRatio).toBeNull();
    });

    // --- request validation -------------------------------------------------

    it('rejects a missing metric (400)', async () => {
        const res = await app.inject({method: 'GET', url: '/api/me/practices/related', headers: auth(aliceToken)});
        expect(res.statusCode).toBe(400);
    });

    it('rejects an unknown metric (400)', async () => {
        const res = await app.inject({method: 'GET', url: '/api/me/practices/related?metric=not_a_metric', headers: auth(aliceToken)});
        expect(res.statusCode).toBe(400);
    });

    it('rejects a non-integer / out-of-range limit (400)', async () => {
        const bad = await app.inject({method: 'GET', url: '/api/me/practices/related?metric=churn&limit=abc', headers: auth(aliceToken)});
        expect(bad.statusCode).toBe(400);
        const zero = await app.inject({method: 'GET', url: '/api/me/practices/related?metric=churn&limit=0', headers: auth(aliceToken)});
        expect(zero.statusCode).toBe(400);
        const huge = await app.inject({method: 'GET', url: '/api/me/practices/related?metric=churn&limit=999', headers: auth(aliceToken)});
        expect(huge.statusCode).toBe(400);
    });

    // --- usage-event recording (AC3) ---------------------------------------

    it('recording a view of a surfaced practice writes a usage event (AC3)', async () => {
        const id = make(db, 'Churn tip', {tags: ['churn']});
        const res = await app.inject({
            method: 'POST',
            url: `/api/me/practices/${id}/view`,
            headers: auth(aliceToken),
            payload: {metric: 'churn'},
        });
        expect(res.statusCode).toBe(201);
        expect(res.json().data.event).toBe('viewed');

        const events = listUsageEvents(db, id);
        expect(events).toHaveLength(1);
        expect(events[0].developerId).toBe('alice');
        expect(events[0].event).toBe('viewed');
        expect(events[0].metricContext).toBe('churn');
    });

    it('a view records the SESSION developer id, not request input (privacy)', async () => {
        const id = make(db, 'Churn tip', {tags: ['churn']});
        // bob can only surface org-scoped practices; this one is org-scoped, so it surfaces for bob too.
        const res = await app.inject({method: 'POST', url: `/api/me/practices/${id}/view`, headers: auth(bobToken), payload: {metric: 'churn'}});
        expect(res.statusCode).toBe(201);
        const events = listUsageEvents(db, id);
        expect(events[0].developerId).toBe('bob');
    });

    it('refuses to record a view for a practice not surfaced to the viewer — 404, no event (AC3)', async () => {
        // Team-scoped to eng; bob (data) can never see it, so cannot log a view of it.
        const id = make(db, 'Eng-only', {tags: ['churn'], scope: 'team', scopeTarget: 'eng'});
        const res = await app.inject({method: 'POST', url: `/api/me/practices/${id}/view`, headers: auth(bobToken), payload: {metric: 'churn'}});
        expect(res.statusCode).toBe(404);
        expect(listUsageEvents(db, id)).toEqual([]);
    });

    it('refuses to record a view for a suppressed practice — 404, no event', async () => {
        const id = make(db, 'Suppressed', {tags: ['churn']});
        addMetricPin(db, {contributionId: id, metric: 'churn', action: 'suppress', actorId: 'lead', createdAt: NOW});
        const res = await app.inject({method: 'POST', url: `/api/me/practices/${id}/view`, headers: auth(aliceToken), payload: {metric: 'churn'}});
        expect(res.statusCode).toBe(404);
        expect(listUsageEvents(db, id)).toEqual([]);
    });

    it('refuses to record a view against the WRONG metric — 404, no event', async () => {
        // Tagged churn only; viewing it "next to acceptance_rate" is not a surfaced view.
        const id = make(db, 'Churn only', {tags: ['churn']});
        const res = await app.inject({method: 'POST', url: `/api/me/practices/${id}/view`, headers: auth(aliceToken), payload: {metric: 'acceptance_rate'}});
        expect(res.statusCode).toBe(404);
        expect(listUsageEvents(db, id)).toEqual([]);
    });

    it('view rejects a non-object body, an unknown key, and a missing/unknown metric (400)', async () => {
        const id = make(db, 'Churn tip', {tags: ['churn']});
        const base = `/api/me/practices/${id}/view`;
        expect((await app.inject({method: 'POST', url: base, headers: auth(aliceToken), payload: ['nope']})).statusCode).toBe(400);
        expect((await app.inject({method: 'POST', url: base, headers: auth(aliceToken), payload: {metric: 'churn', extra: 1}})).statusCode).toBe(400);
        expect((await app.inject({method: 'POST', url: base, headers: auth(aliceToken), payload: {}})).statusCode).toBe(400);
        expect((await app.inject({method: 'POST', url: base, headers: auth(aliceToken), payload: {metric: 'bogus'}})).statusCode).toBe(400);
        // None of the rejected requests recorded an event.
        expect(listUsageEvents(db, id)).toEqual([]);
    });

    it('view requires authentication (401)', async () => {
        const id = make(db, 'Churn tip', {tags: ['churn']});
        const res = await app.inject({method: 'POST', url: `/api/me/practices/${id}/view`, payload: {metric: 'churn'}});
        expect(res.statusCode).toBe(401);
    });
});
