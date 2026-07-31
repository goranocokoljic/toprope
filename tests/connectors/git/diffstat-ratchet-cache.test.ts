/**
 * #273 — the per-commit diffstat ratchet cache.
 *
 * The expensive phase of a git sync is the per-commit diffstat fan-out: one API call per
 * commit, thousands over hours on a full-history window. And it is all-or-nothing — per #231
 * a repo failure holds the provider's cursor and discards every partial result, so a 503 on
 * commit 4,900 of 5,000 used to throw away 4,899 fetches. A commit's diffstat is IMMUTABLE, so
 * it can be memoized permanently: the run that fails still makes permanent progress.
 *
 * These tests drive the REAL provider classes, built by the REAL factory, through the REAL
 * sync pipeline over a counting `fetch` stub — nothing between `syncProviders` and the socket
 * is mocked. That matters specifically here: the factory is the only place the cache is handed
 * to a provider, so stubbing it (as the sibling git test files do) would leave "the pipeline
 * actually installs the ratchet" unproven while every assertion below still passed.
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
import {
    DIFFSTAT_CACHE_DEGRADED_PREFIX,
    GIT_REPO_RETRY_DELAYS_MS,
    GIT_RUN_WALL_CLOCK_BUDGET_MS,
    GitSync,
    isAdvisoryError,
    syncStateKey,
} from '../../../src/connectors/git/sync';
import {
    createCommitDiffstatCache,
    deleteContainerDiffstats,
} from '../../../src/connectors/git/diffstat-cache';
import {resolveCommitDiffstat} from '../../../src/connectors/git/providers/diffstat';
import {
    GitProviderFetchError,
    MAX_SERVER_ERROR_RETRIES,
} from '../../../src/connectors/git/providers/http-retry';
import type {
    GitFileDiff,
    GitProviderConfig,
    GitProviderType,
} from '../../../src/connectors/git/providers/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');

const AUTHOR_EMAIL = 'alice@example.com';
const COMMIT_DATE = '2024-01-15T10:00:00.000Z';
const NOW = '2026-07-28T00:00:00.000Z';
const SHAS = ['sha-aaa', 'sha-bbb', 'sha-ccc', 'sha-ddd', 'sha-eee'];

/**
 * Carries twelve `ERROR_HANDLING_PATTERN` tokens, which is what makes the commit MESSAGE
 * load-bearing for `ai_signature_score` (signal 3 fires at >= 10 mentions). The GitHub
 * cache-hit path rebuilds the message from the commit LIST row rather than the detail
 * response, so without this the byte-identity comparison could not see it being dropped.
 */
const COMMIT_MESSAGE =
    'fix: try catch throw Error exception handleError onError try catch throw Error exception';

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
    /** Shas whose per-commit request should answer 503 (mutated between runs). */
    failing: Set<string>;
    /** Shas whose per-commit request should answer 404. */
    missing: Set<string>;
    /** Fired once, on the repo's commit-LIST request — the mid-fetch injection point. */
    onListRequest?: () => void;
    countOk(sha: string): number;
    countAll(sha: string): number;
    reset(): void;
}

function makeLog(): DiffstatLog {
    const log: DiffstatLog = {
        all: [],
        ok: [],
        failing: new Set<string>(),
        missing: new Set<string>(),
        countOk: (sha) => log.ok.filter((s) => s === sha).length,
        countAll: (sha) => log.all.filter((s) => s === sha).length,
        reset: () => {
            log.all.length = 0;
            log.ok.length = 0;
        },
    };
    return log;
}

/**
 * Five files per commit, shaped so the columns computed FROM the file-level entries carry real
 * signal — `code_churn_rate` and `ai_signature_score` are the only readers of `status` and of
 * the per-file additions distribution, so a thin fixture would leave both at 0 and a corrupted
 * cache round-trip would be invisible to a snapshot comparison.
 *
 * 40 additions per file deliberately, not 60: that keeps the AI-signature "bulk error handling"
 * signal off its NUMERIC branch (which needs avg > 50 and > 200 additions), so the branch is
 * driven by {@link COMMIT_MESSAGE} alone and the message becomes observable in the score.
 */
const FILES = Array.from({length: 5}, (_, i) => ({
    path: `src/gen${i}.ts`,
    additions: 40,
    deletions: 2,
    status: 'added',
}));
const TOTAL_ADDITIONS = FILES.reduce((s, f) => s + f.additions, 0);
const TOTAL_DELETIONS = FILES.reduce((s, f) => s + f.deletions, 0);

/**
 * GitHub's commit-level totals, deliberately NOT equal to the sum of {@link FILES}.
 *
 * GitHub caps a commit's `files` array at 300 while `stats` covers the whole commit, which is
 * why `CommitDiffstat` stores the totals rather than re-deriving them — and why the warm path
 * reads `hit.additions` instead of summing `hit.entries`. If the fixture made the two equal,
 * that single most GitHub-specific line in the diff would be unfalsifiable: replacing it with a
 * re-sum would keep every assertion green.
 */
const GITHUB_STATS = {additions: 9999, deletions: 8888};

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
            log.onListRequest?.();
            return jsonResponse(200, {
                values: shas.map((hash) => ({
                    hash,
                    author: {raw: `Alice <${AUTHOR_EMAIL}>`, user: {nickname: 'alice-bb'}},
                    date: COMMIT_DATE,
                    message: COMMIT_MESSAGE,
                })),
            });
        }
        // PR list and anything else — an empty page.
        return jsonResponse(200, {values: []});
    });
}

/**
 * One GitHub commit-list row. `malformed` reproduces the real shape GitHub returns for a
 * commit whose git author it cannot parse — `commit.author` is `null`, not missing — which is
 * the input the author-date guard exists for.
 */
function githubListRow(sha: string, malformed = false): Record<string, unknown> {
    if (malformed) {
        // No embedded `commit` object AT ALL — the shape the optional-chaining guards on both
        // the hit path and the detail path exist for. A missing key is strictly harder than a
        // null author: it is what would raise a TypeError out of `getCommits` and, via #231,
        // hold the cursor and discard the provider's whole window.
        return {sha, author: {login: 'alice-gh'}};
    }
    return {
        sha,
        commit: {
            author: {name: 'Alice', email: AUTHOR_EMAIL, date: COMMIT_DATE},
            message: COMMIT_MESSAGE,
        },
        author: {login: 'alice-gh'},
    };
}

/**
 * Routes the GitHub endpoints; the per-commit DETAIL request is what the cache elides.
 * `malformed` names shas whose LIST **and** DETAIL rows carry no author date, so the
 * fall-through guard and the drop branch are both exercised.
 */
function githubFetch(
    log: DiffstatLog,
    shas: string[] = SHAS,
    malformed: ReadonlySet<string> = new Set(),
): ReturnType<typeof vi.fn> {
    return vi.fn(async (url: string): Promise<Response> => {
        const u = String(url);
        const detail = u.match(/\/repos\/test-org\/repo1\/commits\/([^?]+)$/);
        if (detail) {
            const sha = detail[1];
            log.all.push(sha);
            if (log.failing.has(sha)) return jsonResponse(503, {message: 'transient'});
            if (log.missing.has(sha)) return jsonResponse(404, {message: 'no commit'});
            log.ok.push(sha);
            return jsonResponse(200, {
                ...githubListRow(sha, malformed.has(sha)),
                stats: {
                    ...GITHUB_STATS,
                    total: GITHUB_STATS.additions + GITHUB_STATS.deletions,
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
            log.onListRequest?.();
            // The FULL list row GitHub actually returns — the cache-hit path builds the whole
            // commit from it instead of re-requesting the detail.
            return jsonResponse(200, shas.map((sha) => githubListRow(sha, malformed.has(sha))));
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
            log.onListRequest?.();
            return jsonResponse(
                200,
                shas.map((id) => ({
                    id,
                    author_name: 'Alice',
                    author_email: AUTHOR_EMAIL,
                    authored_date: COMMIT_DATE,
                    message: COMMIT_MESSAGE,
                })),
            );
        }
        return jsonResponse(200, []);
    });
}

/**
 * The three providers under one description, so every invariant below is asserted against all
 * of them rather than against Bitbucket with the other two riding along.
 */
interface ProviderCase {
    name: string;
    type: GitProviderType;
    container: string;
    config: GitProviderConfig;
    fetchFor: (log: DiffstatLog) => ReturnType<typeof vi.fn>;
    /**
     * The COMMIT-LEVEL totals this provider reports per commit. Equal to the sum of
     * {@link FILES} on Bitbucket and GitLab, where the diffstat entries ARE the commit; not
     * equal on GitHub, whose `stats` covers the whole commit while `files` is capped at 300.
     */
    totals: {additions: number; deletions: number};
    /**
     * Does a 404 on this provider's per-commit endpoint MEAN something ("no diffstat exists")
     * or is it an anomaly? Bitbucket/GitLab: an answer, cached. GitHub: the endpoint is the
     * commit itself and the sha came from its own list, so a 404 must propagate uncached.
     */
    fourOhFourIsAnAnswer: boolean;
}

const PROVIDERS: ProviderCase[] = [
    {
        name: 'Bitbucket',
        type: 'bitbucket',
        container: 'test-ws',
        config: BITBUCKET_CONFIG,
        fetchFor: bitbucketFetch,
        totals: {additions: TOTAL_ADDITIONS, deletions: TOTAL_DELETIONS},
        fourOhFourIsAnAnswer: true,
    },
    {
        name: 'GitHub',
        type: 'github',
        container: 'test-org',
        config: GITHUB_CONFIG,
        fetchFor: githubFetch,
        totals: GITHUB_STATS,
        fourOhFourIsAnAnswer: false,
    },
    {
        name: 'GitLab',
        type: 'gitlab',
        container: 'test-group',
        config: GITLAB_CONFIG,
        fetchFor: gitlabFetch,
        totals: {additions: TOTAL_ADDITIONS, deletions: TOTAL_DELETIONS},
        fourOhFourIsAnAnswer: true,
    },
];

/**
 * Each provider's repo COMMIT-LIST url, as distinct from its per-commit endpoint (#283).
 *
 * Anchored on the query string, which is what separates the two on GitHub
 * (`/commits?per_page=…` vs `/commits/{sha}`); the other two use different path segments
 * entirely. Kept beside {@link PROVIDERS} rather than inside the fetch stubs because the stubs
 * log SHAS, and this is the one assertion that needs the raw urls.
 */
const LIST_PAGE_URL: Record<GitProviderType, RegExp> = {
    bitbucket: /\/repositories\/test-ws\/repo1\/commits\?/,
    github: /\/repos\/test-org\/repo1\/commits\?/,
    gitlab: /\/repository\/commits\?/,
};

// --- Shared helpers ----------------------------------------------------------------------

/** Runs one sync to completion, draining the request- and repo-level pauses on the fake clock. */
async function runSync(
    db: Database.Database,
    config: GitProviderConfig,
    options?: Parameters<GitSync['syncProviders']>[3],
): Promise<Awaited<ReturnType<GitSync['syncProviders']>>> {
    const pending = new GitSync({enabled: false}).syncProviders(db, [config], undefined, options);
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

/**
 * How many diffstats are cached for one `(provider, container)`. A local helper rather than a
 * module export: the production module has no caller for it, and a test-only export widens its
 * public API for nothing (the graduated "don't build scope without a production caller" rule).
 */
function countDiffstats(
    db: Database.Database,
    provider: GitProviderType,
    container: string,
): number {
    return (
        db
            .prepare(
                'SELECT COUNT(*) AS n FROM commit_diffstats WHERE provider = ? AND container = ?',
            )
            .get(provider, container) as {n: number}
    ).n;
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

/** The admin-connected (DB-owned) provider row for `bitbucket/test-ws`. */
function insertBitbucketProviderRow(db: Database.Database): void {
    db.prepare(
        `INSERT INTO git_providers
         (id, type, container, url, include_subgroups, auth_method, auth_username,
          token_ciphertext, token_meta, token_last4, repos_include, repos_exclude,
          enabled, created_at, updated_at, created_by, last_sync_at, last_sync_status, last_sync_error)
         VALUES ('p1', 'bitbucket', 'test-ws', NULL, NULL, 'access_token', NULL, ?, ?, '1234',
                 NULL, NULL, 1, ?, ?, NULL, NULL, NULL, NULL)`,
    ).run(
        Buffer.from('cipher'),
        '{"algo":"AES-256-GCM","iv":"x","auth_tag":"y","key_id":"k1"}',
        NOW,
        NOW,
    );
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

/**
 * The retained raw rows, identity columns included.
 *
 * `git_snapshots` alone cannot see a hit path that drops the commit AUTHOR's login or display
 * name — this developer resolves by email either way, so the projected row is unchanged while
 * the raw row silently re-keys from `…:login:alice-gh` to `…:email:…`, splitting one person
 * into two identities for the author-candidate and auto-create surfaces (#253/#256).
 * `first_seen`/`last_seen` are excluded: they are per-run instants and the two databases are
 * synced at different points on the fake clock.
 */
function rawRows(db: Database.Database): Array<Record<string, unknown>> {
    return db
        .prepare(
            `SELECT provider, container, raw_author_key, author_login, author_email,
                    author_display_name, date, commits, lines_added, lines_removed,
                    files_changed, code_churn_rate, ai_signature_score, avg_commit_size
               FROM raw_author_daily ORDER BY raw_author_key, date`,
        )
        .all() as Array<Record<string, unknown>>;
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

    // --- AC1 + AC3 + the never-cache-a-failure guard, on EVERY provider -------------------

    for (const provider of PROVIDERS) {
        it(`${provider.name}: a run that dies mid-repo keeps its diffstats, writes NO data, holds the cursor — and the next run re-requests only the uncached shas`, async () => {
            const db = makeDb();
            seedAlice(db);
            const log = makeLog();
            // The third commit's per-commit endpoint is down for the whole of run 1.
            log.failing.add(SHAS[2]);
            vi.stubGlobal('fetch', provider.fetchFor(log));

            const result = await runSync(db, provider.config);

            // The repo's commit fetch failed, so #231 discards the provider's whole window.
            expect(result.errors.some((e) => e.includes('Failed to fetch commits'))).toBe(true);
            expect(countRows(db, 'raw_author_daily')).toBe(0);
            expect(countRows(db, 'git_snapshots')).toBe(0);
            expect(countRows(db, 'pr_records')).toBe(0);
            expect(
                db
                    .prepare('SELECT value FROM sync_state WHERE key = ?')
                    .get(syncStateKey(provider.type, provider.container)),
            ).toBeUndefined();

            // …but the two diffstats fetched before the failure SURVIVED. That is the ratchet.
            expect(cachedRows(db).map((r) => r.sha)).toEqual([SHAS[0], SHAS[1]]);
            // A 5xx is a statement about the server, not about the commit — never cached.
            expect(cachedRows(db).some((r) => r.sha === SHAS[2])).toBe(false);
            // The row holds the COMMIT-LEVEL totals the provider reported, and the file
            // entries separately. On GitHub those legitimately differ (`stats` covers the
            // whole commit, `files` is capped at 300), so re-deriving either from the other
            // would silently under-report exactly the largest commits.
            expect(cachedRows(db)[0]).toMatchObject({
                additions: provider.totals.additions,
                deletions: provider.totals.deletions,
            });
            expect(JSON.parse(cachedRows(db)[0].entries)).toHaveLength(FILES.length);
            // The in-run repo retry (#272) re-attempts the whole repo twice more; because the
            // first two shas are already cached, neither is re-requested even WITHIN the run.
            expect(log.countAll(SHAS[0])).toBe(1);
            expect(log.countAll(SHAS[1])).toBe(1);

            // --- Run 2, with the outage over ---------------------------------------------
            log.failing.clear();
            log.reset();
            const second = await runSync(db, provider.config);

            expect(second.errors.filter((e) => e.includes('Failed to fetch'))).toEqual([]);
            // ONLY the uncached shas were requested. This is AC1.
            expect([...new Set(log.all)].sort()).toEqual([SHAS[2], SHAS[3], SHAS[4]]);
            // …and the run completed with every commit's churn, including the two it never
            // re-fetched.
            expect(
                db
                    .prepare(
                        'SELECT commits, lines_added, lines_removed, files_changed FROM git_snapshots',
                    )
                    .get(),
            ).toEqual({
                commits: SHAS.length,
                lines_added: SHAS.length * provider.totals.additions,
                lines_removed: SHAS.length * provider.totals.deletions,
                files_changed: SHAS.length * FILES.length,
            });
            expect(
                db
                    .prepare('SELECT value FROM sync_state WHERE key = ?')
                    .get(syncStateKey(provider.type, provider.container)),
            ).toEqual({value: second.lastSyncTime});

            db.close();
        });
    }

    // --- #283: what a repo RETRY actually costs, stated exactly ---------------------------

    for (const provider of PROVIDERS) {
        it(`${provider.name}: an in-run repo retry re-pages the commit LIST but not the fan-out (#283)`, async () => {
            // #272's own docs called an unresumable `getCommits` a residual — "a retry
            // re-issues the repo's whole O(commits) detail fan-out" — and #283 is titled for
            // closing it. It was in fact closed by #273: the memo is written per commit
            // OUTSIDE the run transaction, so a retry pays only for what never succeeded.
            //
            // The sibling test above pins the fan-out half by sha. This pins the SHAPE of the
            // retry, which is the claim #283's docs now make and which nothing else measures:
            // the list IS re-paged once per attempt (so the claim is not overstated — it is
            // O(pages + failures), not O(failures)), and the per-commit endpoint is NOT.
            const db = makeDb();
            seedAlice(db);
            const log = makeLog();
            // The LAST sha fails all run: the first four are memoized before the fault, so a
            // retry that re-issued the fan-out would show four extra per-commit requests.
            log.failing.add(SHAS[4]);
            const fetchMock = provider.fetchFor(log);
            vi.stubGlobal('fetch', fetchMock);

            await runSync(db, provider.config);

            const urls = fetchMock.mock.calls.map((c) => String(c[0]));
            const listPages = urls.filter((u) => LIST_PAGE_URL[provider.type].test(u)).length;
            // Attempt + the two GIT_REPO_RETRY_DELAYS_MS retries: three walks of the list.
            expect(listPages).toBe(1 + GIT_REPO_RETRY_DELAYS_MS.length);
            // The four commits that succeeded were fetched exactly once ACROSS all three
            // attempts — the fan-out did not repeat.
            for (const sha of SHAS.slice(0, 4)) expect(log.countAll(sha)).toBe(1);
            // Only the never-successful commit was re-attempted — and it alone carries the
            // request layer's own 5xx budget on top of each repo attempt, which is the other
            // multiplier #283 bounds with a wall clock.
            expect(log.countAll(SHAS[4])).toBe(
                (1 + GIT_REPO_RETRY_DELAYS_MS.length) * (1 + MAX_SERVER_ERROR_RETRIES),
            );

            db.close();
        });
    }

    // --- #283: the deadline converges BECAUSE of this memo -------------------------------

    it('a run cut off by the wall-clock deadline keeps its diffstats, and the next run finishes', async () => {
        // The claim that licenses #283's hard cut-off at all — quoted in
        // `GIT_RUN_WALL_CLOCK_BUDGET_MS` and in `GitRunDeadline`: a deadline is safe only
        // because the memo survives #231's drop-partials rule, so consecutive runs redo
        // strictly less. Until now that rested entirely on prose and on analogy with the 503
        // case; a future "clean up after a failed run" step that purged the memo on the
        // deadline path would leave every other assertion in this file green while turning a
        // large repo into a permanent brick.
        const db = makeDb();
        seedAlice(db);
        const log = makeLog();
        const base = bitbucketFetch(log);
        // Burn the run's whole wall clock partway through the fan-out. The NEXT request then
        // trips `assertRunTimeRemaining` inside the provider — the request-layer check, not the
        // repo-loop one — so this exercises the deadline exactly where it really lands.
        const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
            if (/\/diffstat\//.test(String(url)) && log.ok.length === 2) {
                vi.setSystemTime(new Date(Date.now() + GIT_RUN_WALL_CLOCK_BUDGET_MS + 1));
            }
            return base(url, init);
        });
        vi.stubGlobal('fetch', fetchMock);

        const first = await runSync(db, BITBUCKET_CONFIG);

        // #231 in full: the window was not covered, so nothing was written and no cursor moved.
        expect(first.errors.some((e) => e.includes('wall-clock budget'))).toBe(true);
        expect(countRows(db, 'raw_author_daily')).toBe(0);
        expect(countRows(db, 'git_snapshots')).toBe(0);
        expect(
            db
                .prepare('SELECT value FROM sync_state WHERE key = ?')
                .get(syncStateKey('bitbucket', 'test-ws')),
        ).toBeUndefined();
        // …but the diffstats fetched before the cut-off survived. THAT is the ratchet.
        const kept = cachedRows(db).map((r) => r.sha);
        expect(kept.length).toBeGreaterThan(0);

        // --- Run 2, with a fresh deadline ---------------------------------------------
        log.reset();
        const second = await runSync(db, BITBUCKET_CONFIG);

        expect(second.errors.filter((e) => !isAdvisoryError(e))).toEqual([]);
        // It redid strictly less: not one of the memoized shas was re-requested.
        for (const sha of kept) expect(log.countAll(sha)).toBe(0);
        expect([...new Set(log.all)].sort()).toEqual(SHAS.filter((s) => !kept.includes(s)).sort());
        // And it finished — cursor advanced, every commit's churn present including the ones
        // it never re-fetched.
        expect(
            db.prepare('SELECT commits FROM git_snapshots').get(),
        ).toEqual({commits: SHAS.length});
        expect(
            db
                .prepare('SELECT value FROM sync_state WHERE key = ?')
                .get(syncStateKey('bitbucket', 'test-ws')),
        ).toEqual({value: second.lastSyncTime});

        db.close();
    });

    // --- AC3, the hard case: the write TRANSACTION rolls back ------------------------------

    it('keeps its diffstats when the run’s write transaction rolls back — the out-of-transaction placement', async () => {
        // The placement IS the feature, and a fetch-time failure does not prove it: on that
        // path `insertMany()` still commits (with nothing to write). Only an actual rollback
        // distinguishes "written through during the fetch" from "buffered and flushed inside
        // the run transaction", which is exactly the optimisation a future change might make.
        const db = makeDb();
        seedAlice(db);
        const log = makeLog();
        vi.stubGlobal('fetch', bitbucketFetch(log));
        // The projection writes here; without the table the write transaction throws.
        db.exec('DROP TABLE git_snapshots');

        const result = await runSync(db, BITBUCKET_CONFIG);

        expect(result.errors.some((e) => e.includes('transaction rolled back'))).toBe(true);
        expect(countRows(db, 'raw_author_daily')).toBe(0);
        expect(
            db
                .prepare('SELECT value FROM sync_state WHERE key = ?')
                .get(syncStateKey('bitbucket', 'test-ws')),
        ).toBeUndefined();
        // Everything the run wrote inside the transaction is gone; the memo is not.
        expect(cachedRows(db).map((r) => r.sha)).toEqual([...SHAS].sort());

        db.close();
    });

    // --- AC2: convergence under repeated intermittent failures ---------------------------

    it('converges across repeated runs: each distinct commit is fetched successfully exactly once', async () => {
        const db = makeDb();
        seedAlice(db);
        const log = makeLog();
        vi.stubGlobal('fetch', bitbucketFetch(log));

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
        expect(db.prepare('SELECT commits FROM git_snapshots').get()).toEqual({
            commits: SHAS.length,
        });

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

    // --- AC4: the deterministic 404 -------------------------------------------------------

    for (const provider of PROVIDERS.filter((p) => p.fourOhFourIsAnAnswer)) {
        it(`${provider.name}: caches a 404-absent diffstat and reproduces the zero-stat commit without re-asking`, async () => {
            const first = makeDb();
            const devA = seedAlice(first);
            const log = makeLog();
            for (const sha of SHAS) log.missing.add(sha);
            vi.stubGlobal('fetch', provider.fetchFor(log));

            await runSync(first, provider.config);

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

            // A fresh store that has ALREADY ratcheted these commits must not re-ask the
            // endpoint that just 404'd — those are exactly the commits a naive cache re-asks
            // forever.
            const second = makeDb();
            const devB = seedAlice(second);
            expect(copyDiffstats(first, second)).toBe(SHAS.length);
            log.reset();
            await runSync(second, provider.config);

            expect(log.all).toEqual([]);
            expect(fullSnapshot(second, devB)).toEqual(zeroStat);

            first.close();
            second.close();
        });
    }

    it('GitHub: a 404 on the commit detail is an ANOMALY — it propagates and is never cached', async () => {
        // The asymmetry that makes GitHub's write site different from the other two: the sha
        // came from GitHub's own commit list and the endpoint IS the commit, so a 404 is not
        // "this commit has no diffstat". Recording it would freeze a real commit as zero-churn.
        const db = makeDb();
        seedAlice(db);
        const log = makeLog();
        log.missing.add(SHAS[2]);
        vi.stubGlobal('fetch', githubFetch(log));

        const result = await runSync(db, GITHUB_CONFIG);

        expect(result.errors.some((e) => e.includes('Failed to fetch commits'))).toBe(true);
        expect(cachedRows(db).map((r) => r.sha)).toEqual([SHAS[0], SHAS[1]]);
        expect(cachedRows(db).every((r) => r.absent === 0)).toBe(true);
        db.close();
    });

    // --- AC6: byte-identical analysis input, on every provider ----------------------------

    // Run the identical commit set twice against a fresh store — once with an empty cache
    // (every fetch happens) and once with the cache pre-loaded and the per-commit endpoint
    // wired to FAIL. The second run can only succeed if it made no request at all, and both
    // the projected row AND the retained raw row must match.
    for (const provider of PROVIDERS) {
        it(`${provider.name}: a fully-cached run makes ZERO per-commit requests and writes identical rows`, async () => {
            const log = makeLog();
            vi.stubGlobal('fetch', provider.fetchFor(log));

            const fresh = makeDb();
            const devA = seedAlice(fresh);
            await runSync(fresh, provider.config);
            const fetchedSnapshot = fullSnapshot(fresh, devA);
            const fetchedRaw = rawRows(fresh);
            // Positive controls: without these, two all-zero rows would compare equal and the
            // comparison below would prove nothing.
            expect(fetchedSnapshot.commits).toBe(SHAS.length);
            expect(fetchedSnapshot.lines_added as number).toBeGreaterThan(0);
            expect(fetchedSnapshot.code_churn_rate as number).toBeGreaterThan(0);
            expect(fetchedSnapshot.ai_signature_score as number).toBeGreaterThan(0);
            expect(fetchedRaw).toHaveLength(1);
            expect(log.ok).toHaveLength(SHAS.length);

            const warm = makeDb();
            const devB = seedAlice(warm);
            expect(copyDiffstats(fresh, warm)).toBe(SHAS.length);
            // Every per-commit request now answers 503. A cache MISS would fail the repo and
            // leave `git_snapshots` empty, so this is a hard proof that none happened.
            for (const sha of SHAS) log.failing.add(sha);
            log.reset();

            const result = await runSync(warm, provider.config);

            expect(log.all).toEqual([]);
            expect(result.errors.filter((e) => e.includes('Failed to fetch'))).toEqual([]);
            expect(fullSnapshot(warm, devB)).toEqual(fetchedSnapshot);
            // The raw row too — it is the only place a dropped commit author login/display
            // name would show, and a re-keyed identity is a real defect the snapshot hides.
            expect(rawRows(warm)).toEqual(fetchedRaw);

            fresh.close();
            warm.close();
        });
    }

    // --- GitHub's malformed-commit branches ------------------------------------------------

    it('GitHub: a commit with no embedded `commit` object is dropped, uncached, on both the cold and the warm run', async () => {
        // The hit path gates on `isAttributableDate`, the SAME predicate the un-cached path
        // decides on, so the cache can neither drop a commit the un-cached path kept nor add one
        // it dropped. The fixture omits the `commit` object entirely on BOTH the list row and
        // the detail response, so an unguarded dereference on either side raises a TypeError out
        // of `getCommits` — which #231 turns into "hold the cursor, discard the whole provider".
        //
        // Since #275 a detail whose `commit` is unusable is RECOVERED from the list row, so this
        // commit is dropped only because BOTH copies are missing it — which is what the fixture
        // builds, and what keeps this test about the cache rather than about the fallback. The
        // "uncached" half is load-bearing in a second way now: this fixture's detail carries no
        // `stats` either, and #275 routes a body with neither a usable `commit` nor `stats` to a
        // THROW rather than caching its zeros — so nothing is memoized for it on any run.
        const db = makeDb();
        const devId = seedAlice(db);
        const log = makeLog();
        vi.stubGlobal('fetch', githubFetch(log, SHAS, new Set([SHAS[1]])));

        const first = await runSync(db, GITHUB_CONFIG);

        expect(first.errors.filter((e) => e.includes('Failed to fetch'))).toEqual([]);
        // The malformed commit is dropped — and NOT cached, so hit and miss agree.
        expect(cachedRows(db).map((r) => r.sha)).toEqual(
            SHAS.filter((s) => s !== SHAS[1]).sort(),
        );
        expect(fullSnapshot(db, devId).commits).toBe(SHAS.length - 1);

        // A warm run over the same set drops it again — the cache does not resurrect it.
        const warm = makeDb();
        const devB = seedAlice(warm);
        copyDiffstats(db, warm);
        log.reset();
        await runSync(warm, GITHUB_CONFIG);

        expect(fullSnapshot(warm, devB).commits).toBe(SHAS.length - 1);
        // The one uncached sha is the malformed one; every other commit was served warm.
        expect([...new Set(log.all)]).toEqual([SHAS[1]]);

        db.close();
        warm.close();
    });

    // --- The cache is scoped to (provider, container, repo) --------------------------------

    it('does not serve one container’s or one repo’s cache to another', async () => {
        const db = makeDb();
        seedAlice(db);
        const log = makeLog();
        vi.stubGlobal('fetch', bitbucketFetch(log));

        await runSync(db, BITBUCKET_CONFIG);
        expect(countDiffstats(db, 'bitbucket', 'test-ws')).toBe(SHAS.length);
        expect(countDiffstats(db, 'bitbucket', 'other-ws')).toBe(0);

        const cache = createCommitDiffstatCache(db, 'bitbucket', 'test-ws');
        // A DIFFERENT repo in the same workspace, with the same sha names, starts cold — a
        // regression dropping `repo` from the WHERE clause would serve one repo's churn for
        // another's identically-named commit.
        expect(cache.load('repo2', SHAS).size).toBe(0);
        expect(cache.load('repo1', SHAS).size).toBe(SHAS.length);
        // A different workspace whose API happens to serve the same repo/sha names, likewise.
        expect(createCommitDiffstatCache(db, 'bitbucket', 'other-ws').load('repo1', SHAS).size).toBe(0);
        // …and a different PROVIDER FAMILY with a colliding container/repo/sha. Mirrored repos
        // really do share shas across providers, so `provider = ?` in the WHERE clause is load
        // bearing, not decorative.
        const mirrored = createCommitDiffstatCache(db, 'github', 'test-ws');
        expect(mirrored.load('repo1', SHAS).size).toBe(0);
        mirrored.put('repo1', SHAS[0], {additions: 1, deletions: 0, entries: [], absent: false});
        expect(cache.load('repo1', [SHAS[0]]).get(SHAS[0])?.additions).not.toBe(1);
        // …and the same workspace spelled differently resolves to the SAME rows (#266
        // normalization — the value compared is the value persisted).
        expect(
            createCommitDiffstatCache(db, 'bitbucket', '  TEST-WS ').load('repo1', SHAS).size,
        ).toBe(SHAS.length);

        db.close();
    });

    // --- A DB-connected provider that SURVIVES its run -------------------------------------

    it('keeps the cache of an admin-connected provider that is still there when the run ends', async () => {
        // The production shape, and the only one in which the mid-run purge's ownership guard
        // is evaluated on its happy path: every other test here passes an ad-hoc config with no
        // `git_providers` row, which short-circuits the guard before it compares anything. A
        // regression that inverted the comparison would purge the cache after every scheduled
        // sync — the ratchet dead in production, suite green.
        const db = makeDb();
        seedAlice(db);
        insertBitbucketProviderRow(db);
        const log = makeLog();
        vi.stubGlobal('fetch', bitbucketFetch(log));

        const first = await runSync(db, BITBUCKET_CONFIG);

        expect(first.errors.filter((e) => e.includes('Failed to fetch'))).toEqual([]);
        expect(
            first.errors.some((e) => e.startsWith('Provider changed during this run:')),
        ).toBe(false);
        // A HEALTHY run must not report a degraded cache. Without this, a counter that fired
        // on a success (or a refusal) would make the advisory permanently true in production
        // and no test would notice — the operator signal dead in the opposite direction.
        expect(first.errors.some((e) => e.startsWith(DIFFSTAT_CACHE_DEGRADED_PREFIX))).toBe(false);
        expect(countDiffstats(db, 'bitbucket', 'test-ws')).toBe(SHAS.length);

        // …and it is actually reused: reset the cursor so the same window is re-walked, and no
        // per-commit request is made.
        db.prepare('DELETE FROM sync_state WHERE key = ?').run(syncStateKey('bitbucket', 'test-ws'));
        log.reset();
        await runSync(db, BITBUCKET_CONFIG);
        expect(log.all).toEqual([]);
        expect(countDiffstats(db, 'bitbucket', 'test-ws')).toBe(SHAS.length);

        db.close();
    });

    // --- A degraded cache is reported, never silent ------------------------------------------

    it('reports an ADVISORY when the cache is unusable, and still completes the run', async () => {
        // The cache never throws, so without this line a permanently dead ratchet and a working
        // one produce byte-identical output. It must be an advisory, not a failure: turning the
        // provider red would hold its cursor and discard a perfectly good window.
        const db = makeDb();
        const devId = seedAlice(db);
        const log = makeLog();
        vi.stubGlobal('fetch', bitbucketFetch(log));
        db.exec('DROP TABLE commit_diffstats');

        const result = await runSync(db, BITBUCKET_CONFIG);

        const advisory = result.errors.find((e) => e.startsWith(DIFFSTAT_CACHE_DEGRADED_PREFIX));
        expect(advisory).toBeDefined();
        expect(isAdvisoryError(advisory!)).toBe(true);
        // The run itself is untouched: every commit was fetched, the data landed, and — the
        // consequence the advisory classification exists to prevent — the cursor ADVANCED.
        // Classified as a failure instead, this would hold the cursor and discard a window
        // that synced perfectly, which is worse than the degradation it reports.
        expect(result.errors.filter((e) => e.includes('Failed to fetch'))).toEqual([]);
        expect(fullSnapshot(db, devId).commits).toBe(SHAS.length);
        expect(log.ok).toHaveLength(SHAS.length);
        expect(
            db
                .prepare('SELECT value FROM sync_state WHERE key = ?')
                .get(syncStateKey('bitbucket', 'test-ws')),
        ).toEqual({value: result.lastSyncTime});
        db.close();
    });

    // --- Mid-run provider delete ------------------------------------------------------------

    it('purges rows a run wrote for a container whose provider was deleted mid-run', async () => {
        // The cascade empties the table for its container when it runs, but this run keeps
        // writing through for the rest of its fetch. Left behind, a re-added provider would
        // inherit file-level detail its credentials may no longer justify.
        const db = makeDb();
        seedAlice(db);
        insertBitbucketProviderRow(db);

        const log = makeLog();
        // Delete the owning row on the repo's commit-list request — i.e. after the run
        // snapshotted ownership and before any diffstat is written, the shape a concurrent
        // admin delete produces.
        log.onListRequest = (): void => {
            db.prepare("DELETE FROM git_providers WHERE id = 'p1'").run();
        };
        vi.stubGlobal('fetch', bitbucketFetch(log));

        const result = await runSync(db, BITBUCKET_CONFIG);

        expect(result.errors.some((e) => e.startsWith('Provider changed during this run:'))).toBe(
            true,
        );
        // Positive control: rows really were written and then removed, so the zero below is a
        // DELETION rather than a run that never cached anything.
        expect(log.ok).toHaveLength(SHAS.length);
        expect(countDiffstats(db, 'bitbucket', 'test-ws')).toBe(0);
        db.close();
    });

    it('a purge that itself fails does not replace a committed run’s result with a throw', async () => {
        // The purge runs AFTER the write transaction commits, so an exception escaping it would
        // lose the whole `SyncResult` of a run whose data is already durable — strictly worse
        // than a rollback, because the state and the report would then disagree.
        const db = makeDb();
        seedAlice(db);
        insertBitbucketProviderRow(db);
        const log = makeLog();
        log.onListRequest = (): void => {
            db.prepare("DELETE FROM git_providers WHERE id = 'p1'").run();
            db.exec('DROP TABLE commit_diffstats');
        };
        vi.stubGlobal('fetch', bitbucketFetch(log));

        const result = await runSync(db, BITBUCKET_CONFIG);

        expect(result.errors.some((e) => e.startsWith('Provider changed during this run:'))).toBe(
            true,
        );
        // …and the cache's own faults were reported rather than swallowed into silence.
        expect(result.errors.some((e) => e.startsWith(DIFFSTAT_CACHE_DEGRADED_PREFIX))).toBe(true);
        db.close();
    });

    it('purges them on a FAILED BACKFILL too — the path the ownership gate never reaches', async () => {
        // The gate that records an orphan only runs from inside the write transaction, driven
        // by rows/cursors/stall updates. A backfill run whose fetch was incomplete pushes NONE
        // of those (stall accounting is forward-only, and an incomplete provider is skipped
        // before its cursor closure), so the gate is never invoked for the container — yet the
        // run wrote a diffstat for every commit it did fetch. That is the intersection of
        // "long-running backfill" and "run failed partway" the ratchet exists for, and it is
        // the state that leaves the MOST stray rows behind.
        const db = makeDb();
        seedAlice(db);
        insertBitbucketProviderRow(db);

        const log = makeLog();
        log.failing.add(SHAS[2]);
        log.onListRequest = (): void => {
            db.prepare("DELETE FROM git_providers WHERE id = 'p1'").run();
        };
        vi.stubGlobal('fetch', bitbucketFetch(log));

        const result = await runSync(db, BITBUCKET_CONFIG, {
            backfill: {since: '2024-01-01T00:00:00.000Z', until: '2024-06-01T00:00:00.000Z'},
        });

        expect(result.errors.some((e) => e.includes('Failed to fetch commits'))).toBe(true);
        // The gate never fired, so nothing was reported as orphaned…
        expect(result.errors.some((e) => e.startsWith('Provider changed during this run:'))).toBe(
            false,
        );
        // …yet two diffstats were written before the failure, and both are retracted anyway.
        expect(log.ok).toEqual([SHAS[0], SHAS[1]]);
        expect(countDiffstats(db, 'bitbucket', 'test-ws')).toBe(0);
        db.close();
    });

    // --- The shared helper's 404-ONLY rule ---------------------------------------------------

    describe('resolveCommitDiffstat (the shared Bitbucket/GitLab fetch site)', () => {
        let db: Database.Database;

        beforeEach(() => {
            db = makeDb();
        });
        afterEach(() => db.close());

        const ENTRIES: GitFileDiff[] = [
            {path: 'src/a.ts', additions: 3, deletions: 1, status: 'modified'},
        ];

        it('caches a success and a 404, and NOTHING else — including a transport fault', async () => {
            // The 404-is-an-answer rule has two disjuncts, and only one of them is a status
            // test. A transport fault surfaces as `GitProviderFetchError` with `status: null`
            // (no response was ever produced) and a bug in our own adapter is not a
            // `GitProviderFetchError` at all — both must rethrow, or an outage is frozen as a
            // commit's churn.
            const cache = createCommitDiffstatCache(db, 'gitlab', 'grp');
            const cached = new Map<string, never>();

            await expect(
                resolveCommitDiffstat(cache, cached, 'repo1', 'ok', async () => ENTRIES),
            ).resolves.toEqual({additions: 3, deletions: 1, entries: ENTRIES, absent: false});
            await expect(
                resolveCommitDiffstat(cache, cached, 'repo1', 'gone', async () => {
                    throw new GitProviderFetchError('GitLab API error 404: /diff', 404);
                }),
            ).resolves.toEqual({additions: 0, deletions: 0, entries: [], absent: true});

            for (const fault of [
                new GitProviderFetchError('GitLab API server error 503: /diff', 503),
                new GitProviderFetchError('ECONNRESET', null),
                new TypeError('adapter bug'),
            ]) {
                await expect(
                    resolveCommitDiffstat(cache, cached, 'repo1', `bad-${fault.name}`, async () => {
                        throw fault;
                    }),
                ).rejects.toBe(fault);
            }

            expect(cachedRows(db).map((r) => r.sha)).toEqual(['gone', 'ok']);
        });

        it('serves a hit without calling the fetcher at all', async () => {
            const hit = {additions: 9, deletions: 4, entries: ENTRIES, absent: false};
            const fetcher = vi.fn();
            await expect(
                resolveCommitDiffstat(
                    undefined,
                    new Map([['sha1', hit]]),
                    'repo1',
                    'sha1',
                    fetcher as unknown as () => Promise<GitFileDiff[]>,
                ),
            ).resolves.toBe(hit);
            expect(fetcher).not.toHaveBeenCalled();
        });
    });

    // --- The cache module's own contract ----------------------------------------------------

    describe('createCommitDiffstatCache', () => {
        let db: Database.Database;

        beforeEach(() => {
            db = makeDb();
        });
        afterEach(() => db.close());

        it('is TOTAL — a blank container degrades to a dead cache rather than throwing', () => {
            // A blank container is not an attribution key, so nothing may be stored under one.
            // But refusing it by THROWING would be the single unguarded call in a module whose
            // contract is that it cannot break a sync: the throw lands on the pipeline's
            // per-provider handler and skips that provider's entire run. The table's
            // `CHECK (length(container) > 0)` refuses the write instead, and it is counted.
            const cache = createCommitDiffstatCache(db, 'github', '   ');
            expect(() =>
                cache.put('repo1', 'sha1', {additions: 1, deletions: 0, entries: [], absent: false}),
            ).not.toThrow();
            expect(countRows(db, 'commit_diffstats')).toBe(0);
            expect(cache.load('repo1', ['sha1']).size).toBe(0);
            // A CHECK violation IS a swallowed database fault, unlike the deterministic
            // refusals below — the write was attempted and the database rejected it.
            expect(cache.faults()).toBe(1);
        });

        it('refuses to store any value its own reader would reject — entries AND totals', () => {
            // The two boundaries must agree, or the ratchet silently no-ops for those commits
            // forever: every run writes the row, every next run rejects it on read and
            // re-fetches. Both cases are reachable from real provider data — Bitbucket maps an
            // entry with neither `new` nor `old` to `path: ''`, and GitHub's commit totals come
            // straight from unvalidated `detail.stats`, which INTEGER affinity would let past
            // the table's own CHECK.
            const cache = createCommitDiffstatCache(db, 'github', 'org');
            const unreadable: GitFileDiff[] = [
                {path: '', additions: 1, deletions: 0, status: 'modified'},
            ];
            cache.put('repo1', 'bad-entry', {
                additions: 1,
                deletions: 0,
                entries: unreadable,
                absent: false,
            });
            cache.put('repo1', 'bad-total', {
                additions: 1.5,
                deletions: 0,
                entries: [...FILES],
                absent: false,
            });

            expect(countDiffstats(db, 'github', 'org')).toBe(0);
            // A deterministic refusal is NOT a cache fault: it says this commit's data cannot
            // be stored, not that the cache is unhealthy. Counting it would make the operator
            // advisory fire on every run forever for one un-nameable file entry.
            expect(cache.faults()).toBe(0);
        });

        it('round-trips a diffstat, whole and idempotently', () => {
            const cache = createCommitDiffstatCache(db, 'github', 'org');
            const value = {additions: 7, deletions: 2, entries: [...FILES], absent: false};
            cache.put('repo1', 'sha1', value);
            cache.put('repo1', 'sha1', value);
            expect(countDiffstats(db, 'github', 'org')).toBe(1);
            const decoded = cache.load('repo1', ['sha1']).get('sha1');
            expect(decoded).toEqual(value);
            // Nothing here failed, so the counter that drives the operator advisory must be
            // ZERO. Without this the counter could be moved out of its `catch` (or added to
            // the success path) and every healthy sync would report a degraded cache — the
            // signal permanently false, and every existing assertion still green.
            expect(cache.faults()).toBe(0);
            // Pin the ENTRY shape explicitly: the decoder rebuilds `GitFileDiff` field by
            // field, so a new optional field on that type would silently stop round-tripping
            // and AC6 ("byte-identical analysis input") would quietly stop holding for it.
            expect(Object.keys(decoded!.entries[0]).sort()).toEqual(
                (['additions', 'deletions', 'path', 'status'] satisfies Array<keyof GitFileDiff>).sort(),
            );
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
            // 900 shas exceeds the canonical READ_CHUNK_SIZE, so this fails if the chunking is
            // wrong — and it would also fail as a single 900-parameter statement on an older
            // SQLite build.
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
            // A repeated sha must not inflate a chunk past the bind limit either.
            expect(cache.load('repo1', [...shas, ...shas]).size).toBe(900);
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
                // Domain, not just shape: these per-file numbers feed code_churn_rate and
                // ai_signature_score directly.
                '[{"path":"a.ts","additions":-4,"deletions":0,"status":"added"}]',
                '[{"path":"a.ts","additions":1.5,"deletions":0,"status":"added"}]',
                '[{"path":"","additions":1,"deletions":0,"status":"added"}]',
            ];
            for (const [i, entries] of bad.entries()) {
                const sha = `bad-${i}`;
                cache.put('repo1', sha, {additions: 1, deletions: 0, entries: [], absent: false});
                db.prepare('UPDATE commit_diffstats SET entries = ? WHERE sha = ?').run(entries, sha);
                expect(cache.load('repo1', [sha]).size, entries).toBe(0);
            }
        });

        it('treats a fractional stored total as a MISS — INTEGER affinity lets one past the CHECK', () => {
            const cache = createCommitDiffstatCache(db, 'github', 'org');
            cache.put('repo1', 'sha1', {additions: 1, deletions: 0, entries: [], absent: false});
            db.prepare("UPDATE commit_diffstats SET additions = 1.5 WHERE sha = 'sha1'").run();
            expect(cache.load('repo1', ['sha1']).size).toBe(0);
        });

        it('a cache write can never fail a sync — every nonsensical put is swallowed, not thrown', () => {
            // `put` runs per commit inside the provider's fetch loop, whose throw path holds the
            // provider's cursor and discards the whole run's data (#231). Nothing about a memo
            // is worth that, so every failure degrades to "one re-fetch next run".
            const cache = createCommitDiffstatCache(db, 'github', 'org');
            const value = {additions: 1, deletions: 0, entries: [], absent: false};
            expect(() => cache.put('', 'sha1', value)).not.toThrow();
            expect(() => cache.put('repo1', '', value)).not.toThrow();
            expect(() => cache.put('repo1', 'sha1', {...value, additions: -1})).not.toThrow();
            expect(() => cache.put('repo1', 'sha2', {...value, deletions: Number.NaN})).not.toThrow();
            expect(countDiffstats(db, 'github', 'org')).toBe(0);
        });

        it('neither method throws when the table itself is gone — including at construction', () => {
            // The general form of the guarantee above: SQLITE_BUSY against a second connection,
            // a full disk, a schema the process did not expect. A missing table is the
            // reproducible stand-in — before #273 the fetch phase issued no DB calls at all, so
            // any of these would be a NEW way to lose a multi-hour sync.
            //
            // The cache is CONSTRUCTED after the drop, which is the case an eagerly-prepared
            // INSERT statement would fail on — outside every catch, on the pipeline's
            // per-provider handler, reporting a disposable memo's fault as "this provider could
            // not be used" and skipping its whole sync.
            db.exec('DROP TABLE commit_diffstats');
            const cache = createCommitDiffstatCache(db, 'github', 'org');
            expect(() =>
                cache.put('repo1', 'sha1', {additions: 1, deletions: 0, entries: [], absent: false}),
            ).not.toThrow();
            expect(cache.load('repo1', ['sha1']).size).toBe(0);
            expect(cache.faults()).toBe(2);
        });

        it('load short-circuits on an empty request instead of issuing a query', () => {
            const cache = createCommitDiffstatCache(db, 'github', 'org');
            expect(cache.load('repo1', []).size).toBe(0);
            expect(cache.load('', ['sha1']).size).toBe(0);
            expect(cache.faults()).toBe(0);
        });

        it('load survives a non-string sha without blanking the rest of the repo', () => {
            // The shas come off an unchecked cast of the provider's commit-list JSON, so a row
            // missing `sha` yields `undefined` — which better-sqlite3 refuses to bind. Without
            // the type filter that throw lands in `load`'s catch and returns an EMPTY map, so
            // one malformed list row costs the whole repo its cache for the run.
            const cache = createCommitDiffstatCache(db, 'github', 'org');
            cache.put('repo1', 'good', {additions: 1, deletions: 0, entries: [], absent: false});
            const shas = ['good', undefined, 42, ''] as unknown as string[];
            expect([...cache.load('repo1', shas).keys()]).toEqual(['good']);
            expect(cache.faults()).toBe(0);
        });

        it('deleteContainerDiffstats removes exactly one container’s rows', () => {
            for (const [provider, container] of [
                ['bitbucket', 'ws-a'],
                ['bitbucket', 'ws-b'],
                ['github', 'ws-a'],
            ] as const) {
                createCommitDiffstatCache(db, provider, container).put('r', 's', {
                    additions: 1,
                    deletions: 0,
                    entries: [],
                    absent: false,
                });
            }

            expect(deleteContainerDiffstats(db, 'bitbucket', 'ws-a')).toBe(1);

            expect(countDiffstats(db, 'bitbucket', 'ws-a')).toBe(0);
            expect(countDiffstats(db, 'bitbucket', 'ws-b')).toBe(1);
            expect(countDiffstats(db, 'github', 'ws-a')).toBe(1);
        });
    });
});
