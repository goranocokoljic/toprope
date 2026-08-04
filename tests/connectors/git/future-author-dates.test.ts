/**
 * #309 — the two gaps #304 named and deliberately left open.
 *
 * 1. GITHUB AND GITLAB IMPORTED A FUTURE-DATED COMMIT THAT BITBUCKET ONLY REPORTS. #304 added
 *    `FUTURE_AUTHOR_DATE_DROP_REASON` for a commit whose author date is ahead of both `until` and
 *    the clock — but only an IN-MEMORY `until` filter can see that, and today that is Bitbucket's
 *    commit walk alone. The other two push the window to the SERVER, and that server window
 *    filters on the COMMITTER date. `git commit --date="2099-01-01"` (or a rebase of imported
 *    history) leaves the committer date at now, so the row comes back; the day key this pipeline
 *    derives comes from the AUTHOR date; and `isAttributableDate` is a bare shape-plus-parse test
 *    with no upper bound. The row was therefore written into `raw_author_daily` as a `2099-01-01`
 *    developer-day and projected into `git_snapshots`, where append-only means it could never be
 *    corrected — the graduated "bound and clamp ranges driven by external timestamps" hazard #106
 *    already hit once. The fix is at the WRITE boundary, for all three providers at once.
 *
 * 2. THE WINDOW BOUNDS WERE TOTAL ON ONE WALK ONLY. `since`/`until` are derived ONCE, per provider
 *    per run, in `fetchProviderData` and handed to every `getCommits` AND every `getPullRequests`
 *    — but only `BitbucketProvider.getCommits` checked them. #309 hoists the check to where the
 *    strings are derived, so every provider and both walks fail closed once per run.
 *
 * These drive the REAL provider classes through the REAL sync pipeline over a stubbed `fetch`,
 * because both properties are about what the pipeline WRITES (or refuses to fetch at all), which
 * no provider-level test can see.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper} from '../../../src/registry/developers';
import {
    AUTHOR_DAYS_SKIPPED_PREFIX,
    GitSync,
    isAdvisoryError,
    syncStateKey,
} from '../../../src/connectors/git/sync';
import {
    BITBUCKET_CONFIG,
    GITHUB_CONFIG,
    GITLAB_CONFIG,
    bitbucketRoutes,
    githubRoutes,
    gitlabRoutes,
    makeCountingFetch,
    type CountingFetch,
    type Route,
} from './providers/provider-fetch-fixtures';
import type {GitProviderConfig} from '../../../src/connectors/git/providers/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');

const AUTHOR_EMAIL = 'alice@example.com';
const NOW = '2024-01-20T00:00:00.000Z';

/** In the run's window, and the POSITIVE CONTROL: this day must still be written. */
const GOOD_DAY = '2024-01-15';

/**
 * What `git commit --date="2099-01-01"` leaves on the AUTHOR date while the committer date stays
 * at now — so the server-side window (which filters on the committer date) returns the row.
 */
const FUTURE_DAY = '2099-01-01';

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

/** Resolvable by commit email on every provider, so the retained rows actually project. */
function seedAlice(db: Database.Database): string {
    addTeam(db, 'eng');
    const dev = addDeveloper(db, 'alice', 'eng', AUTHOR_EMAIL, 'Alice');
    db.prepare(`UPDATE developers SET external_ids = '{"github":"alice-gh"}' WHERE id = ?`).run(dev.id);
    return dev.id;
}

const DAYS = [GOOD_DAY, FUTURE_DAY] as const;

/**
 * HEX, with no `sha-` prefix, because `sanitizeSha` allowlists a git object name (`[0-9a-fA-F]`)
 * before letting it into an operator-facing advisory — a prefixed fixture renders as
 * `<invalid sha>` and the Bitbucket drop assertion below would be asserting on a string the code
 * cannot emit.
 */
const shaFor = (day: string): string => day.replace(/-/g, '');

/**
 * GitHub routes listing one commit per entry of {@link DAYS}, each on its own author date.
 *
 * The stub ignores query parameters, which is exactly the condition under test: GitHub's real
 * `since`/`until` are server-side and filter the COMMITTER date, so a commit authored in 2099 and
 * committed today IS returned by the very window this run asked for. Modelling the author-date
 * filter here would model a filter GitHub does not apply and the whole case would vanish.
 */
function githubFutureDateRoutes(): Route[] {
    const commitFor = (day: string): Record<string, unknown> => ({
        author: {name: 'Alice', email: AUTHOR_EMAIL, date: `${day}T10:00:00.000Z`},
        message: 'feat: work',
    });
    const byS = new Map(DAYS.map((day) => [shaFor(day), day]));
    return [
        {
            match: /\/repos\/test-org\/repo1\/commits\?/,
            body: DAYS.map((day) => ({
                sha: shaFor(day),
                commit: commitFor(day),
                author: {login: 'alice-gh'},
            })),
        },
        {
            match: /\/repos\/test-org\/repo1\/commits\/[^?]+$/,
            bodyFor: (url: string): Record<string, unknown> => {
                const day = byS.get(url.split('/').pop()!) ?? DAYS[0];
                return {
                    sha: shaFor(day),
                    commit: commitFor(day),
                    author: {login: 'alice-gh'},
                    stats: {additions: 40, deletions: 5, total: 45},
                    files: [{filename: 'src/foo.ts', additions: 30, deletions: 5, status: 'modified'}],
                };
            },
        },
        ...githubRoutes(),
    ];
}

/** The GitLab twin — same two commits, on `authored_date`, which is what GitLab keys the day on. */
function gitlabFutureDateRoutes(): Route[] {
    return [
        {
            match: /\/repository\/commits\?/,
            body: DAYS.map((day) => ({
                id: shaFor(day),
                author_name: 'Alice',
                author_email: AUTHOR_EMAIL,
                authored_date: `${day}T10:00:00.000Z`,
                message: 'feat: work',
            })),
        },
        ...gitlabRoutes(),
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

function rawDays(db: Database.Database): string[] {
    return (
        db.prepare('SELECT date FROM raw_author_daily ORDER BY date').all() as Array<{date: string}>
    ).map((r) => r.date);
}

function snapshotDays(db: Database.Database): string[] {
    return (
        db.prepare('SELECT date FROM git_snapshots ORDER BY date').all() as Array<{date: string}>
    ).map((r) => r.date);
}

function cursorOf(db: Database.Database, key: string): string | undefined {
    return (db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
        | {value: string}
        | undefined)?.value;
}

describe('#309 a future-dated author date is refused at the write boundary, not imported', () => {
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
        vi.unstubAllGlobals();
    });

    /**
     * GITHUB AND GITLAB SPECIFICALLY — the two the issue names, because they are the two that
     * IMPORTED the row. Bitbucket already reported it under `FUTURE_AUTHOR_DATE_DROP_REASON`
     * (#304), so a table that only covered Bitbucket would be green over the providers the defect
     * is about.
     */
    it.each([
        ['github', GITHUB_CONFIG, githubFutureDateRoutes] as const,
        ['gitlab', GITLAB_CONFIG, gitlabFutureDateRoutes] as const,
    ])('%s: writes the in-window day and refuses the 2099 one', async (provider, config, routes) => {
        seedAlice(db);
        vi.stubGlobal('fetch', makeCountingFetch(routes()).fetchMock);

        const result = await runSync(db, [config]);

        // THE PROPERTY: the future developer-day never reaches the retained spine, and therefore
        // never reaches the projection either. Asserted as the WHOLE day set, not as "2099 is
        // absent", so a run that wrote nothing at all cannot pass.
        expect(rawDays(db)).toEqual([GOOD_DAY]);
        expect(snapshotDays(db)).toEqual([GOOD_DAY]);
        // The positive control, stated as its own assertion: the fixture really did deliver two
        // commits down the same pipe and only one of them was refused. Without this the test would
        // pass against a provider whose routes returned nothing.
        expect(
            (
                db.prepare('SELECT commits FROM raw_author_daily WHERE date = ?').get(GOOD_DAY) as
                    | {commits: number}
                    | undefined
            )?.commits,
        ).toBe(1);

        // AND THE RUN SAYS SO. A silent skip is what #302 built this advisory to prevent: the
        // cursor advances over the window, so nothing ever re-asks the row.
        const skip = skipLineOf(result.errors);
        expect(skip).toBeDefined();
        expect(skip).toContain('future_date');
        expect(skip).toContain(FUTURE_DAY);
        expect(skip).toContain(provider);

        // An ADVISORY, not a failure — re-fetching returns the identical author date, so turning
        // the provider red would re-run the connector forever and still never write the row.
        expect(isAdvisoryError(skip!)).toBe(true);
        // …and the cursor advances, which is what makes it a row-level refusal rather than a
        // rollback. One odd commit must not hold the whole provider's window.
        expect(cursorOf(db, syncStateKey(provider, config.type === 'github' ? 'test-org' : 'test-group'))).toBe(NOW);
    });

    it('keeps Bitbucket reporting the same commit as a drop, which names its SHA', async () => {
        // The asymmetry the issue is about, asserted from the other side. Bitbucket's in-memory
        // `until` filter sees the future date one frame EARLIER, so it never builds an author-day
        // row for it at all — and that earlier report is strictly better, because it can name the
        // commit. The write-boundary refusal is what the other two get instead, and it can only
        // ever name the (author, day). Both are now covered; neither imports the row.
        seedAlice(db);
        vi.stubGlobal(
            'fetch',
            makeCountingFetch([
                {
                    match: /\/repositories\/test-ws\/repo1\/commits\?/,
                    body: {
                        values: DAYS.map((day) => ({
                            hash: shaFor(day),
                            author: {raw: `Alice <${AUTHOR_EMAIL}>`, user: {nickname: 'alice-bb'}},
                            date: `${day}T10:00:00.000Z`,
                            message: 'feat: work',
                        })),
                    },
                },
                ...bitbucketRoutes(),
            ]).fetchMock,
        );

        const result = await runSync(db, [BITBUCKET_CONFIG]);

        expect(rawDays(db)).toEqual([GOOD_DAY]);
        expect(result.errors.some((e) => e.includes(shaFor(FUTURE_DAY)))).toBe(true);
        // It never became an author-day row, so the write boundary never saw it.
        expect(skipLineOf(result.errors)).toBeUndefined();
    });
});

describe('#309 the window bounds are validated once, where they are derived', () => {
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
        vi.unstubAllGlobals();
    });

    function seedCursor(db: Database.Database, provider: string, container: string, value: string): void {
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
            syncStateKey(provider, container),
            value,
        );
    }

    /**
     * ALL THREE PROVIDERS, from one corrupt `git_last_sync` row.
     *
     * An ISO expanded year is what a skewed host clock or `git commit --date=@999999999999`
     * stamps into the cursor. Before #309 only Bitbucket refused it: GitHub and GitLab pushed it
     * into a query string, where the plausible outcome is an empty result set returned as a
     * success — after which the run records the whole unwalked span as covered and advances the
     * cursor past it.
     */
    it.each([
        ['github', GITHUB_CONFIG, 'test-org', githubRoutes] as const,
        ['gitlab', GITLAB_CONFIG, 'test-group', gitlabRoutes] as const,
        ['bitbucket', BITBUCKET_CONFIG, 'test-ws', bitbucketRoutes] as const,
    ])(
        '%s: refuses an expanded-year cursor before issuing a single request',
        async (provider, config, container, routes) => {
            const corrupt = '+033658-09-27T00:00:00.000Z';
            seedAlice(db);
            seedCursor(db, provider, container, corrupt);
            const counting: CountingFetch = makeCountingFetch(routes());
            vi.stubGlobal('fetch', counting.fetchMock);

            const result = await runSync(db, [config]);

            // NO NETWORK WORK AT ALL — not the repo list, not the commit walk, and not the PR
            // walk. That is the whole point of checking where the strings are derived rather than
            // inside one provider method: the refusal lands before the first request, for every
            // walk at once.
            expect(counting.fetchMock).not.toHaveBeenCalled();
            // Reported, and it names the bound and the state key to repair — never the value,
            // which is response/DB-derived and reaches a terminal and `sync_logs.errors`.
            const line = result.errors.find((e) => /four-digit-year/.test(e));
            expect(line).toBeDefined();
            expect(line).toContain('"since"');
            expect(line).toContain('git_last_sync');
            expect(line).not.toContain(corrupt);
            // A genuine error, not an advisory: an operator has to fix the state row.
            expect(isAdvisoryError(line!)).toBe(false);
            // FAIL-CLOSED: the cursor is untouched, so the window re-covers intact once the value
            // is repaired — rather than being recorded as covered while nothing was walked.
            expect(cursorOf(db, syncStateKey(provider, container))).toBe(corrupt);
            expect(rawDays(db)).toEqual([]);
        },
    );

    it('refuses an INVERTED window on GitHub, which had no bound check of its own before', () => {
        // `catchUpUntil` clamps `until` to `now` while `since` stays whatever the cursor says, so a
        // host clock that ran ahead once MANUFACTURES `since > until`. Each bound is individually
        // valid; only the pair check catches it. On GitHub that window goes to the server, which
        // answers it with an empty page — a success the run reads as "this span is covered".
        seedAlice(db);
        seedCursor(db, 'github', 'test-org', '2026-02-01T00:00:00.000Z');
        const counting = makeCountingFetch(githubRoutes());
        vi.stubGlobal('fetch', counting.fetchMock);

        return runSync(db, [GITHUB_CONFIG]).then((result) => {
            expect(counting.fetchMock).not.toHaveBeenCalled();
            expect(result.errors.some((e) => /inverted/.test(e))).toBe(true);
            expect(cursorOf(db, syncStateKey('github', 'test-org'))).toBe('2026-02-01T00:00:00.000Z');
        });
    });

    it('leaves an ordinary run untouched — the check refuses, it does not narrow', () => {
        // The other half of a fail-closed gate: it must not cost a healthy run anything. A normal
        // first sync (`since: ''`, `until: now`) walks and writes exactly as before.
        seedAlice(db);
        vi.stubGlobal('fetch', makeCountingFetch(githubFutureDateRoutes()).fetchMock);

        return runSync(db, [GITHUB_CONFIG]).then(() => {
            expect(rawDays(db)).toEqual([GOOD_DAY]);
            expect(cursorOf(db, syncStateKey('github', 'test-org'))).toBe(NOW);
        });
    });
});
