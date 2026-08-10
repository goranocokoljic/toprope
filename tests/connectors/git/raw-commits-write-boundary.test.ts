/**
 * IG1.2 (#318, epic #316) — the write boundary: per-commit `raw_commits` inserts + per-cell
 * recompute of `raw_author_daily`.
 *
 * This file carries the epic's verification matrix rows that belong to this child — V1, V4, V5,
 * V6 — plus criterion C (the disjointness machinery is GONE, not bypassed) and criterion D (every
 * `ROW_LEVEL_REFUSALS` code exercised against the NEW path). Criterion B is the golden test
 * (`golden-raw-author-daily.test.ts`), inherited from #317 unchanged and deliberately not touched
 * here.
 *
 * The end-to-end rows drive the REAL pipeline — `GitSync.syncProviders` over the real provider
 * classes over a stubbed `fetch` — for the same reason the golden does: a harness that
 * re-implemented the ingest tail would pass by construction and prove nothing. Everything is
 * pinned (frozen clock, fixed route table, no network), so a difference between two runs can only
 * come from the pipeline.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper} from '../../../src/registry/developers';
import {GitSync, syncStateKey} from '../../../src/connectors/git/sync';
import {
    insertRawCommit,
    projectRawAuthorDailyCell,
    readAuthorBurstsByDay,
    readCellCommitTotals,
    toUtcInstant,
    type RawCommitInput,
} from '../../../src/connectors/git/raw-commits';
import {
    RawAuthorDailyError,
    ROW_LEVEL_REFUSALS,
    type RawAuthorDailyErrorCode,
} from '../../../src/connectors/git/raw-author-daily';
import {
    BITBUCKET_CONFIG,
    GITHUB_CONFIG,
    bitbucketRoutes,
    githubRoutes,
    makeCountingFetch,
    type Route,
} from './providers/provider-fetch-fixtures';
import type {GitProviderConfig} from '../../../src/connectors/git/providers/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');
const SRC_DIR = path.resolve(__dirname, '../../../src');

/** Late enough that every fixture date is inside the first-sync window, and none is in the future. */
const NOW = '2024-01-20T00:00:00.000Z';
const OBSERVED_AT = '2026-07-01T10:00:00.000Z';

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

/**
 * Every stored table this epic makes a claim about, as comparable JSON.
 *
 * `id` is excluded from `raw_author_daily` for the reason the golden excludes it: it is a
 * `randomUUID` with no meaning, and `(provider, container, raw_author_key, date)` is the real key.
 * Every OTHER column is compared, including `first_seen`/`last_seen`, so a second run that
 * silently rewrote provenance would fail here.
 */
function dumpTables(db: Database.Database): Record<string, unknown[]> {
    return {
        raw_commits: db
            .prepare('SELECT * FROM raw_commits ORDER BY provider, container, repo, sha')
            .all(),
        raw_author_daily: db
            .prepare(
                `SELECT provider, container, raw_author_key, author_login, author_email,
                        author_display_name, date, commits, lines_added, lines_removed,
                        files_changed, prs_opened, prs_merged, review_comments_given,
                        avg_time_to_merge_hours, code_churn_rate, ai_signature_score,
                        avg_commit_size, commit_burst_count, first_seen, last_seen
                   FROM raw_author_daily ORDER BY provider, container, raw_author_key, date`,
            )
            .all(),
        git_snapshots: db
            .prepare(
                `SELECT developer_id, date, commits, lines_added, lines_removed, files_changed,
                        prs_opened, prs_merged, review_comments_given, avg_time_to_merge_hours,
                        code_churn_rate, ai_signature_score, avg_commit_size, commit_burst_count,
                        data_source, is_projected
                   FROM git_snapshots ORDER BY developer_id, date`,
            )
            .all(),
    };
}

function seedDev(db: Database.Database, login: string, provider = 'github'): string {
    addTeam(db, 'eng');
    const dev = addDeveloper(db, login, 'eng', `${login}@example.com`, login);
    db.prepare('UPDATE developers SET external_ids = ? WHERE id = ?').run(
        JSON.stringify({[provider]: login}),
        dev.id,
    );
    return dev.id;
}

/** A minimal, valid `raw_commits` row; override one field per case. */
function commitRow(over: Partial<RawCommitInput> = {}): RawCommitInput {
    return {
        provider: 'github',
        container: 'test-org',
        repo: 'repo1',
        sha: 'sha-1',
        raw_author_key: 'github:login:alice',
        author_login: 'alice',
        author_email: 'Alice@Example.com',
        author_display_name: 'Alice',
        author_day: '2026-07-01',
        committed_at: '2026-07-01T09:00:00.000Z',
        lines_added: 10,
        lines_removed: 2,
        files_changed: 1,
        is_merge: false,
        ai_signature: false,
        ...over,
    };
}

describe('raw_commits — the per-commit write boundary (#318)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });
    afterEach(() => {
        db.close();
    });

    it('stores one row per sha and makes a re-observation a NO-OP', () => {
        expect(insertRawCommit(db, commitRow(), OBSERVED_AT)).toBe(true);
        expect(insertRawCommit(db, commitRow(), '2026-07-09T10:00:00.000Z')).toBe(false);

        const rows = db.prepare('SELECT * FROM raw_commits').all() as Array<Record<string, unknown>>;
        expect(rows).toHaveLength(1);
        // `first_seen` records the FIRST sighting and is never moved by a later one.
        expect(rows[0].first_seen).toBe(OBSERVED_AT);
    });

    it('lowercases author_email at the write boundary, as the schema comment contracts', () => {
        insertRawCommit(db, commitRow(), OBSERVED_AT);
        const row = db.prepare('SELECT author_email FROM raw_commits').get() as {author_email: string};
        expect(row.author_email).toBe('alice@example.com');
    });

    it('UPGRADES a degraded observation, and only ever upward', () => {
        // The #288 shape: a commit whose diffstat endpoint answered without stats is imported
        // with zeros, and a later run re-asks and gets the real numbers. A bare DO NOTHING would
        // freeze the zeros forever WHILE the later run's advisory cleared — a recovery reported
        // to an operator that did not happen.
        insertRawCommit(db, commitRow({lines_added: 0, lines_removed: 0, files_changed: 0}), OBSERVED_AT);
        expect(insertRawCommit(db, commitRow({lines_added: 40, lines_removed: 2, files_changed: 3}), OBSERVED_AT)).toBe(true);
        expect(db.prepare('SELECT lines_added, files_changed FROM raw_commits').get()).toEqual({
            lines_added: 40,
            files_changed: 3,
        });

        // …and a LESS informative later observation cannot undo it, which is what keeps the
        // table monotone and therefore idempotent under any fetch order.
        expect(insertRawCommit(db, commitRow({lines_added: 0, lines_removed: 0, files_changed: 0}), OBSERVED_AT)).toBe(false);
        expect(db.prepare('SELECT lines_added, files_changed FROM raw_commits').get()).toEqual({
            lines_added: 40,
            files_changed: 3,
        });
    });

    describe('toUtcInstant', () => {
        it('normalizes an OFFSET-bearing author date to the same UTC instant', () => {
            // GitLab's `authored_date` really is offset-bearing; stored verbatim it would break
            // every string comparison of an instant.
            expect(toUtcInstant('2024-01-15T10:00:00.000+02:00')).toBe('2024-01-15T08:00:00.000Z');
        });

        it("returns '' for a non-string, an unparseable string, and an expanded ISO year", () => {
            // A non-string must not be coerced: `Date.parse(['2024-01-15T00:00:00Z'])` parses.
            expect(toUtcInstant(['2024-01-15T00:00:00Z'])).toBe('');
            expect(toUtcInstant(null)).toBe('');
            expect(toUtcInstant('not-a-date')).toBe('');
            // Expanded years round-trip through toISOString() but sort BEFORE ordinary years.
            expect(toUtcInstant('+010000-01-01T00:00:00.000Z')).toBe('');
        });
    });

    describe('criterion D — every ROW_LEVEL_REFUSALS code, against the NEW path', () => {
        /** The code `insertRawCommit` throws for `row`, or null if it accepts it. */
        function refusalFor(row: RawCommitInput, observedAt = OBSERVED_AT): RawAuthorDailyErrorCode | null {
            try {
                insertRawCommit(db, row, observedAt);
                return null;
            } catch (e) {
                if (e instanceof RawAuthorDailyError) return e.code;
                throw e;
            }
        }

        const cases: Array<[RawAuthorDailyErrorCode, RawCommitInput]> = [
            ['invalid_date', commitRow({author_day: '2026-7-1'})],
            ['future_date', commitRow({author_day: '2026-07-05', committed_at: '2026-07-05T00:00:00.000Z'})],
            ['invalid_identity', commitRow({author_display_name: 42 as never})],
            ['invalid_metric', commitRow({lines_added: -1})],
        ];

        for (const [code, row] of cases) {
            it(`refuses ${code} and writes NO row`, () => {
                expect(refusalFor(row)).toBe(code);
                expect(db.prepare('SELECT COUNT(*) AS n FROM raw_commits').get()).toEqual({n: 0});
            });
        }

        it('covers every ROW_LEVEL_REFUSALS code, so a new one cannot be added untested', () => {
            expect(new Set(cases.map(([code]) => code))).toEqual(new Set(ROW_LEVEL_REFUSALS));
        });

        it('refuses a blank repo and a blank sha as row-level, never rolling the run back', () => {
            // Both are row-carried and come back byte-identical on every re-fetch, so they are
            // skippable — unlike `invalid_key`, which is decided partly by `provider`.
            expect(refusalFor(commitRow({repo: '  '}))).toBe('invalid_identity');
            expect(refusalFor(commitRow({sha: ''}))).toBe('invalid_identity');
            expect(ROW_LEVEL_REFUSALS).toContain('invalid_identity');
        });

        it('still THROWS run/provider-level defects, which must roll the run back', () => {
            for (const [row, code] of [
                [commitRow({provider: 'perforce' as never}), 'invalid_provider'],
                [commitRow({container: '   '}), 'invalid_container'],
                [commitRow({raw_author_key: 'gitlab:login:alice'}), 'invalid_key'],
            ] as const) {
                const code0 = refusalFor(row);
                expect(code0).toBe(code);
                expect(ROW_LEVEL_REFUSALS).not.toContain(code0);
            }
            // …and the run-constant clock is checked FIRST, so a corrupt clock is reported as
            // the run-level fault it is rather than as a heap of skipped rows.
            expect(refusalFor(commitRow({author_day: '2026-7-1'}), 'nonsense')).toBe('invalid_instant');
        });

        it('refuses a committed_at that is not a UTC ISO instant as a row-level invalid_date', () => {
            expect(refusalFor(commitRow({committed_at: ''}))).toBe('invalid_date');
        });
    });

    describe('the cell recompute', () => {
        it('sums a cell from ALL its commits and derives avg_commit_size from the same operands', () => {
            insertRawCommit(db, commitRow({sha: 'a', lines_added: 10, lines_removed: 2, files_changed: 1}), OBSERVED_AT);
            insertRawCommit(db, commitRow({sha: 'b', lines_added: 30, lines_removed: 8, files_changed: 3}), OBSERVED_AT);
            // A different day, and a different container — neither may leak into the cell.
            insertRawCommit(db, commitRow({sha: 'c', author_day: '2026-07-02', lines_added: 99}), OBSERVED_AT);
            insertRawCommit(db, commitRow({sha: 'd', container: 'other-org', lines_added: 77}), OBSERVED_AT);

            expect(
                readCellCommitTotals(db, {
                    provider: 'github',
                    container: 'test-org',
                    raw_author_key: 'github:login:alice',
                    date: '2026-07-01',
                }),
            ).toEqual({
                commits: 2,
                lines_added: 40,
                lines_removed: 10,
                files_changed: 4,
                avg_commit_size: 25,
            });
        });

        it('reports an empty cell as zeros, not as NULLs (a PR-only author-day is a real state)', () => {
            expect(
                readCellCommitTotals(db, {
                    provider: 'github',
                    container: 'test-org',
                    raw_author_key: 'github:login:nobody',
                    date: '2026-07-01',
                }),
            ).toEqual({commits: 0, lines_added: 0, lines_removed: 0, files_changed: 0, avg_commit_size: 0});
        });

        it('recomputes bursts from the stored stream, including one that spans midnight', () => {
            // Three commits inside 30 minutes, straddling midnight: the burst belongs to the day
            // of its FIRST commit, which a per-cell read could never see.
            const at = (day: string, time: string): Partial<RawCommitInput> => ({
                sha: `${day}-${time}`,
                author_day: day,
                committed_at: `${day}T${time}.000Z`,
            });
            insertRawCommit(db, commitRow(at('2026-07-01', '23:50:00')), OBSERVED_AT);
            insertRawCommit(db, commitRow(at('2026-07-01', '23:55:00')), OBSERVED_AT);
            insertRawCommit(db, commitRow(at('2026-07-02', '00:05:00')), OBSERVED_AT);

            const bursts = readAuthorBurstsByDay(db, 'github', 'test-org', 'github:login:alice');
            expect(bursts.get('2026-07-01')).toBe(1);
            expect(bursts.get('2026-07-02')).toBeUndefined();
        });

        it('REPLACES the projected cell rather than adding to it, and preserves first_seen', () => {
            const cell = {
                provider: 'github' as const,
                container: 'test-org',
                raw_author_key: 'github:login:alice',
                date: '2026-07-01',
                author_login: 'alice',
                author_email: 'alice@example.com',
                author_display_name: 'Alice',
                prs_opened: 1,
                prs_merged: 0,
                review_comments_given: 2,
                avg_time_to_merge_hours: null,
                code_churn_rate: 0.5,
                ai_signature_score: 20,
            };
            insertRawCommit(db, commitRow({sha: 'a'}), OBSERVED_AT);
            const bursts = new Map<string, number>();
            projectRawAuthorDailyCell(db, cell, bursts, OBSERVED_AT);

            insertRawCommit(db, commitRow({sha: 'b'}), OBSERVED_AT);
            const second = projectRawAuthorDailyCell(db, cell, bursts, '2026-07-02T10:00:00.000Z');

            // 2, not 1 + 2: the recompute sees the whole cell, so the write is a replacement.
            expect(second.commits).toBe(2);
            expect(second.lines_added).toBe(20);
            expect(second.first_seen).toBe(OBSERVED_AT);
            expect(second.last_seen).toBe('2026-07-02T10:00:00.000Z');
            expect(
                (db.prepare('SELECT COUNT(*) AS n FROM raw_author_daily').get() as {n: number}).n,
            ).toBe(1);
        });
    });
});

describe('criterion C — the disjointness machinery is gone, not bypassed (#318)', () => {
    it('leaves no reference to the three deleted symbols anywhere under src/', () => {
        const offenders: string[] = [];
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                } else if (/\.(ts|tsx)$/.test(entry.name)) {
                    const text = fs.readFileSync(full, 'utf-8');
                    if (/mergeDailyAcrossRuns|mergeDailyDisjoint|commitWeightedAvg/.test(text)) {
                        offenders.push(path.relative(SRC_DIR, full));
                    }
                }
            }
        };
        walk(SRC_DIR);
        // Comments count too: the epic's criterion is that the machinery and the commentary
        // defending it are both gone, so a doc block still explaining the additive merge is a
        // failure — that is the "docs must match code" rule, and this is its positive control.
        expect(offenders).toEqual([]);
    });
});

describe('IG1 verification matrix — the rows IG1.2 owns (#318)', () => {
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

    async function sync(configs: GitProviderConfig[], routes: Route[]): Promise<void> {
        vi.stubGlobal('fetch', makeCountingFetch(routes).fetchMock);
        const pending = new GitSync({enabled: false}).syncProviders(db, configs);
        await vi.runAllTimersAsync();
        await pending;
    }

    it('V1 — syncing the same window TWICE yields byte-identical tables', async () => {
        seedDev(db, 'alice-gh');
        const routes = githubRoutes();

        await sync([GITHUB_CONFIG], routes);
        const first = dumpTables(db);
        // Non-vacuous: an empty pair of dumps would compare equal and prove nothing.
        expect(first.raw_commits.length).toBeGreaterThan(0);
        expect(first.raw_author_daily.length).toBeGreaterThan(0);
        expect(first.git_snapshots.length).toBeGreaterThan(0);

        // The cursor now sits at `now`, so a second run re-asks a window that overlaps
        // everything already stored — the exact shape that used to double-count.
        await sync([GITHUB_CONFIG], routes);

        expect(dumpTables(db)).toEqual(first);
    });

    it('V4 — deleting the forward cursor mid-history costs only re-fetching', async () => {
        seedDev(db, 'alice-gh');
        const routes = githubRoutes();

        await sync([GITHUB_CONFIG], routes);
        const first = dumpTables(db);

        // Lose the cursor entirely: under the old model this was the #262 hazard — the only
        // evidence that the next window was disjoint from what was stored.
        const cursorKey = syncStateKey('github', 'test-org');
        expect(db.prepare('SELECT value FROM sync_state WHERE key = ?').get(cursorKey)).toBeDefined();
        db.prepare('DELETE FROM sync_state WHERE key = ?').run(cursorKey);

        const counting = makeCountingFetch(routes);
        vi.stubGlobal('fetch', counting.fetchMock);
        const pending = new GitSync({enabled: false}).syncProviders(db, [GITHUB_CONFIG]);
        await vi.runAllTimersAsync();
        await pending;

        // The tables are identical — the ONLY cost is that the commit list was asked for again.
        expect(dumpTables(db)).toEqual(first);
        expect(counting.hits(/\/commits/)).toBeGreaterThan(0);
    });

    it('V5 — two providers contributing to ONE developer-day preserve both contributions', async () => {
        // One human, two provider identities, one day. Their `raw_author_daily` cells are
        // separate rows (keyed by provider+container) and the projection folds them into one
        // `git_snapshots` cell — so a scoped second run must not clobber the first's half.
        const devId = seedDev(db, 'alice-gh');
        db.prepare('UPDATE developers SET external_ids = ? WHERE id = ?').run(
            JSON.stringify({github: 'alice-gh', bitbucket: 'alice-bb'}),
            devId,
        );

        await sync([GITHUB_CONFIG], githubRoutes());
        const afterGithub = db
            .prepare('SELECT commits FROM git_snapshots WHERE developer_id = ?')
            .get(devId) as {commits: number};
        expect(afterGithub.commits).toBeGreaterThan(0);

        await sync([BITBUCKET_CONFIG], bitbucketRoutes());

        const rawRows = db
            .prepare('SELECT provider, commits FROM raw_author_daily ORDER BY provider')
            .all() as Array<{provider: string; commits: number}>;
        expect(rawRows.map((r) => r.provider)).toEqual(['bitbucket', 'github']);

        const cell = db
            .prepare('SELECT commits FROM git_snapshots WHERE developer_id = ?')
            .get(devId) as {commits: number};
        // Both providers' commits, on one cell — the github half was NOT dropped by the scoped
        // bitbucket-only run (#192/#205).
        expect(cell.commits).toBe(rawRows[0].commits + rawRows[1].commits);
        expect(cell.commits).toBeGreaterThan(afterGithub.commits);
    });

    it('V6 — a failed run’s commits survive, and the completing run does not double-count', async () => {
        seedDev(db, 'alice-gh');

        // Run 1: the repo LIST succeeds but one repo's commit fetch 500s, so the provider is
        // incomplete. Its commits are still written; only the cursor is held.
        const failing: Route[] = [
            {match: /\/repos\/test-org\/repo1\/commits\?/, status: 500, body: {message: 'boom'}},
            ...githubRoutes(),
        ];
        await sync([GITHUB_CONFIG], failing);

        const partial = db.prepare('SELECT COUNT(*) AS n FROM raw_commits').get() as {n: number};
        // Nothing to keep from repo1 itself — the point is the cursor, asserted next.
        expect(db.prepare('SELECT value FROM sync_state WHERE key = ?').get(syncStateKey('github', 'test-org'))).toBeUndefined();

        // Run 2 completes. Because the cursor was held it re-covers the WHOLE window, so every
        // sha run 1 did store is re-observed — and inserts nothing.
        await sync([GITHUB_CONFIG], githubRoutes());

        const rows = db.prepare('SELECT sha FROM raw_commits').all() as Array<{sha: string}>;
        expect(new Set(rows.map((r) => r.sha)).size).toBe(rows.length);
        expect(rows.length).toBeGreaterThanOrEqual(partial.n);

        const cell = db
            .prepare('SELECT commits FROM raw_author_daily')
            .get() as {commits: number};
        // The counter equals the number of DISTINCT commits, not the number of times they were
        // observed. Under the additive merge this was run1 + run2.
        expect(cell.commits).toBe(rows.length);

        // A third, fully-successful run must not move it either.
        await sync([GITHUB_CONFIG], githubRoutes());
        expect((db.prepare('SELECT commits FROM raw_author_daily').get() as {commits: number}).commits).toBe(
            rows.length,
        );
    });
});
