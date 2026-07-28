/**
 * #273 — the per-commit diffstat ratchet cache.
 *
 * The expensive phase of a git sync is the per-commit diffstat fan-out: one API call per
 * commit, thousands over hours on a full-history window. And it is all-or-nothing — per #231
 * a repo failure holds the provider's cursor and discards every partial result, so a 503 on
 * commit 4,900 of 5,000 used to throw away 4,899 fetches. A commit's diffstat is IMMUTABLE, so
 * it can be memoized permanently: the run that fails still makes permanent progress.
 *
 * These tests drive the REAL provider classes through the REAL sync pipeline over a counting
 * `fetch` stub, so they measure request volume exactly as the provider's API sees it. A mock
 * provider could not catch a regression that re-introduces the fetch, because the cache lives
 * inside the provider.
 *
 * Fake timers throughout: a 503 costs the request layer up to five backoff sleeps and then the
 * in-run repo retry's 5- and 15-minute pauses (#272).
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper} from '../../../src/registry/developers';
import {GitSync, syncStateKey} from '../../../src/connectors/git/sync';
import {BitbucketProvider} from '../../../src/connectors/git/providers/bitbucket';
import {GitHubProvider} from '../../../src/connectors/git/providers/github';
import {GitLabProvider} from '../../../src/connectors/git/providers/gitlab';
import {
    countContainerDiffstats,
    createCommitDiffstatCache,
    deleteContainerDiffstats,
} from '../../../src/connectors/git/diffstat-cache';
import {MAX_SERVER_ERROR_RETRIES} from '../../../src/connectors/git/providers/http-retry';
import type {GitProviderConfig} from '../../../src/connectors/git/providers/types';

// Same shape as sync.test.ts / diff-fetch-dedup.test.ts: stub the factory so `syncProviders`
// uses the provider we hand it, while keeping the rest of the module (config validation) real.
vi.mock('../../../src/connectors/git/providers/factory', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/connectors/git/providers/factory')>();
    return {...actual, createGitProvider: vi.fn()};
});

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');

const AUTHOR_EMAIL = 'alice@example.com';
const COMMIT_DATE = '2024-01-15T10:00:00.000Z';
const NOW = '2026-07-28T00:00:00.000Z';
const SHAS = ['sha-aaa', 'sha-bbb', 'sha-ccc', 'sha-ddd', 'sha-eee'];

const BITBUCKET_CONFIG: GitProviderConfig = {
    type: 'bitbucket',
    workspace: 'test-ws',
    auth: {type: 'access_token', token: 'tok'},
};
const GITHUB_CONFIG: GitProviderConfig = {
    type: 'github',
    org: 'test-org',
    auth: {type: 'token', api_token: 'tok'},
};
const GITLAB_CONFIG: GitProviderConfig = {
    type: 'gitlab',
    group: 'test-group',
    auth: {type: 'personal_access_token', token: 'tok'},
};

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

/** A developer resolvable by commit email on ANY provider (`email:` lookup key). */
function seedAlice(db: Database.Database): string {
    addTeam(db, 'eng');
    return addDeveloper(db, 'alice', 'eng', AUTHOR_EMAIL, 'Alice').id;
}

async function getCreateGitProvider(): Promise<ReturnType<typeof vi.fn>> {
    const {createGitProvider} = await import('../../../src/connectors/git/providers/factory');
    return createGitProvider as ReturnType<typeof vi.fn>;
}

function jsonResponse(status: number, body: unknown): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers({}),
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
    } as unknown as Response;
}

/**
 * A commit-diffstat request log, shared by every provider stub below.
 *
 * `ok` — the shas that were ANSWERED successfully. That is the number the convergence bound is
 * stated in: "each distinct commit is fetched successfully exactly once, ever". `all` also
 * counts the attempts that failed, which is what makes "+ retries" measurable rather than
 * hand-waved.
 */
interface DiffstatLog {
    all: string[];
    ok: string[];
    /** Shas whose diffstat request should answer 503 (mutated between runs). */
    failing: Set<string>;
    /** Shas whose diffstat request should answer 404 (a deterministic "no diffstat"). */
    missing: Set<string>;
    countOk(sha: string): number;
    countAll(sha: string): number;
}

function makeLog(): DiffstatLog {
    const log: DiffstatLog = {
        all: [],
        ok: [],
        failing: new Set<string>(),
        missing: new Set<string>(),
        countOk: (sha) => log.ok.filter((s) => s === sha).length,
        countAll: (sha) => log.all.filter((s) => s === sha).length,
    };
    return log;
}

/**
 * Five files per commit, shaped so the columns computed FROM the file-level entries carry real
 * signal — `code_churn_rate` and `ai_signature_score` are the only readers of `status` and of
 * the per-file additions distribution, so a thin fixture would leave both at 0 and a corrupted
 * cache round-trip would be invisible to a snapshot comparison. Five `added` `.ts` files of 60
 * additions each trips the bulk-new-files, large-commit and uniform-file-size AI signals.
 */
const FILES = Array.from({length: 5}, (_, i) => ({
    path: `src/gen${i}.ts`,
    additions: 60,
    deletions: 2,
    status: 'added',
}));
const TOTAL_ADDITIONS = FILES.reduce((s, f) => s + f.additions, 0);
const TOTAL_DELETIONS = FILES.reduce((s, f) => s + f.deletions, 0);

/** A unified-diff hunk that parses to exactly `additions`/`deletions` changed lines (GitLab). */
function hunk(additions: number, deletions: number): string {
    return (
        `@@ -1,${deletions} +1,${additions} @@\n` +
        '+added line\n'.repeat(additions) +
        '-removed line\n'.repeat(deletions)
    );
}

// --- Provider fetch stubs ----------------------------------------------------------------

/** Routes the Bitbucket endpoints; records and scripts every `/diffstat/{sha}` request. */
function bitbucketFetch(log: DiffstatLog, shas: string[] = SHAS): ReturnType<typeof vi.fn> {
    return vi.fn(async (url: string): Promise<Response> => {
        const u = String(url);
        const diffstat = u.match(/\/diffstat\/([^?]+)/);
        if (diffstat) {
            const sha = diffstat[1];
            log.all.push(sha);
            if (log.failing.has(sha)) return jsonResponse(503, {error: 'transient'});
            if (log.missing.has(sha)) return jsonResponse(404, {error: 'no diffstat'});
            log.ok.push(sha);
            return jsonResponse(200, {
                values: FILES.map((f) => ({
                    status: f.status,
                    lines_added: f.additions,
                    lines_removed: f.deletions,
                    new: {path: f.path},
                    old: {path: f.path},
                })),
            });
        }
        if (/\/repositories\/test-ws\?/.test(u)) {
            return jsonResponse(200, {
                values: [
                    {
                        uuid: 'u1',
                        slug: 'repo1',
                        full_name: 'test-ws/repo1',
                        mainbranch: {name: 'main'},
                        scm: 'git',
                    },
                ],
            });
        }
        if (/\/repo1\/commits\?/.test(u)) {
            return jsonResponse(200, {
                values: shas.map((hash) => ({
                    hash,
                    author: {raw: `Alice <${AUTHOR_EMAIL}>`, user: {nickname: 'alice-bb'}},
                    date: COMMIT_DATE,
                    message: 'feat: work',
                })),
            });
        }
        // PR list and anything else — an empty page.
        return jsonResponse(200, {values: []});
    });
}

/** Routes the GitHub endpoints; the per-commit DETAIL request is what the cache elides. */
function githubFetch(log: DiffstatLog, shas: string[] = SHAS): ReturnType<typeof vi.fn> {
    return vi.fn(async (url: string): Promise<Response> => {
        const u = String(url);
        const detail = u.match(/\/repos\/test-org\/repo1\/commits\/([^?]+)$/);
        if (detail) {
            const sha = detail[1];
            log.all.push(sha);
            if (log.failing.has(sha)) return jsonResponse(503, {message: 'transient'});
            log.ok.push(sha);
            return jsonResponse(200, {
                sha,
                commit: {
                    author: {name: 'Alice', email: AUTHOR_EMAIL, date: COMMIT_DATE},
                    message: 'feat: work',
                },
                author: {login: 'alice-gh'},
                stats: {
                    additions: TOTAL_ADDITIONS,
                    deletions: TOTAL_DELETIONS,
                    total: TOTAL_ADDITIONS + TOTAL_DELETIONS,
                },
                files: FILES.map((f) => ({
                    filename: f.path,
                    additions: f.additions,
                    deletions: f.deletions,
                    status: f.status,
                })),
            });
        }
        if (/\/orgs\/test-org\/repos\?/.test(u)) {
            return jsonResponse(200, [
                {
                    id: 1,
                    name: 'repo1',
                    full_name: 'test-org/repo1',
                    default_branch: 'main',
                    archived: false,
                },
            ]);
        }
        if (/\/repos\/test-org\/repo1\/commits\?/.test(u)) {
            // The FULL list row GitHub actually returns — the cache-hit path builds the whole
            // commit from it instead of re-requesting the detail.
            return jsonResponse(
                200,
                shas.map((sha) => ({
                    sha,
                    commit: {
                        author: {name: 'Alice', email: AUTHOR_EMAIL, date: COMMIT_DATE},
                        message: 'feat: work',
                    },
                    author: {login: 'alice-gh'},
                })),
            );
        }
        return jsonResponse(200, []);
    });
}

/** Routes the GitLab endpoints; records and scripts every per-commit `/diff` request. */
function gitlabFetch(log: DiffstatLog, shas: string[] = SHAS): ReturnType<typeof vi.fn> {
    return vi.fn(async (url: string): Promise<Response> => {
        const u = String(url);
        const diff = u.match(/\/repository\/commits\/([^/]+)\/diff\?/);
        if (diff) {
            const sha = diff[1];
            log.all.push(sha);
            if (log.failing.has(sha)) return jsonResponse(503, {message: 'transient'});
            if (log.missing.has(sha)) return jsonResponse(404, {message: 'no diff'});
            log.ok.push(sha);
            return jsonResponse(
                200,
                FILES.map((f) => ({
                    old_path: f.path,
                    new_path: f.path,
                    // `new_file` maps to status 'added' — matching FILES, so all three
                    // providers feed the analysis the same file-level shape.
                    new_file: true,
                    renamed_file: false,
                    deleted_file: false,
                    diff: hunk(f.additions, f.deletions),
                })),
            );
        }
        if (/\/groups\/test-group\/projects\?/.test(u)) {
            return jsonResponse(200, [
                {
                    id: 7,
                    name: 'Repo1',
                    path: 'repo1',
                    path_with_namespace: 'test-group/repo1',
                    default_branch: 'main',
                    archived: false,
                },
            ]);
        }
        if (/\/repository\/commits\?/.test(u)) {
            return jsonResponse(
                200,
                shas.map((id) => ({
                    id,
                    author_name: 'Alice',
                    author_email: AUTHOR_EMAIL,
                    authored_date: COMMIT_DATE,
                    message: 'feat: work',
                })),
            );
        }
        return jsonResponse(200, []);
    });
}

// --- Shared helpers ----------------------------------------------------------------------

/** Runs one sync to completion, draining the request- and repo-level pauses on the fake clock. */
async function runSync(
    db: Database.Database,
    config: GitProviderConfig,
): Promise<Awaited<ReturnType<GitSync['syncProviders']>>> {
    const pending = new GitSync({enabled: false}).syncProviders(db, [config]);
    await vi.runAllTimersAsync();
    return pending;
}

interface CachedRow {
    repo: string;
    sha: string;
    additions: number;
    deletions: number;
    absent: number;
    entries: string;
}

function cachedRows(db: Database.Database): CachedRow[] {
    return db
        .prepare(
            'SELECT repo, sha, additions, deletions, absent, entries FROM commit_diffstats ORDER BY sha',
        )
        .all() as CachedRow[];
}

/** Move the whole diffstat cache between two databases — the "already ratcheted" setup. */
function copyDiffstats(from: Database.Database, to: Database.Database): number {
    const rows = from.prepare('SELECT * FROM commit_diffstats').all() as Array<
        Record<string, unknown>
    >;
    const insert = to.prepare(
        `INSERT INTO commit_diffstats
             (provider, container, repo, sha, additions, deletions, absent, entries, fetched_at)
         VALUES (@provider, @container, @repo, @sha, @additions, @deletions, @absent, @entries, @fetched_at)`,
    );
    for (const row of rows) insert.run(row);
    return rows.length;
}

function countRows(db: Database.Database, table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n: number}).n;
}

/**
 * The WHOLE projected row minus the two identity columns — the strongest form of "the analysis
 * input was identical". `lines_added` would survive almost any corruption of the file-level
 * entries; `code_churn_rate` and `ai_signature_score` are computed FROM them, so they are what
 * makes this comparison able to fail.
 */
function fullSnapshot(db: Database.Database, devId: string): Record<string, unknown> {
    const row = db
        .prepare('SELECT * FROM git_snapshots WHERE developer_id = ?')
        .get(devId) as Record<string, unknown>;
    const rest = {...row};
    delete rest.id;
    delete rest.developer_id;
    return rest;
}

describe('#273 per-commit diffstat ratchet cache', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(NOW));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        // `restoreAllMocks` does NOT undo `stubGlobal`, and `unstubGlobals` is not set in
        // vitest.config.ts — without this the last counting `fetch` leaks into the next test.
        vi.unstubAllGlobals();
    });

    // --- AC1 + AC3: a failed run keeps its diffstats and nothing else ---------------------

    it('a run that dies mid-repo persists the diffstats it fetched, writes NO data, and holds the cursor', async () => {
        const db = makeDb();
        seedAlice(db);
        const log = makeLog();
        // The third commit's diffstat is down for the whole of run 1.
        log.failing.add(SHAS[2]);
        vi.stubGlobal('fetch', bitbucketFetch(log));
        (await getCreateGitProvider()).mockImplementation((cfg, cache) =>
            new BitbucketProvider(cfg, cache),
        );

        const result = await runSync(db, BITBUCKET_CONFIG);

        // The repo's commit fetch failed, so #231 discards the provider's whole window.
        expect(result.errors.some((e) => e.includes('Failed to fetch commits'))).toBe(true);
        expect(countRows(db, 'raw_author_daily')).toBe(0);
        expect(countRows(db, 'git_snapshots')).toBe(0);
        expect(countRows(db, 'pr_records')).toBe(0);
        expect(
            db
                .prepare('SELECT value FROM sync_state WHERE key = ?')
                .get(syncStateKey('bitbucket', 'test-ws')),
        ).toBeUndefined();

        // …but the two diffstats fetched before the failure SURVIVED. That is the ratchet.
        expect(cachedRows(db).map((r) => r.sha)).toEqual([SHAS[0], SHAS[1]]);
        // A 5xx is a statement about the server, not about the commit — never cached.
        expect(cachedRows(db).some((r) => r.sha === SHAS[2])).toBe(false);
        // The in-run repo retry (#272) re-attempts the whole repo twice more; because the
        // first two shas are already cached, neither is re-requested even WITHIN the run.
        expect(log.countAll(SHAS[0])).toBe(1);
        expect(log.countAll(SHAS[1])).toBe(1);

        // --- Run 2, with the outage over -------------------------------------------------
        log.failing.clear();
        log.all.length = 0;
        log.ok.length = 0;
        const second = await runSync(db, BITBUCKET_CONFIG);

        expect(second.errors.filter((e) => e.includes('Failed to fetch'))).toEqual([]);
        // ONLY the uncached shas were requested. This is AC1.
        expect([...new Set(log.all)].sort()).toEqual([SHAS[2], SHAS[3], SHAS[4]]);
        // …and the run completed with every commit's churn, including the two it never
        // re-fetched: 5 commits × 2 files.
        expect(
            db
                .prepare(
                    'SELECT commits, lines_added, lines_removed, files_changed FROM git_snapshots',
                )
                .get(),
        ).toEqual({
            commits: 5,
            lines_added: 5 * TOTAL_ADDITIONS,
            lines_removed: 5 * TOTAL_DELETIONS,
            files_changed: 5 * FILES.length,
        });
        // The cursor now exists and matches the instant this run reported covering.
        expect(
            db
                .prepare('SELECT value FROM sync_state WHERE key = ?')
                .get(syncStateKey('bitbucket', 'test-ws')),
        ).toEqual({value: second.lastSyncTime});

        db.close();
    });

    // --- AC2: convergence under repeated intermittent failures ---------------------------

    it('converges across repeated runs: each distinct commit is fetched successfully exactly once', async () => {
        const db = makeDb();
        seedAlice(db);
        const log = makeLog();
        vi.stubGlobal('fetch', bitbucketFetch(log));
        (await getCreateGitProvider()).mockImplementation((cfg, cache) =>
            new BitbucketProvider(cfg, cache),
        );

        // A different commit is down on each of the first three runs, so no single run can
        // complete; the fourth is clean. Without the ratchet, each run re-fetches from zero
        // and the successful-fetch total grows without bound.
        const script = [SHAS[1], SHAS[2], SHAS[3], null];
        let completed = 0;
        for (const downSha of script) {
            log.failing.clear();
            if (downSha) log.failing.add(downSha);
            const result = await runSync(db, BITBUCKET_CONFIG);
            if (!result.errors.some((e) => e.includes('Failed to fetch commits'))) completed++;
        }

        // The sync eventually completes — exactly once, on the run whose outage was over.
        expect(completed).toBe(1);
        expect(
            db
                .prepare('SELECT commits FROM git_snapshots')
                .get(),
        ).toEqual({commits: SHAS.length});

        // THE BOUND. Every distinct commit was successfully fetched exactly once across all
        // four runs — the total is the number of distinct commits, not runs × commits.
        expect(log.ok.length).toBe(SHAS.length);
        for (const sha of SHAS) expect(log.countOk(sha)).toBe(1);

        // The only extra requests are FAILED attempts, and they are bounded by the retry
        // budgets: per run, one down sha × (1 + request-level 5xx retries) × repo attempts.
        const attemptsPerFault = (1 + MAX_SERVER_ERROR_RETRIES) * 3;
        expect(log.all.length).toBeLessThanOrEqual(SHAS.length + 3 * attemptsPerFault);
        // …and a positive control that the script actually produced failures, so the bound
        // above is not vacuously satisfied by a run that never failed.
        expect(log.all.length).toBeGreaterThan(SHAS.length);

        db.close();
    });

    // --- AC4: the deterministic 404 is an answer, and is cached ---------------------------

    it('caches a 404-absent diffstat and reproduces the zero-stat commit without re-asking', async () => {
        const first = makeDb();
        const devA = seedAlice(first);
        const log = makeLog();
        for (const sha of SHAS) log.missing.add(sha);
        vi.stubGlobal('fetch', bitbucketFetch(log));
        (await getCreateGitProvider()).mockImplementation((cfg, cache) =>
            new BitbucketProvider(cfg, cache),
        );

        await runSync(first, BITBUCKET_CONFIG);

        // A 404 is a deterministic per-commit answer: it is recorded, explicitly marked.
        const rows = cachedRows(first);
        expect(rows).toHaveLength(SHAS.length);
        for (const row of rows) {
            expect(row.absent).toBe(1);
            expect(row.entries).toBe('[]');
            expect(row.additions).toBe(0);
            expect(row.deletions).toBe(0);
        }
        const zeroStat = fullSnapshot(first, devA);
        expect(zeroStat).toMatchObject({
            commits: SHAS.length,
            lines_added: 0,
            lines_removed: 0,
            files_changed: 0,
        });

        // A fresh store that has ALREADY ratcheted these commits must not re-ask the endpoint
        // that just 404'd — those are exactly the commits a naive cache re-asks forever.
        const second = makeDb();
        const devB = seedAlice(second);
        expect(copyDiffstats(first, second)).toBe(SHAS.length);
        log.all.length = 0;
        await runSync(second, BITBUCKET_CONFIG);

        expect(log.all).toEqual([]);
        expect(fullSnapshot(second, devB)).toEqual(zeroStat);

        first.close();
        second.close();
    });

    // --- AC6: byte-identical analysis input, on every provider ----------------------------

    // Run the identical commit set twice against a fresh store — once with an empty cache
    // (every fetch happens) and once with the cache pre-loaded and the per-commit endpoint
    // wired to FAIL. The second run can only succeed if it made no request at all, and the
    // whole projected row must match, not just the line counts.
    const providers: Array<{
        name: string;
        config: GitProviderConfig;
        fetchFor: (log: DiffstatLog) => ReturnType<typeof vi.fn>;
        build: (cfg: never, cache: never) => unknown;
    }> = [
        {
            name: 'Bitbucket',
            config: BITBUCKET_CONFIG,
            fetchFor: bitbucketFetch,
            build: (cfg, cache) => new BitbucketProvider(cfg, cache),
        },
        {
            name: 'GitHub',
            config: GITHUB_CONFIG,
            fetchFor: githubFetch,
            build: (cfg, cache) => new GitHubProvider(cfg, cache),
        },
        {
            name: 'GitLab',
            config: GITLAB_CONFIG,
            fetchFor: gitlabFetch,
            build: (cfg, cache) => new GitLabProvider(cfg, cache),
        },
    ];

    for (const provider of providers) {
        it(`${provider.name}: a fully-cached run makes ZERO per-commit requests and writes an identical snapshot`, async () => {
            const log = makeLog();
            vi.stubGlobal('fetch', provider.fetchFor(log));
            (await getCreateGitProvider()).mockImplementation(provider.build);

            const fresh = makeDb();
            const devA = seedAlice(fresh);
            await runSync(fresh, provider.config);
            const fetched = fullSnapshot(fresh, devA);
            // Positive controls: without these, two all-zero rows would compare equal and the
            // comparison below would prove nothing.
            expect(fetched.commits).toBe(SHAS.length);
            expect(fetched.lines_added as number).toBeGreaterThan(0);
            expect(fetched.code_churn_rate as number).toBeGreaterThan(0);
            expect(fetched.ai_signature_score as number).toBeGreaterThan(0);
            expect(log.ok).toHaveLength(SHAS.length);

            const warm = makeDb();
            const devB = seedAlice(warm);
            expect(copyDiffstats(fresh, warm)).toBe(SHAS.length);
            // Every per-commit request now answers 503. A cache MISS would fail the repo and
            // leave `git_snapshots` empty, so this is a hard proof that none happened.
            for (const sha of SHAS) log.failing.add(sha);
            log.all.length = 0;
            log.ok.length = 0;

            const result = await runSync(warm, provider.config);

            expect(log.all).toEqual([]);
            expect(result.errors.filter((e) => e.includes('Failed to fetch'))).toEqual([]);
            expect(fullSnapshot(warm, devB)).toEqual(fetched);

            fresh.close();
            warm.close();
        });
    }

    // --- The cache is scoped to (provider, container) --------------------------------------

    it('does not serve one container’s cache to another container of the same family', async () => {
        const db = makeDb();
        seedAlice(db);
        const log = makeLog();
        vi.stubGlobal('fetch', bitbucketFetch(log));
        (await getCreateGitProvider()).mockImplementation((cfg, cache) =>
            new BitbucketProvider(cfg, cache),
        );

        await runSync(db, BITBUCKET_CONFIG);
        expect(countContainerDiffstats(db, 'bitbucket', 'test-ws')).toBe(SHAS.length);
        expect(countContainerDiffstats(db, 'bitbucket', 'other-ws')).toBe(0);

        // A different workspace whose API happens to serve the same repo/sha names starts cold.
        const other = createCommitDiffstatCache(db, 'bitbucket', 'other-ws');
        expect(other.load('repo1', SHAS).size).toBe(0);
        // …and the same workspace spelled differently resolves to the SAME rows (#266
        // normalization — the value compared is the value persisted).
        expect(
            createCommitDiffstatCache(db, 'bitbucket', '  TEST-WS ').load('repo1', SHAS).size,
        ).toBe(SHAS.length);

        db.close();
    });

    // --- Mid-run provider delete ------------------------------------------------------------

    it('purges rows a run wrote for a container whose provider was deleted mid-run', async () => {
        // The cascade empties the table for its container when it runs, but this run keeps
        // writing through for the rest of its fetch. Left behind, a re-added provider would
        // inherit file-level detail its credentials may no longer justify.
        const db = makeDb();
        seedAlice(db);
        db.prepare(
            `INSERT INTO git_providers
             (id, type, container, url, include_subgroups, auth_method, auth_username,
              token_ciphertext, token_meta, token_last4, repos_include, repos_exclude,
              enabled, created_at, updated_at, created_by, last_sync_at, last_sync_status, last_sync_error)
             VALUES ('p1', 'bitbucket', 'test-ws', NULL, NULL, 'access_token', NULL, ?, ?, '1234',
                     NULL, NULL, 1, ?, ?, NULL, NULL, NULL, NULL)`,
        ).run(Buffer.from('cipher'), '{"algo":"AES-256-GCM","iv":"x","auth_tag":"y","key_id":"k1"}', NOW, NOW);

        const log = makeLog();
        vi.stubGlobal('fetch', bitbucketFetch(log));
        (await getCreateGitProvider()).mockImplementation((cfg, cache) => {
            // Delete the owning row the moment the run starts fetching, i.e. before any
            // diffstat is written — the shape a concurrent admin delete produces.
            db.prepare("DELETE FROM git_providers WHERE id = 'p1'").run();
            return new BitbucketProvider(cfg, cache);
        });

        const result = await runSync(db, BITBUCKET_CONFIG);

        expect(result.errors.some((e) => e.startsWith('Provider changed during this run:'))).toBe(
            true,
        );
        expect(countContainerDiffstats(db, 'bitbucket', 'test-ws')).toBe(0);
        db.close();
    });

    // --- The cache module's own contract ----------------------------------------------------

    describe('createCommitDiffstatCache', () => {
        let db: Database.Database;

        beforeEach(() => {
            db = makeDb();
        });
        afterEach(() => db.close());

        it('refuses a blank container — it is not an attribution key', () => {
            expect(() => createCommitDiffstatCache(db, 'github', '   ')).toThrow(/container is blank/);
        });

        it('round-trips a diffstat and is idempotent under re-recording', () => {
            const cache = createCommitDiffstatCache(db, 'github', 'org');
            const value = {additions: 7, deletions: 2, entries: [...FILES], absent: false};
            cache.put('repo1', 'sha1', value);
            cache.put('repo1', 'sha1', value);
            expect(countContainerDiffstats(db, 'github', 'org')).toBe(1);
            expect(cache.load('repo1', ['sha1']).get('sha1')).toEqual(value);
        });

        it('normalizes an absent marker to zero stats and no entries', () => {
            const cache = createCommitDiffstatCache(db, 'github', 'org');
            // A caller passing stats alongside `absent` is incoherent; the row must not record
            // both "no diffstat exists" and "here are its changed lines".
            cache.put('repo1', 'sha1', {additions: 9, deletions: 9, entries: [...FILES], absent: true});
            expect(cache.load('repo1', ['sha1']).get('sha1')).toEqual({
                additions: 0,
                deletions: 0,
                entries: [],
                absent: true,
            });
        });

        it('reads a batch far larger than one bound-parameter chunk in full', () => {
            // 900 shas exceeds the internal chunk size, so this fails if the chunking is wrong
            // — and it would also fail as a single 900-parameter statement on an older SQLite.
            const cache = createCommitDiffstatCache(db, 'gitlab', 'grp');
            const shas = Array.from({length: 900}, (_, i) => `sha-${i}`);
            for (const sha of shas) {
                cache.put('repo1', sha, {additions: 1, deletions: 0, entries: [], absent: false});
            }
            const loaded = cache.load('repo1', shas);
            expect(loaded.size).toBe(900);
            expect(loaded.get('sha-899')).toEqual({
                additions: 1,
                deletions: 0,
                entries: [],
                absent: false,
            });
        });

        it('treats an undecodable stored row as a MISS rather than a corrupted commit', () => {
            const cache = createCommitDiffstatCache(db, 'github', 'org');
            cache.put('repo1', 'good', {additions: 1, deletions: 0, entries: [...FILES], absent: false});
            cache.put('repo1', 'torn', {additions: 1, deletions: 0, entries: [...FILES], absent: false});
            cache.put('repo1', 'shape', {additions: 1, deletions: 0, entries: [...FILES], absent: false});
            // `entries` is an unconstrained TEXT column: a truncated value and a well-formed
            // JSON array of the wrong shape are both reachable by anything that writes the
            // file directly. Neither may become a commit with a `undefined` path.
            db.prepare("UPDATE commit_diffstats SET entries = '[{\"path\":' WHERE sha = 'torn'").run();
            db.prepare(
                `UPDATE commit_diffstats SET entries = '[{"path":"a.ts","additions":"lots","deletions":0,"status":"added"}]' WHERE sha = 'shape'`,
            ).run();

            const loaded = cache.load('repo1', ['good', 'torn', 'shape']);
            expect([...loaded.keys()]).toEqual(['good']);
        });

        it('rejects every undecodable entries shape, not just a torn one', () => {
            const cache = createCommitDiffstatCache(db, 'github', 'org');
            const bad = [
                // Not an array at all.
                '{"path":"a.ts"}',
                // An array of primitives.
                '["a.ts"]',
                // A null element — `typeof null === 'object'`, the classic hole.
                '[null]',
                // A non-string status.
                '[{"path":"a.ts","additions":1,"deletions":0,"status":7}]',
                // A JSON `null` addition, which is what a NaN round-trips to.
                '[{"path":"a.ts","additions":null,"deletions":0,"status":"added"}]',
            ];
            for (const [i, entries] of bad.entries()) {
                const sha = `bad-${i}`;
                cache.put('repo1', sha, {additions: 1, deletions: 0, entries: [], absent: false});
                db.prepare('UPDATE commit_diffstats SET entries = ? WHERE sha = ?').run(entries, sha);
                expect(cache.load('repo1', [sha]).size, entries).toBe(0);
            }
        });

        it('a cache write can never fail a sync — a nonsensical put is skipped, not thrown', () => {
            // `put` runs per commit inside the provider's fetch loop, whose throw path holds the
            // provider's cursor and discards the whole run's data (#231). Nothing about a memo
            // is worth that, so every guard here degrades to "one re-fetch next run".
            const cache = createCommitDiffstatCache(db, 'github', 'org');
            const value = {additions: 1, deletions: 0, entries: [], absent: false};
            expect(() => cache.put('', 'sha1', value)).not.toThrow();
            expect(() => cache.put('repo1', '', value)).not.toThrow();
            expect(() =>
                cache.put('repo1', 'sha1', {...value, additions: -1}),
            ).not.toThrow();
            expect(() =>
                cache.put('repo1', 'sha2', {...value, deletions: Number.NaN}),
            ).not.toThrow();
            expect(countContainerDiffstats(db, 'github', 'org')).toBe(0);
        });

        it('load short-circuits on an empty request instead of issuing a query', () => {
            const cache = createCommitDiffstatCache(db, 'github', 'org');
            expect(cache.load('repo1', []).size).toBe(0);
            expect(cache.load('', ['sha1']).size).toBe(0);
        });

        it('deleteContainerDiffstats removes exactly one container’s rows', () => {
            createCommitDiffstatCache(db, 'bitbucket', 'ws-a').put('r', 's', {
                additions: 1,
                deletions: 0,
                entries: [],
                absent: false,
            });
            createCommitDiffstatCache(db, 'bitbucket', 'ws-b').put('r', 's', {
                additions: 1,
                deletions: 0,
                entries: [],
                absent: false,
            });
            createCommitDiffstatCache(db, 'github', 'ws-a').put('r', 's', {
                additions: 1,
                deletions: 0,
                entries: [],
                absent: false,
            });

            expect(deleteContainerDiffstats(db, 'bitbucket', 'ws-a')).toBe(1);

            expect(countContainerDiffstats(db, 'bitbucket', 'ws-a')).toBe(0);
            expect(countContainerDiffstats(db, 'bitbucket', 'ws-b')).toBe(1);
            expect(countContainerDiffstats(db, 'github', 'ws-a')).toBe(1);
        });
    });
});
