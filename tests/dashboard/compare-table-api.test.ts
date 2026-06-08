/**
 * Sortable all-teams table API (Task 4.10 / #105):
 * GET /api/teams/compare-table?period=<quarter>.
 *
 * Covers the acceptance criteria the issue lists for the endpoint: every
 * overseen team listed once; the period selector picking which quarter's
 * pre-computed aggregates are returned; the full column set (utilization, active
 * devs, cost, cost-per-PR, churn, maturity + git_estimate basis, waste); the
 * per-team data-quality tier (incl. the weakest-link rule); teams with no row
 * for the period coming back with null metrics (still listed); period validation
 * + defaulting to the latest; and admin-role gating.
 */

import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {makeTestDb} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerCompareTableRoutes} from '../../src/dashboard/api/compare-table';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';

const PASSWORD = 'correct-horse-battery';
const CREATED = '2026-01-01T00:00:00.000Z';

async function buildApp(db: Database.Database): Promise<FastifyInstance> {
    const app = Fastify({logger: false});
    registerSessionAuth(app, db);
    registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
    registerCompareTableRoutes(app, db);
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

function seedTeam(db: Database.Database, name: string, created = CREATED): void {
    db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, ?, ?, ?)').run(
        name,
        'engineering',
        `${name}-mgr@test.com`,
        created,
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

/** A high-tier developer (API tool data) so a team can read tier 'high'. */
function seedTool(db: Database.Database, dev: string, date: string, tool: string): void {
    db.prepare(
        `INSERT INTO tool_snapshots
         (id, developer_id, date, tool, data_source, data_quality, is_active, interaction_count, acceptance_count, acceptance_rate)
         VALUES (?, ?, ?, ?, 'api', 'high', 1, 40, 30, 0.75)`,
    ).run(`tool:${dev}:${tool}:${date}`, dev, date, tool);
}

/** A medium-tier developer (git only) so a team can be dragged off 'high'. */
function seedGit(db: Database.Database, dev: string, date: string): void {
    db.prepare(
        `INSERT INTO git_snapshots (id, developer_id, date, commits, lines_added, lines_removed, prs_merged, code_churn_rate, ai_signature_score, data_source)
         VALUES (?, ?, ?, 3, 100, 20, 1, 0.2, 0.6, 'git')`,
    ).run(`git:${dev}:${date}`, dev, date);
}

interface QuarterlyOpts {
    developer_count?: number;
    active_developer_count?: number;
    utilization_rate?: number | null;
    total_subscription_cost?: number | null;
    cost_per_pr?: number | null;
    avg_code_churn?: number | null;
    total_prs_merged?: number | null;
    ai_maturity_score?: number | null;
    ai_maturity_basis?: string | null;
    wasted_spend?: number | null;
    unused_seat_count?: number | null;
}

function seedQuarterly(db: Database.Database, team: string, quarter: string, opts: QuarterlyOpts = {}): void {
    // `pick` respects an EXPLICIT null in opts (vs. an omitted key, which takes
    // the default) — `??` would wrongly treat an intentional null as missing.
    function pick<K extends keyof QuarterlyOpts>(key: K, fallback: QuarterlyOpts[K]): QuarterlyOpts[K] {
        return key in opts ? opts[key] : fallback;
    }
    db.prepare(
        `INSERT INTO quarterly_aggregates
         (id, team, quarter, developer_count, active_developer_count, utilization_rate,
          total_subscription_cost, total_estimated_api_cost, unused_seat_count, wasted_spend,
          avg_code_churn, total_prs_merged, cost_per_pr, ai_maturity_score, ai_maturity_basis, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        `q:${team}:${quarter}`,
        team,
        quarter,
        pick('developer_count', 2),
        pick('active_developer_count', 1),
        pick('utilization_rate', 0.5),
        pick('total_subscription_cost', 100),
        pick('unused_seat_count', 0),
        pick('wasted_spend', 0),
        pick('avg_code_churn', 0.2),
        pick('total_prs_merged', 4),
        pick('cost_per_pr', 25),
        pick('ai_maturity_score', 60),
        pick('ai_maturity_basis', 'git_estimate'),
        CREATED,
    );
}

interface TableTeam {
    name: string;
    department: string | null;
    manager: string | null;
    tier: string;
    tier_breakdown: {high: number; medium: number; low: number; none: number};
    metrics: {
        developer_count: number;
        active_developer_count: number;
        utilization_rate: number | null;
        total_subscription_cost: number | null;
        cost_per_pr: number | null;
        avg_code_churn: number | null;
        total_prs_merged: number | null;
        ai_maturity_score: number | null;
        ai_maturity_basis: string | null;
        wasted_spend: number | null;
        unused_seat_count: number | null;
    } | null;
}

interface TableResponse {
    data: {period: string | null; available_periods: string[]; teams: TableTeam[]};
}

function find(body: TableResponse, name: string): TableTeam {
    const found = body.data.teams.find((t) => t.name === name);
    if (!found) {
        throw new Error(`team '${name}' not in response`);
    }
    return found;
}

describe('GET /api/teams/compare-table', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let adminToken: string;

    beforeEach(async () => {
        db = makeTestDb();
        const hash = await hashPassword(PASSWORD);
        createUser(db, {email: 'admin@test.com', passwordHash: hash, role: 'admin'});
        app = await buildApp(db);
        adminToken = await login(app, 'admin@test.com');
    });

    afterEach(async () => {
        await app.close();
        db.close();
    });

    it('lists every overseen team once for the period, in name order', async () => {
        seedTeam(db, 'alpha');
        seedTeam(db, 'bravo');
        seedTeam(db, 'charlie');
        seedQuarterly(db, 'alpha', '2026-Q1');
        seedQuarterly(db, 'bravo', '2026-Q1');
        seedQuarterly(db, 'charlie', '2026-Q1');

        const res = await app.inject({
            method: 'GET',
            url: '/api/teams/compare-table?period=2026-Q1',
            headers: authHeaders(adminToken),
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as TableResponse;
        expect(body.data.period).toBe('2026-Q1');
        expect(body.data.teams.map((t) => t.name)).toEqual(['alpha', 'bravo', 'charlie']);
        // One row per team, no duplicates.
        expect(new Set(body.data.teams.map((t) => t.name)).size).toBe(3);
    });

    it('returns the full column set from the pre-computed aggregate', async () => {
        seedTeam(db, 'alpha');
        seedQuarterly(db, 'alpha', '2026-Q1', {
            developer_count: 5,
            active_developer_count: 4,
            utilization_rate: 0.8,
            total_subscription_cost: 250,
            cost_per_pr: 12.5,
            avg_code_churn: 0.33,
            total_prs_merged: 20,
            ai_maturity_score: 72,
            ai_maturity_basis: 'git_estimate',
            wasted_spend: 40,
            unused_seat_count: 2,
        });

        const res = await app.inject({
            method: 'GET',
            url: '/api/teams/compare-table?period=2026-Q1',
            headers: authHeaders(adminToken),
        });
        const body = res.json() as TableResponse;
        const alpha = find(body, 'alpha');
        expect(alpha.metrics).toEqual({
            developer_count: 5,
            active_developer_count: 4,
            utilization_rate: 0.8,
            total_subscription_cost: 250,
            cost_per_pr: 12.5,
            avg_code_churn: 0.33,
            total_prs_merged: 20,
            ai_maturity_score: 72,
            ai_maturity_basis: 'git_estimate',
            wasted_spend: 40,
            unused_seat_count: 2,
        });
    });

    it('defaults to the latest rolled-up quarter and lists available periods desc', async () => {
        seedTeam(db, 'alpha');
        seedQuarterly(db, 'alpha', '2025-Q4', {ai_maturity_score: 30});
        seedQuarterly(db, 'alpha', '2026-Q1', {ai_maturity_score: 50});
        seedQuarterly(db, 'alpha', '2026-Q2', {ai_maturity_score: 70});

        const res = await app.inject({
            method: 'GET',
            url: '/api/teams/compare-table',
            headers: authHeaders(adminToken),
        });
        const body = res.json() as TableResponse;
        expect(body.data.period).toBe('2026-Q2');
        expect(body.data.available_periods).toEqual(['2026-Q2', '2026-Q1', '2025-Q4']);
        expect(find(body, 'alpha').metrics?.ai_maturity_score).toBe(70);
    });

    it('changes the underlying aggregates when the period changes', async () => {
        seedTeam(db, 'alpha');
        seedQuarterly(db, 'alpha', '2026-Q1', {utilization_rate: 0.2, ai_maturity_score: 40});
        seedQuarterly(db, 'alpha', '2026-Q2', {utilization_rate: 0.9, ai_maturity_score: 80});

        const q1 = (
            await app.inject({
                method: 'GET',
                url: '/api/teams/compare-table?period=2026-Q1',
                headers: authHeaders(adminToken),
            })
        ).json() as TableResponse;
        const q2 = (
            await app.inject({
                method: 'GET',
                url: '/api/teams/compare-table?period=2026-Q2',
                headers: authHeaders(adminToken),
            })
        ).json() as TableResponse;

        expect(find(q1, 'alpha').metrics?.utilization_rate).toBe(0.2);
        expect(find(q1, 'alpha').metrics?.ai_maturity_score).toBe(40);
        expect(find(q2, 'alpha').metrics?.utilization_rate).toBe(0.9);
        expect(find(q2, 'alpha').metrics?.ai_maturity_score).toBe(80);
    });

    it('lists a team with no aggregate row for the period with null metrics', async () => {
        seedTeam(db, 'alpha');
        seedTeam(db, 'bravo');
        // Only alpha has a row this quarter; bravo joined later / not yet rolled up.
        seedQuarterly(db, 'alpha', '2026-Q1');

        const res = await app.inject({
            method: 'GET',
            url: '/api/teams/compare-table?period=2026-Q1',
            headers: authHeaders(adminToken),
        });
        const body = res.json() as TableResponse;
        expect(body.data.teams).toHaveLength(2);
        expect(find(body, 'alpha').metrics).not.toBeNull();
        expect(find(body, 'bravo').metrics).toBeNull();
    });

    it('carries each team data-quality tier (weakest-link) regardless of period', async () => {
        // alpha: one API + one git developer → weakest-link tier is 'medium'.
        seedTeam(db, 'alpha');
        seedDeveloper(db, 'a-api', 'alpha');
        seedDeveloper(db, 'a-git', 'alpha');
        seedTool(db, 'a-api', '2026-05-01', 'copilot');
        seedGit(db, 'a-git', '2026-05-01');
        // bravo: both API developers → tier 'high'.
        seedTeam(db, 'bravo');
        seedDeveloper(db, 'b-1', 'bravo');
        seedDeveloper(db, 'b-2', 'bravo');
        seedTool(db, 'b-1', '2026-05-01', 'copilot');
        seedTool(db, 'b-2', '2026-05-01', 'copilot');

        seedQuarterly(db, 'alpha', '2026-Q1');
        seedQuarterly(db, 'bravo', '2026-Q1');

        const res = await app.inject({
            method: 'GET',
            url: '/api/teams/compare-table?period=2026-Q1',
            headers: authHeaders(adminToken),
        });
        const body = res.json() as TableResponse;
        const alpha = find(body, 'alpha');
        expect(alpha.tier).toBe('medium');
        expect(alpha.tier_breakdown).toEqual({high: 1, medium: 1, low: 0, none: 0});
        expect(find(body, 'bravo').tier).toBe('high');
    });

    it('still lists teams (no period) when no aggregates have been computed', async () => {
        seedTeam(db, 'alpha');
        seedTeam(db, 'bravo');

        const res = await app.inject({
            method: 'GET',
            url: '/api/teams/compare-table',
            headers: authHeaders(adminToken),
        });
        const body = res.json() as TableResponse;
        expect(body.data.period).toBeNull();
        expect(body.data.available_periods).toEqual([]);
        expect(body.data.teams.map((t) => t.name)).toEqual(['alpha', 'bravo']);
        expect(body.data.teams.every((t) => t.metrics === null)).toBe(true);
    });

    it('returns the requested period with all-null rows when it has no data', async () => {
        seedTeam(db, 'alpha');
        seedQuarterly(db, 'alpha', '2026-Q1');

        const res = await app.inject({
            method: 'GET',
            url: '/api/teams/compare-table?period=2026-Q2',
            headers: authHeaders(adminToken),
        });
        const body = res.json() as TableResponse;
        expect(body.data.period).toBe('2026-Q2');
        expect(find(body, 'alpha').metrics).toBeNull();
        // The other quarter that does have data is still advertised for the selector.
        expect(body.data.available_periods).toContain('2026-Q1');
    });

    it('rejects a malformed period with 400', async () => {
        seedTeam(db, 'alpha');
        const res = await app.inject({
            method: 'GET',
            url: '/api/teams/compare-table?period=2026-13',
            headers: authHeaders(adminToken),
        });
        expect(res.statusCode).toBe(400);
    });

    it('preserves a null metric column (e.g. cost-per-PR with no PRs)', async () => {
        seedTeam(db, 'alpha');
        seedQuarterly(db, 'alpha', '2026-Q1', {cost_per_pr: null, total_prs_merged: 0, utilization_rate: null});

        const res = await app.inject({
            method: 'GET',
            url: '/api/teams/compare-table?period=2026-Q1',
            headers: authHeaders(adminToken),
        });
        const body = res.json() as TableResponse;
        const alpha = find(body, 'alpha');
        expect(alpha.metrics?.cost_per_pr).toBeNull();
        expect(alpha.metrics?.utilization_rate).toBeNull();
        expect(alpha.metrics?.total_prs_merged).toBe(0);
    });

    it('rejects a non-admin (developer) with 403', async () => {
        seedTeam(db, 'alpha');
        seedDeveloper(db, 'dev-1', 'alpha');
        createUser(db, {
            email: 'dev@test.com',
            passwordHash: await hashPassword(PASSWORD),
            role: 'developer',
            developerId: 'dev-1',
        });
        const devToken = await login(app, 'dev@test.com');

        const res = await app.inject({
            method: 'GET',
            url: '/api/teams/compare-table?period=2026-Q1',
            headers: authHeaders(devToken),
        });
        expect(res.statusCode).toBe(403);
    });

    it('requires authentication', async () => {
        const res = await app.inject({method: 'GET', url: '/api/teams/compare-table'});
        expect(res.statusCode).toBe(401);
    });
});
