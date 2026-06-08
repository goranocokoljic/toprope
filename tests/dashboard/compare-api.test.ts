/**
 * Team comparison API (Task 4.9 / #104): GET /api/compare?teams=a,b&range=<r>.
 *
 * Covers the acceptance criteria the issue lists for the endpoint: comparison
 * data assembly (every metric, tool mix, overlaid trend), max-4 (and min-2)
 * enforcement, per-team data-quality tier labeling incl. the weakest-link rule,
 * maturity carrying the git_estimate basis, range handling (presets + custom +
 * lifetime + invalid), unknown-team 404s, and admin-role gating.
 */

import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {makeTestDb} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerCompareRoutes} from '../../src/dashboard/api/compare';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';

const PASSWORD = 'correct-horse-battery';
const CREATED = '2026-01-01T00:00:00.000Z';
const ASSIGNED = '2026-01-01T00:00:00.000Z';

async function buildApp(db: Database.Database): Promise<FastifyInstance> {
    const app = Fastify({logger: false});
    registerSessionAuth(app, db);
    registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
    registerCompareRoutes(app, db);
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

function authHeaders(token: string): Record<string, string> {
    return {cookie: `${SESSION_COOKIE}=${token}`};
}

function seedTeam(db: Database.Database, name: string): void {
    db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, ?, ?, ?)').run(
        name,
        'engineering',
        `${name}-mgr@test.com`,
        CREATED,
    );
}

function seedDeveloper(db: Database.Database, id: string, team: string): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        id,
        `${id}@test.com`,
        team,
        CREATED,
    );
}

function seedGit(
    db: Database.Database,
    dev: string,
    date: string,
    opts: {commits: number; prs: number; churn: number},
): void {
    db.prepare(
        `INSERT INTO git_snapshots (id, developer_id, date, commits, lines_added, lines_removed, prs_merged, code_churn_rate, ai_signature_score, data_source)
         VALUES (?, ?, ?, ?, 100, 20, ?, ?, 0.6, 'git')`,
    ).run(`git:${dev}:${date}`, dev, date, opts.commits, opts.prs, opts.churn);
}

function seedTool(db: Database.Database, dev: string, date: string, tool: string): void {
    db.prepare(
        `INSERT INTO tool_snapshots
         (id, developer_id, date, tool, data_source, data_quality, is_active, interaction_count, acceptance_count, acceptance_rate)
         VALUES (?, ?, ?, ?, 'api', 'high', 1, 40, 30, 0.75)`,
    ).run(`tool:${dev}:${tool}:${date}`, dev, date, tool);
}

function seedSubscription(db: Database.Database, dev: string, tool: string, cost: number): void {
    db.prepare(
        `INSERT INTO subscriptions (id, developer_id, tool, plan, billing_model, monthly_cost, seat_assigned_at, data_source)
         VALUES (?, ?, ?, 'business', 'company_managed', ?, ?, 'csv')`,
    ).run(`sub:${dev}:${tool}`, dev, tool, cost, ASSIGNED);
}

function seedQuarterly(db: Database.Database, team: string, quarter: string, score: number): void {
    db.prepare(
        `INSERT INTO quarterly_aggregates (id, team, quarter, developer_count, ai_maturity_score, ai_maturity_basis, computed_at)
         VALUES (?, ?, ?, 2, ?, 'git_estimate', ?)`,
    ).run(`q:${team}:${quarter}`, team, quarter, score, CREATED);
}

interface CompareTeamShape {
    name: string;
    tier: string;
    tier_breakdown: {high: number; medium: number; low: number; none: number};
    metrics: {
        developer_count: number;
        active_developer_count: number;
        utilization_rate: number | null;
        total_subscription_cost: number;
        cost_per_pr: number | null;
        avg_code_churn: number | null;
        total_prs_merged: number;
        ai_maturity_score: number | null;
        ai_maturity_basis: string | null;
        tool_mix: string[];
    };
    trend: Array<{date: string; active_developers: number}>;
}

/** Find a compared team in the response by name. */
function team(body: {data: {teams: CompareTeamShape[]}}, name: string): CompareTeamShape {
    const found = body.data.teams.find((t) => t.name === name);
    if (!found) {
        throw new Error(`team '${name}' not in response`);
    }
    return found;
}

describe('Team comparison API (Task 4.9)', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let adminToken: string;
    let devToken: string;

    beforeEach(async () => {
        db = makeTestDb();
        const hash = await hashPassword(PASSWORD);
        createUser(db, {email: 'admin@test.com', passwordHash: hash, role: 'admin'});
        createUser(db, {email: 'dev@test.com', passwordHash: hash, role: 'developer'});

        // alpha: fully connected (a1 API+git+sub, a2 API+git) → tier high.
        seedTeam(db, 'alpha');
        seedDeveloper(db, 'a1', 'alpha');
        seedDeveloper(db, 'a2', 'alpha');
        seedGit(db, 'a1', '2026-05-10', {commits: 5, prs: 2, churn: 0.2});
        seedGit(db, 'a2', '2026-05-11', {commits: 3, prs: 1, churn: 0.4});
        seedTool(db, 'a1', '2026-05-10', 'copilot');
        seedTool(db, 'a2', '2026-05-11', 'claude_code');
        seedSubscription(db, 'a1', 'copilot', 19);
        seedQuarterly(db, 'alpha', '2026-Q2', 80);

        // beta: git-only → tier medium, no tool mix.
        seedTeam(db, 'beta');
        seedDeveloper(db, 'b1', 'beta');
        seedDeveloper(db, 'b2', 'beta');
        seedGit(db, 'b1', '2026-05-12', {commits: 4, prs: 0, churn: 0.1});
        seedGit(db, 'b2', '2026-05-13', {commits: 2, prs: 3, churn: 0.5});
        seedQuarterly(db, 'beta', '2026-Q2', 60);

        // gamma: expense-only → tier low.
        seedTeam(db, 'gamma');
        seedDeveloper(db, 'g1', 'gamma');
        seedSubscription(db, 'g1', 'cursor', 20);

        // delta: registered developer with no data at all → tier none.
        seedTeam(db, 'delta');
        seedDeveloper(db, 'd1', 'delta');

        // epsilon: one connected (API) + one git-only → weakest-link tier medium.
        seedTeam(db, 'epsilon');
        seedDeveloper(db, 'e1', 'epsilon');
        seedDeveloper(db, 'e2', 'epsilon');
        seedTool(db, 'e1', '2026-05-14', 'copilot');
        seedGit(db, 'e1', '2026-05-14', {commits: 1, prs: 0, churn: 0.1});
        seedGit(db, 'e2', '2026-05-15', {commits: 1, prs: 0, churn: 0.1});

        app = await buildApp(db);
        adminToken = await login(app, 'admin@test.com');
        devToken = await login(app, 'dev@test.com');
    });

    afterEach(async () => {
        await app.close();
        db.close();
    });

    // ── comparison data assembly ──────────────────────────────────────────────
    it('assembles every per-metric row for the selected teams', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/compare?teams=alpha,beta&range=lifetime',
            headers: authHeaders(adminToken),
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.data.range).toBe('lifetime');
        expect(body.data.teams.map((t: {name: string}) => t.name)).toEqual(['alpha', 'beta']);

        const alpha = team(body, 'alpha');
        expect(alpha.metrics.developer_count).toBe(2);
        expect(alpha.metrics.active_developer_count).toBe(2);
        expect(alpha.metrics.utilization_rate).toBe(1);
        expect(alpha.metrics.total_prs_merged).toBe(3);
        expect(alpha.metrics.avg_code_churn).toBe(0.3);
        expect(alpha.metrics.tool_mix).toEqual(['claude_code', 'copilot']);
        expect(alpha.metrics.ai_maturity_score).toBe(80);
        expect(alpha.metrics.ai_maturity_basis).toBe('git_estimate');
        // Cost is prorated > 0 (a1 holds a $19 copilot seat through the window);
        // cost-per-PR is that spend over the 3 merged PRs.
        expect(alpha.metrics.total_subscription_cost).toBeGreaterThan(0);
        expect(alpha.metrics.cost_per_pr).toBeGreaterThan(0);
        expect(Math.abs(alpha.metrics.cost_per_pr - alpha.metrics.total_subscription_cost / 3)).toBeLessThan(0.02);

        const beta = team(body, 'beta');
        expect(beta.metrics.tool_mix).toEqual([]);
        expect(beta.metrics.ai_maturity_score).toBe(60);
        // No subscriptions on beta → no spend; cost-per-PR is 0 spend over its
        // 3 merged PRs (not null — null is reserved for zero PRs, a real divide).
        expect(beta.metrics.total_subscription_cost).toBe(0);
        expect(beta.metrics.cost_per_pr).toBe(0);
    });

    it('returns one overlaid trend line per team with the active-developer series', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/compare?teams=alpha,beta&range=lifetime',
            headers: authHeaders(adminToken),
        });
        expect(res.statusCode).toBe(200);
        const alpha = team(res.json(), 'alpha');
        // alpha had two active tool-snapshot days; beta (git-only) has none.
        expect(alpha.trend.map((p: {date: string}) => p.date)).toEqual(['2026-05-10', '2026-05-11']);
        expect(alpha.trend.every((p: {active_developers: number}) => p.active_developers === 1)).toBe(true);
        expect(team(res.json(), 'beta').trend).toEqual([]);
    });

    // ── tier labeling ─────────────────────────────────────────────────────────
    it('labels each team with its data-quality tier (high/medium/low/none)', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/compare?teams=alpha,beta,gamma,delta&range=lifetime',
            headers: authHeaders(adminToken),
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(team(body, 'alpha').tier).toBe('high');
        expect(team(body, 'beta').tier).toBe('medium');
        expect(team(body, 'gamma').tier).toBe('low');
        expect(team(body, 'delta').tier).toBe('none');
        // Breakdown surfaces the per-developer mix behind the tier.
        expect(team(body, 'alpha').tier_breakdown).toEqual({high: 2, medium: 0, low: 0, none: 0});
        expect(team(body, 'delta').tier_breakdown).toEqual({high: 0, medium: 0, low: 0, none: 1});
    });

    it('uses the weakest-link rule: a part-connected team reads medium, not high', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/compare?teams=alpha,epsilon&range=lifetime',
            headers: authHeaders(adminToken),
        });
        expect(res.statusCode).toBe(200);
        const epsilon = team(res.json(), 'epsilon');
        // e1 is API (high), e2 git-only (medium): weakest data-bearing signal wins.
        expect(epsilon.tier).toBe('medium');
        expect(epsilon.tier_breakdown).toEqual({high: 1, medium: 1, low: 0, none: 0});
    });

    // ── max-4 / min-2 enforcement ─────────────────────────────────────────────
    it('rejects more than 4 teams with a 400', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/compare?teams=alpha,beta,gamma,delta,epsilon&range=lifetime',
            headers: authHeaders(adminToken),
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toMatch(/at most 4/i);
    });

    it('rejects fewer than 2 teams with a 400', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/compare?teams=alpha&range=lifetime',
            headers: authHeaders(adminToken),
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toMatch(/at least 2/i);
    });

    it('de-duplicates repeated team names before counting (alpha,alpha → too few)', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/compare?teams=alpha,alpha&range=lifetime',
            headers: authHeaders(adminToken),
        });
        expect(res.statusCode).toBe(400);
    });

    // ── range handling ────────────────────────────────────────────────────────
    it('accepts every preset range and echoes it back', async () => {
        for (const range of ['30d', '90d', 'year', 'lifetime']) {
            const res = await app.inject({
                method: 'GET',
                url: `/api/compare?teams=alpha,beta&range=${range}`,
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.range).toBe(range);
        }
    });

    it('accepts a custom range', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/compare?teams=alpha,beta&range=custom&from=2026-04-01&to=2026-06-30',
            headers: authHeaders(adminToken),
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().data.from).toBe('2026-04-01');
        expect(res.json().data.to).toBe('2026-06-30');
    });

    it('400s on an unknown range', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/compare?teams=alpha,beta&range=forever',
            headers: authHeaders(adminToken),
        });
        expect(res.statusCode).toBe(400);
    });

    it('400s on a malformed custom range (from after to)', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/compare?teams=alpha,beta&range=custom&from=2026-06-30&to=2026-04-01',
            headers: authHeaders(adminToken),
        });
        expect(res.statusCode).toBe(400);
    });

    // ── existence + gating ────────────────────────────────────────────────────
    it('404s when any requested team does not exist', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/compare?teams=alpha,ghost&range=lifetime',
            headers: authHeaders(adminToken),
        });
        expect(res.statusCode).toBe(404);
        expect(res.json().message).toMatch(/ghost/);
    });

    it('403s for the developer role', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/compare?teams=alpha,beta&range=lifetime',
            headers: authHeaders(devToken),
        });
        expect(res.statusCode).toBe(403);
    });

    it('assembles a shaped no-data result for a window with no snapshots', async () => {
        // A future window has no snapshots for either team; the assembly path
        // must return nulls/zeros/empties (not NaN or a throw), and delta — a
        // team with a developer but no data at all — must read tier 'none'.
        const res = await app.inject({
            method: 'GET',
            url: '/api/compare?teams=alpha,delta&range=custom&from=2099-01-01&to=2099-01-31',
            headers: authHeaders(adminToken),
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();

        const alpha = team(body, 'alpha');
        // alpha has developers but none active in this window.
        expect(alpha.metrics.developer_count).toBe(2);
        expect(alpha.metrics.active_developer_count).toBe(0);
        expect(alpha.metrics.utilization_rate).toBe(0);
        expect(alpha.metrics.total_prs_merged).toBe(0);
        expect(alpha.metrics.cost_per_pr).toBeNull(); // 0 PRs → null, not a divide
        expect(alpha.metrics.avg_code_churn).toBeNull();
        expect(alpha.metrics.tool_mix).toEqual([]);
        expect(alpha.metrics.ai_maturity_score).toBeNull(); // no quarter overlaps
        expect(alpha.trend).toEqual([]);

        const delta = team(body, 'delta');
        // One developer, no data of any kind → utilization null (no /0 NaN), none tier.
        expect(delta.metrics.developer_count).toBe(1);
        expect(delta.metrics.utilization_rate).toBe(0);
        expect(delta.tier).toBe('none');
        expect(delta.metrics.tool_mix).toEqual([]);
        expect(delta.trend).toEqual([]);
    });

    it('serves a comparison well under the 2s budget', async () => {
        const start = performance.now();
        const res = await app.inject({
            method: 'GET',
            url: '/api/compare?teams=alpha,beta,gamma,delta&range=lifetime',
            headers: authHeaders(adminToken),
        });
        const elapsed = performance.now() - start;
        expect(res.statusCode).toBe(200);
        expect(elapsed).toBeLessThan(2000);
    });
});
