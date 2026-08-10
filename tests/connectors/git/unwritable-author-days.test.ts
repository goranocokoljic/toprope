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
    PR_RECORDS_SKIPPED_PREFIX,
    isAdvisoryError,
    sanitizeAdvisoryLabel,
    isPermanentLossAdvisory,
    rankAdvisories,
    stallStateKey,
    syncStateKey,
} from '../../../src/connectors/git/sync';
import {
    MAX_STORED_COLUMN_CHARS,
    createProvider,
    getProvider,
    recordSyncOutcome,
    toPublicProvider,
} from '../../../src/connectors/git/providers/store';
import {loadServerKey} from '../../../src/connectors/git/providers/secret';
import {
    COMMIT_DATE,
    SHAS,
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

/**
 * Resolvable by commit email on every provider, so cells actually project — AND by the github
 * login the PR fixtures author under.
 *
 * That second half is load-bearing, not tidiness: `upsertPRRecord` only runs for a PR whose
 * author resolves to a developer (`if (developerId) upsertPRRecord(...)`), so a fixture whose
 * github id does not match `alice-gh` leaves the entire `pr_records` write path dark — and that
 * path holds the run's OTHER unvalidated `NOT NULL` bind (#302 review cycle 1, SEC-1).
 */
function seedAlice(db: Database.Database): string {
    addTeam(db, 'eng');
    const dev = addDeveloper(db, 'alice', 'eng', AUTHOR_EMAIL, 'Alice');
    db.prepare(`UPDATE developers SET external_ids = '{"github":"alice-gh"}' WHERE id = ?`).run(dev.id);
    return dev.id;
}

interface GitHubPRFields {
    login?: string;
    /** `unknown`, because the point of several cases below is a body whose field is NOT a string. */
    created_at: unknown;
    merged_at: unknown;
    /** Same reason: an omitted `state` arrives `undefined` through GitHub's cast. */
    state?: unknown;
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
                    state: 'state' in pr ? pr.state : 'closed',
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

/**
 * GitHub COMMIT routes whose `author.login` is not a string, prepended so they shadow
 * `githubRoutes()`' own commit list/detail entries.
 *
 * `toAnalysisCommit` fills `authorLogin` as `username || email`, and `||` filters only FALSY —
 * so a `{}` login survives and becomes a `metricsMap` KEY. The commit email is left intact, so
 * the author still has a usable identity to be keyed by; what is unusable is the value that
 * lands in the row's `author_login` column.
 */
function githubNonStringLoginRoutes(login: unknown): Route[] {
    const commit = {
        author: {name: 'Alice', email: AUTHOR_EMAIL, date: COMMIT_DATE},
        message: 'feat: work',
    };
    return [
        {
            match: /\/repos\/test-org\/repo1\/commits\?/,
            body: SHAS.map((sha) => ({sha, commit, author: {login}})),
        },
        {
            match: /\/repos\/test-org\/repo1\/commits\/[^?]+$/,
            bodyFor: (url: string): Record<string, unknown> => ({
                sha: url.split('/').pop(),
                commit,
                author: {login},
                stats: {additions: 40, deletions: 5, total: 45},
                files: [{filename: 'src/foo.ts', additions: 30, deletions: 5, status: 'modified'}],
            }),
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

function prLineOf(errors: string[]): string | undefined {
    return errors.find((e) => e.startsWith(PR_RECORDS_SKIPPED_PREFIX));
}

function countRows(db: Database.Database, table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n: number}).n;
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

/**
 * A forward cursor just before the fixtures' commit day, for the cases that need the run to
 * RESUME rather than treat the window as a first sync. `catchUpUntil` then derives `until` from
 * this instant plus the catch-up cap rather than from the clock, which is what lets a case with a
 * corrupt clock still reach the write transaction (#309).
 */
const CURSOR_BEFORE_FIXTURES = '2024-01-10T00:00:00.000Z';

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
        it("costs GitHub one author-day row and leaves GitLab's whole window committed", async () => {
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

        it("costs Bitbucket one author-day row and leaves GitLab's whole window committed", async () => {
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
            // The day the row was refused FOR — `toDateString` yields `''` for a non-string, and
            // the line has to name that rather than print an empty gap between two words.
            expect(skipLineOf(result.errors)).toContain('github:login:alice-gh on <empty>');
            // …and the OTHER write in the same transaction refused it too, rather than binding a
            // NULL into `pr_records.created_at` and rolling the run back (review cycle 1, SEC-1).
            const prLine = prLineOf(result.errors);
            expect(prLine).toContain('[github/test-org]');
            expect(prLine).toContain('1 PR(s)');
            // #307 no longer classifies WHICH column was unstorable — the skip is caught at the
            // write, so the reason is one generic literal rather than a per-column code.
            expect(prLine).toContain('refused as an unstorable field');
            expect(prLine).toContain('repo1#1');
            expect(countRows(db, 'pr_records')).toBe(0);
        });

        it("costs the review comment's own row and nothing else", async () => {
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

    describe('the identity door', () => {
        it('costs one author-day when the login is a non-string, and leaves the other provider committed', async () => {
            // #302 review cycle 3, SO-1/SEC-1 — the end-to-end case for `invalid_identity`, which
            // until now was only ever driven through the validator directly.
            //
            // A `{}` login is dereferenced THREE times before the write boundary ever sees it:
            // `retentionKeyFor`'s `.toLowerCase()`, `rawAuthorKeyFor`'s `.trim()`, and the store's
            // `bestKnown`. The first two run in `sync.ts`'s post-fetch loop, which sits inside NO
            // `try` — so before the fix a TypeError there escaped the entire run: no provider
            // wrote, no cursor advanced, no advisory was emitted, and the next run replayed the
            // identical body forever. Revert either `typeof` guard and this test fails with a
            // TypeError while the rest of the suite goes red for the wrong reason.
            seedAlice(db);
            vi.stubGlobal(
                'fetch',
                makeCountingFetch([
                    ...githubNonStringLoginRoutes({}),
                    ...gitlabRoutes(),
                ]).fetchMock,
            );

            const result = await runSync(db, [GITHUB_CONFIG, GITLAB_CONFIG]);

            // The run survived: GitLab's whole window is committed and its cursor advanced…
            expect(rowsFor(db, 'gitlab')[0].commits).toBe(3);
            expect(cursorOf(db, GITLAB_CURSOR)).toBeDefined();
            // …GitHub's day is the only casualty, keyed by the email branch because the login was
            // unusable, and refused for the identity rather than the date…
            expect(rowsFor(db, 'github')).toHaveLength(0);
            const line = skipLineOf(result.errors);
            expect(line).toContain('[github/test-org]');
            expect(line).toContain('1 author-day row(s)');
            expect(line).toContain('refused as invalid_identity');
            expect(line).toContain(`github:email:${AUTHOR_EMAIL} on ${DAY}`);
        });

        it('drops the author with no advisory when BOTH login and email are unusable', async () => {
            // The honest limit of the fix: with no usable identity there is no key to report the
            // day under, so it takes the same silent path a truly-anonymous commit has always
            // taken (`if (!rawAuthorKey) continue`). Pinned so the asymmetry with the case above
            // is a decision on record rather than a surprise — and so the run still SURVIVES,
            // which is the property that actually matters.
            seedAlice(db);
            vi.stubGlobal(
                'fetch',
                makeCountingFetch([
                    {
                        match: /\/repos\/test-org\/repo1\/commits\?/,
                        body: SHAS.map((sha) => ({
                            sha,
                            commit: {author: {name: 'Alice', email: 42, date: COMMIT_DATE}, message: 'x'},
                            author: {login: {}},
                        })),
                    },
                    {
                        match: /\/repos\/test-org\/repo1\/commits\/[^?]+$/,
                        bodyFor: (url: string): Record<string, unknown> => ({
                            sha: url.split('/').pop(),
                            commit: {author: {name: 'Alice', email: 42, date: COMMIT_DATE}, message: 'x'},
                            author: {login: {}},
                            stats: {additions: 1, deletions: 0, total: 1},
                            files: [],
                        }),
                    },
                    ...githubRoutes(),
                    ...gitlabRoutes(),
                ]).fetchMock,
            );

            const result = await runSync(db, [GITHUB_CONFIG, GITLAB_CONFIG]);

            expect(rowsFor(db, 'gitlab')[0].commits).toBe(3);
            expect(rowsFor(db, 'github')).toHaveLength(0);
            expect(skipLineOf(result.errors)).toBeUndefined();
        });
    });

    describe('the NaN avg_time_to_merge_hours door', () => {
        it("keeps the merged day's commits when created_at is unparseable, reporting it unknown", async () => {
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
        it('does NOT claim the window was recorded when the rollback fires AFTER the staging site', async () => {
            // THE SHARP VERSION (#302 review cycle 3, TST-1), and the one that actually tests the
            // mechanism. The `DROP TABLE` case below throws at `projectSnapshots`, which runs
            // BEFORE the `cursorAdvances` loop — and unlike its three sibling advisories, this
            // line is not a pre-built string handed to the closure, it is RENDERED INSIDE it. So
            // on that path the render never executes and `skipLineOf` is trivially undefined:
            // the assertion passes whether or not the staging exists. Replace the
            // `skippedRowAdvisories.push(...)` at the staging site with a direct `errors.push`
            // and every other test in this file, that one included, stays green.
            //
            // `stallUpdates` runs AFTER the advances, so a throw there is the one window where
            // the advisory HAS been rendered and staged and the transaction still rolls back —
            // exactly the pattern `commit-loss.test.ts` uses for the drop line (#275 cycle 3).
            seedAlice(db);
            vi.stubGlobal(
                'fetch',
                makeCountingFetch([
                    // `null` on both, so BOTH advisories are rendered at the staging site — the
                    // author-day line AND the `pr_records` one. A fixture that only trips one of
                    // them would leave the other's assertion below trivially true.
                    ...githubPRRoutes({created_at: null, merged_at: null}),
                    ...gitlabRoutes(),
                ]).fetchMock,
            );
            // A complete run CLEARS the provider's stall key in `stallUpdates`; seed that exact
            // key on both providers so the DELETE matches a row, then make the delete abort.
            const seedStall = (key: string): void => {
                db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
                    key,
                    JSON.stringify({runs: 1, since: '2024-01-01T00:00:00.000Z'}),
                );
            };
            seedStall(stallStateKey('github', 'test-org'));
            seedStall(stallStateKey('gitlab', 'test-group'));
            db.exec(`
                CREATE TRIGGER boom BEFORE DELETE ON sync_state
                WHEN old.key LIKE 'git_stall:%'
                BEGIN SELECT RAISE(ABORT, 'stall-clear boom'); END;
            `);

            const result = await runSync(db, [GITHUB_CONFIG, GITLAB_CONFIG]);

            // Positive controls: the run rolled back, and the cursor whose advance the
            // advisory's claim rests on did not persist…
            expect(result.errors.some((e) => /transaction rolled back/.test(e))).toBe(true);
            expect(cursorOf(db, GITHUB_CURSOR)).toBeUndefined();
            expect(countRows(db, 'raw_author_daily')).toBe(0);
            // …so NEITHER permanence claim survived, even though the staging site DID execute
            // and both lines were rendered.
            expect(skipLineOf(result.errors)).toBeUndefined();
            expect(prLineOf(result.errors)).toBeUndefined();
        });

        it('does NOT claim the window was recorded when the write transaction rolls back', async () => {
            // The line says the commits "could not be imported by this run, whose window is now
            // recorded as covered", which is only true of a run that committed. Staged on the cursor advance
            // and pushed after the commit, exactly like the drop advisory. Kept alongside the
            // sharper case above because it covers a DIFFERENT discard path (a failure before
            // the advances rather than after them) — but note it cannot fail for the staging
            // itself; that is what the test above is for.
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

    describe('many skips in one run', () => {
        /**
         * Seven authors, each with one PR whose `created_at` is unusable — so one provider
         * produces seven skipped author-days in a single run.
         *
         * Every other test in this file skips exactly ONE row, which leaves the grouping, the
         * count above 1, the per-group sample cap and the `(+N more)` tail unexercised: replace
         * the whole grouped render with a single ungrouped, uncapped join and they all stay green.
         */
        function manyBadPRRoutes(count: number): Route[] {
            return [
                {match: /\/repos\/test-org\/repo1\/pulls\/\d+\/comments/, body: []},
                {match: /\/repos\/test-org\/repo1\/pulls\/\d+\/reviews/, body: []},
                {
                    match: /\/repos\/test-org\/repo1\/pulls\?/,
                    body: Array.from({length: count}, (_, i) => ({
                        number: i + 1,
                        title: 'feat: work',
                        user: {login: `dev-${i}`},
                        state: 'open',
                        created_at: EXPANDED_YEAR,
                        merged_at: null,
                        closed_at: null,
                        updated_at: PR_MERGED,
                        requested_reviewers: [],
                    })),
                },
                ...githubRoutes(),
            ];
        }

        it('counts all of them, samples five, and tails the remainder', async () => {
            seedAlice(db);
            vi.stubGlobal('fetch', makeCountingFetch(manyBadPRRoutes(7)).fetchMock);

            const line = skipLineOf((await runSync(db, [GITHUB_CONFIG])).errors)!;

            expect(line).toContain('7 author-day row(s)');
            expect(line).toContain('7 refused as invalid_date');
            expect(line).toContain('(+2 more)');
            // Exactly five named — the cap, not the count.
            expect(line.match(/github:login:dev-\d/g)).toHaveLength(5);
        });

        it("stays inside the provider column's storage cap and survives the round-trip", async () => {
            // `AUTHOR_DAYS_SKIPPED_PREFIX` is ranked to the FRONT of a bounded column
            // (`PERMANENT_LOSS_ADVISORY_PREFIXES`), and the cap truncates the TAIL — which on
            // this line is `groups`, the only actionable content. The sibling churn advisory is
            // pinned the same way for the same reason (`commit-loss.test.ts`).
            seedAlice(db);
            vi.stubGlobal('fetch', makeCountingFetch(manyBadPRRoutes(7)).fetchMock);

            const line = skipLineOf((await runSync(db, [GITHUB_CONFIG])).errors)!;
            expect(line.length).toBeLessThanOrEqual(MAX_STORED_COLUMN_CHARS);
            // …and it is really long enough for the cap to be a live question, not a formality.
            expect(line.length).toBeGreaterThan(500);

            // Round-trip the REAL line through the store: "the emitted line fits" and "the store
            // does not cut it" are two different claims, and only this composes them.
            const store = makeDb();
            try {
                const key = loadServerKey({TOPROPE_SECRET_KEY: Buffer.alloc(32, 7).toString('base64')});
                const rec = createProvider(store, key, {config: GITHUB_CONFIG, createdBy: null});
                recordSyncOutcome(store, rec.id, {status: 'ok', at: NOW, advisories: [line]});
                expect(toPublicProvider(getProvider(store, rec.id)!).last_sync_advisories).toEqual([line]);
            } finally {
                store.close();
            }
        });
    });

    describe('the OTHER write in the transaction (pr_records)', () => {
        /**
         * The two bind faults `pr_records` refuses at the write (#302/#307), driven end to end —
         * the two error SHAPES `isUnstorablePRFieldError` matches beyond the `null` NOT-NULL case
         * covered above: an object bound positionally (better-sqlite3 RangeError) and a `NOT NULL`
         * column bound `undefined` (`SQLITE_CONSTRAINT_NOTNULL`).
         *
         * Each is a `NOT NULL` column (or a nullable one whose non-string value `toUtcIso` passes
         * through untouched to the bind) filled from a field GitHub CASTS rather than validates.
         * Before #302 each threw out of `insertMany` and rolled back every provider's window; the
         * existing date fixtures could not reach them, because they only ever use a string or
         * `null`. #307 no longer names the offending column, so all report one generic reason.
         */
        const PR_BIND_FAULTS: Array<{name: string; pr: GitHubPRFields}> = [
            {name: 'an object merged_at', pr: {created_at: PR_CREATED, merged_at: {}}},
            {name: 'an omitted state', pr: {created_at: PR_CREATED, merged_at: null, state: undefined}},
        ];

        for (const fault of PR_BIND_FAULTS) {
            it(`skips the PR for ${fault.name}, leaving GitLab's window committed`, async () => {
                seedAlice(db);
                vi.stubGlobal(
                    'fetch',
                    makeCountingFetch([...githubPRRoutes(fault.pr), ...gitlabRoutes()]).fetchMock,
                );

                const result = await runSync(db, [GITHUB_CONFIG, GITLAB_CONFIG]);

                expect(result.errors.some((e) => /transaction rolled back/.test(e))).toBe(false);
                expect(rowsFor(db, 'gitlab')[0].commits).toBe(3);
                expect(cursorOf(db, GITLAB_CURSOR)).toBeDefined();
                expect(countRows(db, 'pr_records')).toBe(0);
                expect(prLineOf(result.errors)).toContain('refused as an unstorable field');
                expect(prLineOf(result.errors)).toContain('repo1#1');
            });
        }

        it('strips the invisible reordering characters a newline check does not catch', () => {
            // The input class ONLY the widened character class handles. U+202E (RLO) visually
            // reverses everything after it — an author login carrying one can make the refusal
            // code render as something else entirely — and U+2028 is a LINE TERMINATOR to several
            // renderers, so a C0-only strip leaves "this advisory is exactly one entry" half
            // true. Neither is a control character in the C0/DEL sense, so the `\n` fixture above
            // passes with or without them.
            expect(sanitizeAdvisoryLabel('alice\u202Egnp.exe')).toBe('alice?gnp.exe');
            expect(sanitizeAdvisoryLabel('alice\u2028forged')).toBe('alice?forged');
            expect(sanitizeAdvisoryLabel('alice\u200Bbob')).toBe('alice?bob');
            // …while a legitimate non-ASCII name is left intact, which is why this is a strip
            // and not an allowlist.
            expect(sanitizeAdvisoryLabel('Ana María 田中')).toBe('Ana María 田中');
        });

        it('truncates by CODE POINT, so an astral character is never cut in half', () => {
            // The input class only the code-point cut handles: 59 ASCII characters then an
            // astral pair straddling the 60-unit boundary. A UTF-16 `slice` keeps the high
            // surrogate alone, which is an unpaired surrogate in a string this pipeline
            // JSON-stringifies into a TEXT column.
            const label = `${'a'.repeat(59)}👍tail`;
            const cut = sanitizeAdvisoryLabel(label);
            expect(cut).toBe(`${'a'.repeat(59)}👍…`);
            expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut)).toBe(false);
            // The cap is what is pinned, not an arbitrary ceiling: 60 code points plus the mark.
            expect([...cut]).toHaveLength(61);
        });

        it('renders a non-string repo/prId as <non-string> instead of throwing on it', async () => {
            // `SkippedPRRecord.repo`/`prId` are `unknown` precisely because the refusal may be
            // that they are NOT strings, and the advisory still has to render. Unit-level: no
            // provider produces a non-string repo name today, so driving it through a run would
            // be pinning a fixture rather than the branch.
            expect(sanitizeAdvisoryLabel(undefined)).toBe('<non-string>');
            expect(sanitizeAdvisoryLabel(42)).toBe('<non-string>');
            expect(sanitizeAdvisoryLabel(null)).toBe('<non-string>');
        });
    });

    describe('a refusal that is NOT a property of the row', () => {
        it('still rolls back and holds the cursor, instead of discarding the window fail-open', async () => {
            // Four of the six refusal codes are decided by operands constant for the whole run
            // (`observedAt`) or the whole provider (`provider`, `container`, the key's
            // namespacing). Skipping those would discard EVERY row of EVERY provider, advance
            // every cursor and report the run clean — strictly worse than the rollback this
            // issue is about, and it would silently undo the fail-closed behaviour
            // `providers/config.ts` explicitly relies on. So they must still throw.
            //
            // Driven through `observedAt`, which is `new Date().toISOString()` — the one
            // run-level operand a real deployment can actually corrupt, by having a clock that
            // reads an ISO 8601 expanded year (the same #233 hazard class as the commit dates
            // above). A blank container cannot get this far: the factory refuses it by name
            // before a provider is ever built.
            //
            // BOTH PROVIDERS ARE GIVEN A STORED CURSOR FIRST, and that is what keeps this test
            // pointed at the store's rollback rather than at #309's window check. With no cursor
            // the run's `until` IS the corrupt clock reading, which `fetchProviderData` now
            // refuses outright before a single request — a strictly better outcome, pinned by the
            // no-cursor corrupt-clock case in `future-author-dates.test.ts` ("the window bounds
            // are validated once"), but it never reaches the write transaction this case is about. With
            // a cursor, `catchUpUntil` caps `until` to `since + GIT_CATCHUP_WINDOW_MAX_DAYS`, an
            // ordinary four-digit-year instant the window check accepts, so the corrupt clock
            // survives to `observedAt` exactly as it did before.
            seedAlice(db);
            db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?), (?, ?)').run(
                GITHUB_CURSOR,
                CURSOR_BEFORE_FIXTURES,
                GITLAB_CURSOR,
                CURSOR_BEFORE_FIXTURES,
            );
            vi.setSystemTime(new Date(EXPANDED_YEAR));
            vi.stubGlobal(
                'fetch',
                makeCountingFetch([
                    ...githubPRRoutes({created_at: PR_CREATED, merged_at: PR_MERGED}),
                    ...gitlabRoutes(),
                ]).fetchMock,
            );

            const result = await runSync(db, [GITHUB_CONFIG, GITLAB_CONFIG]);

            // Loud, not silent: the run reports a rollback…
            expect(result.errors.some((e) => /transaction rolled back/.test(e))).toBe(true);
            expect(result.errors.some((e) => /observedAt must be a UTC ISO instant/.test(e))).toBe(true);
            // …NO cursor advanced, for either provider, so both windows re-cover once the
            // operator fixes the clock…
            expect(cursorOf(db, GITLAB_CURSOR)).toBe(CURSOR_BEFORE_FIXTURES);
            expect(cursorOf(db, GITHUB_CURSOR)).toBe(CURSOR_BEFORE_FIXTURES);
            expect(rawRows(db)).toHaveLength(0);
            // …and it was NOT reported as a per-row skip, which would have claimed a permanent
            // loss over a window that is in fact intact.
            expect(skipLineOf(result.errors)).toBeUndefined();
        });
    });

    describe('a non-refusal error is never swallowed as a skip (#307)', () => {
        // The write-boundary skip is now a CATCH at each write, and the whole point of #307's
        // discrimination is that the catch is narrow: it absorbs ONLY the store's own row-level
        // refusal (raw side) or an unstorable-field bind error (pr side). A bare `catch {}` in
        // either place would swallow a raised trigger, SQLITE_BUSY or a genuine bug as a "skipped
        // row" advisory WITH the cursor advanced — fail-open on an unknown error class, a worse
        // version of the failure #302 closed. These two drive an unrelated SQLite error through
        // each write and assert the run rolls back loudly instead. Replace either catch's filter
        // with a bare catch and exactly the matching test here goes red.
        it('rethrows a raised trigger from the raw_author_daily write and rolls the run back', async () => {
            seedAlice(db);
            // Not a RawAuthorDailyError and not row-level: RAISE(ABORT) surfaces as a SqliteError
            // (SQLITE_CONSTRAINT_TRIGGER), which the raw catch must let propagate.
            db.exec(`
                CREATE TRIGGER raw_boom BEFORE INSERT ON raw_author_daily
                BEGIN SELECT RAISE(ABORT, 'raw boom'); END;
            `);
            vi.stubGlobal(
                'fetch',
                makeCountingFetch(githubPRRoutes({created_at: PR_CREATED, merged_at: PR_MERGED})).fetchMock,
            );

            const result = await runSync(db, [GITHUB_CONFIG]);

            expect(result.errors.some((e) => /transaction rolled back/.test(e))).toBe(true);
            expect(result.errors.some((e) => /raw boom/.test(e))).toBe(true);
            expect(countRows(db, 'raw_author_daily')).toBe(0);
            expect(cursorOf(db, GITHUB_CURSOR)).toBeUndefined();
            // NOT reported as a per-row skip — that would claim a permanent loss over an intact
            // window and advance the cursor past it.
            expect(skipLineOf(result.errors)).toBeUndefined();
        });

        it('rethrows a raised trigger from the pr_records write and rolls the run back', async () => {
            seedAlice(db);
            // A trigger abort is SQLITE_CONSTRAINT_TRIGGER, not the SQLITE_CONSTRAINT_NOTNULL /
            // bind shapes `isUnstorablePRFieldError` matches — so the pr catch must rethrow it.
            db.exec(`
                CREATE TRIGGER pr_boom BEFORE INSERT ON pr_records
                BEGIN SELECT RAISE(ABORT, 'pr boom'); END;
            `);
            vi.stubGlobal(
                'fetch',
                makeCountingFetch(githubPRRoutes({created_at: PR_CREATED, merged_at: PR_MERGED})).fetchMock,
            );

            const result = await runSync(db, [GITHUB_CONFIG]);

            expect(result.errors.some((e) => /transaction rolled back/.test(e))).toBe(true);
            expect(result.errors.some((e) => /pr boom/.test(e))).toBe(true);
            // The raw writes ran first but rolled back with the failing PR write.
            expect(countRows(db, 'raw_author_daily')).toBe(0);
            expect(cursorOf(db, GITHUB_CURSOR)).toBeUndefined();
            expect(prLineOf(result.errors)).toBeUndefined();
        });
    });

    describe('classification', () => {
        it('is an advisory, so a run that skips a row is not retried forever', async () => {
            // Driven through the REAL pipeline rather than a hand-built literal, so a reworded
            // prefix cannot leave this passing against a line the code no longer emits.
            seedAlice(db);
            vi.stubGlobal(
                'fetch',
                makeCountingFetch(
                    githubPRRoutes({created_at: null, merged_at: null}),
                ).fetchMock,
            );

            const errors = (await runSync(db, [GITHUB_CONFIG])).errors;

            expect(isAdvisoryError(skipLineOf(errors)!)).toBe(true);
            expect(isAdvisoryError(prLineOf(errors)!)).toBe(true);
        });

        it('is a PERMANENT loss, so a bounded surface keeps it over an actionable line', async () => {
            seedAlice(db);
            vi.stubGlobal(
                'fetch',
                makeCountingFetch(
                    githubPRRoutes({created_at: EXPANDED_YEAR, merged_at: null}),
                ).fetchMock,
            );

            const skipped = skipLineOf((await runSync(db, [GITHUB_CONFIG])).errors)!;
            expect(isPermanentLossAdvisory(skipped)).toBe(true);
            const legacy = `${LEGACY_CELLS_SKIPPED_PREFIX} 2 cell(s)`;
            expect(rankAdvisories([legacy, skipped])).toEqual([skipped, legacy]);
        });

        it('ranks the PR-records line as a permanent loss too, not just the author-day one', async () => {
            // The sibling assertion above covered only `AUTHOR_DAYS_SKIPPED_PREFIX` (#302 review
            // cycle 3, TST-2). Both prefixes are in `PERMANENT_LOSS_ADVISORY_PREFIXES`, and that
            // membership is what keeps the line at the FRONT of the bounded
            // `last_sync_advisories` column — i.e. the difference between the operator seeing
            // the loss and it being truncated away. Drop `PR_RECORDS_SKIPPED_PREFIX` from that
            // array and only this test fails.
            seedAlice(db);
            vi.stubGlobal(
                'fetch',
                makeCountingFetch(
                    // `null`, not an expanded year: the PR-record guard refuses a non-string
                    // bind, so an ill-shaped but well-typed day is storable there.
                    githubPRRoutes({created_at: null, merged_at: null}),
                ).fetchMock,
            );

            const prLine = prLineOf((await runSync(db, [GITHUB_CONFIG])).errors)!;
            expect(isPermanentLossAdvisory(prLine)).toBe(true);
            const legacy = `${LEGACY_CELLS_SKIPPED_PREFIX} 2 cell(s)`;
            expect(rankAdvisories([legacy, prLine])).toEqual([prLine, legacy]);
        });
    });
});
