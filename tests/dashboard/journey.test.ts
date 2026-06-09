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
import {
    buildTrajectory,
    detectAnnotations,
    developerTier,
    getDeveloperJourney,
    weekStartOf,
    type DailyActivity,
    type DeveloperJourney,
    type JourneyTrajectoryPoint,
} from '../../src/dashboard/api/journey';

const PASSWORD = 'correct-horse-battery';
const NOW = '2026-05-30T00:00:00.000Z';
// A fixed "present" so the trajectory's to-now upper bound is deterministic.
const FIXED_NOW = new Date('2026-05-30T00:00:00.000Z');

// ── pure helpers ─────────────────────────────────────────────────────────────

describe('journey pure helpers', () => {
    describe('weekStartOf', () => {
        it('snaps any day to the Monday of its ISO week (UTC)', () => {
            // 2024-01-01 is a Monday.
            expect(weekStartOf('2024-01-01')).toBe('2024-01-01'); // Monday
            expect(weekStartOf('2024-01-03')).toBe('2024-01-01'); // Wednesday
            expect(weekStartOf('2024-01-07')).toBe('2024-01-01'); // Sunday (same week)
            expect(weekStartOf('2024-01-08')).toBe('2024-01-08'); // next Monday
        });
    });

    describe('buildTrajectory', () => {
        it('emits a continuous weekly series, gaps filled with zeros, averaging the AI signature', () => {
            const daily: DailyActivity[] = [
                {date: '2024-01-01', interactions: 5, commits: 0, active: true, ai_signature_score: 0.2},
                {date: '2024-01-02', interactions: 3, commits: 1, active: true, ai_signature_score: 0.4},
                // skip the 2024-01-08 week entirely → it must still appear as zeros
                {date: '2024-01-15', interactions: 0, commits: 2, active: true, ai_signature_score: null},
            ];
            const points = buildTrajectory(daily, '2024-01-01', '2024-01-15');

            expect(points.map((p) => p.week_start)).toEqual(['2024-01-01', '2024-01-08', '2024-01-15']);
            expect(points[0]).toEqual({
                week_start: '2024-01-01',
                active_days: 2,
                interactions: 8,
                commits: 1,
                ai_signature_score: 0.3, // mean of 0.2 and 0.4
            });
            // The gap week is present and entirely zero.
            expect(points[1]).toEqual({
                week_start: '2024-01-08',
                active_days: 0,
                interactions: 0,
                commits: 0,
                ai_signature_score: null,
            });
            expect(points[2]).toMatchObject({active_days: 1, commits: 2, ai_signature_score: null});
        });
    });

    describe('detectAnnotations', () => {
        const point = (week: string, magnitude: number, active = magnitude > 0): JourneyTrajectoryPoint => ({
            week_start: week,
            active_days: active ? 3 : 0,
            interactions: magnitude,
            commits: 0,
            ai_signature_score: null,
        });

        it('returns nothing for a never-active trajectory', () => {
            const traj = [point('2024-01-01', 0, false), point('2024-01-08', 0, false)];
            expect(detectAnnotations(traj)).toEqual([]);
        });

        it('marks the first active week', () => {
            const traj = [point('2024-01-01', 0, false), point('2024-01-08', 4), point('2024-01-15', 0, false)];
            const ann = detectAnnotations(traj);
            expect(ann.find((a) => a.type === 'first_active_week')?.week_start).toBe('2024-01-08');
        });

        it('detects a sustained ramp (three weeks strictly rising)', () => {
            const traj = [point('2024-01-01', 2), point('2024-01-08', 5), point('2024-01-15', 9)];
            const ann = detectAnnotations(traj);
            const ramp = ann.find((a) => a.type === 'sustained_ramp');
            expect(ramp?.week_start).toBe('2024-01-01');
            // A strict ramp is not a plateau.
            expect(ann.some((a) => a.type === 'plateau')).toBe(false);
        });

        it('detects a plateau (three flat active weeks)', () => {
            const traj = [point('2024-01-01', 10), point('2024-01-08', 10), point('2024-01-15', 10)];
            const ann = detectAnnotations(traj);
            expect(ann.find((a) => a.type === 'plateau')?.week_start).toBe('2024-01-01');
            expect(ann.some((a) => a.type === 'sustained_ramp')).toBe(false);
        });

        it('treats a near-flat run just inside the 20% band as a plateau, just outside as not', () => {
            // [10,9,10]: range 1, mean 9.67, 0.2·mean ≈ 1.93 → 1 ≤ 1.93 → plateau.
            const inside = [point('2024-01-01', 10), point('2024-01-08', 9), point('2024-01-15', 10)];
            expect(detectAnnotations(inside).some((a) => a.type === 'plateau')).toBe(true);
            // [10,8,10]: range 2, mean 9.33, 0.2·mean ≈ 1.87 → 2 > 1.87 → not a plateau.
            const outside = [point('2024-01-01', 10), point('2024-01-08', 8), point('2024-01-15', 10)];
            expect(detectAnnotations(outside).some((a) => a.type === 'plateau')).toBe(false);
        });

        it('annotates both a ramp and a later plateau on a ramp-then-settle curve', () => {
            // The realistic adoption shape: rise, then settle into a steady rhythm.
            const traj = [
                point('2024-01-01', 2),
                point('2024-01-08', 5),
                point('2024-01-15', 9),
                point('2024-01-22', 9),
                point('2024-01-29', 9),
            ];
            const ann = detectAnnotations(traj);
            // Ramp anchored at the first rising window (2<5<9).
            expect(ann.find((a) => a.type === 'sustained_ramp')?.week_start).toBe('2024-01-01');
            // Plateau anchored at the first flat window ([9,9,9]).
            expect(ann.find((a) => a.type === 'plateau')?.week_start).toBe('2024-01-15');
        });

        it('does not mistake a gap (zero-activity weeks) for a plateau', () => {
            // Three consecutive zero weeks are inactive, not a flat rhythm.
            const traj = [
                point('2024-01-01', 6),
                point('2024-01-08', 0, false),
                point('2024-01-15', 0, false),
                point('2024-01-22', 0, false),
            ];
            const ann = detectAnnotations(traj);
            expect(ann.some((a) => a.type === 'plateau')).toBe(false);
        });
    });
});

// ── DB-backed assembly + API ─────────────────────────────────────────────────

function seedDeveloper(db: Database.Database, id: string, team: string | null): void {
    if (team) {
        db.prepare('INSERT OR IGNORE INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run(
            team,
            NOW,
        );
    }
    db.prepare(
        'INSERT INTO developers (id, external_ids, name, email, team, created_at) VALUES (?, NULL, ?, ?, ?, ?)',
    ).run(id, id, `${id}@example.com`, team, NOW);
}

function seedTool(
    db: Database.Database,
    opts: {
        developer: string;
        date: string;
        tool?: string;
        quality?: string;
        isActive?: boolean;
        interactions?: number;
    },
): void {
    const tool = opts.tool ?? 'copilot';
    db.prepare(
        `INSERT INTO tool_snapshots
           (id, developer_id, date, tool, data_source, data_quality, is_active, interaction_count, acceptance_count)
         VALUES (?, ?, ?, ?, 'api', ?, ?, ?, 0)`,
    ).run(
        `${opts.developer}-${opts.date}-${tool}`,
        opts.developer,
        opts.date,
        tool,
        opts.quality ?? 'high',
        opts.isActive === false ? 0 : 1,
        opts.interactions ?? 0,
    );
}

function seedGit(
    db: Database.Database,
    opts: {developer: string; date: string; commits?: number; aiSignature?: number | null},
): void {
    db.prepare(
        `INSERT INTO git_snapshots
           (id, developer_id, date, commits, lines_added, lines_removed, files_changed,
            prs_opened, prs_merged, ai_signature_score, data_source)
         VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, ?, 'git')`,
    ).run(
        `${opts.developer}-${opts.date}-git`,
        opts.developer,
        opts.date,
        opts.commits ?? 1,
        opts.aiSignature ?? null,
    );
}

function seedSubscription(
    db: Database.Database,
    opts: {id: string; developer: string; tool: string; cost?: number; plan?: string; revokedAt?: string | null},
): void {
    db.prepare(
        `INSERT INTO subscriptions
           (id, developer_id, tool, plan, billing_model, monthly_cost, seat_assigned_at, seat_revoked_at, data_source)
         VALUES (?, ?, ?, ?, 'company_managed', ?, ?, ?, 'expense_import')`,
    ).run(opts.id, opts.developer, opts.tool, opts.plan ?? 'pro', opts.cost ?? 19, NOW, opts.revokedAt ?? null);
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
           (id, developer_id, tool, old_tool, old_plan, new_plan, old_monthly_cost, new_monthly_cost, changed_at)
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

describe('getDeveloperJourney (assembly)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        seedDeveloper(db, 'alice', 'eng');
    });

    afterEach(() => {
        db.close();
    });

    it('bounds the timeline by first/last ACTIVE day, ignoring seat-only inactive days', () => {
        // An is_active=0 day precedes real engagement and must not count as the start.
        seedTool(db, {developer: 'alice', date: '2026-02-01', isActive: false, interactions: 0});
        seedTool(db, {developer: 'alice', date: '2026-03-10', interactions: 8});
        seedGit(db, {developer: 'alice', date: '2026-04-20', commits: 3, aiSignature: 0.5});

        const journey = getDeveloperJourney(db, 'alice', FIXED_NOW);
        expect(journey.bounds.first_activity).toBe('2026-03-10');
        expect(journey.bounds.last_activity).toBe('2026-04-20');
    });

    it('builds a trajectory that runs to the present even after activity stops', () => {
        seedTool(db, {developer: 'alice', date: '2026-03-10', interactions: 8});
        const journey = getDeveloperJourney(db, 'alice', FIXED_NOW);

        expect(journey.trajectory.length).toBeGreaterThan(1);
        expect(journey.trajectory[0].week_start).toBe(weekStartOf('2026-03-10'));
        // Extends to the week of "now", not clamped to the last active week.
        expect(journey.trajectory[journey.trajectory.length - 1].week_start).toBe(weekStartOf('2026-05-30'));
    });

    it('clamps the trajectory to the present — a future-dated row cannot explode the series', () => {
        seedTool(db, {developer: 'alice', date: '2026-03-10', interactions: 8});
        // A bad/clock-skewed row dated far in the future must not extend the
        // weekly walk to thousands of points; the series stops at the present.
        seedGit(db, {developer: 'alice', date: '2099-01-01', commits: 1});

        const journey = getDeveloperJourney(db, 'alice', FIXED_NOW);
        // ~12 weeks from 2026-03-10 to 2026-05-30, not 3,800+.
        expect(journey.trajectory.length).toBeLessThan(20);
        expect(journey.trajectory[journey.trajectory.length - 1].week_start).toBe(weekStartOf('2026-05-30'));
    });

    it('plots tool/plan transitions from lifecycle data', () => {
        seedTool(db, {developer: 'alice', date: '2026-03-01', tool: 'claude_code', interactions: 5});
        seedPlanChange(db, {
            id: 'pc1', developer: 'alice', tool: 'claude_code', oldPlan: 'pro', newPlan: 'max',
            oldCost: 20, newCost: 200, changedAt: '2026-04-01T12:00:00.000Z',
        });
        seedPlanChange(db, {
            id: 'pc2', developer: 'alice', tool: 'windsurf', oldTool: 'copilot', oldPlan: 'business',
            newPlan: 'pro', oldCost: 19, newCost: 15, changedAt: '2026-05-10T09:00:00.000Z',
        });

        const journey = getDeveloperJourney(db, 'alice', FIXED_NOW);
        expect(journey.events.find((e) => e.type === 'plan_change')).toMatchObject({
            tool: 'claude_code', from_plan: 'pro', to_plan: 'max',
        });
        expect(journey.events.find((e) => e.type === 'tool_switch')).toMatchObject({
            from_tool: 'copilot', tool: 'windsurf',
        });
    });

    it('returns an empty journey for a developer with no history', () => {
        const journey = getDeveloperJourney(db, 'alice', FIXED_NOW);
        expect(journey.bounds).toEqual({first_activity: null, last_activity: null});
        expect(journey.trajectory).toEqual([]);
        expect(journey.annotations).toEqual([]);
        expect(journey.tier).toBe('none');
    });
});

describe('developerTier labeling', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        seedDeveloper(db, 'api-dev', 'eng');
        seedDeveloper(db, 'git-dev', 'eng');
        seedDeveloper(db, 'expense-dev', 'eng');
        seedDeveloper(db, 'empty-dev', 'eng');
    });

    afterEach(() => {
        db.close();
    });

    it('classifies a developer by their best available signal', () => {
        seedTool(db, {developer: 'api-dev', date: '2026-03-01', quality: 'high', interactions: 5});
        seedGit(db, {developer: 'git-dev', date: '2026-03-01', commits: 2});
        seedSubscription(db, {id: 's1', developer: 'expense-dev', tool: 'copilot'});

        expect(developerTier(db, 'api-dev')).toBe('high');
        expect(developerTier(db, 'git-dev')).toBe('medium');
        expect(developerTier(db, 'expense-dev')).toBe('low');
        expect(developerTier(db, 'empty-dev')).toBe('none');
    });

    it('a git-only journey is labelled the medium (estimate) tier, surfaced on the journey', () => {
        seedGit(db, {developer: 'git-dev', date: '2026-03-01', commits: 2, aiSignature: 0.6});
        const journey = getDeveloperJourney(db, 'git-dev', FIXED_NOW);
        expect(journey.tier).toBe('medium');
    });
});

// ── API + scoping (own vs manager) ───────────────────────────────────────────

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

interface JourneyEnvelope {
    data: DeveloperJourney;
}

describe('journey API scoping (own vs manager)', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let aliceToken: string;
    let adminToken: string;

    beforeEach(async () => {
        db = makeTestDb();
        const hash = await hashPassword(PASSWORD);
        seedDeveloper(db, 'alice', 'eng');
        seedDeveloper(db, 'bob', 'eng');
        seedTool(db, {developer: 'alice', date: '2026-03-10', interactions: 8});
        seedGit(db, {developer: 'alice', date: '2026-03-12', commits: 2, aiSignature: 0.5});

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

    it('enriches /api/me/journey with bounds, trajectory, annotations, and tier', async () => {
        const res = await app.inject({method: 'GET', url: '/api/me/journey', headers: authHeaders(aliceToken)});
        expect(res.statusCode).toBe(200);
        const {data} = res.json() as JourneyEnvelope;
        expect(data.bounds.first_activity).toBe('2026-03-10');
        expect(Array.isArray(data.trajectory)).toBe(true);
        expect(data.trajectory.length).toBeGreaterThan(0);
        expect(Array.isArray(data.annotations)).toBe(true);
        expect(data.tier).toBe('high');
        // Base contract preserved.
        expect(Array.isArray(data.tools)).toBe(true);
        expect(Array.isArray(data.events)).toBe(true);
    });

    it('serves a manager the aggregate journey for any developer', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/developers/alice/journey',
            headers: authHeaders(adminToken),
        });
        expect(res.statusCode).toBe(200);
        const {data} = res.json() as JourneyEnvelope;
        expect(data.bounds.first_activity).toBe('2026-03-10');
        expect(data.tier).toBe('high');
    });

    it('returns 404 for an unknown developer id on the manager route', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/developers/nobody/journey',
            headers: authHeaders(adminToken),
        });
        expect(res.statusCode).toBe(404);
    });

    it('forbids a developer-role account from the manager journey route', async () => {
        // Developers are confined to /api/me — they cannot read another developer's
        // journey (or even their own) through the manager route.
        const res = await app.inject({
            method: 'GET',
            url: '/api/developers/alice/journey',
            headers: authHeaders(aliceToken),
        });
        expect(res.statusCode).toBe(403);
    });

    it('requires authentication on the manager journey route', async () => {
        const res = await app.inject({method: 'GET', url: '/api/developers/alice/journey'});
        expect(res.statusCode).toBe(401);
    });
});
