import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {makeTestDb} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerMeRoutes} from '../../src/dashboard/api/me';
import {registerDeveloperRoutes} from '../../src/dashboard/api/developers';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';

const PASSWORD = 'correct-horse-battery';
const NOW = '2026-05-30T00:00:00.000Z';

async function buildApp(db: Database.Database): Promise<FastifyInstance> {
    const app = Fastify({logger: false});
    registerSessionAuth(app, db);
    registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
    registerMeRoutes(app, db);
    registerDeveloperRoutes(app, db);
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

function seedToolSnapshot(
    db: Database.Database,
    opts: {
        developer: string;
        date: string;
        tool?: string;
        isActive?: boolean;
        interactions?: number;
        acceptances?: number;
        // Production connectors store a {feature: count} object; a legacy array
        // (names only) is also accepted. Both are exercised here.
        features?: string[] | Record<string, number>;
    },
): void {
    const tool = opts.tool ?? 'copilot';
    db.prepare(
        `INSERT INTO tool_snapshots
           (id, developer_id, date, tool, data_source, data_quality, is_active,
            interaction_count, acceptance_count, features_used)
         VALUES (?, ?, ?, ?, 'api', 'high', ?, ?, ?, ?)`,
    ).run(
        `${opts.developer}-${opts.date}-${tool}`,
        opts.developer,
        opts.date,
        tool,
        opts.isActive === false ? 0 : 1,
        opts.interactions ?? 0,
        opts.acceptances ?? 0,
        opts.features ? JSON.stringify(opts.features) : null,
    );
}

function seedGitSnapshot(
    db: Database.Database,
    opts: {
        developer: string;
        date: string;
        dataSource?: string;
        commits?: number;
        linesAdded?: number;
        linesRemoved?: number;
        prsOpened?: number;
        prsMerged?: number;
        churn?: number;
    },
): void {
    db.prepare(
        `INSERT INTO git_snapshots
           (id, developer_id, date, commits, lines_added, lines_removed, files_changed,
            prs_opened, prs_merged, code_churn_rate, data_source)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    ).run(
        `${opts.developer}-${opts.date}-${opts.dataSource ?? 'git'}`,
        opts.developer,
        opts.date,
        opts.commits ?? 1,
        opts.linesAdded ?? 0,
        opts.linesRemoved ?? 0,
        opts.prsOpened ?? 0,
        opts.prsMerged ?? 0,
        opts.churn ?? null,
        opts.dataSource ?? 'git',
    );
}

function seedSubscription(
    db: Database.Database,
    opts: {
        id: string;
        developer: string;
        tool: string;
        cost: number;
        revoked?: boolean;
        plan?: string;
        assignedAt?: string;
        revokedAt?: string;
    },
): void {
    const revokedAt = opts.revokedAt ?? (opts.revoked ? NOW : null);
    db.prepare(
        `INSERT INTO subscriptions
           (id, developer_id, tool, plan, billing_model, monthly_cost, seat_assigned_at,
            seat_revoked_at, data_source)
         VALUES (?, ?, ?, ?, 'company_managed', ?, ?, ?, 'expense_import')`,
    ).run(opts.id, opts.developer, opts.tool, opts.plan ?? 'pro', opts.cost, opts.assignedAt ?? NOW, revokedAt);
}

function seedPlanChange(
    db: Database.Database,
    opts: {
        id: string;
        developer: string;
        tool: string;
        oldTool?: string | null;
        oldPlan?: string | null;
        newPlan?: string | null;
        oldCost?: number | null;
        newCost?: number | null;
        changedAt: string;
    },
): void {
    db.prepare(
        `INSERT INTO plan_change_events
           (id, developer_id, tool, old_tool, old_plan, new_plan, old_monthly_cost,
            new_monthly_cost, changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        opts.id,
        opts.developer,
        opts.tool,
        opts.oldTool ?? null,
        opts.oldPlan ?? null,
        opts.newPlan ?? null,
        opts.oldCost ?? null,
        opts.newCost ?? null,
        opts.changedAt,
    );
}

interface MeRangeBody {
    data: {range: string; from: string; to: string} & Record<string, unknown>;
}

describe('Developer API (Task 2.4)', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let aliceToken: string;
    let bobToken: string;

    beforeEach(async () => {
        db = makeTestDb();
        const hash = await hashPassword(PASSWORD);

        seedTeam(db, 'eng');
        seedDeveloper(db, 'alice', 'eng');
        seedDeveloper(db, 'bob', 'eng');

        createUser(db, {email: 'alice@test.com', passwordHash: hash, role: 'developer', developerId: 'alice'});
        createUser(db, {email: 'bob@test.com', passwordHash: hash, role: 'developer', developerId: 'bob'});
        createUser(db, {email: 'admin@test.com', passwordHash: hash, role: 'admin'});

        app = await buildApp(db);
        aliceToken = await login(app, 'alice@test.com');
        bobToken = await login(app, 'bob@test.com');
    });

    afterEach(async () => {
        await app.close();
        db.close();
    });

    // ── authentication / scoping ─────────────────────────────────────────────
    describe('authentication and scoping', () => {
        const endpoints = [
            '/api/me/overview',
            '/api/me/tools',
            '/api/me/timeline',
            '/api/me/activity',
            '/api/me/journey',
        ];

        it('returns 401 for unauthenticated requests on every endpoint', async () => {
            for (const url of endpoints) {
                const res = await app.inject({method: 'GET', url});
                expect(res.statusCode, url).toBe(401);
            }
        });

        it('returns 404 for a developer-role account with no linked developer', async () => {
            const hash = await hashPassword(PASSWORD);
            createUser(db, {email: 'unlinked@test.com', passwordHash: hash, role: 'developer', developerId: null});
            const token = await login(app, 'unlinked@test.com');
            for (const url of endpoints) {
                const res = await app.inject({method: 'GET', url, headers: authHeaders(token)});
                expect(res.statusCode, url).toBe(404);
            }
        });

        it('scopes data to the session developer regardless of any developer_id passed', async () => {
            // Alice has activity, Bob does not. Even if Alice tries to pass bob's
            // id by any parameter or body, the result is always Alice's own data.
            seedToolSnapshot(db, {developer: 'alice', date: '2026-05-20', interactions: 10, acceptances: 5});

            const plain = await app.inject({method: 'GET', url: '/api/me/overview', headers: authHeaders(aliceToken)});
            const withQuery = await app.inject({
                method: 'GET',
                url: '/api/me/overview?developer_id=bob&developerId=bob&id=bob',
                headers: authHeaders(aliceToken),
            });

            expect(plain.statusCode).toBe(200);
            expect(withQuery.statusCode).toBe(200);
            // Both reflect Alice's activity (10 interactions → 1 active day), not Bob's empty data.
            expect((plain.json() as MeRangeBody).data.active_days).toBe(1);
            expect((withQuery.json() as MeRangeBody).data).toEqual((plain.json() as MeRangeBody).data);
        });

        it("bob never sees alice's data", async () => {
            seedToolSnapshot(db, {developer: 'alice', date: '2026-05-20', interactions: 10, acceptances: 5});
            seedSubscription(db, {id: 's-alice', developer: 'alice', tool: 'copilot', cost: 19});

            const res = await app.inject({method: 'GET', url: '/api/me/overview', headers: authHeaders(bobToken)});
            expect(res.statusCode).toBe(200);
            const {data} = res.json() as MeRangeBody;
            expect(data.active_days).toBe(0);
            expect(data.estimated_monthly_cost).toBe(0);
        });
    });

    // ── overview ─────────────────────────────────────────────────────────────
    describe('GET /api/me/overview', () => {
        it('summarises active days, primary tools, trend, and cost', async () => {
            seedToolSnapshot(db, {developer: 'alice', date: '2026-05-10', tool: 'copilot', interactions: 100, acceptances: 40});
            seedToolSnapshot(db, {developer: 'alice', date: '2026-05-12', tool: 'windsurf', interactions: 20, acceptances: 5});
            seedToolSnapshot(db, {developer: 'alice', date: '2026-05-28', tool: 'copilot', interactions: 100, acceptances: 70});
            seedGitSnapshot(db, {developer: 'alice', date: '2026-05-15', commits: 3});
            seedSubscription(db, {id: 's1', developer: 'alice', tool: 'copilot', cost: 19});
            seedSubscription(db, {id: 's2', developer: 'alice', tool: 'windsurf', cost: 15});
            seedSubscription(db, {id: 's3', developer: 'alice', tool: 'old', cost: 99, revoked: true});

            const res = await app.inject({
                method: 'GET',
                url: '/api/me/overview?range=custom&from=2026-05-01&to=2026-05-31',
                headers: authHeaders(aliceToken),
            });
            expect(res.statusCode).toBe(200);
            const {data} = res.json() as {
                data: {
                    active_days: number;
                    primary_tools: string[];
                    acceptance_rate: {current: number | null; previous: number | null; trend: string};
                    estimated_monthly_cost: number;
                };
            };
            // 3 tool-active days + 1 git-active day = 4 distinct active days.
            expect(data.active_days).toBe(4);
            // copilot has the most interactions, so it leads primary_tools.
            expect(data.primary_tools[0]).toBe('copilot');
            expect(data.primary_tools).toContain('windsurf');
            // Revoked seat excluded: 19 + 15 = 34.
            expect(data.estimated_monthly_cost).toBe(34);
            // Acceptance rate rose between the first and second half → 'up'.
            expect(data.acceptance_rate.trend).toBe('up');
        });

        it('reports a flat trend for a single-day window (no distinct halves to compare)', async () => {
            // The midpoint split must not double-count the only day into both
            // halves and read a false direction — a one-day window is 'flat'.
            seedToolSnapshot(db, {developer: 'alice', date: '2026-05-15', interactions: 100, acceptances: 90});
            const res = await app.inject({
                method: 'GET',
                url: '/api/me/overview?range=custom&from=2026-05-15&to=2026-05-15',
                headers: authHeaders(aliceToken),
            });
            expect(res.statusCode).toBe(200);
            const {data} = res.json() as {data: {acceptance_rate: {trend: string; current: number | null; previous: number | null}}};
            expect(data.acceptance_rate.trend).toBe('flat');
            expect(data.acceptance_rate.current).toBeCloseTo(0.9);
            expect(data.acceptance_rate.previous).toBeCloseTo(0.9);
        });

        it('does not double-count the midpoint day across the trend halves', async () => {
            // Two-day window: each day is its own half. A drop from day 1 to day 2
            // must read 'down', which only holds if the halves are disjoint.
            seedToolSnapshot(db, {developer: 'alice', date: '2026-05-10', interactions: 100, acceptances: 90});
            seedToolSnapshot(db, {developer: 'alice', date: '2026-05-11', interactions: 100, acceptances: 10});
            const res = await app.inject({
                method: 'GET',
                url: '/api/me/overview?range=custom&from=2026-05-10&to=2026-05-11',
                headers: authHeaders(aliceToken),
            });
            expect(res.statusCode).toBe(200);
            const {data} = res.json() as {data: {acceptance_rate: {trend: string; current: number | null; previous: number | null}}};
            expect(data.acceptance_rate.previous).toBeCloseTo(0.9);
            expect(data.acceptance_rate.current).toBeCloseTo(0.1);
            expect(data.acceptance_rate.trend).toBe('down');
        });

        it('reports zeros and a flat trend for a developer with no activity', async () => {
            const res = await app.inject({method: 'GET', url: '/api/me/overview', headers: authHeaders(aliceToken)});
            expect(res.statusCode).toBe(200);
            const {data} = res.json() as MeRangeBody & {
                data: {active_days: number; acceptance_rate: {trend: string}; primary_tools: string[]};
            };
            expect(data.active_days).toBe(0);
            expect((data as {primary_tools: string[]}).primary_tools).toEqual([]);
            expect((data as {acceptance_rate: {trend: string}}).acceptance_rate.trend).toBe('flat');
        });
    });

    // ── tools ────────────────────────────────────────────────────────────────
    describe('GET /api/me/tools', () => {
        it('breaks down activity, acceptance, feature counts, and cost per tool', async () => {
            // Production object form: {feature: count}. Counts sum across days.
            seedToolSnapshot(db, {
                developer: 'alice', date: '2026-05-10', tool: 'copilot',
                interactions: 50, acceptances: 30, features: {completions: 40, chat: 5},
            });
            seedToolSnapshot(db, {
                developer: 'alice', date: '2026-05-11', tool: 'copilot',
                interactions: 50, acceptances: 10, features: {chat: 3, chat_copies: 2},
            });
            seedToolSnapshot(db, {developer: 'alice', date: '2026-05-12', tool: 'windsurf', interactions: 10, acceptances: 8});
            seedSubscription(db, {id: 's1', developer: 'alice', tool: 'copilot', cost: 19});

            const res = await app.inject({
                method: 'GET',
                url: '/api/me/tools?range=custom&from=2026-05-01&to=2026-05-31',
                headers: authHeaders(aliceToken),
            });
            expect(res.statusCode).toBe(200);
            const {data} = res.json() as {
                data: {
                    tools: Array<{
                        tool: string;
                        active_days: number;
                        interactions: number;
                        acceptances: number;
                        acceptance_rate: number | null;
                        feature_usage: Array<{feature: string; count: number}>;
                        activity: Array<{date: string; interactions: number}>;
                        estimated_monthly_cost: number;
                    }>;
                };
            };
            const copilot = data.tools.find((t) => t.tool === 'copilot')!;
            expect(copilot.active_days).toBe(2);
            expect(copilot.interactions).toBe(100);
            expect(copilot.acceptances).toBe(40);
            expect(copilot.acceptance_rate).toBeCloseTo(0.4);
            // Per-feature counts, summed across both days and ordered most-used first.
            expect(copilot.feature_usage).toEqual([
                {feature: 'completions', count: 40},
                {feature: 'chat', count: 8},
                {feature: 'chat_copies', count: 2},
            ]);
            // Daily interaction series, ascending by date.
            expect(copilot.activity).toEqual([
                {date: '2026-05-10', interactions: 50},
                {date: '2026-05-11', interactions: 50},
            ]);
            expect(copilot.estimated_monthly_cost).toBe(19);

            const windsurf = data.tools.find((t) => t.tool === 'windsurf')!;
            expect(windsurf.estimated_monthly_cost).toBe(0); // no subscription
        });

        it('accepts the legacy array feature form and drops non-count metric keys', async () => {
            // Legacy array form counts one occurrence per name; ai_code_percentage
            // is a derived metric, not a usage count, so it is excluded.
            seedToolSnapshot(db, {
                developer: 'alice', date: '2026-05-10', tool: 'windsurf',
                interactions: 20, acceptances: 10, features: ['autocomplete', 'chat'],
            });
            seedToolSnapshot(db, {
                developer: 'alice', date: '2026-05-11', tool: 'windsurf',
                interactions: 20, acceptances: 10,
                features: {autocomplete: 100, ai_code_percentage: 37},
            });

            const res = await app.inject({
                method: 'GET',
                url: '/api/me/tools?range=custom&from=2026-05-01&to=2026-05-31',
                headers: authHeaders(aliceToken),
            });
            expect(res.statusCode).toBe(200);
            const {data} = res.json() as {
                data: {tools: Array<{tool: string; feature_usage: Array<{feature: string; count: number}>}>};
            };
            const windsurf = data.tools.find((t) => t.tool === 'windsurf')!;
            // autocomplete: 1 (array occurrence) + 100 (object count) = 101; chat: 1.
            // ai_code_percentage never appears.
            expect(windsurf.feature_usage).toEqual([
                {feature: 'autocomplete', count: 101},
                {feature: 'chat', count: 1},
            ]);
            expect(windsurf.feature_usage.some((f) => f.feature === 'ai_code_percentage')).toBe(false);
        });
    });

    // ── timeline ─────────────────────────────────────────────────────────────
    describe('GET /api/me/timeline', () => {
        it('returns a per-day series with PR overlay and respects the range window', async () => {
            seedToolSnapshot(db, {developer: 'alice', date: '2026-05-10', interactions: 5});
            seedGitSnapshot(db, {developer: 'alice', date: '2026-05-10', commits: 2, linesAdded: 100, prsOpened: 3, prsMerged: 1});
            seedToolSnapshot(db, {developer: 'alice', date: '2026-01-01', interactions: 9}); // outside window

            const res = await app.inject({
                method: 'GET',
                url: '/api/me/timeline?range=custom&from=2026-05-01&to=2026-05-31',
                headers: authHeaders(aliceToken),
            });
            expect(res.statusCode).toBe(200);
            const {data} = res.json() as {
                data: {
                    from: string;
                    to: string;
                    points: Array<{
                        date: string;
                        tool_activity: {interaction_count: number};
                        git_activity: {commits: number; prs_opened: number; prs_merged: number};
                    }>;
                };
            };
            expect(data.points).toHaveLength(1);
            expect(data.points[0].date).toBe('2026-05-10');
            expect(data.points[0].tool_activity.interaction_count).toBe(5);
            expect(data.points[0].git_activity.commits).toBe(2);
            // Git activity overlay carries PRs for the developer trend chart.
            expect(data.points[0].git_activity.prs_opened).toBe(3);
            expect(data.points[0].git_activity.prs_merged).toBe(1);
        });

        it('rejects an invalid custom range with 400 (same as manager endpoints)', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/me/timeline?range=custom&from=2026-05-31&to=2026-05-01',
                headers: authHeaders(aliceToken),
            });
            expect(res.statusCode).toBe(400);
        });

        it('supports lifetime range from the developer\'s earliest record', async () => {
            seedToolSnapshot(db, {developer: 'alice', date: '2026-03-15', interactions: 1});
            seedGitSnapshot(db, {developer: 'alice', date: '2026-02-01', commits: 1});
            const res = await app.inject({
                method: 'GET',
                url: '/api/me/timeline?range=lifetime',
                headers: authHeaders(aliceToken),
            });
            expect(res.statusCode).toBe(200);
            expect((res.json() as MeRangeBody).data.from).toBe('2026-02-01');
        });
    });

    // ── activity (cross-provider) ────────────────────────────────────────────
    describe('GET /api/me/activity', () => {
        it('aggregates git activity across multiple providers for the same developer', async () => {
            // Bitbucket + GitHub commits on different days, unified into one total.
            seedGitSnapshot(db, {developer: 'alice', date: '2026-05-10', dataSource: 'github', commits: 4, linesAdded: 200, prsMerged: 2, churn: 0.2});
            seedGitSnapshot(db, {developer: 'alice', date: '2026-05-11', dataSource: 'bitbucket', commits: 3, linesAdded: 90, prsMerged: 1, churn: 0.4});
            // Bob's activity must never leak in.
            seedGitSnapshot(db, {developer: 'bob', date: '2026-05-10', dataSource: 'github', commits: 99});

            const res = await app.inject({
                method: 'GET',
                url: '/api/me/activity?range=custom&from=2026-05-01&to=2026-05-31',
                headers: authHeaders(aliceToken),
            });
            expect(res.statusCode).toBe(200);
            const {data} = res.json() as {
                data: {
                    totals: {commits: number; lines_added: number; prs_merged: number; avg_churn_rate: number | null};
                    providers: Array<{provider: string; commits: number}>;
                };
            };
            // Unified across github + bitbucket: 4 + 3 = 7 commits, 200 + 90 = 290 lines.
            expect(data.totals.commits).toBe(7);
            expect(data.totals.lines_added).toBe(290);
            expect(data.totals.prs_merged).toBe(3);
            expect(data.totals.avg_churn_rate).toBeCloseTo(0.3);

            const github = data.providers.find((p) => p.provider === 'github')!;
            const bitbucket = data.providers.find((p) => p.provider === 'bitbucket')!;
            expect(github.commits).toBe(4);
            expect(bitbucket.commits).toBe(3);
        });

        it("surfaces a merged same-day cross-provider row under the 'multi' bucket", async () => {
            // At sync time a day with activity on >1 provider is merged into one
            // row (UNIQUE(developer_id, date)) tagged data_source='multi'. The
            // breakdown reflects how the data is stored; totals stay correct.
            seedGitSnapshot(db, {developer: 'alice', date: '2026-05-10', dataSource: 'multi', commits: 7, linesAdded: 290, prsMerged: 3});

            const res = await app.inject({
                method: 'GET',
                url: '/api/me/activity?range=custom&from=2026-05-01&to=2026-05-31',
                headers: authHeaders(aliceToken),
            });
            expect(res.statusCode).toBe(200);
            const {data} = res.json() as {
                data: {totals: {commits: number}; providers: Array<{provider: string; commits: number}>};
            };
            expect(data.totals.commits).toBe(7);
            expect(data.providers).toHaveLength(1);
            expect(data.providers[0].provider).toBe('multi');
            expect(data.providers[0].commits).toBe(7);
        });

        it('returns zero totals and no providers for a developer with no git activity', async () => {
            const res = await app.inject({method: 'GET', url: '/api/me/activity', headers: authHeaders(aliceToken)});
            expect(res.statusCode).toBe(200);
            const {data} = res.json() as {data: {totals: {commits: number; avg_churn_rate: number | null}; providers: unknown[]}};
            expect(data.totals.commits).toBe(0);
            expect(data.totals.avg_churn_rate).toBeNull();
            expect(data.providers).toEqual([]);
        });
    });

    // ── adoption journey ─────────────────────────────────────────────────────
    interface JourneyBody {
        data: {
            tools: Array<{
                tool: string;
                started_on: string | null;
                last_active_on: string | null;
                current_plan: string | null;
                current_monthly_cost: number | null;
                active: boolean;
            }>;
            events: Array<{
                date: string;
                type: 'started' | 'plan_change' | 'tool_switch';
                tool: string;
                from_tool: string | null;
                from_plan: string | null;
                to_plan: string | null;
                old_monthly_cost: number | null;
                new_monthly_cost: number | null;
            }>;
        };
    }

    describe('GET /api/me/journey', () => {
        it('reports per-tool start dates, current plan/cost, and active status', async () => {
            // First activity predates the subscription assignment for copilot.
            seedToolSnapshot(db, {developer: 'alice', date: '2026-03-01', tool: 'copilot', interactions: 5});
            seedToolSnapshot(db, {developer: 'alice', date: '2026-05-20', tool: 'copilot', interactions: 5});
            seedToolSnapshot(db, {developer: 'alice', date: '2026-04-10', tool: 'windsurf', interactions: 2});
            seedSubscription(db, {
                id: 's-cop', developer: 'alice', tool: 'copilot', cost: 19, plan: 'business',
                assignedAt: '2026-03-15T00:00:00.000Z',
            });
            // Windsurf seat was revoked — tool no longer active, but still in the journey.
            seedSubscription(db, {
                id: 's-wind', developer: 'alice', tool: 'windsurf', cost: 15, plan: 'pro',
                assignedAt: '2026-04-01T00:00:00.000Z', revokedAt: '2026-05-01T00:00:00.000Z',
            });

            const res = await app.inject({method: 'GET', url: '/api/me/journey', headers: authHeaders(aliceToken)});
            expect(res.statusCode).toBe(200);
            const {data} = res.json() as JourneyBody;

            const copilot = data.tools.find((t) => t.tool === 'copilot')!;
            // started_on is the earliest of first activity (03-01) and seat assignment (03-15).
            expect(copilot.started_on).toBe('2026-03-01');
            expect(copilot.last_active_on).toBe('2026-05-20');
            expect(copilot.current_plan).toBe('business');
            expect(copilot.current_monthly_cost).toBe(19);
            expect(copilot.active).toBe(true);

            const windsurf = data.tools.find((t) => t.tool === 'windsurf')!;
            // Earliest of activity (04-10) and seat assignment (04-01) → 04-01.
            expect(windsurf.started_on).toBe('2026-04-01');
            expect(windsurf.active).toBe(false);
            expect(windsurf.current_plan).toBeNull();

            // Tools are ordered by start date — copilot (March) before windsurf (April).
            expect(data.tools.map((t) => t.tool)).toEqual(['copilot', 'windsurf']);
        });

        it('emits chronological milestones: started, plan changes, and tool switches', async () => {
            seedToolSnapshot(db, {developer: 'alice', date: '2026-03-01', tool: 'claude_code', interactions: 5});
            seedSubscription(db, {
                id: 's1', developer: 'alice', tool: 'claude_code', cost: 200, plan: 'max',
                assignedAt: '2026-04-01T00:00:00.000Z',
            });
            // Pro → Max upgrade on the same tool.
            seedPlanChange(db, {
                id: 'pc1', developer: 'alice', tool: 'claude_code', oldPlan: 'pro', newPlan: 'max',
                oldCost: 20, newCost: 200, changedAt: '2026-04-01T12:00:00.000Z',
            });
            // A genuine tool switch: copilot → windsurf.
            seedPlanChange(db, {
                id: 'pc2', developer: 'alice', tool: 'windsurf', oldTool: 'copilot', oldPlan: 'business',
                newPlan: 'pro', oldCost: 19, newCost: 15, changedAt: '2026-05-10T09:00:00.000Z',
            });

            const res = await app.inject({method: 'GET', url: '/api/me/journey', headers: authHeaders(aliceToken)});
            expect(res.statusCode).toBe(200);
            const {events} = (res.json() as JourneyBody).data;

            // Chronological: started (03-01) → plan_change (04-01) → tool_switch (05-10).
            expect(events.map((e) => e.type)).toEqual(['started', 'plan_change', 'tool_switch']);
            expect(events[0]).toMatchObject({date: '2026-03-01', tool: 'claude_code'});

            const upgrade = events.find((e) => e.type === 'plan_change')!;
            expect(upgrade).toMatchObject({from_plan: 'pro', to_plan: 'max', new_monthly_cost: 200});

            const move = events.find((e) => e.type === 'tool_switch')!;
            expect(move).toMatchObject({from_tool: 'copilot', tool: 'windsurf', date: '2026-05-10'});
        });

        it('starts the journey at the first ACTIVE day, not the first tracked snapshot', async () => {
            // A seat-but-no-usage day (is_active = 0) precedes real engagement.
            // "Started using" must reflect first engagement, matching the
            // is_active semantics the overview uses for active_days.
            seedToolSnapshot(db, {developer: 'alice', date: '2026-02-01', tool: 'copilot', isActive: false, interactions: 0});
            seedToolSnapshot(db, {developer: 'alice', date: '2026-03-10', tool: 'copilot', interactions: 8});

            const res = await app.inject({method: 'GET', url: '/api/me/journey', headers: authHeaders(aliceToken)});
            expect(res.statusCode).toBe(200);
            const copilot = (res.json() as JourneyBody).data.tools.find((t) => t.tool === 'copilot')!;
            expect(copilot.started_on).toBe('2026-03-10');
            expect(copilot.last_active_on).toBe('2026-03-10');
        });

        it('returns empty tools and events for a developer with no history', async () => {
            const res = await app.inject({method: 'GET', url: '/api/me/journey', headers: authHeaders(aliceToken)});
            expect(res.statusCode).toBe(200);
            const {data} = res.json() as JourneyBody;
            expect(data.tools).toEqual([]);
            expect(data.events).toEqual([]);
        });

        it("never includes another developer's journey", async () => {
            seedToolSnapshot(db, {developer: 'alice', date: '2026-03-01', tool: 'copilot', interactions: 5});
            const res = await app.inject({method: 'GET', url: '/api/me/journey', headers: authHeaders(bobToken)});
            expect(res.statusCode).toBe(200);
            expect((res.json() as JourneyBody).data.tools).toEqual([]);
        });
    });

    // ── range parity with manager endpoints ──────────────────────────────────
    describe('range parameter parity', () => {
        it('defaults to a 30-day window when no range is given', async () => {
            const res = await app.inject({method: 'GET', url: '/api/me/overview', headers: authHeaders(aliceToken)});
            expect(res.statusCode).toBe(200);
            expect((res.json() as MeRangeBody).data.range).toBe('30d');
        });

        it('rejects an unknown range kind with 400', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/me/tools?range=decade',
                headers: authHeaders(aliceToken),
            });
            expect(res.statusCode).toBe(400);
        });
    });
});
