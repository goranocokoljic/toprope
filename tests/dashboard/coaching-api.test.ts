import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import {makeTestDb} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerMeRoutes} from '../../src/dashboard/api/me';
import {registerCoachingRoutes} from '../../src/dashboard/api/coaching';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';
import type {ScopeVariant} from '../../src/coaching/pr-review/types';

const PASSWORD = 'correct-horse-battery';
const NOW = '2026-06-15T00:00:00.000Z';

async function buildApp(db: Database.Database): Promise<FastifyInstance> {
    const app = Fastify({logger: false});
    registerSessionAuth(app, db);
    registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
    registerMeRoutes(app, db);
    registerCoachingRoutes(app, db);
    await app.ready();
    return app;
}

function cookieToken(res: {headers: Record<string, unknown>}): string {
    const raw = res.headers['set-cookie'];
    const header = Array.isArray(raw) ? raw[0] : (raw as string);
    const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header);
    return match ? decodeURIComponent(match[1]) : '';
}

async function login(app: FastifyInstance, email: string): Promise<string> {
    const res = await app.inject({method: 'POST', url: '/api/auth/login', payload: {email, password: PASSWORD}});
    expect(res.statusCode).toBe(200);
    return cookieToken(res);
}

function auth(token: string): Record<string, string> {
    return {cookie: `${SESSION_COOKIE}=${token}`};
}

function seedTeam(db: Database.Database, name: string): void {
    db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run(name, NOW);
}

function seedDeveloper(db: Database.Database, id: string, team: string): void {
    db.prepare(
        'INSERT INTO developers (id, external_ids, name, email, team, created_at) VALUES (?, NULL, ?, ?, ?, ?)',
    ).run(id, id, `${id}@example.com`, team, NOW);
}

function seedMetric(
    db: Database.Database,
    o: {developerId: string; period: string; variant: ScopeVariant; prsTotal: number; rework: number},
): void {
    db.prepare(
        `INSERT INTO pr_review_metrics
         (id, developer_id, period, scope_variant, prs_total, prs_merged, rework_rate,
          avg_review_rounds, review_rejection_rate, avg_comment_density, comment_density_vs_baseline,
          avg_time_to_merge_hours, review_comments_given, avg_churn, combined_signal, basis, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1.0, ?, 2.0, NULL, 5.0, 0, 0.1, 'effective', ?, ?)`,
    ).run(
        randomUUID(),
        o.developerId,
        o.period,
        o.variant,
        o.prsTotal,
        o.prsTotal,
        o.rework,
        o.rework,
        o.variant === 'all_pr' ? 'factual' : 'inferred',
        NOW,
    );
}

interface CoachingBody {
    data: {all_pr: {points: Array<{period: string; prs_total: number | null; suppressed?: boolean}>}};
}

describe('Coaching API privacy boundary (Task 5.3)', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let aliceToken: string;
    let adminToken: string;

    beforeEach(async () => {
        db = makeTestDb();
        const hash = await hashPassword(PASSWORD);

        seedTeam(db, 'eng');
        seedDeveloper(db, 'alice', 'eng');
        seedDeveloper(db, 'bob', 'eng');
        seedDeveloper(db, 'carol', 'eng');

        createUser(db, {email: 'alice@test.com', passwordHash: hash, role: 'developer', developerId: 'alice'});
        createUser(db, {email: 'admin@test.com', passwordHash: hash, role: 'admin'});

        app = await buildApp(db);
        aliceToken = await login(app, 'alice@test.com');
        adminToken = await login(app, 'admin@test.com');
    });

    afterEach(async () => {
        await app.close();
        db.close();
    });

    it('requires authentication on both surfaces', async () => {
        for (const url of ['/api/me/pr-coaching', '/api/coaching/pr-review/org', '/api/coaching/pr-review/team/eng']) {
            const res = await app.inject({method: 'GET', url});
            expect(res.statusCode, url).toBe(401);
        }
    });

    it('lets a developer see ONLY their own coaching, never the manager aggregate', async () => {
        seedMetric(db, {developerId: 'alice', period: '2026-06', variant: 'all_pr', prsTotal: 5, rework: 0.2});

        const own = await app.inject({method: 'GET', url: '/api/me/pr-coaching', headers: auth(aliceToken)});
        expect(own.statusCode).toBe(200);
        const june = (own.json() as CoachingBody).data.all_pr.points.find((p) => p.period === '2026-06');
        expect(june?.prs_total).toBe(5);

        // The middleware confines developers to /api/me — the manager aggregate is 403.
        for (const url of ['/api/coaching/pr-review/org', '/api/coaching/pr-review/team/eng']) {
            const res = await app.inject({method: 'GET', url, headers: auth(aliceToken)});
            expect(res.statusCode, url).toBe(403);
        }
    });

    it("a developer's /api/me coaching never reflects another developer's numbers", async () => {
        seedMetric(db, {developerId: 'alice', period: '2026-06', variant: 'all_pr', prsTotal: 5, rework: 0.2});
        seedMetric(db, {developerId: 'bob', period: '2026-06', variant: 'all_pr', prsTotal: 99, rework: 0.9});

        const own = await app.inject({method: 'GET', url: '/api/me/pr-coaching', headers: auth(aliceToken)});
        const june = (own.json() as CoachingBody).data.all_pr.points.find((p) => p.period === '2026-06');
        expect(june?.prs_total).toBe(5); // alice's, not bob's 99
    });

    it('serves the manager a TEAM aggregate that contains no individual developer id', async () => {
        // 3 contributors → not suppressed.
        for (const id of ['alice', 'bob', 'carol']) {
            seedMetric(db, {developerId: id, period: '2026-06', variant: 'all_pr', prsTotal: 4, rework: 0.25});
        }
        const res = await app.inject({method: 'GET', url: '/api/coaching/pr-review/team/eng', headers: auth(adminToken)});
        expect(res.statusCode).toBe(200);
        const june = (res.json() as CoachingBody).data.all_pr.points.find((p) => p.period === '2026-06');
        expect(june?.suppressed).toBe(false);
        expect(june?.prs_total).toBe(12);
        // Regression guard: no developer id ever appears in the manager payload.
        const raw = res.payload;
        for (const id of ['alice', 'bob', 'carol']) {
            expect(raw.includes(id)).toBe(false);
        }
    });

    it('suppresses a thin team period so a single developer cannot be read off the aggregate', async () => {
        // Only alice has PRs this period within a 3-person team → suppressed.
        seedMetric(db, {developerId: 'alice', period: '2026-06', variant: 'all_pr', prsTotal: 7, rework: 0.5});
        const res = await app.inject({method: 'GET', url: '/api/coaching/pr-review/team/eng', headers: auth(adminToken)});
        const june = (res.json() as CoachingBody).data.all_pr.points.find((p) => p.period === '2026-06');
        expect(june?.suppressed).toBe(true);
        expect(june?.prs_total).toBeNull();
    });

    it('404s an unknown team rather than leaking an empty aggregate path', async () => {
        const res = await app.inject({method: 'GET', url: '/api/coaching/pr-review/team/nope', headers: auth(adminToken)});
        expect(res.statusCode).toBe(404);
    });
});
