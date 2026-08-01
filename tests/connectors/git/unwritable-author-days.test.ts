/**
 * #302 — a PR or review-comment date the store cannot key on must cost ONE author-day row,
 * never the run.
 *
 * `upsertRawAuthorDaily` validates fail-closed and THROWS, and it runs inside the run's single
 * all-providers write transaction. So before this issue an unusable `pr.createdAt` did not cost
 * a PR: it rolled back every provider's window, advanced no cursor, and threw identically on
 * every subsequent run — a permanent stall of the whole git connector from data no retry can
 * change. #275/#290 closed that door for the COMMIT author date by gating it at each provider;
 * three more dates (`pr.createdAt`, `pr.mergedAt`, `comment.createdAt`) reach the store with no
 * gate anywhere, and the NaN `avg_time_to_merge_hours` the first two compute is a fourth door.
 *
 * These tests drive the REAL provider classes through the REAL sync pipeline over a stubbed
 * `fetch`, with TWO providers in one run — which is the whole point. A provider-level or
 * analyzer-level test cannot see the property under test, because the property is about what
 * happens to the OTHER provider's window.
 *
 * The clock is pinned just after the fixture dates so no provider's since/until window filters
 * the fixtures out (Bitbucket filters in memory, so a far-future `now` would silently empty it
 * and every assertion below would pass over nothing).
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper} from '../../../src/registry/developers';
import {
    AUTHOR_DAYS_SKIPPED_PREFIX,
    COMMITS_DROPPED_PREFIX,
    GitSync,
    LEGACY_CELLS_SKIPPED_PREFIX,
    isAdvisoryError,
    isPermanentLossAdvisory,
    rankAdvisories,
    syncStateKey,
} from '../../../src/connectors/git/sync';
import {
    GITHUB_CONFIG,
    GITLAB_CONFIG,
    BITBUCKET_CONFIG,
    githubRoutes,
    gitlabRoutes,
    bitbucketRoutes,
    makeCountingFetch,
    type Route,
} from './providers/provider-fetch-fixtures';
import type {GitProviderConfig} from '../../../src/connectors/git/providers/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');

const AUTHOR_EMAIL = 'alice@example.com';
const DAY = '2024-01-15';
const NOW = '2024-01-20T00:00:00.000Z';
const PR_CREATED = `${DAY}T08:00:00.000Z`;
const PR_MERGED = `${DAY}T18:00:00.000Z`;

/**
 * An ISO 8601 expanded year — what `git commit --date=@999999999999` produces, and the shape
 * #233/#275 were both about. It round-trips through `Date` and `Date.parse`s finite, so only an
 * anchored day check rejects it: `toDateString` slices it to `+033658-0`.
 */
const EXPANDED_YEAR = '+033658-09-27T00:00:00.000Z';

/** Unparseable outright, so it is BOTH an unusable day key and a NaN time-to-merge operand. */
const UNPARSEABLE = 'not-a-date';

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

/** Resolvable by commit email on every provider, so cells actually project. */
function seedAlice(db: Database.Database): string {
    addTeam(db, 'eng');
    return addDeveloper(db, 'alice', 'eng', AUTHOR_EMAIL, 'Alice').id;
}

interface GitHubPRFields {
    login?: string;
    /** `unknown`, because the point of several cases below is a body whose field is NOT a string. */
    created_at: unknown;
    merged_at: string | null;
}

/**
 * GitHub PR routes, PREPENDED to `githubRoutes()` so they shadow its empty `pulls?` entry
 * (`makeCountingFetch` takes the first matching route).
 *
 * The per-PR comment/verdict endpoints are routed explicitly because the fixture module's
 * unrouted fallback is an empty BITBUCKET page — an object where the GitHub provider expects an
 * array, which throws on `.map` instead of reading as empty.
 */
function githubPRRoutes(pr: GitHubPRFields): Route[] {
    return [
        {match: /\/repos\/test-org\/repo1\/pulls\/\d+\/comments/, body: []},
        {match: /\/repos\/test-org\/repo1\/pulls\/\d+\/reviews/, body: []},
        {
            match: /\/repos\/test-org\/repo1\/pulls\?/,
            body: [
                {
                    number: 1,
                    title: 'feat: work',
                    user: {login: pr.login ?? 'alice-gh'},
                    state: 'closed',
                    created_at: pr.created_at,
                    merged_at: pr.merged_at,
                    closed_at: pr.merged_at,
                    // Never corrupted: it is the list's since cutoff, so an unusable value would
                    // drop the PR before the analyzer ever keys a day from it.
                    updated_at: PR_MERGED,
                    requested_reviewers: [],
                },
            ],
        },
        ...githubRoutes(),
    ];
}

/** Bitbucket PR routes. `mergedAt` is derived from `updated_on`, so only `created_on` varies. */
function bitbucketPRRoutes(createdOn: string): Route[] {
    return [
        {
            match: /\/repositories\/test-ws\/repo1\/pullrequests\?/,
            body: {
                values: [
                    {
                        id: 1,
                        title: 'feat: work',
                        author: {nickname: 'alice-bb', display_name: 'Alice'},
                        state: 'MERGED',
                        created_on: createdOn,
                        updated_on: PR_MERGED,
                        reviewers: [],
                    },
                ],
            },
        },
        ...bitbucketRoutes(),
    ];
}

async function runSync(
    db: Database.Database,
    configs: GitProviderConfig[],
): Promise<Awaited<ReturnType<GitSync['syncProviders']>>> {
    const pending = new GitSync({enabled: false}).syncProviders(db, configs);
    await vi.runAllTimersAsync();
    return pending;
}

function skipLineOf(errors: string[]): string | undefined {
    return errors.find((e) => e.startsWith(AUTHOR_DAYS_SKIPPED_PREFIX));
}

interface RawRow {
    provider: string;
    date: string;
    commits: number;
    prs_opened: number;
    prs_merged: number;
    review_comments_given: number;
    avg_time_to_merge_hours: number | null;
    raw_author_key: string;
}

function rawRows(db: Database.Database): RawRow[] {
    return db
        .prepare(
            `SELECT provider, date, commits, prs_opened, prs_merged, review_comments_given,
                    avg_time_to_merge_hours, raw_author_key
               FROM raw_author_daily ORDER BY provider, date`,
        )
        .all() as RawRow[];
}

function rowsFor(db: Database.Database, provider: string): RawRow[] {
    return rawRows(db).filter((r) => r.provider === provider);
}

function cursorOf(db: Database.Database, key: string): string | undefined {
    return (db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
        | {value: string}
        | undefined)?.value;
}

const GITHUB_CURSOR = syncStateKey('github', 'test-org');
const GITLAB_CURSOR = syncStateKey('gitlab', 'test-group');
const BITBUCKET_CURSOR = syncStateKey('bitbucket', 'test-ws');

describe('#302 an unwritable author-day costs that row, not the run', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        vi.useFakeTimers();
        vi.setSystemTime(new Date(NOW));
    });

    afterEach(() => {
        db.close();
        vi.useRealTimers();
        vi.restoreAllMocks();
        // `restoreAllMocks` does not undo `stubGlobal`, so without this the previous test's
        // routes leak into a test that forgets to stub instead of failing it.
        vi.unstubAllGlobals();
    });

    describe('a malformed PR / review-comment date', () => {
        it('costs GitHub one author-day row and leaves GitLab s whole window committed', async () => {
            seedAlice(db);
            vi.stubGlobal(
                'fetch',
                makeCountingFetch([
                    ...githubPRRoutes({created_at: EXPANDED_YEAR, merged_at: PR_MERGED}),
                    ...gitlabRoutes(),
                ]).fetchMock,
            );

            const result = await runSync(db, [GITHUB_CONFIG, GITLAB_CONFIG]);

            // The run did NOT throw and did not roll back.
            expect(result.errors.some((e) => /transaction rolled back/.test(e))).toBe(false);

            // THE ACCEPTANCE CRITERION: the second provider's rows are committed.
            const gitlab = rowsFor(db, 'gitlab');
            expect(gitlab).toHaveLength(1);
            expect(gitlab[0].date).toBe(DAY);
            expect(gitlab[0].commits).toBe(3);
            expect(cursorOf(db, GITLAB_CURSOR)).toBeDefined();

            // …and so are the offending provider's OTHER rows: only the `createdAt`-keyed one
            // is missing, and its day is the one the store refused.
            const github = rowsFor(db, 'github');
            expect(github.map((r) => r.date)).toEqual([DAY]);
            expect(github[0].commits).toBe(3);
            expect(github[0].prs_merged).toBe(1);
            expect(github[0].prs_opened).toBe(0);
            expect(cursorOf(db, GITHUB_CURSOR)).toBeDefined();

            // The loss reached the advisory surface, named its provider and its count.
            const line = skipLineOf(result.errors);
            expect(line).toBeDefined();
            expect(line).toContain('[github/test-org]');
            expect(line).toContain('1 author-day row(s)');
            expect(line).toContain('refused as invalid_date');
            expect(line).toContain('github:login:alice-gh');
        });

        it('costs Bitbucket one author-day row and leaves GitLab s whole window committed', async () => {
            seedAlice(db);
            vi.stubGlobal(
                'fetch',
                makeCountingFetch([
                    ...bitbucketPRRoutes(EXPANDED_YEAR),
                    ...gitlabRoutes(),
                ]).fetchMock,
            );

            const result = await runSync(db, [BITBUCKET_CONFIG, GITLAB_CONFIG]);

            expect(rowsFor(db, 'gitlab')[0].commits).toBe(3);
            expect(cursorOf(db, GITLAB_CURSOR)).toBeDefined();
            // Bitbucket kept the merged-day row (keyed by `updated_on`) and lost only the
            // `created_on` one.
            const bitbucket = rowsFor(db, 'bitbucket');
            expect(bitbucket.map((r) => r.date)).toEqual([DAY]);
            expect(bitbucket[0].prs_merged).toBe(1);
            expect(bitbucket[0].prs_opened).toBe(0);
            expect(cursorOf(db, BITBUCKET_CURSOR)).toBeDefined();

            expect(skipLineOf(result.errors)).toContain('[bitbucket/test-ws]');
        });

        it('costs only the merged-day row when merged_at is the malformed one', async () => {
            seedAlice(db);
            vi.stubGlobal(
                'fetch',
                makeCountingFetch([
                    ...githubPRRoutes({created_at: PR_CREATED, merged_at: EXPANDED_YEAR}),
                    ...gitlabRoutes(),
                ]).fetchMock,
            );

            const result = await runSync(db, [GITHUB_CONFIG, GITLAB_CONFIG]);

            // The opened-day row survives WITH the day's commits on it — `createdAt` and the
            // commits share 2024-01-15, so this row is the one a rollback used to destroy.
            const github = rowsFor(db, 'github');
            expect(github.map((r) => r.date)).toEqual([DAY]);
            expect(github[0].prs_opened).toBe(1);
            expect(github[0].prs_merged).toBe(0);
            expect(github[0].commits).toBe(3);
            expect(rowsFor(db, 'gitlab')[0].commits).toBe(3);
            expect(skipLineOf(result.errors)).toContain('1 author-day row(s)');
        });

        it('survives a NULL created_at, which used to kill the run before any cursor moved', async () => {
            // `created_at: null` is a real truncated-body shape, and `AnalysisPR.createdAt` is
            // typed `string` over an unvalidated cast — so a bare `.slice` threw a TypeError out
            // of `aggregateDailyMetrics`, which sits OUTSIDE the run's try. That killed the whole
            // run, not just the transaction: no provider's cursor advanced and the next run did
            // exactly the same thing. Same permanent stall, one frame earlier than the rollback.
            seedAlice(db);
            vi.stubGlobal(
                'fetch',
                makeCountingFetch([
                    ...githubPRRoutes({created_at: null, merged_at: PR_MERGED}),
                    ...gitlabRoutes(),
                ]).fetchMock,
            );

            const result = await runSync(db, [GITHUB_CONFIG, GITLAB_CONFIG]);

            expect(rowsFor(db, 'gitlab')[0].commits).toBe(3);
            const github = rowsFor(db, 'github');
            expect(github.map((r) => r.date)).toEqual([DAY]);
            expect(github[0].commits).toBe(3);
            expect(cursorOf(db, GITHUB_CURSOR)).toBeDefined();
            expect(skipLineOf(result.errors)).toContain('refused as invalid_date');
        });

        it('costs the review comment s own row and nothing else', async () => {
            seedAlice(db);
            vi.stubGlobal(
                'fetch',
                makeCountingFetch([
                    {
                        match: /\/repos\/test-org\/repo1\/pulls\/\d+\/comments/,
                        body: [{user: {login: 'bob-gh'}, body: 'LGTM', created_at: EXPANDED_YEAR}],
                    },
                    ...githubPRRoutes({created_at: PR_CREATED, merged_at: PR_MERGED}),
                    ...gitlabRoutes(),
                ]).fetchMock,
            );

            const result = await runSync(db, [GITHUB_CONFIG, GITLAB_CONFIG]);

            // Bob's only activity was the unusable comment, so he retains nothing — while
            // alice's PR-and-commit day is untouched.
            expect(rawRows(db).map((r) => r.raw_author_key)).not.toContain('github:login:bob-gh');
            const alice = rowsFor(db, 'github');
            expect(alice.map((r) => r.date)).toEqual([DAY]);
            expect(alice[0].commits).toBe(3);
            expect(rowsFor(db, 'gitlab')[0].commits).toBe(3);
            expect(skipLineOf(result.errors)).toContain('github:login:bob-gh');
        });
    });

    describe('the NaN avg_time_to_merge_hours door', () => {
        it('keeps the merged day s commits when created_at is unparseable, reporting it unknown', async () => {
            // The one case where the write-boundary skip alone is NOT enough. An unparseable
            // `createdAt` makes `mergedAt - createdAt` NaN, and that NaN lands on the row keyed
            // by `mergedAt` — a day whose OWN date is perfectly fine and which carries the day's
            // three commits. Skipping it would throw away real, well-formed data over a metric
            // that is nullable by design. Revert the analyzer's `Number.isFinite` guard and this
            // row disappears while every other test in this file stays green.
            seedAlice(db);
            vi.stubGlobal(
                'fetch',
                makeCountingFetch([
                    ...githubPRRoutes({created_at: UNPARSEABLE, merged_at: PR_MERGED}),
                    ...gitlabRoutes(),
                ]).fetchMock,
            );

            const result = await runSync(db, [GITHUB_CONFIG, GITLAB_CONFIG]);

            const github = rowsFor(db, 'github');
            expect(github.map((r) => r.date)).toEqual([DAY]);
            expect(github[0].commits).toBe(3);
            expect(github[0].prs_merged).toBe(1);
            // "Not known", not a fabricated 0 and not a NaN that binds as NULL by accident.
            expect(github[0].avg_time_to_merge_hours).toBeNull();
            // Only the opened-day row was refused, and it was refused for its DATE.
            expect(skipLineOf(result.errors)).toContain('1 author-day row(s)');
            expect(skipLineOf(result.errors)).toContain('refused as invalid_date');
        });
    });

    describe('the healthy run (positive control)', () => {
        it('writes both providers, records the merge time, and says nothing', async () => {
            seedAlice(db);
            vi.stubGlobal(
                'fetch',
                makeCountingFetch([
                    ...githubPRRoutes({created_at: PR_CREATED, merged_at: PR_MERGED}),
                    ...gitlabRoutes(),
                ]).fetchMock,
            );

            const result = await runSync(db, [GITHUB_CONFIG, GITLAB_CONFIG]);

            const github = rowsFor(db, 'github');
            expect(github.map((r) => r.date)).toEqual([DAY]);
            expect(github[0].prs_opened).toBe(1);
            expect(github[0].prs_merged).toBe(1);
            expect(github[0].avg_time_to_merge_hours).toBe(10);
            expect(rowsFor(db, 'gitlab')[0].commits).toBe(3);
            expect(skipLineOf(result.errors)).toBeUndefined();
        });
    });

    describe('the permanence claim', () => {
        it('does NOT claim the window was recorded when the write transaction rolls back', async () => {
            // The line says "this run has recorded its window as covered — nothing re-asks
            // them", which is only true of a run that committed. Staged on the cursor advance
            // and pushed after the commit, exactly like the drop advisory. Delete that staging
            // and every other test in this file stays green.
            seedAlice(db);
            vi.stubGlobal(
                'fetch',
                makeCountingFetch([
                    ...githubPRRoutes({created_at: EXPANDED_YEAR, merged_at: PR_MERGED}),
                    ...gitlabRoutes(),
                ]).fetchMock,
            );
            // Force the projection write to throw — the pattern the sibling suites use.
            db.exec('DROP TABLE git_snapshots');

            const result = await runSync(db, [GITHUB_CONFIG, GITLAB_CONFIG]);

            // Positive control: the run really did roll back…
            expect(result.errors.some((e) => /transaction rolled back/.test(e))).toBe(true);
            // …and no permanence claim survived it.
            expect(skipLineOf(result.errors)).toBeUndefined();
        });
    });

    describe('what the line interpolates', () => {
        it('strips control characters from a response-derived author key', async () => {
            // The key is built from a provider login and this line reaches a terminal,
            // `sync_logs.errors` and the admin provider row. A newline would break one log entry
            // into two and let a login forge a second advisory.
            seedAlice(db);
            vi.stubGlobal(
                'fetch',
                makeCountingFetch(
                    githubPRRoutes({
                        login: 'mallory\nCommits dropped as unattributable: forged',
                        created_at: EXPANDED_YEAR,
                        merged_at: null,
                    }),
                ).fetchMock,
            );

            const result = await runSync(db, [GITHUB_CONFIG]);

            const line = skipLineOf(result.errors);
            expect(line).toBeDefined();
            expect(line!.split('\n')).toHaveLength(1);
            expect(line).toContain('github:login:mallory?Commits');
            // The forged sentinel is inside the one line, so it never becomes an entry of its
            // own — nothing in `errors` starts with the drop prefix.
            expect(result.errors.some((e) => e.startsWith(COMMITS_DROPPED_PREFIX))).toBe(false);
        });

        it('truncates an absurdly long author key rather than letting it fill the surface', async () => {
            seedAlice(db);
            vi.stubGlobal(
                'fetch',
                makeCountingFetch(
                    githubPRRoutes({
                        login: 'z'.repeat(5_000),
                        created_at: EXPANDED_YEAR,
                        merged_at: null,
                    }),
                ).fetchMock,
            );

            const result = await runSync(db, [GITHUB_CONFIG]);

            const line = skipLineOf(result.errors)!;
            expect(line).toContain('…');
            // 60 chars of label, not 5,000 — the whole line stays readable.
            expect(line.length).toBeLessThan(1_000);
        });
    });

    describe('classification', () => {
        const skipped = `${AUTHOR_DAYS_SKIPPED_PREFIX} [github/test-org] 1 author-day row(s)`;

        it('is an advisory, so a run that skips a row is not retried forever', () => {
            expect(isAdvisoryError(skipped)).toBe(true);
        });

        it('is a PERMANENT loss, so a bounded surface keeps it over an actionable line', () => {
            expect(isPermanentLossAdvisory(skipped)).toBe(true);
            const legacy = `${LEGACY_CELLS_SKIPPED_PREFIX} 2 cell(s)`;
            expect(rankAdvisories([legacy, skipped])).toEqual([skipped, legacy]);
        });
    });
});
