import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {makeTestDb, seedFixtures} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerMeRoutes} from '../../src/dashboard/api/me';
import {registerAdminRoutes} from '../../src/dashboard/api/admin';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';
import {loadServerKey} from '../../src/connectors/git/providers/secret';
import {getDecryptedConfig} from '../../src/connectors/git/providers/store';
import {upsertRawAuthorDaily} from '../../src/connectors/git/raw-author-daily';
import {projectSnapshots} from '../../src/connectors/git/projection';
import {computeAllWeeklyAggregates} from '../../src/aggregation/weekly';
import type {GitConnectorConfig} from '../../src/config/types';

const PASSWORD = 'correct-horse-battery';
const KEY_B64 = Buffer.alloc(32, 7).toString('base64');

// A config-file provider — carries a plaintext token that must NEVER surface in
// any response, and is read-only (no edit/delete from the UI).
const CONFIG_TOKEN = 'ghp_CONFIG_PLAINTEXT_9999';
const CONFIG_PROVIDER_ID = 'config:github:config-org';
const GIT_CONFIG: GitConnectorConfig = {
    providers: [{type: 'github', org: 'config-org', auth: {type: 'token', api_token: CONFIG_TOKEN}}],
};

async function buildApp(db: Database.Database): Promise<FastifyInstance> {
    const app = Fastify({logger: false});
    registerSessionAuth(app, db);
    registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
    registerMeRoutes(app, db);
    registerAdminRoutes(app, db, GIT_CONFIG);
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
    return res.statusCode === 200 ? cookieToken(res) : '';
}

function authHeaders(token: string): Record<string, string> {
    return {cookie: `${SESSION_COOKIE}=${token}`};
}

describe('admin git-provider CRUD API (#197)', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let adminToken: string;
    let devToken: string;
    let priorKey: string | undefined;

    beforeEach(async () => {
        priorKey = process.env.TOPROPE_SECRET_KEY;
        process.env.TOPROPE_SECRET_KEY = KEY_B64;
        db = makeTestDb();
        seedFixtures(db);
        const hash = await hashPassword(PASSWORD);
        createUser(db, {email: 'admin@test.com', passwordHash: hash, role: 'admin'});
        createUser(db, {email: 'alice@test.com', passwordHash: hash, role: 'developer', developerId: 'dev-1'});
        app = await buildApp(db);
        adminToken = await login(app, 'admin@test.com');
        devToken = await login(app, 'alice@test.com');
    });

    afterEach(async () => {
        await app.close();
        db.close();
        if (priorKey === undefined) delete process.env.TOPROPE_SECRET_KEY;
        else process.env.TOPROPE_SECRET_KEY = priorKey;
    });

    // Create a github provider and return its DTO.
    async function createGithub(token = 'ghp_dbSECRET_TOKEN_ABCD'): Promise<Record<string, unknown>> {
        const res = await app.inject({
            method: 'POST',
            url: '/api/admin/git/providers',
            headers: authHeaders(adminToken),
            payload: {type: 'github', container: 'db-org', token},
        });
        expect(res.statusCode).toBe(201);
        return res.json().data as Record<string, unknown>;
    }

    describe('role enforcement — server is the trust boundary', () => {
        const routes: {method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string}[] = [
            {method: 'GET', url: '/api/admin/git/providers'},
            {method: 'POST', url: '/api/admin/git/providers'},
            {method: 'PATCH', url: '/api/admin/git/providers/some-id'},
            {method: 'DELETE', url: '/api/admin/git/providers/some-id'},
        ];

        it('rejects every route for a developer session (403)', async () => {
            for (const r of routes) {
                const res = await app.inject({
                    method: r.method,
                    url: r.url,
                    headers: authHeaders(devToken),
                    payload: r.method === 'GET' || r.method === 'DELETE' ? undefined : {},
                });
                expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
            }
        });

        it('rejects every route with no session (401/403)', async () => {
            for (const r of routes) {
                const res = await app.inject({method: r.method, url: r.url, payload: {}});
                expect([401, 403]).toContain(res.statusCode);
            }
        });
    });

    describe('create', () => {
        it('creates a github provider (201), returns a masked DB DTO', async () => {
            const dto = await createGithub('ghp_dbSECRET_TOKEN_WXYZ');
            expect(dto.source).toBe('db');
            expect(dto.type).toBe('github');
            expect(dto.container).toBe('db-org');
            expect(dto.enabled).toBe(true);
            expect(dto.token_last4).toBe('WXYZ');
            expect(dto.token_masked).toBe('••••WXYZ');
            // No token material of any kind in the DTO.
            expect(JSON.stringify(dto)).not.toContain('ghp_dbSECRET_TOKEN_WXYZ');
        });

        it('creates a self-hosted gitlab provider round-tripping url + include_subgroups', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
                payload: {
                    type: 'gitlab',
                    auth_method: 'personal_access_token',
                    container: 'grp',
                    token: 'glpat-1234',
                    url: 'https://gitlab.internal.acme.dev',
                    include_subgroups: true,
                    repos: ['team/repo'],
                },
            });
            expect(res.statusCode).toBe(201);
            const dto = res.json().data;
            expect(dto.url).toBe('https://gitlab.internal.acme.dev');
            expect(dto.include_subgroups).toBe(true);
            expect(dto.repos_include).toBe(JSON.stringify(['team/repo']));
        });

        it('honors enabled:false on create', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
                payload: {type: 'github', container: 'off-org', token: 'ghp_x', enabled: false},
            });
            expect(res.statusCode).toBe(201);
            expect(res.json().data.enabled).toBe(false);
        });

        it('rejects an unknown provider type (400, fail-closed)', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
                payload: {type: 'svn', container: 'x', token: 't'},
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().message).toMatch(/type must be one of/);
        });

        it('rejects an unknown auth_method (400, fail-closed)', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
                payload: {type: 'bitbucket', auth_method: 'password', container: 'ws', token: 't'},
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().message).toMatch(/auth_method for bitbucket/);
        });

        it('rejects a missing token on create (400)', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
                payload: {type: 'github', container: 'x'},
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().message).toMatch(/token is required/);
        });

        it('rejects a bitbucket app_password without username (400)', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
                payload: {type: 'bitbucket', auth_method: 'app_password', container: 'ws', token: 'pw'},
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().message).toMatch(/username is required/);
        });

        it('maps a factory validation failure (bad gitlab url) to 400, not 500', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
                payload: {type: 'gitlab', auth_method: 'oauth', container: 'g', token: 't', url: 'ftp://nope'},
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().message).toMatch(/http or https/);
        });

        it('fails closed with a clear 503 (not 500) when the server key is unconfigured', async () => {
            delete process.env.TOPROPE_SECRET_KEY;
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
                payload: {type: 'github', container: 'x', token: 'ghp_x'},
            });
            expect(res.statusCode).toBe(503);
            expect(res.json().message).toMatch(/TOPROPE_SECRET_KEY is not set/);
        });
    });

    describe('list', () => {
        it('lists DB providers first, then read-only config-file providers', async () => {
            await createGithub();
            const res = await app.inject({
                method: 'GET',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(200);
            const rows = res.json().data as {source: string; id: string}[];
            expect(rows).toHaveLength(2);
            expect(rows[0].source).toBe('db');
            expect(rows[1].source).toBe('config');
            expect(rows[1].id).toBe(CONFIG_PROVIDER_ID);
        });

        it('marks the config row read-only with no token material and null lifecycle fields', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
            });
            const config = (res.json().data as Record<string, unknown>[]).find((r) => r.source === 'config');
            expect(config).toBeDefined();
            expect(config?.token_masked).toBe('••••');
            expect(config?.token_last4).toBeNull();
            expect(config?.created_at).toBeNull();
            expect(config?.enabled).toBe(true);
        });

        it('never leaks token material for DB or config providers (masked only)', async () => {
            await createGithub('ghp_dbSECRET_TOKEN_LEAK');
            const res = await app.inject({
                method: 'GET',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
            });
            const body = JSON.stringify(res.json());
            // Positive control: the scan target is real — the response is non-empty
            // and contains the containers we seeded.
            expect(body).toContain('db-org');
            expect(body).toContain('config-org');
            // The actual leak vectors: neither the DB nor the config token appears.
            expect(body).not.toContain('ghp_dbSECRET_TOKEN_LEAK');
            expect(body).not.toContain(CONFIG_TOKEN);
            // But the mask (with last4 for the DB row) is present.
            expect(body).toContain('••••LEAK');
        });
    });

    describe('update', () => {
        it('edits fields and KEEPS the stored token when omitted', async () => {
            const dto = await createGithub('ghp_KEEP_ME_1234');
            const id = dto.id as string;
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/git/providers/${id}`,
                headers: authHeaders(adminToken),
                // The container stays put — it is immutable since #264 (see the dedicated
                // tests below). Repo scope is the editable field this exercises.
                payload: {type: 'github', container: 'db-org', repos: ['include:svc-a']},
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.repos_include).toBe(JSON.stringify(['include:svc-a']));
            // The token is unchanged — decrypt it back through the store.
            const cfg = getDecryptedConfig(db, loadServerKey({TOPROPE_SECRET_KEY: KEY_B64}), id);
            expect(cfg?.type).toBe('github');
            expect(cfg?.type === 'github' && cfg.auth.api_token).toBe('ghp_KEEP_ME_1234');
        });

        it('replaces the token when a new one is supplied', async () => {
            const dto = await createGithub('ghp_OLD_TOKEN_1111');
            const id = dto.id as string;
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/git/providers/${id}`,
                headers: authHeaders(adminToken),
                payload: {type: 'github', container: 'db-org', token: 'ghp_NEW_TOKEN_2222'},
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.token_last4).toBe('2222');
            const cfg = getDecryptedConfig(db, loadServerKey({TOPROPE_SECRET_KEY: KEY_B64}), id);
            expect(cfg?.type === 'github' && cfg.auth.api_token).toBe('ghp_NEW_TOKEN_2222');
        });

        it('rejects editing a config-file provider (409, read-only)', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/git/providers/${CONFIG_PROVIDER_ID}`,
                headers: authHeaders(adminToken),
                payload: {type: 'github', container: 'hijack'},
            });
            expect(res.statusCode).toBe(409);
            expect(res.json().message).toMatch(/read-only/);
        });

        it('returns a typed 404 for an unknown id', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: '/api/admin/git/providers/does-not-exist',
                headers: authHeaders(adminToken),
                payload: {type: 'github', container: 'x'},
            });
            expect(res.statusCode).toBe(404);
            expect(res.json().message).toMatch(/not found/);
        });

        it('rejects a malformed body on an existing provider (400, fail-closed)', async () => {
            const id = (await createGithub()).id as string;
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/git/providers/${id}`,
                headers: authHeaders(adminToken),
                payload: {type: 'mercurial', container: 'x'},
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().message).toMatch(/type must be one of/);
        });

        it('maps a factory validation failure on update to 400, not 500', async () => {
            const create = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
                payload: {type: 'gitlab', auth_method: 'oauth', container: 'grp', token: 'glpat-1'},
            });
            const id = create.json().data.id as string;
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/git/providers/${id}`,
                headers: authHeaders(adminToken),
                payload: {type: 'gitlab', auth_method: 'oauth', container: 'grp', url: 'ftp://nope'},
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().message).toMatch(/http or https/);
        });

        it('fails closed with 503 when the server key is unconfigured mid-edit', async () => {
            const id = (await createGithub()).id as string;
            delete process.env.TOPROPE_SECRET_KEY;
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/git/providers/${id}`,
                headers: authHeaders(adminToken),
                payload: {type: 'github', container: 'renamed', token: 'ghp_new_5678'},
            });
            expect(res.statusCode).toBe(503);
            expect(res.json().message).toMatch(/TOPROPE_SECRET_KEY is not set/);
        });
    });

    describe('delete', () => {
        it('deletes a DB provider and drops it from the list', async () => {
            const dto = await createGithub();
            const id = dto.id as string;
            const del = await app.inject({
                method: 'DELETE',
                url: `/api/admin/git/providers/${id}`,
                headers: authHeaders(adminToken),
            });
            expect(del.statusCode).toBe(200);
            // The response REPORTS what was removed (#264 AC9) rather than a bare
            // {deleted:true}: nothing was imported for this provider, so every count is 0.
            expect(del.json().data).toEqual({
                id,
                deleted: true,
                removed: {
                    id,
                    provider: 'github',
                    container: 'db-org',
                    raw_author_rows: 0,
                    pr_records: 0,
                    days: 0,
                    earliest_date: null,
                    latest_date: null,
                    snapshot_cells_retracted: 0,
                    snapshot_cells_rewritten: 0,
                    snapshot_cells_legacy_skipped: 0,
                    developers_affected: 0,
                    cursor_keys_purged: 0,
                    cascade_skipped: false,
                },
                // Nothing was retracted, so there is no span to recompute.
                aggregates: {from: null, to: null, periods: 0, prMetricPeriods: 0, error: null},
            });
            const list = await app.inject({
                method: 'GET',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
            });
            const ids = (list.json().data as {id: string}[]).map((r) => r.id);
            expect(ids).not.toContain(id);
        });

        it('rejects deleting a config-file provider (409, read-only)', async () => {
            const res = await app.inject({
                method: 'DELETE',
                url: `/api/admin/git/providers/${CONFIG_PROVIDER_ID}`,
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(409);
            expect(res.json().message).toMatch(/read-only/);
        });

        it('returns a typed 404 deleting an unknown id', async () => {
            const res = await app.inject({
                method: 'DELETE',
                url: '/api/admin/git/providers/nope',
                headers: authHeaders(adminToken),
            });
            expect(res.statusCode).toBe(404);
            expect(res.json().message).toMatch(/not found/);
        });

        // KNOWN GAP, pinned deliberately (#262 → #264). The pipeline's cursors are keyed
        // by `type:container`, not by provider id, so this delete leaves them behind and
        // a provider re-added for the same container inherits them. Purging them here in
        // isolation is unsafe: `raw_author_daily` has no container column, so the deleted
        // provider's rows cannot be retracted, and `mergeDailyAcrossRuns` ADDS the commit
        // counters — a re-import over the same window would double-count permanently.
        // #264 adds container attribution and flips this expectation; this test exists so
        // that flip is deliberate rather than silent. The UI is protected in the meantime
        // by `first_sync_pending` (see the create-route test above), which reports false
        // for such a provider and hides the window input.
        // FLIPPED by #264 (was: "leaves the container pipeline cursors in place"). Purging
        // them is safe now precisely because the data they licensed goes with them.
        it('purges exactly the container pipeline cursors, and nothing else', async () => {
            const dto = await createGithub();
            const id = dto.id as string;
            for (const key of [
                'git_last_sync:github:db-org',
                'git_earliest_sync:github:db-org',
                'git_stall:github:db-org',
                // A sibling container's keys, and a non-git key: neither may be touched.
                'git_last_sync:github:other-org',
                'copilot_last_sync',
            ]) {
                db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(key, 'seeded');
            }

            const del = await app.inject({
                method: 'DELETE',
                url: `/api/admin/git/providers/${id}`,
                headers: authHeaders(adminToken),
            });
            expect(del.statusCode).toBe(200);
            expect(del.json().data.removed.cursor_keys_purged).toBe(3);

            const remaining = (
                db.prepare('SELECT key FROM sync_state ORDER BY key').all() as Array<{key: string}>
            ).map((r) => r.key);
            expect(remaining).toEqual(['copilot_last_sync', 'git_last_sync:github:other-org']);
        });
    });

    // #264 AC9: the delete is destructive, so the UI must be able to state the real impact
    // BEFORE it proceeds, and the response must report what actually went.
    describe('delete impact + reported counts', () => {
        // Retain two days of github/db-org authorship for a developer the identity map
        // resolves, so the impact and the delete report non-zero numbers.
        function seedDbOrgHistory(): void {
            db.prepare(`UPDATE developers SET external_ids = '{"github":"alice"}' WHERE id = 'dev-1'`).run();
            for (const [date, commits] of [
                ['2026-07-01', 3],
                ['2026-07-02', 4],
            ] as const) {
                upsertRawAuthorDaily(
                    db,
                    {
                        provider: 'github',
                        container: 'db-org',
                        raw_author_key: 'github:login:alice',
                        author_login: 'alice',
                        author_email: 'alice@example.com',
                        author_display_name: null,
                        date,
                        commits,
                        lines_added: 10,
                        lines_removed: 1,
                        files_changed: 1,
                        prs_opened: 0,
                        prs_merged: 0,
                        review_comments_given: 0,
                        avg_time_to_merge_hours: null,
                        code_churn_rate: 0,
                        ai_signature_score: 0,
                        avg_commit_size: 10,
                        commit_burst_count: 0,
                    },
                    '2026-07-10T00:00:00.000Z',
                );
            }
            projectSnapshots(db, {dates: ['2026-07-01', '2026-07-02']});
            db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
                'git_last_sync:github:db-org',
                '2026-07-10T00:00:00.000Z',
            );
        }

        async function impactOf(id: string): ReturnType<FastifyInstance['inject']> {
            return app.inject({
                method: 'GET',
                url: `/api/admin/git/providers/${id}/delete-impact`,
                headers: authHeaders(adminToken),
            });
        }

        it('previews the real history and developer counts without changing anything', async () => {
            const dto = await createGithub();
            seedDbOrgHistory();
            const res = await impactOf(dto.id as string);
            expect(res.statusCode).toBe(200);
            expect(res.json().data).toEqual({
                provider: 'github',
                container: 'db-org',
                raw_author_rows: 2,
                days: 2,
                earliest_date: '2026-07-01',
                latest_date: '2026-07-02',
                commits: 7,
                pr_records: 0,
                authors: 1,
                developers_affected: 1,
                cascade_skipped: false,
            });
            // Read-only.
            expect(
                (db.prepare('SELECT COUNT(*) AS n FROM raw_author_daily').get() as {n: number}).n,
            ).toBe(2);
        });

        it('the DELETE response reports exactly what the cascade removed', async () => {
            const dto = await createGithub();
            seedDbOrgHistory();
            const del = await app.inject({
                method: 'DELETE',
                url: `/api/admin/git/providers/${dto.id as string}`,
                headers: authHeaders(adminToken),
            });
            expect(del.statusCode).toBe(200);
            expect(del.json().data.removed).toMatchObject({
                container: 'db-org',
                raw_author_rows: 2,
                days: 2,
                earliest_date: '2026-07-01',
                latest_date: '2026-07-02',
                snapshot_cells_retracted: 2,
                snapshot_cells_rewritten: 0,
                developers_affected: 1,
                cursor_keys_purged: 1,
                cascade_skipped: false,
            });
            expect(
                (db.prepare('SELECT COUNT(*) AS n FROM raw_author_daily').get() as {n: number}).n,
            ).toBe(0);
        });

        // The derived rollups are a SECOND projection and the aggregation scheduler only ever
        // recomputes the just-closed period — so the delete must recompute the retracted span
        // itself, or the trend charts keep serving the removed activity forever.
        it('recomputes the derived aggregates over the retracted span, and reports it', async () => {
            const dto = await createGithub();
            seedDbOrgHistory();
            // A weekly aggregate for the retracted week, holding the doomed commits. Written
            // through the real rollup so the row is exactly what the dashboard would read.
            computeAllWeeklyAggregates(db, '2026-07-01', new Date('2026-07-20T00:00:00.000Z'));
            const weekly = (): {commits: number} | undefined =>
                db
                    .prepare(
                        `SELECT total_commits AS commits FROM weekly_aggregates
                          WHERE developer_id = 'dev-1' AND week_start = ?`,
                    )
                    .get('2026-06-29') as {commits: number} | undefined;
            expect(weekly()?.commits).toBe(7);

            const del = await app.inject({
                method: 'DELETE',
                url: `/api/admin/git/providers/${dto.id as string}`,
                headers: authHeaders(adminToken),
            });
            expect(del.statusCode).toBe(200);
            const aggregates = del.json().data.aggregates as {
                from: string;
                to: string;
                periods: number;
                error: string | null;
            };
            expect(aggregates.error).toBeNull();
            expect(aggregates.from).toBe('2026-07-01');
            expect(aggregates.to).toBe('2026-07-02');
            // 1 week + 1 month + 1 quarter + 1 year for a two-day span.
            expect(aggregates.periods).toBe(4);
            // And the rollup no longer reports the retracted commits.
            expect(weekly()?.commits ?? 0).toBe(0);
        });

        // AC6 at the ROUTE, not just in the cascade unit test. Without this, replacing the
        // route's `configContainerKeys()` argument with `new Set()` would break the skip in
        // production and leave the suite green. The colliding state is unreachable through
        // POST (it 409s), but it is the realistic production case: the config file gains the
        // provider AFTER the DB row was saved.
        it('SKIPS the cascade when a config-file provider owns the same container', async () => {
            // Insert the DB row directly, bypassing the create-route conflict guard.
            db.prepare(
                `INSERT INTO git_providers
                 (id, type, container, url, include_subgroups, auth_method, auth_username,
                  token_ciphertext, token_meta, token_last4, repos_include, repos_exclude,
                  enabled, created_at, updated_at, created_by, last_sync_at, last_sync_status, last_sync_error)
                 VALUES ('shadowed', 'github', 'config-org', NULL, NULL, 'token', NULL, ?, ?, '1234',
                         NULL, NULL, 1, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
                         NULL, NULL, NULL, NULL)`,
            ).run(
                Buffer.from('cipher'),
                '{"algo":"AES-256-GCM","iv":"x","auth_tag":"y","key_id":"k1"}',
            );
            db.prepare(`UPDATE developers SET external_ids = '{"github":"alice"}' WHERE id = 'dev-1'`).run();
            upsertRawAuthorDaily(
                db,
                {
                    provider: 'github',
                    container: 'config-org',
                    raw_author_key: 'github:login:alice',
                    author_login: 'alice',
                    author_email: 'alice@example.com',
                    author_display_name: null,
                    date: '2026-07-01',
                    commits: 5,
                    lines_added: 10,
                    lines_removed: 1,
                    files_changed: 1,
                    prs_opened: 0,
                    prs_merged: 0,
                    review_comments_given: 0,
                    avg_time_to_merge_hours: null,
                    code_churn_rate: 0,
                    ai_signature_score: 0,
                    avg_commit_size: 10,
                    commit_burst_count: 0,
                },
                '2026-07-10T00:00:00.000Z',
            );
            projectSnapshots(db, {dates: ['2026-07-01']});
            db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
                'git_last_sync:github:config-org',
                '2026-07-10T00:00:00.000Z',
            );

            // The preview says so up front…
            const impact = await impactOf('shadowed');
            expect(impact.statusCode).toBe(200);
            expect(impact.json().data.cascade_skipped).toBe(true);
            expect(impact.json().data.raw_author_rows).toBe(0);

            const del = await app.inject({
                method: 'DELETE',
                url: '/api/admin/git/providers/shadowed',
                headers: authHeaders(adminToken),
            });
            expect(del.statusCode).toBe(200);
            expect(del.json().data.removed.cascade_skipped).toBe(true);
            expect(del.json().data.removed.raw_author_rows).toBe(0);
            expect(del.json().data.removed.cursor_keys_purged).toBe(0);
            // …and the config provider's data, snapshots and cursor all survive.
            expect(
                (db.prepare('SELECT COUNT(*) AS n FROM raw_author_daily').get() as {n: number}).n,
            ).toBe(1);
            expect(
                (
                    db
                        .prepare("SELECT COUNT(*) AS n FROM git_snapshots WHERE date = '2026-07-01'")
                        .get() as {n: number}
                ).n,
            ).toBe(1);
            expect(
                db
                    .prepare("SELECT value FROM sync_state WHERE key = 'git_last_sync:github:config-org'")
                    .get(),
            ).toEqual({value: '2026-07-10T00:00:00.000Z'});
        });

        it('rejects the preview for a developer session (403)', async () => {
            const dto = await createGithub();
            const res = await app.inject({
                method: 'GET',
                url: `/api/admin/git/providers/${dto.id as string}/delete-impact`,
                headers: authHeaders(devToken),
            });
            expect(res.statusCode).toBe(403);
        });

        it('404s an unknown id and 409s a config-file provider', async () => {
            expect((await impactOf('ghost')).statusCode).toBe(404);
            expect((await impactOf(CONFIG_PROVIDER_ID)).statusCode).toBe(409);
        });
    });

    // #264 AC3 + the deferred #262 PATCH-orphan finding.
    describe('one provider per (type, container)', () => {
        it('rejects a second provider for the same (type, container) with a 409 naming the owner', async () => {
            const first = await createGithub();
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
                payload: {type: 'github', container: 'db-org', token: 'ghp_second_TOKEN_5678'},
            });
            expect(res.statusCode).toBe(409);
            expect(res.json().message).toContain(first.id as string);
            // Only the first provider exists.
            const list = await app.inject({
                method: 'GET',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
            });
            expect(
                (list.json().data as {source: string}[]).filter((r) => r.source === 'db'),
            ).toHaveLength(1);
        });

        it('rejects a provider for a container a CONFIG-FILE provider already owns (409)', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
                payload: {type: 'github', container: 'config-org', token: 'ghp_clash_TOKEN_9999'},
            });
            expect(res.statusCode).toBe(409);
            expect(res.json().message).toContain('config-file provider');
        });

        it('allows the same container NAME under a different provider family', async () => {
            await createGithub();
            const res = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
                payload: {
                    type: 'gitlab',
                    auth_method: 'personal_access_token',
                    container: 'db-org',
                    token: 'glpat-OTHER_1234',
                },
            });
            expect(res.statusCode).toBe(201);
        });

        it('rejects a PATCH that renames onto an occupied container (409 naming the owner)', async () => {
            const first = await createGithub();
            const second = await app.inject({
                method: 'POST',
                url: '/api/admin/git/providers',
                headers: authHeaders(adminToken),
                payload: {type: 'github', container: 'second-org', token: 'ghp_second_TOKEN_5678'},
            });
            expect(second.statusCode).toBe(201);
            const secondId = second.json().data.id as string;

            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/git/providers/${secondId}`,
                headers: authHeaders(adminToken),
                payload: {type: 'github', container: 'db-org'},
            });
            expect(res.statusCode).toBe(409);
            expect(res.json().message).toContain(first.id as string);
            // Untouched.
            expect(
                (db.prepare('SELECT container FROM git_providers WHERE id = ?').get(secondId) as {
                    container: string;
                }).container,
            ).toBe('second-org');
        });

        // A rename onto a FREE container is refused too: the old container's imported data
        // and cursors would otherwise be owned by nobody (the #262 PATCH-orphan finding).
        it('rejects a PATCH that renames onto a FREE container (409), leaving the row intact', async () => {
            const dto = await createGithub();
            const id = dto.id as string;
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/git/providers/${id}`,
                headers: authHeaders(adminToken),
                payload: {type: 'github', container: 'brand-new-org'},
            });
            expect(res.statusCode).toBe(409);
            expect(res.json().message).toMatch(/cannot be changed/i);
            expect(
                (db.prepare('SELECT container FROM git_providers WHERE id = ?').get(id) as {
                    container: string;
                }).container,
            ).toBe('db-org');
        });

        it('accepts a PATCH that leaves (type, container) unchanged', async () => {
            const dto = await createGithub();
            const res = await app.inject({
                method: 'PATCH',
                url: `/api/admin/git/providers/${dto.id as string}`,
                headers: authHeaders(adminToken),
                payload: {type: 'github', container: 'db-org', enabled: false},
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().data.enabled).toBe(false);
        });
    });
});
