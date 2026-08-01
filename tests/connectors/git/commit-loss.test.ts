/**
 * #275 — a commit the provider LISTED but did not return must never be invisible.
 *
 * Two losses are possible in GitHub's per-commit loop, and they are OPPOSITES. These tests
 * pin that they are handled as opposites, end to end through the real `GitHubProvider` over a
 * stubbed `fetch` — the issue is about what the SYNC does with each one, so a provider-only
 * test cannot reach it:
 *
 *   1. A detail FETCH failure is recoverable. It propagates out of `getCommits`, so the run
 *      reports a genuine error, holds the provider's forward cursor and discards the whole
 *      provider's partial data — the window is re-covered next run (#231/#272).
 *   2. A commit with no author date anywhere is NOT recoverable: `raw_author_daily` is keyed
 *      by (raw identity, DATE), so there is no cell to write it to and re-covering the window
 *      returns the identical unusable response. It is reported as an ADVISORY and the cursor
 *      advances — holding it would brick the provider forever without saving the commit.
 *
 * Before #275 case 2 produced NOTHING: no `errors[]` entry, no sync-log trace, and a cursor
 * already advanced past a permanent hole in `git_snapshots`.
 *
 * Fake timers throughout — the failure paths take real 5/15-minute in-run pauses.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper} from '../../../src/registry/developers';
import {
    GitSync,
    COMMITS_DROPPED_PREFIX,
    COMMIT_CHURN_UNKNOWN_PREFIX,
    RETRY_HEALED_PREFIX,
    LEGACY_CELLS_SKIPPED_PREFIX,
    PROVIDER_DELETED_MID_RUN_PREFIX,
    isAdvisoryError,
    isPermanentLossAdvisory,
    isSelfHealedAdvisory,
    rankAdvisories,
    stallStateKey,
    syncStateKey,
} from '../../../src/connectors/git/sync';
import {
    NO_AUTHOR_DATE_DROP_REASON,
    UNATTRIBUTABLE_DATE_DROP_REASON,
} from '../../../src/connectors/git/providers/types';
import {MAX_SERVER_ERROR_RETRIES} from '../../../src/connectors/git/providers/http-retry';
import {
    MAX_STORED_COLUMN_CHARS,
    createProvider,
    getProvider,
    recordSyncOutcome,
    toPublicProvider,
} from '../../../src/connectors/git/providers/store';
import {loadServerKey} from '../../../src/connectors/git/providers/secret';
import type {GitProviderConfig} from '../../../src/connectors/git/providers/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');

const CONFIG: GitProviderConfig = {
    type: 'github',
    org: 'test-org',
    auth: {type: 'token', api_token: 'ghp_test'},
};
const FORWARD_KEY = syncStateKey('github', 'test-org');
const DAY = '2024-01-15';

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function seedAlice(db: Database.Database): void {
    addTeam(db, 'eng');
    const dev = addDeveloper(db, 'alice', 'eng', 'alice@example.com', 'Alice');
    db.prepare(`UPDATE developers SET external_ids = '{"github":"alice"}' WHERE id = ?`).run(dev.id);
}

// --- Raw GitHub response fixtures ---

/** The embedded `commit` object GitHub returns identically on the list and the detail. */
const EMBEDDED = {
    author: {name: 'Alice', email: 'alice@example.com', date: `${DAY}T10:00:00Z`},
    message: 'feat: add feature',
};

/** An embedded object carrying no author date at all. */
const NO_DATE_EMBEDDED = {author: null, message: 'unattributable'};

/**
 * An embedded object whose date is PRESENT but unattributable — an ISO 8601 expanded year.
 * It round-trips through `Date`, so only an anchored shape check rejects it; left unchecked it
 * reaches `raw_author_daily`'s `UTC_DAY_RE` and throws inside the run's write transaction.
 */
const BAD_DATE_EMBEDDED = {
    author: {name: 'Alice', email: 'alice@example.com', date: '+033658-09-27T00:00:00.000Z'},
    message: 'far future',
};

function listRow(sha: string, commit: unknown = EMBEDDED): Record<string, unknown> {
    return {sha, commit, author: {login: 'alice'}};
}

function detailBody(sha: string, commit: unknown = EMBEDDED): Record<string, unknown> {
    return {
        ...listRow(sha, commit),
        // Deliberately SKEWED from `stats`: GitHub caps `files` at 300 per commit while
        // `stats` covers the whole commit, so churn must be read from `stats` and never summed
        // from the file list. With the two agreeing, a regression that summed `files` passed
        // every assertion in this file (#288 review cycle 1, TST-7).
        stats: {additions: 40, deletions: 10, total: 50},
        files: [{filename: 'src/foo.ts', additions: 30, deletions: 5, status: 'modified'}],
    };
}

type Route = {status?: number; body?: unknown};

function respond({status = 200, body = []}: Route): Response {
    return {
        ok: status < 400,
        status,
        headers: new Headers(),
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    } as unknown as Response;
}

/**
 * Stubs `fetch` for one org, routing by URL.
 *
 * - `rows` is the commit LIST response every repo serves by default.
 * - `details` maps sha → that commit's detail response. A thunk instead of a value lets a test
 *   make one commit fail on the first attempt and succeed on the next.
 * - `repos` is the org's repo list; more than one is how a test reaches "repo A dropped, repo B
 *   failed" (the interaction that decides whether a permanence claim is honest).
 * - `listRoutes` overrides a specific repo's commit-LIST response, e.g. to fail it outright.
 */
function stubGitHub(
    rows: Array<Record<string, unknown>>,
    details: Record<string, Route | (() => Route)>,
    repos: string[] = ['repo1'],
    listRoutes: Record<string, Route> = {},
): void {
    vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string) => {
            if (url.includes('/orgs/test-org/repos')) {
                return Promise.resolve(
                    respond({
                        body: repos.map((name, i) => ({
                            id: i + 1,
                            name,
                            full_name: `test-org/${name}`,
                            default_branch: 'main',
                            archived: false,
                        })),
                    }),
                );
            }
            const detailMatch = url.match(/\/commits\/([^/?]+)$/);
            if (detailMatch) {
                const route = details[detailMatch[1]];
                // A non-retryable 4xx rather than a throw: a thrown transport fault would be
                // classified retryable and consumed by the 5xx + repo-retry budgets, surfacing
                // minutes later as a generic "Failed to fetch commits" instead of this message.
                if (!route) {
                    return Promise.resolve({
                        ok: false,
                        status: 418,
                        headers: new Headers(),
                        text: () => Promise.resolve(`test harness: unexpected detail request ${url}`),
                    } as unknown as Response);
                }
                return Promise.resolve(respond(typeof route === 'function' ? route() : route));
            }
            const listMatch = url.match(/\/repos\/test-org\/([^/]+)\/commits\?/);
            if (listMatch) {
                return Promise.resolve(respond(listRoutes[listMatch[1]] ?? {body: rows}));
            }
            // PRs, review comments, verdicts — empty; this suite is about commits.
            return Promise.resolve(respond({body: []}));
        }),
    );
}

async function runSync(
    db: Database.Database,
): Promise<Awaited<ReturnType<GitSync['syncProviders']>>> {
    const pending = new GitSync({enabled: false}).syncProviders(db, [CONFIG]);
    await vi.runAllTimersAsync();
    return pending;
}

function readState(db: Database.Database, key: string): string | undefined {
    return (db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
        | {value: string}
        | undefined)?.value;
}

function dayCommits(db: Database.Database): number | undefined {
    return (db.prepare('SELECT commits FROM git_snapshots WHERE date = ?').get(DAY) as
        | {commits: number}
        | undefined)?.commits;
}

function dropLineOf(errors: string[]): string | undefined {
    return errors.find((e) => e.startsWith(COMMITS_DROPPED_PREFIX));
}

function churnLineOf(errors: string[]): string | undefined {
    return errors.find((e) => e.startsWith(COMMIT_CHURN_UNKNOWN_PREFIX));
}

/**
 * A detail body with a usable `commit` object but NO `stats`/`files` keys (#288).
 *
 * It is literally the commit-LIST row, and that is the empirical point the whole issue rests
 * on rather than a shortcut: GitHub returns the identical embedded `commit` object on both
 * endpoints and adds only `stats`/`files` on the detail, so a list row IS a well-formed detail
 * body minus exactly the two keys in question. Nothing about this fixture is contrived.
 */
function statlessDetail(sha: string): Record<string, unknown> {
    return listRow(sha);
}

function dayLines(
    db: Database.Database,
): {added: number; removed: number; files: number} | undefined {
    return db
        .prepare(
            'SELECT lines_added AS added, lines_removed AS removed, files_changed AS files ' +
                'FROM git_snapshots WHERE date = ?',
        )
        .get(DAY) as {added: number; removed: number; files: number} | undefined;
}

function memoCount(db: Database.Database): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM commit_diffstats').get() as {n: number}).n;
}

describe('unreturned commits are never silent (#275)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        vi.useFakeTimers();
    });

    afterEach(() => {
        db.close();
        vi.useRealTimers();
        vi.restoreAllMocks();
        // `restoreAllMocks` does not undo `stubGlobal`, so without this a future test that
        // forgets to stub would silently inherit the previous test's routes instead of failing.
        vi.unstubAllGlobals();
    });

    describe('a per-commit detail FETCH failure (recoverable)', () => {
        it('reports an error and holds the forward cursor, discarding the partial window', async () => {
            // AC 1 + 2. Three listed commits; the middle one's detail 404s. A sha GitHub's own
            // commit list just returned is not legitimately absent, so this is an anomaly rather
            // than an answer — and a 404 is non-retryable, so it reaches the run's outcome
            // directly instead of burning the retry budget.
            seedAlice(db);
            stubGitHub([listRow('aaa111'), listRow('bbb222'), listRow('ccc333')], {
                aaa111: {body: detailBody('aaa111')},
                bbb222: {status: 404, body: 'not found'},
                ccc333: {body: detailBody('ccc333')},
            });

            const result = await runSync(db);

            // 1. The loss is in errors[] as a GENUINE failure — the pipeline must retry it.
            const failures = result.errors.filter((e) => !isAdvisoryError(e));
            expect(failures).toContainEqual(
                expect.stringContaining('[github/repo1] Failed to fetch commits'),
            );
            expect(failures.some((e) => e.includes('404'))).toBe(true);
            // 2. The forward cursor is HELD, so the next run re-covers the whole window.
            expect(readState(db, FORWARD_KEY)).toBeUndefined();
            // The surviving commits are deliberately NOT persisted here, and that is the #231
            // rule rather than an oversight: commit counts are ADDED across runs, so writing
            // aaa111 now and re-covering the same window next run would double-count it
            // permanently. Discarding the partial window is the only gap-free option — which is
            // precisely why the OTHER loss (below), where no re-cover can ever happen, must not
            // be routed through this path.
            expect(dayCommits(db)).toBeUndefined();
            expect(result.snapshotsWritten).toBe(0);
        });

        it('does not report a drop advisory for a fault the cursor hold already covers', async () => {
            // The two channels are disjoint. A fetch fault must not ALSO be announced as a
            // permanent loss: the window is about to be re-covered, so "PERMANENTLY absent"
            // would be false, and an operator who read it would stop looking.
            seedAlice(db);
            stubGitHub([listRow('aaa111')], {aaa111: {status: 404, body: 'not found'}});

            const result = await runSync(db);

            expect(dropLineOf(result.errors)).toBeUndefined();
        });
    });

    describe('a commit with no author date anywhere (unrecoverable)', () => {
        it('names it in errors[], advances the cursor, and still writes the survivors', async () => {
            // AC 1 + 3, and the deliberate divergence from the case above: no retry can invent
            // an author date, so the run reports the loss and moves on rather than stalling the
            // provider forever over a commit it can never import.
            //
            // bbb222 is dateless on BOTH copies of the embedded object — the list row too,
            // otherwise the list-row fallback recovers it and there is no loss to report.
            seedAlice(db);
            stubGitHub(
                [listRow('aaa111'), listRow('bbb222', NO_DATE_EMBEDDED), listRow('ccc333')],
                {
                    aaa111: {body: detailBody('aaa111')},
                    bbb222: {body: detailBody('bbb222', NO_DATE_EMBEDDED)},
                    ccc333: {body: detailBody('ccc333')},
                },
            );

            const result = await runSync(db);

            // 1. The loss is named, with the sha and the reason the code actually emits.
            const dropLine = dropLineOf(result.errors);
            expect(dropLine).toBeDefined();
            expect(dropLine).toContain('[github/repo1]');
            expect(dropLine).toContain('bbb222');
            expect(dropLine).toContain('1 commit(s)');
            expect(dropLine).toContain(NO_AUTHOR_DATE_DROP_REASON);
            // It must NOT name a commit that imported fine — a line listing every sha in the
            // repo is a line an operator cannot act on.
            expect(dropLine).not.toContain('aaa111');
            // 2. The cursor ADVANCES: the window is as covered as it will ever be.
            expect(readState(db, FORWARD_KEY)).toBe(result.lastSyncTime);
            // 3. The two survivors are written — the loss is one commit, not the run.
            expect(dayCommits(db)).toBe(2);
        });

        it('classifies the drop as an advisory, so the pipeline stops re-fetching forever', async () => {
            // A dateless commit recurs identically on every run. Classified as a failure it
            // would make sync-pipeline re-run the ENTIRE git connector — a second full network
            // fetch — every night, forever, and still never recover the commit.
            seedAlice(db);
            stubGitHub([listRow('aaa111', NO_DATE_EMBEDDED)], {
                aaa111: {body: detailBody('aaa111', NO_DATE_EMBEDDED)},
            });

            const result = await runSync(db);

            // Positive control: the advisory IS present, so the assertion below is about its
            // classification and not about an empty list.
            const dropLine = dropLineOf(result.errors);
            expect(dropLine).toBeDefined();
            expect(isAdvisoryError(dropLine!)).toBe(true);
            // …and the run as a whole reports no genuine failure.
            expect(result.errors.filter((e) => !isAdvisoryError(e))).toEqual([]);
            // A repo whose EVERY commit is dropped still covered its window as well as it ever
            // will, so the cursor advances rather than being held like an un-covered one — and
            // nothing is written, because nothing was attributable (#275 review TST-3).
            expect(readState(db, FORWARD_KEY)).toBe(result.lastSyncTime);
            expect(dayCommits(db)).toBeUndefined();
        });

        it('caps the named shas per reason group and counts the remainder', async () => {
            // The aggregation half of the advisory (#275 review cycle 1, TST-2). With one drop
            // per test, `slice(0, DROPPED_COMMIT_SAMPLE_SIZE)` was indistinguishable from
            // `slice(0, 1)` and the `(+N more)` branch never ran. Seven drops of ONE class, so
            // the per-group cap actually bites.
            seedAlice(db);
            // >= 4 hex chars, like a real (abbreviated) git object name — `sanitizeSha` renders
            // anything that is not a plausible object name as invalid rather than pasting it.
            const shas = ['da01', 'da02', 'da03', 'da04', 'da05', 'da06', 'da07'];
            stubGitHub(
                shas.map((s) => listRow(s, NO_DATE_EMBEDDED)),
                Object.fromEntries(shas.map((s) => [s, {body: detailBody(s, NO_DATE_EMBEDDED)}])),
            );

            const result = await runSync(db);

            const dropLine = dropLineOf(result.errors);
            expect(dropLine).toBeDefined();
            // ONE line for the repo, not one per commit — the point of aggregating.
            expect(result.errors.filter((e) => e.startsWith(COMMITS_DROPPED_PREFIX))).toHaveLength(1);
            expect(dropLine).toContain('7 commit(s)');
            // Exactly the first five are named…
            for (const named of ['da01', 'da02', 'da03', 'da04', 'da05']) {
                expect(dropLine).toContain(named);
            }
            // …and the rest are counted, not listed.
            expect(dropLine).not.toContain('da06');
            expect(dropLine).not.toContain('da07');
            expect(dropLine).toContain('(+2 more)');
            // The reason is stated ONCE for the group, not repeated per commit.
            expect(dropLine!.split(NO_AUTHOR_DATE_DROP_REASON)).toHaveLength(2);
        });

        it('groups shas UNDER their reason so each carries an actionable next step', async () => {
            // The two reasons exist only because the operator's next step differs (#275 review
            // cycle 3, SO-4). Listing every sha beside a merged reason set said nothing about
            // which step applied to which sha, so shas are grouped by reason.
            //
            // Asserted against LITERALS as well as the imported constants (review cycle 2,
            // TST-2/SEC-7): comparing a reason only to the constant the code emits cannot fail
            // if the two sentences are swapped — and a swap sends an operator with a truncated
            // response to inspect a commit whose timestamp is fine.
            seedAlice(db);
            const shas = ['dead01', 'dead02', 'beef01'];
            const embeddedFor = (s: string): unknown =>
                s.startsWith('dead') ? NO_DATE_EMBEDDED : BAD_DATE_EMBEDDED;
            stubGitHub(
                shas.map((s) => listRow(s, embeddedFor(s))),
                Object.fromEntries(shas.map((s) => [s, {body: detailBody(s, embeddedFor(s))}])),
            );

            const result = await runSync(db);

            const dropLine = dropLineOf(result.errors);
            expect(dropLine).toBeDefined();
            expect(dropLine).toContain('3 commit(s)');
            // Each group states its own count, its own reason and its own shas — so a reader can
            // tell which two commits need the transport checked and which one needs the commit
            // itself inspected.
            expect(dropLine).toContain(`2 because ${NO_AUTHOR_DATE_DROP_REASON}`);
            expect(dropLine).toContain(`1 because ${UNATTRIBUTABLE_DATE_DROP_REASON}`);
            expect(dropLine).toContain('no author date on either');
            expect(dropLine).toContain('the author date is present but');
            // The dateless shas sit inside the dateless group, not the other one.
            const datelessAt = dropLine!.indexOf(NO_AUTHOR_DATE_DROP_REASON);
            const unattributableAt = dropLine!.indexOf(UNATTRIBUTABLE_DATE_DROP_REASON);
            expect(dropLine!.indexOf('dead01')).toBeGreaterThan(datelessAt);
            expect(dropLine!.indexOf('dead01')).toBeLessThan(unattributableAt);
            expect(dropLine!.indexOf('beef01')).toBeGreaterThan(unattributableAt);
        });

        it('reports each affected repo separately, with its own shas', async () => {
            // The per-repo loop had only ever run once (#275 review cycle 2, TST-5): emitting
            // just the first entry passed the whole suite, so a provider where two repos both
            // dropped would have reported one repo's loss and silently swallowed the other's —
            // the same invisible partial loss #275 exists to close.
            seedAlice(db);
            stubGitHub(
                // Default rows are unused; each repo gets its own list below.
                [],
                {
                    aa01: {body: detailBody('aa01', NO_DATE_EMBEDDED)},
                    aa02: {body: detailBody('aa02')},
                    bb01: {body: detailBody('bb01', NO_DATE_EMBEDDED)},
                },
                ['repo1', 'repo2'],
                {
                    repo1: {body: [listRow('aa01', NO_DATE_EMBEDDED), listRow('aa02')]},
                    repo2: {body: [listRow('bb01', NO_DATE_EMBEDDED)]},
                },
            );

            const result = await runSync(db);

            const lines = result.errors.filter((e) => e.startsWith(COMMITS_DROPPED_PREFIX));
            expect(lines).toHaveLength(2);
            const forRepo1 = lines.find((l) => l.includes('[github/repo1]'));
            const forRepo2 = lines.find((l) => l.includes('[github/repo2]'));
            expect(forRepo1).toBeDefined();
            expect(forRepo2).toBeDefined();
            // Each line names ONLY its own repo's dropped sha — a shared accumulator would
            // leak repo1's shas into repo2's line.
            expect(forRepo1).toContain('aa01');
            expect(forRepo1).not.toContain('bb01');
            expect(forRepo2).toContain('bb01');
            expect(forRepo2).not.toContain('aa01');
            // repo1's healthy commit still landed.
            expect(dayCommits(db)).toBe(1);
        });

        it('renders a non-hex sha as invalid instead of interpolating it into the log line', async () => {
            // The sha is raw response JSON and this line reaches a terminal and `sync_logs`
            // (#275 review cycle 2, SEC-10). A value that is not a git object name must not be
            // pasted through — but it must still be REPORTED, because "GitHub returned a
            // malformed sha" is itself something the operator needs to see.
            seedAlice(db);
            const nasty = 'aaa[31mBOOM\nnot-a-sha';
            stubGitHub([listRow(nasty, NO_DATE_EMBEDDED)], {
                [nasty]: {body: detailBody(nasty, NO_DATE_EMBEDDED)},
            });

            const result = await runSync(db);

            const dropLine = dropLineOf(result.errors);
            expect(dropLine).toBeDefined();
            expect(dropLine).toContain('1 commit(s)');
            expect(dropLine).toContain('<invalid sha>');
            expect(dropLine).not.toContain('BOOM');
            expect(dropLine).not.toContain('[31m');
            // A newline would break the one-line-per-finding shape the sync log and CLI assume.
            expect(dropLine!.split('\n')).toHaveLength(1);
        });

        it('rejects an over-long hex sha rather than truncating it into a plausible one', async () => {
            // #275 review cycle 3, SO-8/TST-6. Truncating a 64-char hex blob to 40 would
            // manufacture a well-formed-looking sha that resolves to nothing, sending the
            // operator to look up a commit that never existed. The bound lives in the allowlist,
            // so an implausible object name is NAMED as invalid instead.
            seedAlice(db);
            const tooLong = 'a'.repeat(64);
            stubGitHub([listRow(tooLong, NO_DATE_EMBEDDED)], {
                [tooLong]: {body: detailBody(tooLong, NO_DATE_EMBEDDED)},
            });

            const result = await runSync(db);

            const dropLine = dropLineOf(result.errors);
            expect(dropLine).toBeDefined();
            expect(dropLine).toContain('1 commit(s)');
            expect(dropLine).toContain('<invalid sha>');
            // Neither the whole blob nor a 40-char prefix of it appears.
            expect(dropLine).not.toContain('a'.repeat(41));
            expect(dropLine).not.toContain('a'.repeat(40));
        });

        it('survives a non-string sha instead of throwing away the whole provider', async () => {
            // `sha` is an unchecked cast over untrusted body JSON, and `RegExp.test` COERCES — so
            // a numeric sha used to reach `.slice` and raise a TypeError from a line that runs
            // AFTER the provider's entire network walk, discarding its window on every run
            // (#275 review cycle 3, SEC-3). It must degrade to one named-invalid drop.
            seedAlice(db);
            stubGitHub([{sha: 12345, commit: NO_DATE_EMBEDDED, author: {login: 'alice'}}], {
                '12345': {body: {sha: 12345, commit: NO_DATE_EMBEDDED, author: {login: 'alice'}}},
            });

            const result = await runSync(db);

            // The provider was NOT skipped wholesale…
            expect(result.errors.some((e) => /could not be used/.test(e))).toBe(false);
            // …the loss is reported with the sha named as invalid…
            const dropLine = dropLineOf(result.errors);
            expect(dropLine).toBeDefined();
            expect(dropLine).toContain('<invalid sha>');
            // …and the run still completed, advancing the cursor.
            expect(readState(db, FORWARD_KEY)).toBe(result.lastSyncTime);
        });

        it('does NOT claim the window was recorded when the rollback fires AFTER the cursor advance', async () => {
            // The sharp version of the rollback case (#275 review cycle 3, TST-3). The other
            // rollback test below fails at `projectSnapshots`, which is BEFORE the
            // `cursorAdvances` loop — so it never reaches the staging site and passes for a
            // reason that is not the mechanism. `stallUpdates` runs AFTER the advances, so a
            // throw there is the one window where the advisory has already been staged and the
            // transaction still rolls back. Push to `errors` at the staging site instead of
            // staging, and only this test fails.
            seedAlice(db);
            stubGitHub([listRow('aaaa11', NO_DATE_EMBEDDED), listRow('bbbb22')], {
                aaaa11: {body: detailBody('aaaa11', NO_DATE_EMBEDDED)},
                bbbb22: {body: detailBody('bbbb22')},
            });
            // A complete run clears the provider's stall key in `stallUpdates`; seed that exact
            // key so the DELETE matches a row, then make the delete abort.
            db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
                stallStateKey('github', 'test-org'),
                JSON.stringify({runs: 1, since: '2024-01-01T00:00:00.000Z'}),
            );
            db.exec(`
                CREATE TRIGGER boom BEFORE DELETE ON sync_state
                WHEN old.key LIKE 'git_stall:%'
                BEGIN SELECT RAISE(ABORT, 'stall-clear boom'); END;
            `);

            const result = await runSync(db);

            // Positive controls: the run rolled back, and the cursor the advisory's claim rests
            // on did not persist…
            expect(result.errors.some((e) => /transaction rolled back/.test(e))).toBe(true);
            expect(readState(db, FORWARD_KEY)).toBeUndefined();
            // …so no permanence claim survived, even though the staging site DID execute.
            expect(dropLineOf(result.errors)).toBeUndefined();
        });

        it('does NOT claim the window was recorded when the write transaction rolls back', async () => {
            // The third discard path (#275 review cycle 2, SO-4/SEC-11/TST-1). The advisory is
            // staged inside the write transaction and pushed only after it commits, so a
            // rollback — which advances no cursor, leaving the window to be re-covered — must
            // produce no permanence claim. Deleting the `droppedAdvisories.length = 0` /
            // deferred-push pair leaves every other test in this file green.
            seedAlice(db);
            stubGitHub([listRow('aaa111', NO_DATE_EMBEDDED), listRow('bbb222')], {
                aaa111: {body: detailBody('aaa111', NO_DATE_EMBEDDED)},
                bbb222: {body: detailBody('bbb222')},
            });
            // Force the projection write to throw, the pattern used elsewhere in this suite.
            db.exec('DROP TABLE git_snapshots');

            const result = await runSync(db);

            // Positive control: the run really did roll back…
            expect(result.errors.some((e) => /transaction rolled back/.test(e))).toBe(true);
            // …and no drop line survived it.
            expect(dropLineOf(result.errors)).toBeUndefined();
        });

        it('does NOT claim the window was recorded when a later repo fails and it is discarded', async () => {
            // #275 review SEC-6. "The cursor has advanced past them" is only true of a run whose
            // data was kept. repo1 drops a commit, then repo2's commit fetch fails → #231
            // discards the WHOLE provider's window and holds the cursor, so repo1's dropped
            // commit is re-asked next run like everything else. Reporting it as permanent would
            // send the operator chasing a loss that has not happened.
            seedAlice(db);
            stubGitHub([listRow('aaa111', NO_DATE_EMBEDDED), listRow('bbb222')], {
                aaa111: {body: detailBody('aaa111', NO_DATE_EMBEDDED)},
                bbb222: {body: detailBody('bbb222')},
            }, ['repo1', 'repo2'], {repo2: {status: 404, body: 'not found'}});

            const result = await runSync(db);

            // The genuine failure IS reported (positive control — the run really did fail)…
            expect(result.errors.some((e) => /Failed to fetch commits/.test(e))).toBe(true);
            // …the cursor is held…
            expect(readState(db, FORWARD_KEY)).toBeUndefined();
            // …and no permanence claim was made over a window that will be re-covered.
            expect(dropLineOf(result.errors)).toBeUndefined();
        });

        it('counts each dropped commit ONCE even when an in-run retry re-pages the window', async () => {
            // The drop list is reset at the top of every attempt, for the same reason the commit
            // result is ASSIGNED rather than appended (#272): a retry re-pages the same window
            // and re-reports the same drops. Reset per repo instead of per attempt and this run
            // reports "2 commit(s)" for one dropped commit — an operator chasing a second commit
            // that does not exist.
            seedAlice(db);
            let serverErrors = 0;
            stubGitHub([listRow('aaa111', NO_DATE_EMBEDDED), listRow('bbb222')], {
                aaa111: {body: detailBody('aaa111', NO_DATE_EMBEDDED)},
                // 503s until the request layer's own budget is spent, so attempt 1 throws out of
                // getCommits AFTER aaa111 was already dropped; attempt 2 then succeeds.
                bbb222: () => {
                    if (serverErrors++ <= MAX_SERVER_ERROR_RETRIES) {
                        return {status: 503, body: 'unavailable'};
                    }
                    return {body: detailBody('bbb222')};
                },
            });

            const result = await runSync(db);

            // The retry healed, so the run is green and the second attempt's data landed…
            expect(result.errors).toContainEqual(expect.stringContaining(RETRY_HEALED_PREFIX));
            expect(readState(db, FORWARD_KEY)).toBe(result.lastSyncTime);
            expect(dayCommits(db)).toBe(1);
            // …and the commit both attempts dropped is reported exactly once, by exactly one line.
            expect(result.errors.filter((e) => e.startsWith(COMMITS_DROPPED_PREFIX))).toHaveLength(1);
            expect(dropLineOf(result.errors)).toContain('1 commit(s)');
        });

        it('does not report a drop at all for a healthy repo', async () => {
            // The negative control for every assertion above: without it, a bug that pushed the
            // advisory unconditionally would satisfy all of them.
            seedAlice(db);
            stubGitHub([listRow('aaa111')], {aaa111: {body: detailBody('aaa111')}});

            const result = await runSync(db);

            expect(dropLineOf(result.errors)).toBeUndefined();
            expect(dayCommits(db)).toBe(1);
        });
    });

    /**
     * #288 — the THIRD outcome, which is neither of the two above: the commit is returned and
     * imported, but its churn was never observed because the detail response carried no
     * `stats`. GitHub's published schema permits that body, so it cannot be a throw (a throw
     * holds the cursor forever on a shape every re-fetch reproduces) and it is not a drop (the
     * commit lands). What it must not be is what it was before #288 — a memoized, silent zero.
     */
    describe('a commit whose churn was never observed (#288)', () => {
        it('imports the commit, names the loss, and advances the cursor', async () => {
            seedAlice(db);
            stubGitHub([listRow('aaa111'), listRow('bbb222')], {
                // aaa111's detail has a usable commit object and no `stats`.
                aaa111: {body: statlessDetail('aaa111')},
                bbb222: {body: detailBody('bbb222')},
            });

            const result = await runSync(db);

            // 1. BOTH commits import — this is not a drop, so the commit count is the full 2.
            expect(dayCommits(db)).toBe(2);
            // 2. …but only bbb222's churn is in the totals. `added: 40` also pins that churn
            // came from `stats` and not from summing `files` (the fixture skews the two).
            // `files: 1` is the point of SO-2/SEC-2: a stats-less detail carries no file list
            // either, so files_changed is short too — the advisory must not call it unaffected.
            expect(dayLines(db)).toEqual({added: 40, removed: 10, files: 1});
            // 3. The loss is named, with the sha, the count and what actually happened.
            const churnLine = churnLineOf(result.errors);
            expect(churnLine).toBeDefined();
            expect(churnLine).toContain('[github/repo1]');
            expect(churnLine).toContain('aaa111');
            expect(churnLine).toContain('1 commit(s)');
            expect(churnLine).toContain('the provider never observed them');
            // The advisory must NOT reassure about metrics this same shape understates — the
            // operator sizes a destructive repair against this sentence (#288 review SO-2/SEC-2).
            // ai_signature_score is UNCONDITIONAL (three of its five signals gate on the line
            // counts), so it must not sit in the file-list-conditional clause; files_changed and
            // code_churn_rate must (#288 review cycle 2, SO-2).
            expect(churnLine).toContain('avg_commit_size and ai_signature_score');
            expect(churnLine).toContain('files_changed and code_churn_rate are understated too');
            expect(churnLine).not.toMatch(/files_changed[^.]*(are|is) unaffected/);
            // The REMEDY half, which is the part that stops an operator doing something
            // strictly worse than the damage. Deleting `permanentSpanRepair()` from this line
            // left the whole suite green (#288 review cycle 2, TST-2).
            expect(churnLine).toContain('do NOT simply purge');
            expect(churnLine).toContain('delete cascade');
            expect(churnLine).toContain('sync older history');
            expect(churnLine).toContain('CONFIG-FILE provider cannot be deleted');
            // A healthy commit is not named — an operator cannot act on a line listing the repo.
            expect(churnLine).not.toContain('bbb222');
            // 4. The cursor advances: re-fetching returns the identical body.
            expect(readState(db, FORWARD_KEY)).toBe(result.lastSyncTime);
        });

        it('memoizes the observed commit and NOT the unobserved one', async () => {
            // The acceptance criterion in its most direct form: `commit_diffstats` has no
            // invalidation, so a row written for aaa111 would answer for it on every later run
            // in place of a well-formed re-fetch. bbb222 is the positive control — without it a
            // globally-broken memo would satisfy the assertion.
            seedAlice(db);
            stubGitHub([listRow('aaa111'), listRow('bbb222')], {
                aaa111: {body: statlessDetail('aaa111')},
                bbb222: {body: detailBody('bbb222')},
            });

            await runSync(db);

            expect(memoCount(db)).toBe(1);
            const memoed = db
                .prepare('SELECT sha FROM commit_diffstats')
                .all() as Array<{sha: string}>;
            expect(memoed.map((r) => r.sha)).toEqual(['bbb222']);
        });

        it('classifies the churn loss as an advisory, not a failure', async () => {
            // Classified as a failure it would make sync-pipeline re-run the ENTIRE git
            // connector every night forever and still never learn the line counts.
            seedAlice(db);
            stubGitHub([listRow('aaa111')], {aaa111: {body: statlessDetail('aaa111')}});

            const result = await runSync(db);

            const churnLine = churnLineOf(result.errors);
            expect(churnLine).toBeDefined();
            expect(isAdvisoryError(churnLine!)).toBe(true);
            expect(result.errors.filter((e) => !isAdvisoryError(e))).toEqual([]);
        });

        it('says nothing for a commit whose stats were observed to be ZERO', async () => {
            // The distinction the whole decision rests on: an empty commit returns
            // `stats: {additions: 0, deletions: 0, total: 0}` — a present key — so an observed
            // zero is a fact, not a gap. Reporting it would bury the real signal under a line
            // per empty commit, and withholding its memo would disable the #273 ratchet for
            // exactly the cheapest commits.
            seedAlice(db);
            stubGitHub([listRow('aaa111')], {
                aaa111: {
                    body: {...listRow('aaa111'), stats: {additions: 0, deletions: 0, total: 0}, files: []},
                },
            });

            const result = await runSync(db);

            expect(churnLineOf(result.errors)).toBeUndefined();
            expect(dayCommits(db)).toBe(1);
            expect(memoCount(db)).toBe(1);
        });

        it('does not report a churn loss at all for a healthy repo', async () => {
            // The negative control for every assertion above.
            seedAlice(db);
            stubGitHub([listRow('aaa111')], {aaa111: {body: detailBody('aaa111')}});

            const result = await runSync(db);

            expect(churnLineOf(result.errors)).toBeUndefined();
            expect(dayLines(db)).toEqual({added: 40, removed: 10, files: 1});
        });

        it('does NOT claim permanence when a later repo fails and the window is discarded', async () => {
            // The advisory says the understatement can never be re-asked, which is only true of
            // a run whose window is recorded as covered. repo1 degrades a commit, repo2's commit
            // fetch then fails → #231 discards the WHOLE provider's window and holds the cursor,
            // so repo1's commit is re-asked next run and may well arrive with stats. Push at the
            // staging site instead of from the cursor-advance closure and only this fails.
            seedAlice(db);
            stubGitHub(
                [],
                {
                    aa01: {body: statlessDetail('aa01')},
                    bb01: {body: detailBody('bb01')},
                },
                ['repo1', 'repo2'],
                {
                    repo1: {body: [listRow('aa01')]},
                    repo2: {status: 404, body: 'not found'},
                },
            );

            const result = await runSync(db);

            // Positive controls: the run really did fail and the cursor really is held…
            expect(result.errors.some((e) => /Failed to fetch commits/.test(e))).toBe(true);
            expect(readState(db, FORWARD_KEY)).toBeUndefined();
            // …so no permanence claim survived.
            expect(churnLineOf(result.errors)).toBeUndefined();
        });

        it('does NOT claim permanence when the rollback fires AFTER the cursor advance', async () => {
            // #288 review cycle 1, TST-1 — the ONLY test that distinguishes staged-then-pushed
            // from pushed-at-the-staging-site. The `DROP TABLE git_snapshots` variant below
            // fails at `projectSnapshots`, which runs BEFORE the `cursorAdvances` loop, so it
            // never reaches the staging site and passes for a reason that is not the mechanism —
            // the #275 suite above documents exactly that trap. `stallUpdates` runs AFTER the
            // advances, so a throw there is the one window where the advisory has already been
            // staged and the transaction still rolls back. Push to `errors` at the staging site
            // instead of staging, and only this test fails.
            seedAlice(db);
            stubGitHub([listRow('aaa111'), listRow('bbb222')], {
                aaa111: {body: statlessDetail('aaa111')},
                bbb222: {body: detailBody('bbb222')},
            });
            db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
                stallStateKey('github', 'test-org'),
                JSON.stringify({runs: 1, since: '2024-01-01T00:00:00.000Z'}),
            );
            db.exec(`
                CREATE TRIGGER churn_boom BEFORE DELETE ON sync_state
                WHEN old.key LIKE 'git_stall:%'
                BEGIN SELECT RAISE(ABORT, 'stall-clear boom'); END;
            `);

            const result = await runSync(db);

            // Positive controls: the run rolled back and the cursor the claim rests on did not
            // persist…
            expect(result.errors.some((e) => /transaction rolled back/.test(e))).toBe(true);
            expect(readState(db, FORWARD_KEY)).toBeUndefined();
            // …so no permanence claim survived, even though the staging site DID execute.
            expect(churnLineOf(result.errors)).toBeUndefined();
        });

        it('does NOT claim permanence when the write transaction rolls back early', async () => {
            seedAlice(db);
            stubGitHub([listRow('aaa111')], {aaa111: {body: statlessDetail('aaa111')}});
            db.exec('DROP TABLE git_snapshots');

            const result = await runSync(db);

            expect(result.errors.some((e) => /transaction rolled back/.test(e))).toBe(true);
            expect(churnLineOf(result.errors)).toBeUndefined();
        });

        it('lets a LATER run recover the real churn, because nothing was memoized', async () => {
            // #288 review cycle 1, SO-5. Every other assertion here is about the ABSENCE of a
            // write; this is about what that absence buys. Withholding the memo is only
            // worthwhile if a subsequent fetch of the same commit actually reaches the endpoint
            // and gets the fresh answer — a refactor that "helpfully" memoized these as
            // `absent: true` to stop the re-fetch would keep every not-called assertion green
            // and silently make the loss permanent.
            //
            // Run 1's detail is stats-less; run 2's carries real stats.
            //
            // Run 2 drives `syncProviders` with an overlapping backfill window DIRECTLY, which is
            // a MECHANISM PROBE and emphatically NOT the supported repair — the admin route only
            // ever builds a strictly-older, disjoint slice, and re-importing an overlapping span
            // is exactly what `permanentSpanRepair()` tells an operator never to do. It is used
            // here because it is the cheapest way to make a second fetch of the same sha happen;
            // the double-counted commit total it leaves behind is asserted below rather than
            // hidden, so nobody reads this test as licensing the action.
            seedAlice(db);
            let attempt = 0;
            stubGitHub([listRow('aaa111')], {
                aaa111: () =>
                    attempt++ === 0 ? {body: statlessDetail('aaa111')} : {body: detailBody('aaa111')},
            });

            const first = await runSync(db);
            // Run 1: imported, churn unknown, nothing memoized.
            expect(churnLineOf(first.errors)).toBeDefined();
            expect(dayLines(db)).toEqual({added: 0, removed: 0, files: 0});
            expect(memoCount(db)).toBe(0);

            const pending = new GitSync({enabled: false}).syncProviders(db, [CONFIG], undefined, {
                backfill: {since: `${DAY}T00:00:00.000Z`, until: `${DAY}T23:59:59.000Z`},
            });
            await vi.runAllTimersAsync();
            const second = await pending;

            // Run 2 re-asked the endpoint — no memo short-circuited it. THIS is the assertion
            // that pins the mechanism: a refactor that memoized the degraded commit (as
            // `absent: true`, say, to "save" the re-fetch) would serve the memo here, skip the
            // detail request, and leave the count at 0.
            expect(memoCount(db)).toBe(1);
            // The fresh answer arrived and the advisory is gone…
            expect(churnLineOf(second.errors)).toBeUndefined();
            expect(dayLines(db)?.added).toBe(40);
            // …and the price of getting it this way, stated rather than hidden: the overlapping
            // re-import ADDED a second commit for one real commit (#262). That is why the
            // supported repair retracts the span first.
            expect(dayCommits(db)).toBe(2);
        });

        it('counts each unobserved commit ONCE even when an in-run retry re-pages the window', async () => {
            // A retry re-pages the identical window, so a naive accumulator would claim
            // "2 commit(s)" for one commit and send an operator after a commit that does not
            // exist. The count is structurally safe rather than guarded: it is derived from the
            // RETURNED array, which `fetchRepoWithRetry` ASSIGNS rather than appends to. This
            // pins that the derivation stays on the returned array.
            seedAlice(db);
            let serverErrors = 0;
            stubGitHub([listRow('aaa111'), listRow('bbb222')], {
                aaa111: {body: statlessDetail('aaa111')},
                // 503s until the request layer's own budget is spent, so attempt 1 throws AFTER
                // aaa111 was already reported; attempt 2 then succeeds.
                bbb222: () => {
                    if (serverErrors++ <= MAX_SERVER_ERROR_RETRIES) {
                        return {status: 503, body: 'unavailable'};
                    }
                    return {body: detailBody('bbb222')};
                },
            });

            const result = await runSync(db);

            expect(result.errors).toContainEqual(expect.stringContaining(RETRY_HEALED_PREFIX));
            expect(readState(db, FORWARD_KEY)).toBe(result.lastSyncTime);
            expect(
                result.errors.filter((e) => e.startsWith(COMMIT_CHURN_UNKNOWN_PREFIX)),
            ).toHaveLength(1);
            expect(churnLineOf(result.errors)).toContain('1 commit(s)');
        });

        it('reports each affected repo separately, caps the sample and counts the remainder', async () => {
            // Both aggregation halves at once: the per-repo loop must run more than once (a
            // shared accumulator leaks repo1's shas into repo2's line), and the sample cap must
            // actually bite — with one commit per test `slice(0, 5)` is indistinguishable from
            // `slice(0, 1)` and the `(+N more)` branch never runs.
            seedAlice(db);
            const many = ['ca01', 'ca02', 'ca03', 'ca04', 'ca05', 'ca06', 'ca07'];
            stubGitHub(
                [],
                Object.fromEntries(
                    [...many, 'cb01'].map((s) => [s, {body: statlessDetail(s)}]),
                ),
                ['repo1', 'repo2'],
                {
                    repo1: {body: many.map((s) => listRow(s))},
                    repo2: {body: [listRow('cb01')]},
                },
            );

            const result = await runSync(db);

            const lines = result.errors.filter((e) => e.startsWith(COMMIT_CHURN_UNKNOWN_PREFIX));
            expect(lines).toHaveLength(2);
            const forRepo1 = lines.find((l) => l.includes('[github/repo1]'));
            const forRepo2 = lines.find((l) => l.includes('[github/repo2]'));
            expect(forRepo1).toBeDefined();
            expect(forRepo2).toBeDefined();
            expect(forRepo1).toContain('7 commit(s)');
            for (const named of ['ca01', 'ca02', 'ca03', 'ca04', 'ca05']) {
                expect(forRepo1).toContain(named);
            }
            expect(forRepo1).not.toContain('ca06');
            expect(forRepo1).not.toContain('ca07');
            expect(forRepo1).toContain('(+2 more)');
            // Neither line leaks the other repo's shas.
            expect(forRepo1).not.toContain('cb01');
            expect(forRepo2).not.toContain('ca01');
        });

        it('renders a non-hex sha as invalid instead of interpolating it into the log line', async () => {
            // The sha is raw response JSON and this line reaches a terminal and `sync_logs`.
            // `sanitizeSha` is shared with the drop advisory, but sharing it is a property of
            // the CODE, not of the type — a future edit could sanitize one line and not the
            // other, and no other test in this file drives this line with a hostile sha.
            seedAlice(db);
            const nasty = 'ccc[31mBOOM\nnot-a-sha';
            stubGitHub([listRow(nasty)], {[nasty]: {body: statlessDetail(nasty)}});

            const result = await runSync(db);

            const churnLine = churnLineOf(result.errors);
            expect(churnLine).toBeDefined();
            expect(churnLine).toContain('1 commit(s)');
            expect(churnLine).toContain('<invalid sha>');
            expect(churnLine).not.toContain('BOOM');
            expect(churnLine).not.toContain('[31m');
            expect(churnLine!.split('\n')).toHaveLength(1);
        });

        it('fits inside the per-line storage cap at its longest realistic shape', async () => {
            // #289 sizes `MAX_STORED_COLUMN_CHARS` so the lines that carry an OPERATOR
            // INSTRUCTION arrive whole. This line is the longest one the pipeline emits — it
            // embeds `permanentSpanRepair()` AND a five-sha sample — and it is also ranked to
            // the front of the bounded column as permanent loss, so a cap that cuts it mangles
            // exactly the report the ranking exists to protect.
            //
            // Measured against the REAL emitted line at its worst realistic inputs (full
            // 40-hex shas, a long repo path, the `(+N more)` tail), not against an estimate of
            // the prose: it is the line length that has to fit, not the repair paragraph.
            seedAlice(db);
            // Long but slash-free: the GitHub harness routes list calls by a single path
            // segment. A GitLab group path is longer still, which the constant's headroom
            // covers — see MAX_STORED_COLUMN_CHARS.
            const longRepo = 'platform-infrastructure-service-mesh-control-plane';
            const shas = Array.from({length: 9}, (_, i) =>
                String(i + 1).repeat(40).slice(0, 40),
            );
            stubGitHub(
                [],
                Object.fromEntries(shas.map((s) => [s, {body: statlessDetail(s)}])),
                [longRepo],
                {[longRepo]: {body: shas.map((s) => listRow(s))}},
            );

            const result = await runSync(db);

            const churnLine = churnLineOf(result.errors);
            expect(churnLine).toBeDefined();
            expect(churnLine).toContain('(+4 more)');
            expect(churnLine!.length).toBeLessThanOrEqual(MAX_STORED_COLUMN_CHARS);
            // TWO-SIDED. An upper bound alone cannot tell "the cap is comfortably above the
            // line" from "the line collapsed and the cap is now sized against nothing" — and
            // the constant's docstring cites this measurement as its justification, so the
            // measurement itself is what has to stay pinned.
            expect(churnLine!.length).toBeGreaterThan(2_000);
            // The tail is the part a tight cap eats first, and it is the part an operator uses
            // to verify the loss — assert it survived rather than only asserting the total.
            expect(churnLine!.endsWith('.')).toBe(true);
            expect(churnLine).toContain(shas[0]);

            // Round-trip the REAL line through the store: "the emitted line fits" and "the
            // store does not cut it" are two different claims, and only this composes them.
            const db2 = makeDb();
            try {
                const key = loadServerKey({
                    TOPROPE_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
                });
                const rec = createProvider(db2, key, {config: CONFIG, createdBy: null});
                recordSyncOutcome(db2, rec.id, {
                    status: 'ok',
                    at: '2026-08-01T00:00:00.000Z',
                    advisories: [churnLine!],
                });
                expect(toPublicProvider(getProvider(db2, rec.id)!).last_sync_advisories).toEqual([
                    churnLine,
                ]);
            } finally {
                db2.close();
            }
        });
    });
});

/**
 * #289 — the ordering a BOUNDED advisory surface depends on.
 *
 * `git_providers.last_sync_advisories` keeps at most `MAX_STORED_ADVISORIES` lines and
 * truncates the tail. That is only safe if the list arrives importance-first, and
 * `SyncResult.errors` arrives close to the OPPOSITE order: every per-provider fetch-phase
 * line is spliced in first — `RETRY_HEALED_PREFIX` once per healed fetch, so hundreds of them
 * for a large org riding out rate limiting — while the permanent-loss lines are appended last,
 * after the write transaction, because only then is the loss real.
 *
 * Unit-level rather than through a run, deliberately: producing 20+ real retry-heals requires
 * two 5-and-15-minute sleeps per heal (`GIT_REPO_RETRY_DELAYS_MS`), so a run-level test of the
 * over-cap case could only be built on faked time — and what needs pinning is the ordering
 * rule itself, not the pipeline that feeds it.
 */
describe('rankAdvisories — importance order for a bounded surface (#289)', () => {
    const healed = (n: number): string => `${RETRY_HEALED_PREFIX} [github/repo-${n}] commit fetch succeeded on attempt 2`;
    const drop = `${COMMITS_DROPPED_PREFIX} [github/api] 3 commit(s)`;
    const churn = `${COMMIT_CHURN_UNKNOWN_PREFIX} [github/api] 2 commit(s)`;

    it('moves permanent-loss lines ahead of recoverable ones, so a tail cap cannot evict them', () => {
        // The exact arrival shape of a rate-limited large-org run: noise first, loss last.
        const arrived = [...Array.from({length: 25}, (_, i) => healed(i)), drop, churn];

        const ranked = rankAdvisories(arrived);

        // A 20-line tail cap applied to `arrived` keeps zero loss lines; applied to `ranked`
        // it keeps both. That difference IS the finding this function exists to fix.
        expect(arrived.slice(0, 20).filter((a) => isPermanentLossAdvisory(a))).toEqual([]);
        expect(ranked.slice(0, 20).filter((a) => isPermanentLossAdvisory(a))).toEqual([drop, churn]);
    });

    it('is stable within each class and loses nothing', () => {
        // An operator reading the retained set should see it in the order the run produced it,
        // and ranking is a REORDER — never a filter. A rank that dropped the recoverable lines
        // would pass the assertion above while quietly discarding the healed-retry report.
        const arrived = [healed(0), drop, healed(1), churn, healed(2)];
        expect(rankAdvisories(arrived)).toEqual([drop, churn, healed(0), healed(1), healed(2)]);
        expect(rankAdvisories(arrived)).toHaveLength(arrived.length);
    });

    it('leaves a list with no permanent-loss line exactly as it arrived', () => {
        const arrived = [healed(0), healed(1)];
        expect(rankAdvisories(arrived)).toEqual(arrived);
        expect(rankAdvisories([])).toEqual([]);
    });

    it('sinks self-healed lines BELOW the actionable ones, so the cap evicts them first', () => {
        // Two tiers were not enough. `RETRY_HEALED_PREFIX` is the only class with unbounded
        // cardinality — one line per healed fetch, per repo, per fetch kind — AND it arrives
        // first (spliced in during fetch). Ranked as merely "not permanent" it fills the whole
        // remainder of the surface, evicting the two lines that arrive last and carry an
        // operator INSTRUCTION. This is the same shape as the test above, plus the actionable
        // middle tier the two-tier fixture could not detect the loss of.
        const deleted = `${PROVIDER_DELETED_MID_RUN_PREFIX} [github/api] provider removed mid-run`;
        const legacy = `${LEGACY_CELLS_SKIPPED_PREFIX} [github/api] 4 legacy day(s) skipped`;
        const arrived = [...Array.from({length: 25}, (_, i) => healed(i)), deleted, legacy, drop];

        const ranked = rankAdvisories(arrived);
        const kept = ranked.slice(0, 20);

        // Permanent loss first, then the actionable middle tier — both inside a 20-line cap
        // that arrival order, and two-tier ranking, would have spent entirely on healed lines.
        expect(ranked.slice(0, 3)).toEqual([drop, deleted, legacy]);
        expect(kept).toContain(deleted);
        expect(kept).toContain(legacy);
        expect(arrived.slice(0, 20)).not.toContain(deleted);
        // Nothing is dropped — ranking is a reorder, and the healed lines keep their order.
        expect(ranked).toHaveLength(arrived.length);
        expect(ranked.slice(3)).toEqual(Array.from({length: 25}, (_, i) => healed(i)));
    });

    it('classifies a healed retry as self-healed and nothing else as self-healed', () => {
        expect(isSelfHealedAdvisory(healed(0))).toBe(true);
        expect(isSelfHealedAdvisory(drop)).toBe(false);
        expect(isSelfHealedAdvisory(churn)).toBe(false);
        expect(
            isSelfHealedAdvisory(`${PROVIDER_DELETED_MID_RUN_PREFIX} [github/api] removed`),
        ).toBe(false);
        expect(isSelfHealedAdvisory(`${LEGACY_CELLS_SKIPPED_PREFIX} [github/api] 4 day(s)`)).toBe(
            false,
        );
    });

    it('classifies only the un-re-askable sentinels as permanent loss', () => {
        // Both directions, against strings the code itself builds: a recoverable advisory
        // ranked as permanent would push the real loss down and back under the cap.
        expect(isPermanentLossAdvisory(drop)).toBe(true);
        expect(isPermanentLossAdvisory(churn)).toBe(true);
        expect(isPermanentLossAdvisory(healed(0))).toBe(false);
    });
});
