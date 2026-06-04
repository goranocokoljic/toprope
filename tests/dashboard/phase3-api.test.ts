/**
 * Phase 3 API endpoints (Task 3.11 / #80): aggregates, maturity trend, summaries.
 *
 * Exercises each endpoint against seeded fixtures — correct shape, range
 * variations (incl. lifetime + custom), most-recent ordering + is_stale, focus
 * pass-through on regenerate, on-demand quarterly/yearly generation, basis/tier
 * presence, and admin-role gating (403 for the developer role).
 */

import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {makeTestDb} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerMeRoutes} from '../../src/dashboard/api/me';
import {registerAggregateRoutes} from '../../src/dashboard/api/aggregates';
import {registerMaturityRoutes} from '../../src/dashboard/api/maturity';
import {registerSummaryRoutes} from '../../src/dashboard/api/summaries';
import type {SummaryModelClient} from '../../src/summaries/model-client';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';

const PASSWORD = 'correct-horse-battery';
const NOW = '2026-05-30T00:00:00.000Z';

/** A fake model that always succeeds with neutral, guard-safe narrative text. */
const FAKE_TEXT = 'Engineering output held steady this period with healthy commit throughput and clean churn.';
function fakeClient(): SummaryModelClient {
    return {
        modelName: 'fake-model',
        generate: async () => ({ok: true, text: FAKE_TEXT, model: 'fake-model'}),
    } as unknown as SummaryModelClient;
}

async function buildApp(db: Database.Database): Promise<FastifyInstance> {
    const app = Fastify({logger: false});
    registerSessionAuth(app, db);
    registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
    registerMeRoutes(app, db);
    registerAggregateRoutes(app, db);
    registerMaturityRoutes(app, db);
    registerSummaryRoutes(app, db, undefined, {createClient: () => fakeClient()});
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
    db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run(name, NOW);
}

function seedDeveloper(db: Database.Database, id: string, team: string): void {
    db.prepare(
        'INSERT INTO developers (id, external_ids, name, email, team, created_at) VALUES (?, NULL, ?, ?, ?, ?)',
    ).run(id, id, `${id}@example.com`, team, NOW);
}

function seedGitSnapshot(db: Database.Database, developer: string, date: string): void {
    db.prepare(
        `INSERT INTO git_snapshots (id, developer_id, date, commits, lines_added, lines_removed, prs_merged, code_churn_rate, ai_signature_score, data_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'git')`,
    ).run(`${developer}-${date}`, developer, date, 5, 200, 40, 2, 0.2, 0.7);
}

function seedWeekly(db: Database.Database, developer: string, team: string, weekStart: string): void {
    db.prepare(
        `INSERT INTO weekly_aggregates (id, developer_id, week_start, team, active_days, total_commits, total_prs_merged, tools_used, computed_at)
         VALUES (?, ?, ?, ?, 4, 12, 3, ?, ?)`,
    ).run(`weekly:${developer}:${weekStart}`, developer, weekStart, team, JSON.stringify(['copilot']), NOW);
}

function seedMonthly(db: Database.Database, developer: string, team: string, month: string): void {
    db.prepare(
        `INSERT INTO monthly_aggregates (id, developer_id, month, team, active_days, total_commits, tools_used, computed_at)
         VALUES (?, ?, ?, ?, 18, 50, ?, ?)`,
    ).run(`monthly:${developer}:${month}`, developer, month, team, JSON.stringify(['copilot', 'claude_code']), NOW);
}

function seedQuarterly(
    db: Database.Database,
    team: string,
    quarter: string,
    score: number | null,
    delta: number | null = null,
): void {
    db.prepare(
        `INSERT INTO quarterly_aggregates (id, team, quarter, developer_count, ai_maturity_score, ai_maturity_basis, maturity_score_delta, computed_at)
         VALUES (?, ?, ?, 2, ?, 'git_estimate', ?, ?)`,
    ).run(`quarterly:${team}:${quarter}`, team, quarter, score, delta, NOW);
}

function seedYearly(db: Database.Database, team: string, year: string, score: number | null): void {
    db.prepare(
        `INSERT INTO yearly_aggregates (id, team, year, developer_count, ai_maturity_score, ai_maturity_basis, computed_at)
         VALUES (?, ?, ?, 2, ?, 'git_estimate', ?)`,
    ).run(`yearly:${team}:${year}`, team, year, score, NOW);
}

function seedSummary(
    db: Database.Database,
    opts: {
        scope: 'team' | 'org';
        scopeName: string;
        periodType: string;
        periodValue: string;
        generatedAt: string;
        isStale?: 0 | 1;
        regenCount?: number;
    },
): string {
    const id = `summary:${opts.scope}:${opts.scopeName}:${opts.periodType}:${opts.periodValue}`;
    db.prepare(
        `INSERT INTO summaries (id, scope, scope_name, period_type, period_value, summary_text, model_used, data_hash, input_hash, generated_at, regenerated_count, is_stale, ai_maturity_basis, data_quality)
         VALUES (?, ?, ?, ?, ?, ?, 'm', 'h', 'h', ?, ?, ?, 'git_estimate', 'medium')`,
    ).run(
        id,
        opts.scope,
        opts.scopeName,
        opts.periodType,
        opts.periodValue,
        `Narrative for ${opts.scopeName} ${opts.periodValue}`,
        opts.generatedAt,
        opts.regenCount ?? 0,
        opts.isStale ?? 0,
    );
    return id;
}

describe('Phase 3 API (Task 3.11)', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let adminToken: string;
    let devToken: string;

    beforeEach(async () => {
        db = makeTestDb();
        const hash = await hashPassword(PASSWORD);
        createUser(db, {email: 'admin@test.com', passwordHash: hash, role: 'admin'});
        createUser(db, {email: 'dev@test.com', passwordHash: hash, role: 'developer'});
        seedTeam(db, 'frontend');
        seedTeam(db, 'backend');
        seedDeveloper(db, 'dev-1', 'frontend');
        seedDeveloper(db, 'dev-2', 'backend');
        app = await buildApp(db);
        adminToken = await login(app, 'admin@test.com');
        devToken = await login(app, 'dev@test.com');
    });

    afterEach(async () => {
        await app.close();
        db.close();
    });

    // ── aggregates ────────────────────────────────────────────────────────────
    describe('GET /api/aggregates/:scope/:level', () => {
        beforeEach(() => {
            seedWeekly(db, 'dev-1', 'frontend', '2026-05-25');
            seedWeekly(db, 'dev-2', 'backend', '2026-05-25');
            seedMonthly(db, 'dev-1', 'frontend', '2026-05');
            seedQuarterly(db, 'frontend', '2026-Q2', 71);
            seedQuarterly(db, 'backend', '2026-Q2', 64);
            seedYearly(db, 'frontend', '2026', 68);
        });

        it('returns a team weekly aggregate with tools_used parsed to an array', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/aggregates/team:frontend/weekly?period=2026-05-25',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.data.scope).toBe('team:frontend');
            expect(body.data.level).toBe('weekly');
            expect(body.data.period).toBe('2026-05-25');
            expect(body.data.rows).toHaveLength(1);
            expect(body.data.rows[0].developer_id).toBe('dev-1');
            expect(body.data.rows[0].tools_used).toEqual(['copilot']);
        });

        it('normalizes any in-week date to the Monday week_start', async () => {
            // 2026-05-27 is a Wednesday in the week starting Monday 2026-05-25.
            const res = await app.inject({
                method: 'GET',
                url: '/api/aggregates/team:frontend/weekly?period=2026-05-27',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.period).toBe('2026-05-25');
            expect(res.json().data.rows).toHaveLength(1);
        });

        it('returns every developer row for the org weekly scope', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/aggregates/org/weekly?period=2026-05-25',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            // Ordered by team then developer: backend (dev-2) precedes frontend (dev-1).
            expect(res.json().data.rows.map((r: {developer_id: string}) => r.developer_id)).toEqual([
                'dev-2',
                'dev-1',
            ]);
        });

        it('returns the team-level quarterly row with maturity basis', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/aggregates/team:frontend/quarterly?period=2026-Q2',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.rows).toHaveLength(1);
            expect(res.json().data.rows[0].ai_maturity_score).toBe(71);
            expect(res.json().data.rows[0].ai_maturity_basis).toBe('git_estimate');
        });

        it('returns all team rows for the org quarterly scope', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/aggregates/org/quarterly?period=2026-Q2',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.rows.map((r: {team: string}) => r.team)).toEqual(['backend', 'frontend']);
        });

        it('returns the yearly team row', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/aggregates/team:frontend/yearly?period=2026',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.rows[0].ai_maturity_score).toBe(68);
        });

        it('400s on a missing period', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/aggregates/org/weekly',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(400);
        });

        it('400s on an invalid period for the level', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/aggregates/org/monthly?period=2026-13',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(400);
        });

        it('400s on a rolled-over weekly date (2026-02-31), not silently the wrong week', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/aggregates/team:frontend/weekly?period=2026-02-31',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(400);
        });

        it('400s on an unknown level', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/aggregates/org/daily?period=2026-05-25',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(400);
        });

        it('400s on a malformed scope', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/aggregates/bogus/weekly?period=2026-05-25',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(400);
        });

        it('404s on an unknown team', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/aggregates/team:ghost/quarterly?period=2026-Q2',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(404);
        });

        it('403s for the developer role', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/aggregates/org/weekly?period=2026-05-25',
                headers: authHeaders(devToken),
            });
            expect(res.statusCode).toBe(403);
        });

        it('serves a pre-computed aggregate read well under 200ms', async () => {
            const start = performance.now();
            const res = await app.inject({
                method: 'GET',
                url: '/api/aggregates/org/quarterly?period=2026-Q2',
                headers: authHeaders(adminToken),
            });
            const elapsed = performance.now() - start;
            expect(res.statusCode).toBe(200);
            expect(elapsed).toBeLessThan(200);
        });
    });

    // ── maturity trend ──────────────────────────────────────────────────────────
    describe('GET /api/maturity/:team/trend', () => {
        beforeEach(() => {
            seedQuarterly(db, 'frontend', '2025-Q1', 40);
            seedQuarterly(db, 'frontend', '2025-Q2', 50);
            seedQuarterly(db, 'frontend', '2026-Q1', 60, 10);
            seedQuarterly(db, 'frontend', '2026-Q2', 71, 11);
        });

        it('returns score + basis per quarter, chronological', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/maturity/frontend/trend?range=lifetime',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            const points = res.json().data.points;
            expect(points.map((p: {period: string}) => p.period)).toEqual([
                '2025-Q1',
                '2025-Q2',
                '2026-Q1',
                '2026-Q2',
            ]);
            expect(points[0].score).toBe(40);
            expect(points[0].basis).toBe('git_estimate');
            expect(points[3].score_delta).toBe(11);
        });

        it('respects a custom range, including only overlapping quarters', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/maturity/frontend/trend?range=custom&from=2026-01-01&to=2026-06-30',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.points.map((p: {period: string}) => p.period)).toEqual([
                '2026-Q1',
                '2026-Q2',
            ]);
        });

        it('includes a quarter a short 30d range lands mid-way through (overlap)', async () => {
            const res = await app.inject({
                method: 'GET',
                // A 30d window ending 2026-05-15 sits inside Q2 2026.
                url: '/api/maturity/frontend/trend?range=custom&from=2026-04-16&to=2026-05-15',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.points.map((p: {period: string}) => p.period)).toEqual(['2026-Q2']);
        });

        it('returns 30d/90d/year ranges without error', async () => {
            for (const range of ['30d', '90d', 'year']) {
                const res = await app.inject({
                    method: 'GET',
                    url: `/api/maturity/frontend/trend?range=${range}`,
                    headers: authHeaders(adminToken),
                });
                expect(res.statusCode).toBe(200);
                expect(res.json().data.range).toBe(range);
            }
        });

        it('400s on an unknown range', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/maturity/frontend/trend?range=forever',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(400);
        });

        it('404s on an unknown team', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/maturity/ghost/trend?range=lifetime',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(404);
        });

        it('403s for the developer role', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/maturity/frontend/trend?range=lifetime',
                headers: authHeaders(devToken),
            });
            expect(res.statusCode).toBe(403);
        });
    });

    // ── maturity trend: org scope (Task 3.12 / #81) ───────────────────────────
    describe('GET /api/maturity/org/trend', () => {
        /** Quarterly row with an explicit developer_count so weighting is testable. */
        function seedQuarterlyWeighted(
            team: string,
            quarter: string,
            score: number | null,
            devs: number,
        ): void {
            db.prepare(
                `INSERT INTO quarterly_aggregates (id, team, quarter, developer_count, ai_maturity_score, ai_maturity_basis, computed_at)
                 VALUES (?, ?, ?, ?, ?, 'git_estimate', ?)`,
            ).run(`quarterly:${team}:${quarter}`, team, quarter, devs, score, NOW);
        }

        it('folds teams into a developer-count-weighted org score per quarter', async () => {
            // 2026-Q1: frontend 60 (4 devs) + backend 80 (1 dev) → (240+80)/5 = 64.
            seedQuarterlyWeighted('frontend', '2026-Q1', 60, 4);
            seedQuarterlyWeighted('backend', '2026-Q1', 80, 1);
            // 2026-Q2: frontend 70 (4 devs) + backend 90 (1 dev) → (280+90)/5 = 74.
            seedQuarterlyWeighted('frontend', '2026-Q2', 70, 4);
            seedQuarterlyWeighted('backend', '2026-Q2', 90, 1);

            const res = await app.inject({
                method: 'GET',
                url: '/api/maturity/org/trend?range=lifetime',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            const points = res.json().data.points;
            expect(points.map((p: {period: string}) => p.period)).toEqual(['2026-Q1', '2026-Q2']);
            expect(points[0].score).toBe(64);
            expect(points[0].basis).toBe('git_estimate');
            expect(points[0].score_delta).toBe(null);
            // Org delta is the difference of org scores: 74 - 64 = 10.
            expect(points[1].score).toBe(74);
            expect(points[1].score_delta).toBe(10);
        });

        it('ignores teams with a null score and skips a no-score quarter for the score', async () => {
            seedQuarterlyWeighted('frontend', '2026-Q1', 50, 2);
            seedQuarterlyWeighted('backend', '2026-Q1', null, 3); // null score → not weighted in
            const res = await app.inject({
                method: 'GET',
                url: '/api/maturity/org/trend?range=lifetime',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            const points = res.json().data.points;
            // Only frontend contributes, so the org score is frontend's score.
            expect(points[0].score).toBe(50);
        });

        it('reports a mixed basis once a contributing team upgrades past git_estimate', async () => {
            seedQuarterlyWeighted('frontend', '2026-Q1', 60, 2);
            db.prepare(
                `INSERT INTO quarterly_aggregates (id, team, quarter, developer_count, ai_maturity_score, ai_maturity_basis, computed_at)
                 VALUES ('quarterly:backend:2026-Q1', 'backend', '2026-Q1', 2, 80, 'mixed', ?)`,
            ).run(NOW);
            const res = await app.inject({
                method: 'GET',
                url: '/api/maturity/org/trend?range=lifetime',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.points[0].basis).toBe('mixed');
        });

        it('returns an empty series (not 404) when no quarters exist', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/maturity/org/trend?range=lifetime',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.points).toEqual([]);
        });

        it('403s for the developer role', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/maturity/org/trend?range=lifetime',
                headers: authHeaders(devToken),
            });
            expect(res.statusCode).toBe(403);
        });
    });

    // ── summaries: list + detail ──────────────────────────────────────────────
    describe('GET /api/summaries', () => {
        beforeEach(() => {
            seedSummary(db, {
                scope: 'org',
                scopeName: 'org',
                periodType: 'monthly',
                periodValue: '2026-04',
                generatedAt: '2026-05-01T00:00:00.000Z',
            });
            seedSummary(db, {
                scope: 'org',
                scopeName: 'org',
                periodType: 'monthly',
                periodValue: '2026-05',
                generatedAt: '2026-06-01T00:00:00.000Z',
                isStale: 1,
            });
            seedSummary(db, {
                scope: 'team',
                scopeName: 'frontend',
                periodType: 'weekly',
                periodValue: '2026-W21',
                generatedAt: '2026-05-25T00:00:00.000Z',
            });
        });

        it('lists summaries most-recent-first with is_stale and basis/tier', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/summaries',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            const items = res.json().data;
            expect(items).toHaveLength(3);
            // generated_at descending: 2026-06-01, 2026-05-25, 2026-05-01.
            expect(items.map((i: {generated_at: string}) => i.generated_at)).toEqual([
                '2026-06-01T00:00:00.000Z',
                '2026-05-25T00:00:00.000Z',
                '2026-05-01T00:00:00.000Z',
            ]);
            expect(items[0].is_stale).toBe(1);
            expect(items[0].basis).toBe('git_estimate');
            expect(items[0].tier).toBe('medium');
            // The list view omits the heavy narrative text.
            expect(items[0].summary_text).toBeUndefined();
        });

        it('filters by level', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/summaries?level=weekly',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            const items = res.json().data;
            expect(items).toHaveLength(1);
            expect(items[0].period_type).toBe('weekly');
        });

        it('filters by team scope', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/summaries?scope=team:frontend',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            const items = res.json().data;
            expect(items).toHaveLength(1);
            expect(items[0].scope_name).toBe('frontend');
        });

        it('400s on an unknown level filter', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/summaries?level=daily',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(400);
        });

        it('403s for the developer role', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/summaries',
                headers: authHeaders(devToken),
            });
            expect(res.statusCode).toBe(403);
        });

        it('returns one summary with full text + metadata', async () => {
            const id = 'summary:org:org:monthly:2026-05';
            const res = await app.inject({
                method: 'GET',
                url: `/api/summaries/${encodeURIComponent(id)}`,
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            const data = res.json().data;
            expect(data.id).toBe(id);
            expect(data.summary_text).toContain('Narrative for org 2026-05');
            expect(data.model_used).toBe('m');
            expect(data.is_stale).toBe(1);
            expect(data.basis).toBe('git_estimate');
        });

        it('404s on an unknown summary id', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/summaries/summary:org:org:monthly:1999-01',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(404);
        });

        it('surfaces null basis/tier for a legacy row written before migration 018', async () => {
            // A row predating the basis columns: both are NULL.
            const id = 'summary:org:org:monthly:2026-03';
            db.prepare(
                `INSERT INTO summaries (id, scope, scope_name, period_type, period_value, summary_text, model_used, data_hash, input_hash, generated_at, regenerated_count, is_stale)
                 VALUES (?, 'org', 'org', 'monthly', '2026-03', 'Legacy narrative', 'm', 'h', 'h', '2026-04-01T00:00:00.000Z', 0, 0)`,
            ).run(id);
            const res = await app.inject({
                method: 'GET',
                url: `/api/summaries/${encodeURIComponent(id)}`,
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            const data = res.json().data;
            expect(data.basis).toBeNull();
            expect(data.tier).toBeNull();
            expect(data.data_basis).toBeNull();
        });
    });

    // ── summaries: regenerate + generate ────────────────────────────────────────
    describe('summary generation', () => {
        beforeEach(() => {
            // Developers with git activity in Q2 2026 so the scope has data to fold.
            seedGitSnapshot(db, 'dev-1', '2026-05-15');
            seedGitSnapshot(db, 'dev-2', '2026-05-16');
        });

        it('regenerates an existing summary and increments the count', async () => {
            const id = seedSummary(db, {
                scope: 'team',
                scopeName: 'frontend',
                periodType: 'quarterly',
                periodValue: '2026-Q2',
                generatedAt: '2026-06-01T00:00:00.000Z',
                regenCount: 0,
            });
            const res = await app.inject({
                method: 'POST',
                url: `/api/summaries/${encodeURIComponent(id)}/regenerate`,
                headers: authHeaders(adminToken),
                payload: {focus: 'cost efficiency'},
            });
            expect(res.statusCode).toBe(200);
            const data = res.json().data;
            expect(data.summary_text).toBe(FAKE_TEXT);
            expect(data.regenerated_count).toBe(1);
            expect(data.basis).toBe('git_estimate');
        });

        it('regenerating a stale summary clears is_stale', async () => {
            const id = seedSummary(db, {
                scope: 'team',
                scopeName: 'frontend',
                periodType: 'quarterly',
                periodValue: '2026-Q2',
                generatedAt: '2026-06-01T00:00:00.000Z',
                isStale: 1,
            });
            const res = await app.inject({
                method: 'POST',
                url: `/api/summaries/${encodeURIComponent(id)}/regenerate`,
                headers: authHeaders(adminToken),
                payload: {},
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.is_stale).toBe(0);
        });

        it('404s regenerating an unknown summary', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/summaries/summary:team:frontend:quarterly:1999-Q1/regenerate',
                headers: authHeaders(adminToken),
                payload: {},
            });
            expect(res.statusCode).toBe(404);
        });

        it('400s when focus is not a string', async () => {
            const id = seedSummary(db, {
                scope: 'team',
                scopeName: 'frontend',
                periodType: 'quarterly',
                periodValue: '2026-Q2',
                generatedAt: '2026-06-01T00:00:00.000Z',
            });
            const res = await app.inject({
                method: 'POST',
                url: `/api/summaries/${encodeURIComponent(id)}/regenerate`,
                headers: authHeaders(adminToken),
                payload: {focus: 42},
            });
            expect(res.statusCode).toBe(400);
        });

        it('generates a quarterly summary on demand', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/summaries/generate',
                headers: authHeaders(adminToken),
                payload: {level: 'quarterly', period: '2026-Q2', scope: 'team:frontend'},
            });
            expect(res.statusCode).toBe(200);
            const data = res.json().data;
            expect(data.summary_text).toBe(FAKE_TEXT);
            expect(data.period_type).toBe('quarterly');
            expect(data.period_value).toBe('2026-Q2');
            // Persisted so a follow-up read returns it.
            const read = await app.inject({
                method: 'GET',
                url: `/api/summaries/${encodeURIComponent(data.id)}`,
                headers: authHeaders(adminToken),
            });
            expect(read.statusCode).toBe(200);
        });

        it('generates a yearly org summary on demand', async () => {
            seedGitSnapshot(db, 'dev-1', '2026-02-10');
            const res = await app.inject({
                method: 'POST',
                url: '/api/summaries/generate',
                headers: authHeaders(adminToken),
                payload: {level: 'yearly', period: '2026', scope: 'org'},
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.period_type).toBe('yearly');
        });

        it('404s generating for an unknown team (consistent with the read endpoints)', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/summaries/generate',
                headers: authHeaders(adminToken),
                payload: {level: 'quarterly', period: '2026-Q2', scope: 'team:ghost'},
            });
            expect(res.statusCode).toBe(404);
        });

        it('400s on a malformed generate body', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/summaries/generate',
                headers: authHeaders(adminToken),
                payload: {level: 'quarterly', period: '2026-Q2'},
            });
            expect(res.statusCode).toBe(400);
        });

        it('400s on an invalid period for the level', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/summaries/generate',
                headers: authHeaders(adminToken),
                payload: {level: 'quarterly', period: '2026-13', scope: 'org'},
            });
            expect(res.statusCode).toBe(400);
        });

        it('403s generate for the developer role', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/summaries/generate',
                headers: authHeaders(devToken),
                payload: {level: 'quarterly', period: '2026-Q2', scope: 'team:frontend'},
            });
            expect(res.statusCode).toBe(403);
        });

        it('403s regenerate for the developer role', async () => {
            const id = seedSummary(db, {
                scope: 'team',
                scopeName: 'frontend',
                periodType: 'quarterly',
                periodValue: '2026-Q2',
                generatedAt: '2026-06-01T00:00:00.000Z',
            });
            const res = await app.inject({
                method: 'POST',
                url: `/api/summaries/${encodeURIComponent(id)}/regenerate`,
                headers: authHeaders(devToken),
                payload: {},
            });
            expect(res.statusCode).toBe(403);
        });
    });
});
