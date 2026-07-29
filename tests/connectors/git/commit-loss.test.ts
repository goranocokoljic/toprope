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
    RETRY_HEALED_PREFIX,
    isAdvisoryError,
    syncStateKey,
} from '../../../src/connectors/git/sync';
import {NO_AUTHOR_DATE_DROP_REASON} from '../../../src/connectors/git/providers/github';
import {MAX_SERVER_ERROR_RETRIES} from '../../../src/connectors/git/providers/http-retry';
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

/** An embedded object carrying no author date at all — the unattributable shape. */
const NO_DATE_EMBEDDED = {author: null, message: 'unattributable'};

function listRow(sha: string, commit: unknown = EMBEDDED): Record<string, unknown> {
    return {sha, commit, author: {login: 'alice'}};
}

function detailBody(sha: string, commit: unknown = EMBEDDED): Record<string, unknown> {
    return {
        ...listRow(sha, commit),
        stats: {additions: 40, deletions: 10, total: 50},
        files: [{filename: 'src/foo.ts', additions: 40, deletions: 10, status: 'modified'}],
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
 * Stubs `fetch` for one org with one repo, routing by URL. `rows` is the commit LIST response
 * and `details` maps sha → the response for that commit's detail request (a value or a thunk,
 * so a test can make one commit fail on the first attempt and succeed on the next), which is
 * how a single commit is made lossy while its siblings behave normally.
 */
function stubGitHub(
    rows: Array<Record<string, unknown>>,
    details: Record<string, Route | (() => Route)>,
): void {
    vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string) => {
            if (url.includes('/orgs/test-org/repos')) {
                return Promise.resolve(
                    respond({
                        body: [
                            {
                                id: 1,
                                name: 'repo1',
                                full_name: 'test-org/repo1',
                                default_branch: 'main',
                                archived: false,
                            },
                        ],
                    }),
                );
            }
            const detailMatch = url.match(/\/commits\/([^/?]+)$/);
            if (detailMatch) {
                const route = details[detailMatch[1]];
                if (!route) throw new Error(`unexpected detail request: ${url}`);
                return Promise.resolve(respond(typeof route === 'function' ? route() : route));
            }
            if (url.includes('/commits?')) return Promise.resolve(respond({body: rows}));
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
});
