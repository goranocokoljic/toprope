import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {makeTestDb, seedFixtures} from './fixtures';
import {registerSessionAuth} from '../../src/auth/middleware';
import {registerAuthRoutes} from '../../src/dashboard/api/auth-routes';
import {registerAdminRoutes} from '../../src/dashboard/api/admin';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';
import {SESSION_COOKIE} from '../../src/auth/cookies';
import {upsertRawAuthorDaily} from '../../src/connectors/git/raw-author-daily';
import {earliestSyncStateKey, syncStateKey} from '../../src/connectors/git/sync';
import type {GitConnectorConfig} from '../../src/config/types';
import type {GitProviderType} from '../../src/connectors/git/providers/types';

/**
 * #266 — the duplicate-container guard, end to end over HTTP.
 *
 * #264 made `(type, container)` the ATTRIBUTION key: it keys every imported
 * `raw_author_daily`/`pr_records` row and the pipeline's three cursors, and it is the unit a
 * provider delete retracts. The guard it added compared the container with a raw exact match,
 * and SQLite's `=` on TEXT is case-sensitive with nothing trimming — so `Wireless_Media`,
 * `wireless_media`, `WIRELESS_MEDIA` and `Wireless_Media ` were four providers for ONE real
 * workspace: the same commits imported four times into four independent buckets that
 * `git_snapshots` then summed, and deleting one spelling retracted only its quarter.
 *
 * What is asserted here is the pair of properties that closes it: the value the guard
 * compares IS the value persisted (read back off the row, not inferred), and the persisted
 * value is what the cursors and imported rows resolve through.
 */

const PASSWORD = 'correct-horse-battery';
const KEY_B64 = Buffer.alloc(32, 7).toString('base64');

// A read-only config-file provider whose container is spelled with capitals — it occupies a
// `(type, container)` too, so a DB create for any variant of it must be refused.
const GIT_CONFIG: GitConnectorConfig = {
    providers: [
        {type: 'gitlab', group: 'Config_Group', auth: {type: 'oauth', token: 'gl-config-tok'}},
    ],
};

async function buildApp(db: Database.Database): Promise<FastifyInstance> {
    const app = Fastify({logger: false});
    registerSessionAuth(app, db);
    registerAuthRoutes(app, db, {sessionTtlHours: 24, cookieSecure: false});
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

/** The per-type body field names + a valid credential, so the matrix covers all three. */
const TYPE_BODY: Record<GitProviderType, Record<string, unknown>> = {
    github: {type: 'github', token: 'ghp_dbSECRET_TOKEN_ABCD'},
    bitbucket: {type: 'bitbucket', auth_method: 'access_token', token: 'bb-at-TOKEN9012'},
    gitlab: {type: 'gitlab', auth_method: 'oauth', token: 'glpat-TOKEN3456'},
};

// The three spellings that used to slip past the guard, plus the exact match.
const VARIANTS = ['Wireless_Media', 'wireless_media', 'WIRELESS_MEDIA', 'Wireless_Media '];

describe('admin git-provider container normalization (#266)', () => {
    let db: Database.Database;
    let app: FastifyInstance;
    let adminToken: string;
    let priorKey: string | undefined;

    beforeEach(async () => {
        priorKey = process.env.TOPROPE_SECRET_KEY;
        process.env.TOPROPE_SECRET_KEY = KEY_B64;
        db = makeTestDb();
        seedFixtures(db);
        createUser(db, {
            email: 'admin@test.com',
            passwordHash: await hashPassword(PASSWORD),
            role: 'admin',
        });
        app = await buildApp(db);
        const res = await app.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: {email: 'admin@test.com', password: PASSWORD},
        });
        adminToken = cookieToken(res);
    });

    afterEach(async () => {
        await app.close();
        db.close();
        if (priorKey === undefined) delete process.env.TOPROPE_SECRET_KEY;
        else process.env.TOPROPE_SECRET_KEY = priorKey;
    });

    function headers(): Record<string, string> {
        return {cookie: `${SESSION_COOKIE}=${adminToken}`};
    }

    async function create(
        type: GitProviderType,
        container: string,
        extra: Record<string, unknown> = {},
    ): Promise<{statusCode: number; body: Record<string, unknown>}> {
        const res = await app.inject({
            method: 'POST',
            url: '/api/admin/git/providers',
            headers: headers(),
            payload: {...TYPE_BODY[type], container, ...extra},
        });
        return {statusCode: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown>};
    }

    function storedContainer(id: string): string | undefined {
        const row = db.prepare('SELECT container FROM git_providers WHERE id = ?').get(id) as
            | {container: string}
            | undefined;
        return row?.container;
    }

    for (const type of Object.keys(TYPE_BODY) as GitProviderType[]) {
        it(`[${type}] every case/whitespace variant gets the same 409 naming the owner (AC1, AC5)`, async () => {
            const first = await create(type, 'Wireless_Media');
            expect(first.statusCode).toBe(201);
            const owner = (first.body.data as {id: string}).id;

            for (const variant of VARIANTS) {
                const dup = await create(type, variant);
                expect(dup.statusCode, `variant "${variant}" must be refused`).toBe(409);
                // The typed conflict, with the owner named — not a raw SQLITE_CONSTRAINT 500.
                expect(String(dup.body.message)).toContain(owner);
                expect(String(dup.body.message)).not.toContain('SQLITE_CONSTRAINT');
            }
            // Exactly one row survived all four attempts.
            expect(
                (db.prepare('SELECT COUNT(*) AS n FROM git_providers').get() as {n: number}).n,
            ).toBe(1);
        });

        it(`[${type}] the container the guard compared is the container persisted (AC2)`, async () => {
            const created = await create(type, '  Wireless_Media ');
            expect(created.statusCode).toBe(201);
            const dto = created.body.data as {id: string; container: string};
            // Asserted off the ROW, not inferred from the guard's behavior — the #255 shape
            // was precisely "the guard normalized and the write stored raw".
            expect(storedContainer(dto.id)).toBe('wireless_media');
            expect(dto.container).toBe('wireless_media');
        });

        // AC4 over HTTP. WHICH LAYER ANSWERS is stated rather than left to be inferred: the wire
        // parser's `requireString` rejects a container that is blank after trimming, so THAT is
        // what produces this 400 — not the store, and this test would pass unchanged with the
        // store's container guard removed. #266's own contribution to AC4 is one layer down, at
        // the factory: pre-#266 `!config.org` accepted '   ' (it is truthy), so a whitespace-only
        // container from a YAML config provider — which never passes through `requireString` —
        // reached the pipeline and became a real `(type, '')` attribution key. That half is
        // covered by `factory.test.ts` and by `providers-store.test.ts`, which drive the store
        // directly. What this test does prove is that the route answers 400 rather than letting a
        // constraint failure surface, on all three types and on both write verbs.
        it(`[${type}] a blank or whitespace-only container is a typed 400 (AC4)`, async () => {
            for (const blank of ['', '   ', '\t\n']) {
                const res = await create(type, blank);
                expect(res.statusCode, `container ${JSON.stringify(blank)}`).toBe(400);
                expect(String(res.body.message)).not.toContain('SQLITE_CONSTRAINT');
            }
            expect(
                (db.prepare('SELECT COUNT(*) AS n FROM git_providers').get() as {n: number}).n,
            ).toBe(0);
        });
    }

    it('a container owned by a read-only config-file provider is refused for every variant (AC1)', async () => {
        for (const variant of ['Config_Group', 'config_group', 'CONFIG_GROUP', ' config_group ']) {
            const res = await create('gitlab', variant);
            expect(res.statusCode, `variant "${variant}"`).toBe(409);
            expect(String(res.body.message)).toContain('config-file provider');
        }
    });

    it('the config-file provider itself is listed under its normalized container', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/admin/git/providers',
            headers: headers(),
        });
        const rows = (JSON.parse(res.body) as {data: {id: string; container: string}[]}).data;
        const configRow = rows.find((r) => r.id.startsWith('config:'));
        expect(configRow?.container).toBe('config_group');
        // The synthetic id is derived from the same normalized value, so it stays stable
        // however the YAML spells it.
        expect(configRow?.id).toBe('config:gitlab:config_group');
    });

    it('a PATCH that renames a container onto an existing one is a 409 naming the owner (AC5)', async () => {
        const a = await create('github', 'wireless_media');
        const b = await create('github', 'other-org');
        expect(b.statusCode).toBe(201);
        const bId = (b.body.data as {id: string}).id;
        const aId = (a.body.data as {id: string}).id;

        // Even spelled differently, the target pair is owned — the collision message wins over
        // the blanket immutability refusal because it can name who owns it.
        const res = await app.inject({
            method: 'PATCH',
            url: `/api/admin/git/providers/${bId}`,
            headers: headers(),
            payload: {type: 'github', container: 'WIRELESS_MEDIA'},
        });
        expect(res.statusCode).toBe(409);
        expect(String((JSON.parse(res.body) as {message: string}).message)).toContain(aId);
        expect(storedContainer(bId)).toBe('other-org');
    });

    it('a PATCH that only re-cases its OWN container succeeds and stays normalized (AC8)', async () => {
        // The admin edit form re-sends the container on every save, so a re-cased value must
        // not read as "moving to a different container".
        const created = await create('github', 'wireless_media');
        const id = (created.body.data as {id: string}).id;
        const res = await app.inject({
            method: 'PATCH',
            url: `/api/admin/git/providers/${id}`,
            headers: headers(),
            payload: {type: 'github', container: '  Wireless_Media ', enabled: false},
        });
        expect(res.statusCode).toBe(200);
        expect((JSON.parse(res.body) as {data: {enabled: boolean}}).data.enabled).toBe(false);
        expect(storedContainer(id)).toBe('wireless_media');
    });

    it('a PATCH cannot blank the container (AC4)', async () => {
        const created = await create('github', 'wireless_media');
        const id = (created.body.data as {id: string}).id;
        const res = await app.inject({
            method: 'PATCH',
            url: `/api/admin/git/providers/${id}`,
            headers: headers(),
            payload: {type: 'github', container: '   '},
        });
        // Rejected by the wire parser's non-blank check before it reaches the store — either
        // way a typed 400, never a raw constraint failure.
        expect(res.statusCode).toBe(400);
        expect(storedContainer(id)).toBe('wireless_media');
    });

    /**
     * AC3 — the cursor keys and the imported rows must use the SAME normalized form, so a
     * provider added with different casing resolves to the EXISTING data set rather than a
     * fresh empty one. That is what makes the #262/#264 delete-then-re-add reasoning hold: if
     * a re-add under a different spelling resolved to a new bucket, its cursors would be
     * empty, the pipeline would re-import the same span, and `mergeDailyAcrossRuns` would add
     * it on top of rows that were never retracted.
     */
    describe('cursor keys and imported rows resolve through the normalized container (AC3)', () => {
        // Seed one container's worth of imported history plus its forward cursor and
        // earliest-synced watermark, using the NORMALIZED spelling the pipeline writes.
        function seedContainer(container: string): void {
            upsertRawAuthorDaily(
                db,
                {
                    provider: 'github',
                    container,
                    raw_author_key: 'github:login:alice',
                    author_login: 'alice',
                    author_email: 'alice@example.com',
                    author_display_name: null,
                    date: '2026-07-01',
                    commits: 5,
                    lines_added: 50,
                    lines_removed: 5,
                    files_changed: 3,
                    prs_opened: 1,
                    prs_merged: 1,
                    review_comments_given: 0,
                    avg_time_to_merge_hours: 2,
                    code_churn_rate: 0.1,
                    ai_signature_score: 0,
                    avg_commit_size: 10,
                    commit_burst_count: 0,
                },
                '2026-07-02T00:00:00.000Z',
            );
            const put = db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)');
            put.run(syncStateKey('github', container), '2026-07-02T00:00:00.000Z');
            put.run(earliestSyncStateKey('github', container), '2026-01-01T00:00:00.000Z');
        }

        it('a provider created with different casing inherits the existing cursor and rows', async () => {
            seedContainer('wireless_media');

            // Created with capitals and a trailing space — the spellings that used to produce a
            // brand-new, empty container.
            const created = await create('github', 'WIRELESS_MEDIA ');
            expect(created.statusCode).toBe(201);
            const dto = created.body.data as {id: string; first_sync_pending: boolean};

            // It resolved to the SAME cursor key: the pipeline considers it already synced, so
            // the first-sync window input is (correctly) not offered.
            expect(dto.first_sync_pending).toBe(false);

            // And to the SAME raw_author_daily rows: the delete-impact preview — which reads
            // `(provider, container)` — finds the seeded history.
            const impact = await app.inject({
                method: 'GET',
                url: `/api/admin/git/providers/${dto.id}/delete-impact`,
                headers: headers(),
            });
            const data = (
                JSON.parse(impact.body) as {
                    data: {container: string; raw_author_rows: number; commits: number};
                }
            ).data;
            expect(data.container).toBe('wireless_media');
            expect(data.raw_author_rows).toBe(1);
            expect(data.commits).toBe(5);
        });

        it('delete + re-add with different casing starts clean (the cascade covered the same keys)', async () => {
            const created = await create('github', 'Wireless_Media');
            const id = (created.body.data as {id: string}).id;
            seedContainer('wireless_media');

            const del = await app.inject({
                method: 'DELETE',
                url: `/api/admin/git/providers/${id}`,
                headers: headers(),
            });
            expect(del.statusCode).toBe(200);
            const removed = (
                JSON.parse(del.body) as {
                    data: {removed: {raw_author_rows: number; cursor_keys_purged: number}};
                }
            ).data.removed;
            // The cascade found the rows and cursors even though the provider row was created
            // from a differently-cased input — one spelling, one attribution key.
            expect(removed.raw_author_rows).toBe(1);
            // Exact, not `> 0`: `seedContainer` wrote the forward cursor AND the earliest-synced
            // watermark, and a cascade that purged one but missed the other is precisely the
            // half-retraction the #262 rule forbids — it would pass a `> 0` assertion.
            expect(removed.cursor_keys_purged).toBe(2);

            // Re-added under yet another spelling: nothing survived to be double-counted, and
            // the pipeline correctly treats it as never synced.
            const again = await create('github', 'wireless_media');
            expect(again.statusCode).toBe(201);
            const reDto = again.body.data as {id: string; first_sync_pending: boolean};
            expect(reDto.first_sync_pending).toBe(true);
            expect(storedContainer(reDto.id)).toBe('wireless_media');
        });
    });
});
