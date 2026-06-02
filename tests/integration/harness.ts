import Fastify, {type FastifyInstance} from 'fastify';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerMeRoutes} from '../../src/dashboard/api/me';
import {registerOverviewRoutes} from '../../src/dashboard/api/overview';
import {registerTeamRoutes} from '../../src/dashboard/api/teams';
import {registerDeveloperRoutes} from '../../src/dashboard/api/developers';
import {registerWasteRoutes} from '../../src/dashboard/api/waste';
import {registerTrendRoutes} from '../../src/dashboard/api/trends';
import {registerToolsRoutes} from '../../src/dashboard/api/tools';
import {registerCoverageRoutes} from '../../src/dashboard/api/coverage';
import {registerProviderRoutes} from '../../src/dashboard/api/providers';
import {registerSnapshotRoutes} from '../../src/dashboard/api/snapshots';
import {registerExportRoutes} from '../../src/dashboard/api/export';
import {registerSettingsRoutes} from '../../src/dashboard/api/settings';
import {registerLeaderboardRoutes} from '../../src/dashboard/api/leaderboard';
import {registerAdminRoutes} from '../../src/dashboard/api/admin';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

/** Shared login password for every seeded account in the integration suite. */
export const PASSWORD = 'correct-horse-battery';

export function makeIntegrationDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

/**
 * Mounts the FULL dashboard API surface against an existing DB, registering the
 * same routes in the same order as the production `buildServerWithDb`
 * (src/server.ts). The static SPA and the cron scheduler are intentionally
 * omitted — they are exercised elsewhere and need a non-memory DB — so these
 * tests cover the real request/response contract end-to-end with nothing
 * stubbed between auth and the data layer.
 */
export async function buildFullApp(db: Database.Database): Promise<FastifyInstance> {
    const app = Fastify({logger: false});

    registerSessionAuth(app, db);
    app.get('/health', async () => ({status: 'ok'}));
    registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
    registerMeRoutes(app, db);
    registerOverviewRoutes(app, db);
    registerTeamRoutes(app, db);
    registerDeveloperRoutes(app, db);
    registerWasteRoutes(app, db);
    registerTrendRoutes(app, db);
    registerToolsRoutes(app, db);
    registerCoverageRoutes(app, db);
    registerProviderRoutes(app, db);
    registerSnapshotRoutes(app, db);
    registerExportRoutes(app, db);
    registerSettingsRoutes(app, db);
    registerLeaderboardRoutes(app, db);
    registerAdminRoutes(app, db);

    await app.ready();
    return app;
}

// ── auth helpers ────────────────────────────────────────────────────────────

export function cookieToken(res: {headers: Record<string, unknown>}): string {
    const raw = res.headers['set-cookie'];
    const header = Array.isArray(raw) ? raw[0] : (raw as string);
    const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header ?? '');
    return match ? decodeURIComponent(match[1]) : '';
}

export async function login(app: FastifyInstance, email: string): Promise<string> {
    const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {email, password: PASSWORD},
    });
    if (res.statusCode !== 200) {
        throw new Error(`login failed for ${email}: ${res.statusCode} ${res.body}`);
    }
    return cookieToken(res);
}

export function authHeaders(token: string): Record<string, string> {
    return {cookie: `${SESSION_COOKIE}=${token}`};
}

export async function createAccount(
    db: Database.Database,
    opts: {email: string; role: 'admin' | 'developer'; developerId?: string | null},
): Promise<void> {
    const hash = await hashPassword(PASSWORD);
    createUser(db, {
        email: opts.email,
        passwordHash: hash,
        role: opts.role,
        developerId: opts.developerId ?? null,
    });
}

// ── data seeding ────────────────────────────────────────────────────────────

const SEED_NOW = '2026-05-30T00:00:00.000Z';

/** A YYYY-MM-DD string `n` days before today (UTC). */
export function daysAgo(n: number): string {
    return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

export function seedTeam(db: Database.Database, name: string, manager: string | null): void {
    db.prepare(
        'INSERT INTO teams (name, department, manager, created_at) VALUES (?, ?, ?, ?)',
    ).run(name, 'engineering', manager, SEED_NOW);
}

export function seedDeveloper(
    db: Database.Database,
    opts: {id: string; team: string; name?: string; email?: string},
): void {
    db.prepare(
        'INSERT INTO developers (id, external_ids, name, email, team, created_at) VALUES (?, NULL, ?, ?, ?, ?)',
    ).run(opts.id, opts.name ?? opts.id, opts.email ?? `${opts.id}@wmg.test`, opts.team, SEED_NOW);
}

export function seedToolSnapshot(
    db: Database.Database,
    opts: {
        developer: string;
        date: string;
        tool: string;
        isActive?: boolean;
        interactions?: number;
        acceptances?: number;
        quality?: 'high' | 'medium' | 'low';
        features?: Record<string, number>;
    },
): void {
    db.prepare(
        `INSERT INTO tool_snapshots
           (id, developer_id, date, tool, data_source, data_quality, is_active,
            interaction_count, acceptance_count, features_used)
         VALUES (?, ?, ?, ?, 'api', ?, ?, ?, ?, ?)`,
    ).run(
        `${opts.developer}-${opts.date}-${opts.tool}`,
        opts.developer,
        opts.date,
        opts.tool,
        opts.quality ?? 'high',
        opts.isActive === false ? 0 : 1,
        opts.interactions ?? 0,
        opts.acceptances ?? 0,
        opts.features ? JSON.stringify(opts.features) : null,
    );
}

export function seedGitSnapshot(
    db: Database.Database,
    opts: {
        developer: string;
        date: string;
        provider: string;
        commits?: number;
        linesAdded?: number;
        linesRemoved?: number;
        prsOpened?: number;
        prsMerged?: number;
        churn?: number;
        aiScore?: number;
    },
): void {
    db.prepare(
        `INSERT INTO git_snapshots
           (id, developer_id, date, commits, lines_added, lines_removed, files_changed,
            prs_opened, prs_merged, code_churn_rate, ai_signature_score, data_source)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    ).run(
        `${opts.developer}-${opts.date}-${opts.provider}`,
        opts.developer,
        opts.date,
        opts.commits ?? 1,
        opts.linesAdded ?? 0,
        opts.linesRemoved ?? 0,
        opts.prsOpened ?? 0,
        opts.prsMerged ?? 0,
        opts.churn ?? null,
        opts.aiScore ?? null,
        opts.provider,
    );
}

export function seedSubscription(
    db: Database.Database,
    opts: {
        id: string;
        developer: string;
        tool: string;
        cost: number;
        plan?: string;
        assignedAt?: string;
        revokedAt?: string | null;
    },
): void {
    db.prepare(
        `INSERT INTO subscriptions
           (id, developer_id, tool, plan, billing_model, monthly_cost, seat_assigned_at,
            seat_revoked_at, data_source)
         VALUES (?, ?, ?, ?, 'company_managed', ?, ?, ?, 'expense_import')`,
    ).run(
        opts.id,
        opts.developer,
        opts.tool,
        opts.plan ?? 'pro',
        opts.cost,
        opts.assignedAt ?? '2026-01-01T00:00:00.000Z',
        opts.revokedAt ?? null,
    );
}

export function seedPlanChange(
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

export function seedSyncLog(
    db: Database.Database,
    opts: {connector: string; status: string; started: string; finished?: string},
): void {
    db.prepare(
        `INSERT INTO sync_logs (id, connector, started_at, finished_at, status)
         VALUES (?, ?, ?, ?, ?)`,
    ).run(`log-${opts.connector}`, opts.connector, opts.started, opts.finished ?? null, opts.status);
}

export interface WmgDeveloper {
    id: string;
    team: string;
    email: string;
}

export interface WmgDataset {
    teams: string[];
    developers: WmgDeveloper[];
    /** Developer ids by role for convenient assertions. */
    frontend: string[];
    backend: string[];
    platform: string[];
}

/**
 * Builds a representative WMG-shaped dataset that exercises every data source
 * the dashboard reads from at once: all three tool connectors (Copilot, Claude
 * Code, Windsurf) and all three git providers (Bitbucket, GitHub, GitLab),
 * across three teams, with ~90 days of daily history, live + revoked
 * subscriptions, an unused seat, and a plan upgrade. This mirrors the
 * "real multi-source WMG data" the dogfood acceptance criteria call for, while
 * staying deterministic so the integration assertions are stable.
 *
 * Returns the seeded identity map; callers create the matching auth accounts.
 */
export function seedWmgDataset(db: Database.Database): WmgDataset {
    const teams = ['frontend', 'backend', 'platform'];
    seedTeam(db, 'frontend', 'manager@wmg.test');
    seedTeam(db, 'backend', 'manager@wmg.test');
    seedTeam(db, 'platform', 'manager@wmg.test');

    // Each developer is tagged with the git provider their team hosts on, so the
    // multi-provider correlation (Bitbucket + GitHub + GitLab) is real.
    const developers: Array<WmgDeveloper & {tools: string[]; provider: string; idle?: boolean}> = [
        {id: 'amy', team: 'frontend', email: 'amy@wmg.test', tools: ['copilot', 'windsurf'], provider: 'bitbucket'},
        {id: 'ben', team: 'frontend', email: 'ben@wmg.test', tools: ['copilot'], provider: 'bitbucket'},
        {id: 'cara', team: 'backend', email: 'cara@wmg.test', tools: ['claude_code'], provider: 'github'},
        {id: 'dan', team: 'backend', email: 'dan@wmg.test', tools: ['claude_code', 'copilot'], provider: 'github'},
        {id: 'eve', team: 'platform', email: 'eve@wmg.test', tools: ['windsurf'], provider: 'gitlab'},
        // Frank holds a seat but has been idle for the whole window → unused seat.
        {id: 'frank', team: 'platform', email: 'frank@wmg.test', tools: [], provider: 'gitlab', idle: true},
    ];

    for (const dev of developers) {
        seedDeveloper(db, {id: dev.id, team: dev.team, email: dev.email});
    }

    // 90 days of daily history for the active developers. Deterministic counts.
    const HISTORY_DAYS = 90;
    for (const dev of developers) {
        if (dev.idle) {
            continue;
        }
        for (let d = HISTORY_DAYS; d >= 0; d--) {
            const date = daysAgo(d);
            // Light weekend dip via a deterministic modulo so trend lines vary.
            const busy = d % 7 !== 0;
            for (const [i, tool] of dev.tools.entries()) {
                const interactions = busy ? 30 + ((d + i) % 25) : 5 + (d % 5);
                seedToolSnapshot(db, {
                    developer: dev.id,
                    date,
                    tool,
                    interactions,
                    acceptances: Math.round(interactions * 0.6),
                    quality: 'high',
                    features: {completions: Math.round(interactions * 0.7), chat: Math.round(interactions * 0.2)},
                });
            }
            // Git activity a few days a week so churn/AI signatures have data.
            if (busy) {
                seedGitSnapshot(db, {
                    developer: dev.id,
                    date,
                    provider: dev.provider,
                    commits: 1 + (d % 4),
                    linesAdded: 50 + (d % 200),
                    linesRemoved: 10 + (d % 60),
                    prsOpened: d % 3 === 0 ? 1 : 0,
                    prsMerged: d % 4 === 0 ? 1 : 0,
                    churn: 0.1 + (d % 5) / 20,
                    aiScore: 0.5 + (d % 5) / 10,
                });
            }
        }
    }

    // Subscriptions: live seats for every tool a developer actually uses, plus
    // Frank's unused platform seat, plus a revoked legacy seat for history.
    seedSubscription(db, {id: 'sub-amy-cop', developer: 'amy', tool: 'copilot', cost: 19, plan: 'business'});
    seedSubscription(db, {id: 'sub-amy-win', developer: 'amy', tool: 'windsurf', cost: 15});
    seedSubscription(db, {id: 'sub-ben-cop', developer: 'ben', tool: 'copilot', cost: 19, plan: 'business'});
    seedSubscription(db, {id: 'sub-cara-cc', developer: 'cara', tool: 'claude_code', cost: 100, plan: 'max'});
    seedSubscription(db, {id: 'sub-dan-cc', developer: 'dan', tool: 'claude_code', cost: 100, plan: 'max'});
    seedSubscription(db, {id: 'sub-dan-cop', developer: 'dan', tool: 'copilot', cost: 19, plan: 'business'});
    seedSubscription(db, {id: 'sub-eve-win', developer: 'eve', tool: 'windsurf', cost: 15});
    // Frank: established but idle seat → the unused-seat waste alert.
    seedSubscription(db, {id: 'sub-frank-cop', developer: 'frank', tool: 'copilot', cost: 19, plan: 'business'});
    // A revoked legacy seat so cost-over-time history is non-trivial.
    seedSubscription(db, {
        id: 'sub-amy-old', developer: 'amy', tool: 'windsurf', cost: 15,
        assignedAt: '2026-01-01T00:00:00.000Z', revokedAt: '2026-03-01T00:00:00.000Z',
    });

    // Cara upgraded Claude Code Pro → Max; feeds the journey + Plan ROI logic.
    seedPlanChange(db, {
        id: 'pc-cara', developer: 'cara', tool: 'claude_code', oldPlan: 'pro', newPlan: 'max',
        oldCost: 20, newCost: 100, changedAt: daysAgo(40) + 'T00:00:00.000Z',
    });

    // Connector sync logs so coverage / data-sources views reflect live status.
    const now = new Date().toISOString();
    seedSyncLog(db, {connector: 'copilot', status: 'success', started: now, finished: now});
    seedSyncLog(db, {connector: 'claude_code', status: 'success', started: now, finished: now});
    seedSyncLog(db, {connector: 'windsurf', status: 'success', started: now, finished: now});

    return {
        teams,
        developers: developers.map((d) => ({id: d.id, team: d.team, email: d.email})),
        frontend: ['amy', 'ben'],
        backend: ['cara', 'dan'],
        platform: ['eve', 'frank'],
    };
}
