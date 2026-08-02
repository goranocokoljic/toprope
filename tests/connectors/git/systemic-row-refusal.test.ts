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
    SYSTEMIC_ROW_REFUSAL_PREFIX,
    SYSTEMIC_SKIP_MIN_ROWS,
    getProviderRowRefusal,
    isAdvisoryError,
    isSystemicRowRefusal,
    loadGitSyncHealth,
    rowRefusalStateKey,
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
 * GitHub commits across `days.length` distinct days, every one carrying a non-string
 * `author.login`.
 *
 * The systemic shape, built from the door #302 review cycle 2 opened: `toAnalysisCommit` fills
 * `authorLogin` as `username || email`, and `||` filters only FALSY — so a `{}` login survives
 * into the row's `author_login` column and the write boundary refuses it as `invalid_identity`.
 * The commit EMAIL is left intact, so the author still has a usable key and the rows are really
 * built and then refused, rather than dropped earlier for having no identity at all.
 *
 * One commit per day (not one per repo or per author) because the refused unit is the
 * (author, day) ROW: N days is exactly N refusals, with nothing else on the provider to retain.
 */
function githubAllRowsRefusedRoutes(days: readonly string[], login: unknown = {}): Route[] {
    const commitFor = (day: string): Record<string, unknown> => ({
        author: {name: 'Alice', email: AUTHOR_EMAIL, date: `${day}T10:00:00.000Z`},
        message: 'feat: work',
    });
    const shaFor = (day: string): string => `sha-${day.replace(/-/g, '')}`;
    const byS = new Map(days.map((d) => [shaFor(d), d]));
    return [
        {
            match: /\/repos\/test-org\/repo1\/commits\?/,
            body: days.map((day) => ({sha: shaFor(day), commit: commitFor(day), author: {login}})),
        },
        {
            match: /\/repos\/test-org\/repo1\/commits\/[^?]+$/,
            bodyFor: (url: string): Record<string, unknown> => {
                const sha = url.split('/').pop()!;
                return {
                    sha,
                    commit: commitFor(byS.get(sha) ?? days[0]),
                    author: {login},
                    stats: {additions: 40, deletions: 5, total: 45},
                    files: [{filename: 'src/foo.ts', additions: 30, deletions: 5, status: 'modified'}],
                };
            },
        },
        ...githubRoutes(),
    ];
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
                makeCountingFetch([
                    ...githubAllRowsRefusedRoutes(DAYS, 'alice-gh'),
                    ...gitlabRoutes(),
                ]).fetchMock,
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
            // One refused day among a normal window: the row count is at the write count (1 and 1),
            // so only the absolute floor keeps this on the advisory channel. A ratio-only
            // threshold would escalate exactly the case #302 exists to keep quiet.
            vi.stubGlobal(
                'fetch',
                makeCountingFetch([
                    ...githubAllRowsRefusedRoutes([DAYS[0]]),
                    ...gitlabRoutes(),
                ]).fetchMock,
            );

            const result = await runSync(db, [GITHUB_CONFIG, GITLAB_CONFIG]);

            expect(skipLineOf(result.errors)).toContain('1 author-day row(s)');
            expect(systemicLineOf(result.errors)).toBeUndefined();
            // …and the run still settles green, which is the whole point of the advisory channel.
            expect(result.errors.filter((e) => !isAdvisoryError(e))).toEqual([]);
            expect(getProviderRowRefusal(db, 'github', 'test-org')).toBeNull();
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
