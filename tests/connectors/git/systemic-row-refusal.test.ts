/**
 * #306 — a SYSTEMIC row-level refusal must not settle as a green run.
 *
 * #302 made an unwritable author-day cost that row instead of rolling back every provider's
 * window. That trade is right for the one bad PR date that motivated it, and quietly wrong when
 * the same refusal is systemic: the skip is unconditional per row, so when a cause refuses 100%
 * of a provider's rows the provider writes nothing, its forward cursor still advances,
 * `recordSyncOutcome` stores `status: 'ok'` and NULLs `last_sync_error` (the advisory prefix says
 * to), and `sync_logs.records_skipped` reads 0 because `snapshotsSkipped` was reserved for legacy
 * projection cells. `1 author-day row(s)` and `40,000 author-day row(s)` produced the same green.
 *
 * These tests drive the REAL provider classes through the REAL sync pipeline over a stubbed
 * `fetch`, with TWO providers, for the same reason the #302 suite does: the property is partly
 * about what happens to the OTHER provider, which no unit test can see. The one-bad-row case that
 * must STAY an advisory is asserted here beside the systemic one, so a threshold that escalated
 * everything would fail as loudly as one that escalated nothing.
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
    LEGACY_CELLS_SKIPPED_PREFIX,
    PR_RECORDS_SKIPPED_PREFIX,
    SYSTEMIC_ROW_REFUSAL_PREFIX,
    SYSTEMIC_SKIP_MIN_ROWS,
    TOTAL_REFUSAL_ALERT_RUNS,
    getProviderRowRefusal,
    isAdvisoryError,
    isEscalatedRefusal,
    isSystemicRowRefusal,
    loadGitSyncHealth,
    rowRefusalStateKey,
    stallStateKey,
    syncStateKey,
} from '../../../src/connectors/git/sync';
import {deleteProviderWithCascade} from '../../../src/connectors/git/providers/delete-cascade';
import {createProvider} from '../../../src/connectors/git/providers/store';
import {loadServerKey} from '../../../src/connectors/git/providers/secret';
import {
    GITHUB_CONFIG,
    GITLAB_CONFIG,
    githubRoutes,
    gitlabRoutes,
    makeCountingFetch,
    type Route,
} from './providers/provider-fetch-fixtures';
import type {GitProviderConfig} from '../../../src/connectors/git/providers/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');

const AUTHOR_EMAIL = 'alice@example.com';
const NOW = '2024-01-20T00:00:00.000Z';

/** Six distinct UTC days inside the first-sync window, so six distinct author-day ROWS. */
const DAYS = ['2024-01-09', '2024-01-10', '2024-01-11', '2024-01-12', '2024-01-13', '2024-01-14'];

/** Strictly older than every entry in {@link DAYS} — the span a "sync older history" run walks. */
const OLDER_DAYS = ['2023-11-20', '2023-11-21'];

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function seedAlice(db: Database.Database): string {
    addTeam(db, 'eng');
    const dev = addDeveloper(db, 'alice', 'eng', AUTHOR_EMAIL, 'Alice');
    db.prepare(`UPDATE developers SET external_ids = '{"github":"alice-gh"}' WHERE id = ?`).run(dev.id);
    return dev.id;
}

/**
 * One day's commit, and whether the author-day row it builds is writable.
 *
 * `writable: false` uses the door #302 review cycle 2 opened: `toAnalysisCommit` fills
 * `authorLogin` as `username || email`, and `||` filters only FALSY — so a `{}` login survives
 * into the row's `author_login` column and the write boundary refuses it as `invalid_identity`.
 * The commit EMAIL is left intact, so the author still has a usable key and the row is really
 * built and then refused, rather than dropped earlier for having no identity at all.
 */
interface DayCommit {
    day: string;
    writable: boolean;
}

/**
 * GitHub commits, one per entry, each on its own UTC day.
 *
 * ONE builder over a MIX rather than a refused-routes builder and a healthy one, because the
 * routes are keyed by URL and `makeCountingFetch` takes the first match — so two builders
 * spread into one route list silently shadow each other and the second one's days never arrive.
 * The mixed run (some rows refused, some retained) is exactly what the streak-reset and
 * below-the-floor cases need, so the mix has to live inside a single commit list.
 *
 * One commit per day because the refused unit is the (author, day) ROW: N unwritable days is
 * exactly N refusals.
 */
function githubCommitRoutes(entries: readonly DayCommit[]): Route[] {
    const loginFor = (e: DayCommit): unknown => (e.writable ? 'alice-gh' : {});
    const commitFor = (e: DayCommit): Record<string, unknown> => ({
        author: {name: 'Alice', email: AUTHOR_EMAIL, date: `${e.day}T10:00:00.000Z`},
        message: 'feat: work',
    });
    const shaFor = (e: DayCommit): string => `sha-${e.day.replace(/-/g, '')}`;
    const byS = new Map(entries.map((e) => [shaFor(e), e]));
    return [
        {
            match: /\/repos\/test-org\/repo1\/commits\?/,
            body: entries.map((e) => ({
                sha: shaFor(e),
                commit: commitFor(e),
                author: {login: loginFor(e)},
            })),
        },
        {
            match: /\/repos\/test-org\/repo1\/commits\/[^?]+$/,
            bodyFor: (url: string): Record<string, unknown> => {
                const entry = byS.get(url.split('/').pop()!) ?? entries[0];
                return {
                    sha: shaFor(entry),
                    commit: commitFor(entry),
                    author: {login: loginFor(entry)},
                    stats: {additions: 40, deletions: 5, total: 45},
                    files: [{filename: 'src/foo.ts', additions: 30, deletions: 5, status: 'modified'}],
                };
            },
        },
        ...githubRoutes(),
    ];
}

/** Every day unwritable — the "provider writes nothing" shape. */
function githubAllRowsRefusedRoutes(days: readonly string[]): Route[] {
    return githubCommitRoutes(days.map((day) => ({day, writable: false})));
}

/** Every day writable — one retained author-day row per day. */
function githubHealthyCommitRoutes(days: readonly string[]): Route[] {
    return githubCommitRoutes(days.map((day) => ({day, writable: true})));
}

/** GitHub routes that list NO commits at all — the empty window a connector retry re-fetches. */
function githubEmptyRoutes(): Route[] {
    return [{match: /\/repos\/test-org\/repo1\/commits\?/, body: []}, ...githubRoutes()];
}

async function runSync(
    db: Database.Database,
    configs: GitProviderConfig[],
): Promise<Awaited<ReturnType<GitSync['syncProviders']>>> {
    const pending = new GitSync({enabled: false}).syncProviders(db, configs);
    await vi.runAllTimersAsync();
    return pending;
}

function systemicLineOf(errors: string[]): string | undefined {
    return errors.find((e) => e.startsWith(SYSTEMIC_ROW_REFUSAL_PREFIX));
}

function skipLineOf(errors: string[]): string | undefined {
    return errors.find((e) => e.startsWith(AUTHOR_DAYS_SKIPPED_PREFIX));
}

function rawRowCount(db: Database.Database, provider: string): number {
    return (
        db
            .prepare('SELECT COUNT(*) AS n FROM raw_author_daily WHERE provider = ?')
            .get(provider) as {n: number}
    ).n;
}

const GITHUB_CURSOR = syncStateKey('github', 'test-org');

describe('#306 a systemic row refusal does not report clean', () => {
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

    describe('every row of one provider refused', () => {
        it('escalates to a GENUINE error while the other provider commits normally', async () => {
            seedAlice(db);
            vi.stubGlobal(
                'fetch',
                makeCountingFetch([...githubAllRowsRefusedRoutes(DAYS), ...gitlabRoutes()]).fetchMock,
            );

            const result = await runSync(db, [GITHUB_CONFIG, GITLAB_CONFIG]);

            // The #302 guarantee is untouched: nothing rolled back, and the healthy provider's
            // whole window is committed.
            expect(result.errors.some((e) => /transaction rolled back/.test(e))).toBe(false);
            expect(rawRowCount(db, 'gitlab')).toBe(1);
            // GitHub wrote NOTHING, and its cursor advanced anyway — the state this issue is about.
            expect(rawRowCount(db, 'github')).toBe(0);
            expect(
                db.prepare('SELECT value FROM sync_state WHERE key = ?').get(GITHUB_CURSOR),
            ).toBeDefined();

            // THE ACCEPTANCE CRITERION: the run does not settle as `ok`. `isAdvisoryError` is the
            // single classifier `POST /api/admin/git/providers/:id/sync` splits on before choosing
            // `status: 'ok'` vs `'error'`, and `runConnectorWithRetry` reads the same function —
            // so asserting on it IS asserting on what those surfaces decide.
            const systemic = systemicLineOf(result.errors);
            expect(systemic).toBeDefined();
            expect(isAdvisoryError(systemic!)).toBe(false);
            expect(result.errors.some((e) => !isAdvisoryError(e))).toBe(true);
            expect(systemic).toContain('[github/test-org]');
            expect(systemic).toContain(`${DAYS.length} of ${DAYS.length} author-day row(s)`);

            // The advisory that carries the DETAIL is still emitted beside it — the escalation
            // replaces neither the codes nor the sample an operator acts on.
            expect(skipLineOf(result.errors)).toContain('refused as invalid_identity');
        });

        it('moves the numeric field an operator surface already reads', async () => {
            seedAlice(db);
            vi.stubGlobal(
                'fetch',
                makeCountingFetch([...githubAllRowsRefusedRoutes(DAYS), ...gitlabRoutes()]).fetchMock,
            );

            const result = await runSync(db, [GITHUB_CONFIG, GITLAB_CONFIG]);

            // `snapshotsSkipped` reaches `sync_logs.records_skipped` (sync-pipeline.ts) and the
            // "N written, M skipped" CLI summary. Before #306 it counted only legacy projection
            // cells, so it read 0 for a run that refused every row it built.
            expect(result.snapshotsSkipped).toBe(DAYS.length);
            expect(result.snapshotsWritten).toBeGreaterThan(0);
            // The legacy-cell advisory must NOT fire on that number. It reads its own counter
            // now, and the two diverged the moment refused rows joined the sum — point the
            // advisory back at `snapshotsSkipped` and this run invents six pre-upgrade cells
            // that do not exist.
            expect(result.errors.some((e) => e.startsWith(LEGACY_CELLS_SKIPPED_PREFIX))).toBe(false);
        });

        it('counts a refused pr_records row in the same field as a refused author-day row', async () => {
            seedAlice(db);
            // `created_at: null` is the shape a truncated page really produces: the day key it
            // yields is unusable (one refused author-day row) AND `pr_records.created_at` is
            // NOT NULL, so the PR record is refused too — one run, one of each grain. Drop
            // `+ skippedPRRecords.length` from the sum and only this assertion goes red.
            vi.stubGlobal(
                'fetch',
                makeCountingFetch([
                    {match: /\/repos\/test-org\/repo1\/pulls\/\d+\/comments/, body: []},
                    {match: /\/repos\/test-org\/repo1\/pulls\/\d+\/reviews/, body: []},
                    {
                        match: /\/repos\/test-org\/repo1\/pulls\?/,
                        body: [
                            {
                                number: 1,
                                title: 'feat: work',
                                user: {login: 'alice-gh'},
                                state: 'closed',
                                created_at: null,
                                merged_at: null,
                                closed_at: null,
                                updated_at: '2024-01-15T18:00:00.000Z',
                                requested_reviewers: [],
                            },
                        ],
                    },
                    ...githubRoutes(),
                ]).fetchMock,
            );

            const result = await runSync(db, [GITHUB_CONFIG]);

            expect(skipLineOf(result.errors)).toContain('1 author-day row(s)');
            expect(result.errors.some((e) => e.startsWith(PR_RECORDS_SKIPPED_PREFIX))).toBe(true);
            expect(result.snapshotsSkipped).toBe(2);
        });

        it('records a marker that outlives the run, and denies the provider "current"', async () => {
            seedAlice(db);
            vi.stubGlobal(
                'fetch',
                makeCountingFetch([...githubAllRowsRefusedRoutes(DAYS), ...gitlabRoutes()]).fetchMock,
            );

            await runSync(db, [GITHUB_CONFIG, GITLAB_CONFIG]);

            expect(getProviderRowRefusal(db, 'github', 'test-org')).toEqual({
                at: NOW,
                skipped: DAYS.length,
                retained: 0,
                runs: 1,
            });

            const health = loadGitSyncHealth(db, [GITHUB_CONFIG, GITLAB_CONFIG], NOW);
            expect(health.systemicRefusals.map((r) => r.identifier)).toEqual(['test-org']);
            // GitHub's cursor is at `now` and it has no stall streak, so a classification that
            // read the cursor alone would count BOTH providers current.
            expect(health.current).toBe(1);
            expect(health.stalled).toEqual([]);
        });
    });

    describe('mostly — not entirely — refused', () => {
        /**
         * Seven authors whose only PR carries an unusable `created_at`, over a window in which
         * one author's commits DO land: seven refused rows against one retained.
         *
         * The other end-to-end cases above refuse EVERY row, so they exercise only the
         * `retained === 0` arm — a rule written as "the provider wrote nothing" would satisfy
         * them all and still miss the shape a real systemic failure usually takes, where a
         * handful of rows survive. It is also a different refusal CODE (`invalid_date` off a PR
         * timestamp, not `invalid_identity` off a commit author), so the escalation is shown to
         * key on the count rather than on which door was used.
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
                        // An ISO 8601 expanded year — round-trips through `Date`, parses finite,
                        // and slices to a day no anchored check accepts.
                        created_at: '+033658-09-27T00:00:00.000Z',
                        merged_at: null,
                        closed_at: null,
                        updated_at: '2024-01-15T18:00:00.000Z',
                        requested_reviewers: [],
                    })),
                },
                ...githubRoutes(),
            ];
        }

        it('escalates 7 refused against 1 retained, and reports both numbers', async () => {
            seedAlice(db);
            vi.stubGlobal('fetch', makeCountingFetch(manyBadPRRoutes(7)).fetchMock);

            const result = await runSync(db, [GITHUB_CONFIG]);

            // Alice's commit day survived, so this is not the "wrote nothing" arm.
            expect(rawRowCount(db, 'github')).toBe(1);
            const systemic = systemicLineOf(result.errors);
            expect(systemic).toContain('7 of 8 author-day row(s)');
            expect(systemic).toContain('only 1 were written');
            expect(isAdvisoryError(systemic!)).toBe(false);
            expect(getProviderRowRefusal(db, 'github', 'test-org')).toMatchObject({skipped: 7, retained: 1});
        });
    });

    describe('the marker survives the retry the error itself provokes', () => {
        it('is NOT cleared by a later run that imported nothing', async () => {
            seedAlice(db);
            vi.stubGlobal(
                'fetch',
                makeCountingFetch([...githubAllRowsRefusedRoutes(DAYS), ...gitlabRoutes()]).fetchMock,
            );
            await runSync(db, [GITHUB_CONFIG, GITLAB_CONFIG]);
            expect(getProviderRowRefusal(db, 'github', 'test-org')).not.toBeNull();

            // Exactly what `runConnectorWithRetry` does after a non-advisory error: re-run the
            // connector. The first run's cursor advance already covered the window, so the retry
            // fetches an empty span, refuses nothing, and completes clean. "No refusals" is an
            // ABSENCE here, not evidence — clearing on it would hand the fail-open straight back.
            vi.unstubAllGlobals();
            vi.stubGlobal('fetch', makeCountingFetch([...githubEmptyRoutes(), ...gitlabRoutes()]).fetchMock);
            const retry = await runSync(db, [GITHUB_CONFIG, GITLAB_CONFIG]);

            expect(retry.errors.filter((e) => !isAdvisoryError(e))).toEqual([]);
            expect(getProviderRowRefusal(db, 'github', 'test-org')).not.toBeNull();
        });

        it('IS cleared by a later run that actually imported rows', async () => {
            seedAlice(db);
            vi.stubGlobal(
                'fetch',
                makeCountingFetch([...githubAllRowsRefusedRoutes(DAYS), ...gitlabRoutes()]).fetchMock,
            );
            await runSync(db, [GITHUB_CONFIG, GITLAB_CONFIG]);

            // The cause is fixed — the same days now carry a usable login.
            vi.unstubAllGlobals();
            vi.stubGlobal(
                'fetch',
                makeCountingFetch([...githubHealthyCommitRoutes(DAYS), ...gitlabRoutes()]).fetchMock,
            );
            const healed = await runSync(db, [GITHUB_CONFIG, GITLAB_CONFIG]);

            expect(systemicLineOf(healed.errors)).toBeUndefined();
            expect(getProviderRowRefusal(db, 'github', 'test-org')).toBeNull();
            expect(rawRowCount(db, 'github')).toBe(DAYS.length);
            expect(loadGitSyncHealth(db, [GITHUB_CONFIG, GITLAB_CONFIG], NOW).systemicRefusals).toEqual([]);
        });
    });

    describe('the incidental loss #302 was built for STAYS an advisory', () => {
        it('does not escalate a run whose single bad row is below the floor', async () => {
            seedAlice(db);
            // One refused day among a normal window: the refused count is at the write count
            // (1 and 1), so only the absolute floor keeps this on the advisory channel. A
            // ratio-only threshold would escalate exactly the case #302 exists to keep quiet.
            vi.stubGlobal(
                'fetch',
                makeCountingFetch([
                    ...githubCommitRoutes([
                        {day: DAYS[0], writable: false},
                        {day: DAYS[1], writable: true},
                    ]),
                    ...gitlabRoutes(),
                ]).fetchMock,
            );

            const result = await runSync(db, [GITHUB_CONFIG, GITLAB_CONFIG]);

            expect(skipLineOf(result.errors)).toContain('1 author-day row(s)');
            expect(systemicLineOf(result.errors)).toBeUndefined();
            // …and the run still settles green, which is the whole point of the advisory channel.
            expect(result.errors.filter((e) => !isAdvisoryError(e))).toEqual([]);
            // A record IS written — refusals are tracked from the first one, because the streak
            // arm needs the history — but it is not escalated, so no surface reports it.
            const refusal = getProviderRowRefusal(db, 'github', 'test-org')!;
            expect(refusal).toMatchObject({skipped: 1, retained: 1, runs: 0});
            expect(isEscalatedRefusal(refusal)).toBe(false);
            expect(loadGitSyncHealth(db, [GITHUB_CONFIG, GITLAB_CONFIG], NOW).systemicRefusals).toEqual([]);
            // The count still reaches the numeric field — reporting and escalating are separate.
            expect(result.snapshotsSkipped).toBe(1);
        });

        it('does not escalate one row below the floor even when NOTHING was written', async () => {
            seedAlice(db);
            // Ratio 1.0 — the worst possible — on a sample of one. The floor is what decides this,
            // and it is the boundary a "skipped >= retained" rule alone would get wrong.
            vi.stubGlobal('fetch', makeCountingFetch(githubAllRowsRefusedRoutes([DAYS[0]])).fetchMock);

            const result = await runSync(db, [GITHUB_CONFIG]);

            expect(rawRowCount(db, 'github')).toBe(0);
            expect(systemicLineOf(result.errors)).toBeUndefined();
        });
    });

    describe('a small window refused ENTIRELY, run after run', () => {
        /**
         * The hole the per-run floor cannot see, and the reason this arm exists.
         *
         * The scheduled sync is daily, so a steady-state window is one day; for a small org that
         * is a handful of author-day rows. A cause refusing every one of them loses 100% of that
         * provider's data every day forever while `skipped` never reaches SYSTEMIC_SKIP_MIN_ROWS
         * — verbatim the condition #306 says must not settle as ok, just at a smaller scale than
         * the tests above seed.
         */
        const ONE_DAY = [DAYS[0]];

        async function refuseEverything(): Promise<Awaited<ReturnType<GitSync['syncProviders']>>> {
            vi.unstubAllGlobals();
            vi.stubGlobal('fetch', makeCountingFetch(githubAllRowsRefusedRoutes(ONE_DAY)).fetchMock);
            return runSync(db, [GITHUB_CONFIG]);
        }

        it('stays quiet for the first runs, then escalates on the streak', async () => {
            seedAlice(db);

            for (let run = 1; run < TOTAL_REFUSAL_ALERT_RUNS; run++) {
                const early = await refuseEverything();
                // Below BOTH arms: one row is under the floor, and the streak has not run out.
                expect(systemicLineOf(early.errors)).toBeUndefined();
                expect(early.errors.filter((e) => !isAdvisoryError(e))).toEqual([]);
                expect(getProviderRowRefusal(db, 'github', 'test-org')).toMatchObject({runs: run});
            }

            const escalated = await refuseEverything();

            const systemic = systemicLineOf(escalated.errors);
            expect(systemic).toBeDefined();
            expect(isAdvisoryError(systemic!)).toBe(false);
            // The line names the arm that fired — 1 of 1 rows is not self-evidently an alert.
            expect(systemic).toContain(
                `written NOTHING for ${TOTAL_REFUSAL_ALERT_RUNS} consecutive runs`,
            );
            expect(rawRowCount(db, 'github')).toBe(0);
            expect(
                loadGitSyncHealth(db, [GITHUB_CONFIG], NOW).systemicRefusals.map((r) => r.runs),
            ).toEqual([TOTAL_REFUSAL_ALERT_RUNS]);
        });

        it('restarts the streak the moment a run retains anything', async () => {
            seedAlice(db);
            await refuseEverything();
            await refuseEverything();
            expect(getProviderRowRefusal(db, 'github', 'test-org')).toMatchObject({runs: 2});

            // A run that retains a row proves the cause is not total — even though it still
            // refuses one, so the record itself must stand.
            vi.unstubAllGlobals();
            vi.stubGlobal(
                'fetch',
                makeCountingFetch(
                    githubCommitRoutes([
                        {day: ONE_DAY[0], writable: false},
                        {day: DAYS[1], writable: true},
                    ]),
                ).fetchMock,
            );
            const mixed = await runSync(db, [GITHUB_CONFIG]);

            expect(rawRowCount(db, 'github')).toBe(1);
            expect(getProviderRowRefusal(db, 'github', 'test-org')).toMatchObject({runs: 0});
            expect(systemicLineOf(mixed.errors)).toBeUndefined();
        });
    });

    describe('a backfill neither raises nor clears the forward verdict', () => {
        it('does not clear the record when "sync older history" imports a healthy older span', async () => {
            seedAlice(db);
            vi.stubGlobal('fetch', makeCountingFetch(githubAllRowsRefusedRoutes(DAYS)).fetchMock);
            await runSync(db, [GITHUB_CONFIG]);
            expect(getProviderRowRefusal(db, 'github', 'test-org')).not.toBeNull();

            // "Sync older history" is the first thing an operator reaches for when told data is
            // missing, so a backfill clearing the record would be the COMMON path to a false
            // all-clear — and a healthy older span is no evidence at all about the forward
            // window this record is about, because a backfill never touches the forward cursor.
            vi.unstubAllGlobals();
            vi.stubGlobal('fetch', makeCountingFetch(githubHealthyCommitRoutes(OLDER_DAYS)).fetchMock);
            const backfill = new GitSync({enabled: false}).syncProviders(db, [GITHUB_CONFIG], undefined, {
                backfill: {since: `${OLDER_DAYS[0]}T00:00:00.000Z`, until: `${DAYS[0]}T00:00:00.000Z`},
            });
            await vi.runAllTimersAsync();
            await backfill;

            expect(rawRowCount(db, 'github')).toBe(OLDER_DAYS.length);
            expect(getProviderRowRefusal(db, 'github', 'test-org')).toMatchObject({
                skipped: DAYS.length,
                retained: 0,
            });
            expect(loadGitSyncHealth(db, [GITHUB_CONFIG], NOW).systemicRefusals).toHaveLength(1);
        });

        it('does not raise one either, when the backfill itself refuses everything', async () => {
            seedAlice(db);
            // A backfill walks a strictly older span and leaves the forward cursor untouched, so
            // its refusals say nothing about whether the forward sync is healthy. Counting them
            // would turn a provider syncing forward perfectly red.
            vi.stubGlobal('fetch', makeCountingFetch(githubAllRowsRefusedRoutes(OLDER_DAYS)).fetchMock);
            const backfill = new GitSync({enabled: false}).syncProviders(db, [GITHUB_CONFIG], undefined, {
                backfill: {since: `${OLDER_DAYS[0]}T00:00:00.000Z`, until: `${DAYS[0]}T00:00:00.000Z`},
            });
            await vi.runAllTimersAsync();
            const result = await backfill;

            expect(skipLineOf(result.errors)).toContain(`${OLDER_DAYS.length} author-day row(s)`);
            expect(systemicLineOf(result.errors)).toBeUndefined();
            expect(getProviderRowRefusal(db, 'github', 'test-org')).toBeNull();
        });
    });

    describe('a rolled-back run claims nothing and records nothing', () => {
        it('leaves no record, no error line and no skip count when the transaction aborts', async () => {
            seedAlice(db);
            vi.stubGlobal('fetch', makeCountingFetch(githubAllRowsRefusedRoutes(DAYS)).fetchMock);
            // Abort AFTER `cursorAdvances` has already written the refusal record and staged the
            // error line — `stallUpdates` runs last, so a throw there is the one window where
            // both have happened and the transaction still rolls back. Anything that aborts
            // earlier would make the assertions below trivially true. Same fixture, same reason,
            // as the #302 suite's permanence test. A COMPLETE run CLEARS the stall key, so the
            // row has to exist for the DELETE to match and the trigger to fire.
            db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
                stallStateKey('github', 'test-org'),
                JSON.stringify({runs: 1, since: '2024-01-01T00:00:00.000Z'}),
            );
            db.exec(`
                CREATE TRIGGER boom BEFORE DELETE ON sync_state
                WHEN old.key LIKE 'git_stall:%'
                BEGIN SELECT RAISE(ABORT, 'stall-clear boom'); END;
            `);

            const result = await runSync(db, [GITHUB_CONFIG]);

            // Positive control: the rollback really fired, so the assertions below are about a
            // discarded transaction rather than about a run that never got that far.
            expect(result.errors.some((e) => /transaction rolled back/.test(e))).toBe(true);
            // Nothing was recorded as covered, so nothing was lost — a durable record here would
            // fail doctor forever over a window the rollback left intact and re-fetchable.
            expect(systemicLineOf(result.errors)).toBeUndefined();
            expect(getProviderRowRefusal(db, 'github', 'test-org')).toBeNull();
            expect(
                db
                    .prepare('SELECT value FROM sync_state WHERE key = ?')
                    .get(rowRefusalStateKey('github', 'test-org')),
            ).toBeUndefined();
            expect(result.snapshotsSkipped).toBe(0);
            expect(skipLineOf(result.errors)).toBeUndefined();
            expect(result.errors.some((e) => e.startsWith(LEGACY_CELLS_SKIPPED_PREFIX))).toBe(false);
        });
    });

    describe('the provider delete cascade retracts the marker with the data', () => {
        it('leaves no verdict behind for a container a re-add would inherit', async () => {
            seedAlice(db);
            const key = loadServerKey({TOPROPE_SECRET_KEY: Buffer.alloc(32, 7).toString('base64')});
            const record = createProvider(db, key, {config: GITHUB_CONFIG, createdBy: null});
            vi.stubGlobal('fetch', makeCountingFetch(githubAllRowsRefusedRoutes(DAYS)).fetchMock);
            await runSync(db, [GITHUB_CONFIG]);
            expect(getProviderRowRefusal(db, 'github', 'test-org')).not.toBeNull();

            // No config-file entry owns this container, so the cascade actually runs.
            deleteProviderWithCascade(db, record.id, new Set<string>());

            // Read through the raw key as well as the decoder: the marker must be GONE, not
            // merely undecodable, or `doctor` would fail forever against a provider that no
            // longer exists and a re-added one would inherit the deleted provider's verdict.
            expect(
                db
                    .prepare('SELECT value FROM sync_state WHERE key = ?')
                    .get(rowRefusalStateKey('github', 'test-org')),
            ).toBeUndefined();
            expect(getProviderRowRefusal(db, 'github', 'test-org')).toBeNull();
        });
    });

    describe('isSystemicRowRefusal — the threshold itself', () => {
        it('needs BOTH the floor and the ratio, and each alone is not enough', () => {
            // Below the floor: any ratio, including the worst one.
            expect(isSystemicRowRefusal(SYSTEMIC_SKIP_MIN_ROWS - 1, 0)).toBe(false);
            expect(isSystemicRowRefusal(1, 1)).toBe(false);
            // At the floor with the refusals at the write count — "at or near", exactly.
            expect(isSystemicRowRefusal(SYSTEMIC_SKIP_MIN_ROWS, SYSTEMIC_SKIP_MIN_ROWS)).toBe(true);
            // Above the floor but a minority of the rows built: still incidental.
            expect(isSystemicRowRefusal(SYSTEMIC_SKIP_MIN_ROWS, SYSTEMIC_SKIP_MIN_ROWS + 1)).toBe(false);
            // The 100%-refused case the issue is named for.
            expect(isSystemicRowRefusal(40_000, 0)).toBe(true);
            // A run that refused nothing is never systemic, whatever it retained.
            expect(isSystemicRowRefusal(0, 0)).toBe(false);
            expect(isSystemicRowRefusal(0, 1_000)).toBe(false);
        });
    });
});
