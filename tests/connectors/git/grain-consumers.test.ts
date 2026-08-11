/**
 * IG1.3 (#319, epic #316) — the grain consumers on the new model: delete cascade, backfill, replay.
 *
 * This file carries the epic's verification matrix rows that belong to this child — V2 and V3 —
 * plus the V7 citation guard. The three paths it covers are the ones that used to lean on the
 * disjoint-window invariant:
 *
 *   - the provider delete cascade (#264), which now retracts `raw_commits` as the source of record
 *     and lets the projection follow (unit-level coverage lives in `provider-delete-cascade.test.ts`;
 *     what is proven HERE is the end-to-end delete → re-add → resync equality, V2);
 *   - the "sync older history" backfill (#229/#232), whose earliest-watermark disjointness proof
 *     (#233) is deleted — an overlapping slice is now a no-op rather than a double-count (V3);
 *   - replay (#253), which is read-side over `raw_author_daily` and needs no change (V7, cited).
 *
 * The rows drive the REAL pipeline — `GitSync.syncProviders` over the real provider classes over a
 * stubbed `fetch` — for the same reason IG1.2's file does: a harness that re-implemented the ingest
 * tail would pass by construction and prove nothing. Everything is pinned (frozen clock, fixed
 * route table, no network), so a difference between two runs can only come from the pipeline.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper} from '../../../src/registry/developers';
import {GitSync, earliestSyncStateKey, syncStateKey} from '../../../src/connectors/git/sync';
import {deleteProviderWithCascade} from '../../../src/connectors/git/providers/delete-cascade';
import {
    AUTHOR_EMAIL,
    GITHUB_CONFIG,
    COMMIT_DATE,
    SHAS,
    githubRoutes,
    makeCountingFetch,
    type Route,
} from './providers/provider-fetch-fixtures';
import type {GitProviderConfig} from '../../../src/connectors/git/providers/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');
const TESTS_DIR = path.resolve(__dirname, '../../..');

/** Late enough that every fixture date is inside the first-sync window, and none is in the future. */
const NOW = '2024-01-20T00:00:00.000Z';
/** The container `GITHUB_CONFIG` resolves to — the second half of every key below. */
const CONTAINER = 'test-org';

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

/**
 * Every stored table this epic makes a claim about, as comparable JSON — the same dump IG1.2's V1
 * compares, deliberately including `first_seen`/`last_seen` so a run that silently rewrote
 * provenance fails here. `raw_author_daily.id` is excluded for the reason the golden excludes it:
 * a `randomUUID` with no meaning, where `(provider, container, raw_author_key, date)` is the key.
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

function seedDev(db: Database.Database, login: string): string {
    addTeam(db, 'eng');
    const dev = addDeveloper(db, login, 'eng', `${login}@example.com`, login);
    db.prepare('UPDATE developers SET external_ids = ? WHERE id = ?').run(
        JSON.stringify({github: login}),
        dev.id,
    );
    return dev.id;
}

/**
 * The `git_providers` row the cascade acts on. The pipeline is driven from a config object, so
 * this row exists only so `deleteProviderWithCascade` has something to look up and delete —
 * matching what the admin route holds for a DB-connected provider of the same (type, container).
 */
function insertProviderRow(db: Database.Database, id: string): string {
    db.prepare(
        `INSERT INTO git_providers
         (id, type, container, url, include_subgroups, auth_method, auth_username,
          token_ciphertext, token_meta, token_last4, repos_include, repos_exclude,
          enabled, created_at, updated_at, created_by, last_sync_at, last_sync_status, last_sync_error)
         VALUES (?, 'github', ?, NULL, NULL, 'token', NULL, ?, ?, '1234', NULL, NULL,
                 1, ?, ?, NULL, NULL, NULL, NULL)`,
    ).run(
        id,
        CONTAINER,
        Buffer.from('cipher'),
        '{"algo":"AES-256-GCM","iv":"x","auth_tag":"y","key_id":"k1"}',
        NOW,
        NOW,
    );
    return id;
}

/**
 * `githubRoutes()` plus one OLDER commit, on its own sha and its own day.
 *
 * Prepended, not appended: {@link makeCountingFetch} routes on FIRST match, so these two entries
 * shadow the stock list/detail routes. The stub ignores `since`/`until` (GitHub pushes both to the
 * server), so every listed commit comes back on every call — which is exactly the overlap shape
 * V3 is about: a backfill re-observes the whole stored set alongside whatever is genuinely new.
 */
const OLDER_SHA = 'sha-older';
const OLDER_DATE = '2023-05-11T10:00:00.000Z';

function githubRoutesWithOlderCommit(): Route[] {
    const commitBody = (sha: string): Record<string, unknown> => ({
        sha,
        commit: {
            author: {
                name: 'Alice',
                email: AUTHOR_EMAIL,
                date: sha === OLDER_SHA ? OLDER_DATE : COMMIT_DATE,
            },
            message: 'feat: work',
        },
        author: {login: 'alice-gh'},
    });
    return [
        {
            match: /\/repos\/test-org\/repo1\/commits\?/,
            body: [...SHAS, OLDER_SHA].map(commitBody),
        },
        {
            match: /\/repos\/test-org\/repo1\/commits\/[^?]+$/,
            bodyFor: (url: string): Record<string, unknown> => {
                const sha = url.split('/').pop() ?? '';
                return {
                    ...commitBody(sha),
                    stats: {additions: 40, deletions: 5, total: 45},
                    files: [
                        {filename: 'src/foo.ts', additions: 30, deletions: 5, status: 'modified'},
                        {filename: 'src/bar.ts', additions: 10, deletions: 0, status: 'added'},
                    ],
                };
            },
        },
        ...githubRoutes(),
    ];
}

describe('IG1 verification matrix — the rows IG1.3 owns (#319)', () => {
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

    async function sync(
        configs: GitProviderConfig[],
        routes: Route[],
        options?: Parameters<GitSync['syncProviders']>[3],
    ): Promise<void> {
        vi.stubGlobal('fetch', makeCountingFetch(routes).fetchMock);
        const pending = new GitSync({enabled: false}).syncProviders(db, configs, undefined, options);
        await vi.runAllTimersAsync();
        await pending;
    }

    const readState = (key: string): string | undefined =>
        (db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
            | {value: string}
            | undefined)?.value;

    it('V2 — delete the container, re-add it, resync: counts equal the first import exactly', async () => {
        seedDev(db, 'alice-gh');
        const routes = githubRoutes();

        // Import #1.
        await sync([GITHUB_CONFIG], routes, {firstSyncWindowMonths: 6});
        const clean = dumpTables(db);
        // Non-vacuous: `toEqual` over two empty dumps passes and proves nothing.
        expect(clean.raw_commits.length).toBe(SHAS.length);
        expect(clean.raw_author_daily.length).toBeGreaterThan(0);
        expect(clean.git_snapshots.length).toBeGreaterThan(0);

        // Delete the provider. Every table this epic owns is retracted for the container —
        // including `raw_commits`, which before #319 survived and left the re-import reading
        // back rows the operator was told were gone.
        deleteProviderWithCascade(db, insertProviderRow(db, 'prov-gh'), new Set());
        expect(dumpTables(db)).toEqual({raw_commits: [], raw_author_daily: [], git_snapshots: []});
        // The cursors went with the data, so the re-import is genuinely a first sync again.
        expect(readState(syncStateKey('github', CONTAINER))).toBeUndefined();
        expect(readState(earliestSyncStateKey('github', CONTAINER))).toBeUndefined();

        // Re-add and re-import the same window.
        insertProviderRow(db, 'prov-gh-2');
        await sync([GITHUB_CONFIG], routes, {firstSyncWindowMonths: 6});

        // Byte-identical to the single clean import — not the sum of two (#262).
        expect(dumpTables(db)).toEqual(clean);
    });

    it('V2 — a delete that does NOT re-add leaves nothing for a later day to resurrect', async () => {
        // The other half of the retraction claim, and the one the surviving `raw_commits` rows
        // actually broke: a container deleted for good must leave no commit behind for a future
        // projection of the same cell to find. Asserted at the store, because `raw_author_daily`
        // was already empty in both the fixed and the broken build — the leak was invisible
        // there, which is why V2 alone passed against it.
        seedDev(db, 'alice-gh');
        await sync([GITHUB_CONFIG], githubRoutes(), {firstSyncWindowMonths: 6});
        expect(
            db.prepare('SELECT COUNT(*) AS n FROM raw_commits').get(),
        ).toEqual({n: SHAS.length});

        deleteProviderWithCascade(db, insertProviderRow(db, 'prov-gh'), new Set());

        expect(db.prepare('SELECT COUNT(*) AS n FROM raw_commits').get()).toEqual({n: 0});
    });

    it('V3 — a backfill that overlaps the imported span changes nothing but the watermark', async () => {
        seedDev(db, 'alice-gh');
        const routes = githubRoutes();

        await sync([GITHUB_CONFIG], routes, {firstSyncWindowMonths: 6});
        const first = dumpTables(db);
        expect(first.raw_commits.length).toBe(SHAS.length);
        expect(first.raw_author_daily.length).toBeGreaterThan(0);
        const forwardCursor = readState(syncStateKey('github', CONTAINER));
        expect(forwardCursor).toBe(NOW);

        // A MAXIMALLY overlapping slice: `until` is `now`, so the requested span covers every
        // commit already stored. This is the shape #233's deleted 409 existed to prevent — a
        // legacy provider's too-recent floor guess — and under the additive merge it doubled
        // every counter permanently.
        await sync([GITHUB_CONFIG], routes, {
            backfill: {since: '2023-01-20T00:00:00.000Z', until: NOW},
        });

        expect(dumpTables(db)).toEqual(first);
        // The backfill lowered the fetch hint and left the forward cursor alone.
        expect(readState(earliestSyncStateKey('github', CONTAINER))).toBe('2023-01-20T00:00:00.000Z');
        expect(readState(syncStateKey('github', CONTAINER))).toBe(forwardCursor);
    });

    it('V3 — a backfill that brings genuinely older commits adds only the new cell', async () => {
        // The precise claim: overlapped cells are NO-OPS while the new day lands whole. A
        // recompute that re-added the overlap would show up as a changed cell on the old day,
        // and a recompute scoped wrongly would show up as a missing one on the new day.
        seedDev(db, 'alice-gh');

        await sync([GITHUB_CONFIG], githubRoutes(), {firstSyncWindowMonths: 6});
        const before = dumpTables(db);
        const oldDayBefore = before.raw_author_daily;
        expect(oldDayBefore).toHaveLength(1);

        await sync([GITHUB_CONFIG], githubRoutesWithOlderCommit(), {
            backfill: {since: '2023-01-20T00:00:00.000Z', until: NOW},
        });

        const after = dumpTables(db);
        // The already-imported commits are unchanged rows, not re-counted ones…
        const carriedOver = (after.raw_commits as Array<{sha: string}>).filter(
            (r) => r.sha !== OLDER_SHA,
        );
        expect(carriedOver).toEqual(before.raw_commits);
        // …the older commit is stored under its own sha…
        expect(after.raw_commits).toHaveLength(SHAS.length + 1);
        // …the already-projected cell is byte-identical…
        const oldDay = (after.raw_author_daily as Array<{date: string; commits: number}>).filter(
            (r) => r.date === COMMIT_DATE.slice(0, 10),
        );
        expect(oldDay).toEqual(oldDayBefore);
        expect(oldDay[0].commits).toBe(SHAS.length);
        // …and the backfilled day is a NEW cell holding exactly the one older commit.
        const newDay = (after.raw_author_daily as Array<{date: string; commits: number}>).filter(
            (r) => r.date === OLDER_DATE.slice(0, 10),
        );
        expect(newDay).toHaveLength(1);
        expect(newDay[0].commits).toBe(1);
    });

    /**
     * V7 — "add a developer after a sync, `replayDeveloper` attributes the retained history".
     *
     * NOT re-implemented here, per the tracker: `replayDeveloper` / `replayDevelopers` /
     * `projectSnapshots` are read-side over `raw_author_daily`, which still exists and is now
     * projected rather than accumulated, so this child expects no behavioral change and cites the
     * existing #253 coverage instead of duplicating it. The suites that own it:
     *
     *   - `tests/connectors/git/sync.test.ts` — "HEAD-TO-HEAD: create-then-replay equals
     *     developer-existed-then-sync (no double-count, no undercount)". The end-to-end row: a real
     *     pipeline run with the developer ABSENT, then create + replay, compared column-by-column
     *     against a pristine control database where the developer existed before the sync. That
     *     equality is exactly V7's claim, and it is stronger than an isolated replay assertion —
     *     it would fail on an undercount as well as a double-count.
     *   - `tests/connectors/git/projection.test.ts` — the
     *     "replayDeveloper — attributing retained history (#253)" block: idempotence under repeat
     *     replay, per-identity attribution, the legacy-cell refusal, and the unknown-developer throw.
     *
     * This test is the CITATION'S staleness guard, not a second copy of the coverage: a citation
     * that silently rots is worse than none, because the matrix row would read as covered while
     * nothing tested it. It fails if either cited case is renamed or removed, and points at what
     * to do about it.
     */
    it('V7 — the cited #253 replay coverage still exists (citation, not duplication)', () => {
        const cited: Array<[string, string]> = [
            [
                'tests/connectors/git/sync.test.ts',
                'HEAD-TO-HEAD: create-then-replay equals developer-existed-then-sync',
            ],
            [
                'tests/connectors/git/projection.test.ts',
                'replayDeveloper — attributing retained history (#253)',
            ],
        ];
        const missing = cited.filter(
            ([file, title]) => !fs.readFileSync(path.join(TESTS_DIR, file), 'utf-8').includes(title),
        );
        expect(
            missing,
            'IG1 matrix row V7 is covered by citation. If a cited case moved, update this list AND ' +
                'the epic PR body — do not delete the citation, or the row becomes untested silently.',
        ).toEqual([]);
    });
});
