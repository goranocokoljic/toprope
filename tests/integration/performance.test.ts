import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {performance} from 'node:perf_hooks';
import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {
    makeIntegrationDb,
    buildFullApp,
    createAccount,
    login,
    authHeaders,
    seedTeam,
    seedDeveloper,
    seedToolSnapshot,
    seedGitSnapshot,
    seedSubscription,
    daysAgo,
} from './harness';

/**
 * Task 2.12 — Performance gate: every screen's backing endpoints must return
 * well under the 2-second load target, measured against a data volume larger
 * than a single dogfood team (≈60 developers × 120 days of daily, multi-tool,
 * multi-provider history). The build is shared across the suite (beforeAll) so
 * we measure steady-state query cost, not setup.
 */
// The issue's hard target is 2s. This is a deliberately loose ceiling: the real
// signal is "no pathological N+1 / full-scan regression", not a precise SLA. In
// memory queries here run in single-digit ms, so 2000ms leaves wide headroom for
// a contended CI runner without becoming a wall-clock flake.
const LOAD_TARGET_MS = 2000;
const TEAMS = ['frontend', 'backend', 'platform', 'data', 'mobile', 'sre'];
const DEVS_PER_TEAM = 10;
const HISTORY_DAYS = 120;
const TOOLS = ['copilot', 'claude_code', 'windsurf'];
const PROVIDERS = ['github', 'bitbucket', 'gitlab'];

describe('Integration (2.12): performance under real data volume', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let managerHeaders: Record<string, string>;
    let devHeaders: Record<string, string>;

    beforeAll(async () => {
        db = makeIntegrationDb();

        const insertAll = db.transaction(() => {
            for (const team of TEAMS) {
                seedTeam(db, team, 'manager@wmg.test');
            }
            let n = 0;
            for (const team of TEAMS) {
                const provider = PROVIDERS[TEAMS.indexOf(team) % PROVIDERS.length];
                for (let i = 0; i < DEVS_PER_TEAM; i++) {
                    const id = `dev-${n++}`;
                    seedDeveloper(db, {id, team});
                    const tool = TOOLS[i % TOOLS.length];
                    seedSubscription(db, {id: `${id}-sub`, developer: id, tool, cost: 19});
                    for (let d = HISTORY_DAYS; d >= 0; d--) {
                        const date = daysAgo(d);
                        seedToolSnapshot(db, {
                            developer: id, date, tool,
                            interactions: 20 + ((d + i) % 30),
                            acceptances: 10 + (d % 15),
                            features: {completions: 15, chat: 5},
                        });
                        if (d % 2 === 0) {
                            seedGitSnapshot(db, {
                                developer: id, date, provider,
                                commits: 1 + (d % 3), linesAdded: 40 + (d % 120), prsMerged: d % 5 === 0 ? 1 : 0,
                                churn: 0.2, aiScore: 0.6,
                            });
                        }
                    }
                }
            }
        });
        insertAll();

        await createAccount(db, {email: 'manager@wmg.test', role: 'admin'});
        await createAccount(db, {email: 'dev-0@wmg.test', role: 'developer', developerId: 'dev-0'});
        app = await buildFullApp(db);
        managerHeaders = authHeaders(await login(app, 'manager@wmg.test'));
        devHeaders = authHeaders(await login(app, 'dev-0@wmg.test'));
    }, 60_000);

    afterAll(async () => {
        await app.close();
        db.close();
    });

    async function timed(url: string, headers: Record<string, string>): Promise<{status: number; ms: number}> {
        const start = performance.now();
        const res = await app.inject({method: 'GET', url, headers});
        return {status: res.statusCode, ms: performance.now() - start};
    }

    const managerScreens: Array<[string, string]> = [
        ['Overview', '/api/overview'],
        ['Overview trend (lifetime)', '/api/overview/trend?range=lifetime'],
        ['Tool distribution', '/api/tools/distribution'],
        ['Coverage', '/api/coverage'],
        ['Teams list', '/api/teams?limit=100'],
        ['Team detail', '/api/teams/frontend'],
        ['Team trend (lifetime)', '/api/teams/frontend/trend?range=lifetime'],
        ['Snapshots page', '/api/snapshots?limit=100'],
        ['Export (json)', '/api/export'],
    ];

    const developerScreens: Array<[string, string]> = [
        ['My overview (lifetime)', '/api/me/overview?range=lifetime'],
        ['My tools (lifetime)', '/api/me/tools?range=lifetime'],
        ['My timeline (lifetime)', '/api/me/timeline?range=lifetime'],
        ['My activity (lifetime)', '/api/me/activity?range=lifetime'],
        ['My journey', '/api/me/journey'],
    ];

    it('serves every manager screen under the 2-second target', async () => {
        for (const [label, url] of managerScreens) {
            const {status, ms} = await timed(url, managerHeaders);
            expect(status, label).toBe(200);
            expect(ms, `${label} took ${ms.toFixed(0)}ms`).toBeLessThan(LOAD_TARGET_MS);
        }
    });

    it('serves every developer screen under the 2-second target', async () => {
        for (const [label, url] of developerScreens) {
            const {status, ms} = await timed(url, devHeaders);
            expect(status, label).toBe(200);
            expect(ms, `${label} took ${ms.toFixed(0)}ms`).toBeLessThan(LOAD_TARGET_MS);
        }
    });

    it('seeded a volume larger than a single dogfood team', () => {
        const devs = (db.prepare('SELECT COUNT(*) AS c FROM developers').get() as {c: number}).c;
        const snaps = (db.prepare('SELECT COUNT(*) AS c FROM tool_snapshots').get() as {c: number}).c;
        expect(devs).toBe(TEAMS.length * DEVS_PER_TEAM);
        expect(snaps).toBeGreaterThan(5000);
    });
});
