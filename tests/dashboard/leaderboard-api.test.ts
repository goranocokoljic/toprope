import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {makeTestDb} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerMeRoutes} from '../../src/dashboard/api/me';
import {registerLeaderboardRoutes} from '../../src/dashboard/api/leaderboard';
import {canAccessLeaderboard, type LeaderboardRole} from '../../src/dashboard/api/leaderboard-gate';
import {setGlobalSetting, setTeamSetting} from '../../src/settings/store';
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
    registerLeaderboardRoutes(app, db);
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

function seedDeveloper(db: Database.Database, id: string, name: string, team: string): void {
    db.prepare(
        'INSERT INTO developers (id, external_ids, name, email, team, created_at) VALUES (?, NULL, ?, ?, ?, ?)',
    ).run(id, name, `${id}@example.com`, team, NOW);
}

function seedToolSnapshot(
    db: Database.Database,
    opts: {developer: string; date: string; interactions: number; acceptances: number},
): void {
    db.prepare(
        `INSERT INTO tool_snapshots
           (id, developer_id, date, tool, data_source, data_quality, is_active, interaction_count, acceptance_count)
         VALUES (?, ?, ?, 'copilot', 'api', 'high', 1, ?, ?)`,
    ).run(`${opts.developer}-${opts.date}`, opts.developer, opts.date, opts.interactions, opts.acceptances);
}

function seedGitSnapshot(db: Database.Database, developer: string, date: string, commits: number): void {
    db.prepare(
        `INSERT INTO git_snapshots (id, developer_id, date, commits, lines_added) VALUES (?, ?, ?, ?, ?)`,
    ).run(`${developer}-${date}-git`, developer, date, commits, commits * 10);
}

// ── Pure gating logic: every combination of global/team/role ─────────────────
describe('canAccessLeaderboard (gating logic, Task 2.17)', () => {
    const roles: LeaderboardRole[] = ['admin', 'manager', 'developer'];
    const bools = [false, true];

    it('denies everyone when the global master switch is off', () => {
        for (const role of roles) {
            for (const managersCanEnable of bools) {
                for (const teamEnabled of bools) {
                    expect(
                        canAccessLeaderboard({role, globalEnabled: false, managersCanEnable, teamEnabled}),
                    ).toBe(false);
                }
            }
        }
    });

    it('admins may view whenever the global switch is on (team/managers flag irrelevant)', () => {
        for (const managersCanEnable of bools) {
            for (const teamEnabled of bools) {
                expect(
                    canAccessLeaderboard({role: 'admin', globalEnabled: true, managersCanEnable, teamEnabled}),
                ).toBe(true);
            }
        }
    });

    it('managers may view only when managers-can-enable AND the team is enabled', () => {
        const expected: Record<string, boolean> = {
            'false-false': false,
            'false-true': false,
            'true-false': false,
            'true-true': true,
        };
        for (const managersCanEnable of bools) {
            for (const teamEnabled of bools) {
                expect(
                    canAccessLeaderboard({role: 'manager', globalEnabled: true, managersCanEnable, teamEnabled}),
                ).toBe(expected[`${managersCanEnable}-${teamEnabled}`]);
            }
        }
    });

    it('developers are never allowed, regardless of any setting', () => {
        for (const globalEnabled of bools) {
            for (const managersCanEnable of bools) {
                for (const teamEnabled of bools) {
                    expect(
                        canAccessLeaderboard({role: 'developer', globalEnabled, managersCanEnable, teamEnabled}),
                    ).toBe(false);
                }
            }
        }
    });
});

// ── Endpoint behavior ────────────────────────────────────────────────────────
describe('Leaderboard API (Task 2.17)', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let adminToken: string;
    let devToken: string;

    beforeEach(async () => {
        db = makeTestDb();
        const hash = await hashPassword(PASSWORD);
        createUser(db, {email: 'admin@test.com', passwordHash: hash, role: 'admin'});
        createUser(db, {email: 'dev@test.com', passwordHash: hash, role: 'developer'});
        app = await buildApp(db);
        adminToken = await login(app, 'admin@test.com');
        devToken = await login(app, 'dev@test.com');

        seedTeam(db, 'eng');
        seedDeveloper(db, 'd1', 'Alice', 'eng');
        seedDeveloper(db, 'd2', 'Bob', 'eng');
        seedDeveloper(db, 'd3', 'Carol', 'eng');
        // Alice: most interactions, mid acceptance, fewest commits.
        seedToolSnapshot(db, {developer: 'd1', date: '2026-05-29', interactions: 100, acceptances: 50});
        seedGitSnapshot(db, 'd1', '2026-05-29', 2);
        // Bob: fewest interactions, highest acceptance, most commits.
        seedToolSnapshot(db, {developer: 'd2', date: '2026-05-29', interactions: 20, acceptances: 18});
        seedGitSnapshot(db, 'd2', '2026-05-29', 10);
        // Carol: no tool/git activity at all (zero everything).
    });

    afterEach(async () => {
        await app.close();
        db.close();
    });

    describe('default (leaderboard disabled)', () => {
        it('returns 403 for the team endpoint even to an admin', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/leaderboard/eng',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(403);
            expect(res.json().code).toBe('leaderboard_disabled');
        });

        it('availability reports not-available', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/leaderboard/availability',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.available).toBe(false);
        });
    });

    describe('with leaderboard_enabled = true', () => {
        beforeEach(() => {
            setGlobalSetting(db, 'leaderboard_enabled', true);
        });

        it('availability reports available to an admin', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/leaderboard/availability',
                headers: authHeaders(adminToken),
            });
            expect(res.json().data.available).toBe(true);
        });

        it('admin can view a team leaderboard ranked by activity (default metric)', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/leaderboard/eng',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            const {metric, entries} = res.json().data;
            expect(metric).toBe('activity');
            // Alice (100) > Bob (20) > Carol (0).
            expect(entries.map((e: {name: string}) => e.name)).toEqual(['Alice', 'Bob', 'Carol']);
            expect(entries.map((e: {rank: number}) => e.rank)).toEqual([1, 2, 3]);
            expect(entries[0].value).toBe(100);
        });

        it('ranks by acceptance rate when metric=acceptance', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/leaderboard/eng?metric=acceptance',
                headers: authHeaders(adminToken),
            });
            const {entries} = res.json().data;
            // Bob 18/20=0.9 > Alice 50/100=0.5 > Carol 0.
            expect(entries.map((e: {name: string}) => e.name)).toEqual(['Bob', 'Alice', 'Carol']);
            expect(entries[0].value).toBeCloseTo(0.9);
        });

        it('ranks by commits when metric=output', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/leaderboard/eng?metric=output',
                headers: authHeaders(adminToken),
            });
            const {entries} = res.json().data;
            // Bob 10 > Alice 2 > Carol 0.
            expect(entries.map((e: {name: string}) => e.name)).toEqual(['Bob', 'Alice', 'Carol']);
            expect(entries[0].value).toBe(10);
        });

        it('excludes inactive (is_active=0) snapshots from the activity ranking', async () => {
            // Carol gets a big interaction count on an INACTIVE row; it must not
            // count, keeping the leaderboard consistent with every other view.
            db.prepare(
                `INSERT INTO tool_snapshots
                   (id, developer_id, date, tool, data_source, data_quality, is_active, interaction_count, acceptance_count)
                 VALUES ('carol-inactive', 'd3', '2026-05-29', 'copilot', 'api', 'high', 0, 999, 999)`,
            ).run();
            const res = await app.inject({
                method: 'GET',
                url: '/api/leaderboard/eng?metric=activity',
                headers: authHeaders(adminToken),
            });
            const entries = res.json().data.entries as {name: string; interactions: number}[];
            const carol = entries.find((e) => e.name === 'Carol');
            expect(carol?.interactions).toBe(0);
            // Carol stays last despite the 999 on the inactive row.
            expect(entries[entries.length - 1].name).toBe('Carol');
        });

        it('floors low-sample developers on the acceptance metric (no fluke 100%)', async () => {
            // Dave: 1 interaction, 1 acceptance → raw rate 1.0, but below the
            // sample floor, so he must NOT outrank Alice (50/100 = 0.5).
            seedDeveloper(db, 'd4', 'Dave', 'eng');
            seedToolSnapshot(db, {developer: 'd4', date: '2026-05-29', interactions: 1, acceptances: 1});
            const res = await app.inject({
                method: 'GET',
                url: '/api/leaderboard/eng?metric=acceptance',
                headers: authHeaders(adminToken),
            });
            const entries = res.json().data.entries as {name: string; value: number}[];
            const dave = entries.find((e) => e.name === 'Dave');
            const alice = entries.find((e) => e.name === 'Alice');
            expect(dave?.value).toBe(0); // floored
            expect((alice?.value ?? 0) > (dave?.value ?? 0)).toBe(true);
            // The top spot is the high-sample leader, never the 1/1 developer.
            expect(entries[0].name).not.toBe('Dave');
        });

        it('rejects an unknown metric with 400', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/leaderboard/eng?metric=bogus',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(400);
        });

        it('returns 404 for an unknown team', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/leaderboard/ghost',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(404);
        });

        it('still blocks a developer (confined to /api/me by the middleware)', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/leaderboard/eng',
                headers: authHeaders(devToken),
            });
            expect(res.statusCode).toBe(403);
        });

        it('a team that opted out (override=false) does not change the admin view', async () => {
            // managers may enable + team disables it for themselves; the admin
            // path is independent of the per-team value, so the admin still sees it.
            setGlobalSetting(db, 'leaderboard_managers_can_enable', true);
            setTeamSetting(db, 'eng', 'leaderboard_enabled', false);
            const res = await app.inject({
                method: 'GET',
                url: '/api/leaderboard/eng',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
        });
    });

    it('ties share a rank (competition ranking)', async () => {
        setGlobalSetting(db, 'leaderboard_enabled', true);
        // Give Carol the same interactions as Bob → a tie at that value.
        seedToolSnapshot(db, {developer: 'd3', date: '2026-05-29', interactions: 20, acceptances: 5});
        const res = await app.inject({
            method: 'GET',
            url: '/api/leaderboard/eng?metric=activity',
            headers: authHeaders(adminToken),
        });
        const {entries} = res.json().data;
        // Alice 100 (rank 1), Bob & Carol 20 (both rank 2).
        const byName = Object.fromEntries(entries.map((e: {name: string; rank: number}) => [e.name, e.rank]));
        expect(byName.Alice).toBe(1);
        expect(byName.Bob).toBe(2);
        expect(byName.Carol).toBe(2);
    });
});
