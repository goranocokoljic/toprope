import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {randomUUID} from 'crypto';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper} from '../../../src/registry/developers';
import {upsertRawAuthorDaily, type RawAuthorDailyInput} from '../../../src/connectors/git/raw-author-daily';
import {projectSnapshots} from '../../../src/connectors/git/projection';
import {
    containerKey,
    deleteProviderWithCascade,
    providerDeleteImpact,
} from '../../../src/connectors/git/providers/delete-cascade';
import {getProvider, GitProviderStoreError} from '../../../src/connectors/git/providers/store';
import type {GitProviderType} from '../../../src/connectors/git/providers/types';

/**
 * The provider delete cascade (#264).
 *
 * The scenario every test here is built on: ONE developer with a bitbucket login, active on
 * the SAME day in TWO workspaces of the same family. That is exactly the shape the old
 * family-keyed schema could not express — both workspaces summed into one
 * `raw_author_daily` row, so no delete could ever retract just one of them.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');

const RAW_COLUMNS = `provider, container, raw_author_key, author_login, author_email,
     author_display_name, date, commits, lines_added, lines_removed, files_changed,
     prs_opened, prs_merged, review_comments_given, avg_time_to_merge_hours,
     code_churn_rate, ai_signature_score, avg_commit_size, commit_burst_count,
     first_seen, last_seen`;

const SNAPSHOT_COLUMNS = `developer_id, date, commits, lines_added, lines_removed, files_changed,
     prs_opened, prs_merged, review_comments_given, data_source, is_projected`;

const OBSERVED_AT = '2026-07-10T00:00:00.000Z';

function rawRow(over: Partial<RawAuthorDailyInput> & {container: string}): RawAuthorDailyInput {
    return {
        provider: 'bitbucket' as GitProviderType,
        raw_author_key: 'bitbucket:login:alice',
        author_login: 'alice',
        author_email: 'alice@example.com',
        author_display_name: 'Alice A',
        date: '2026-07-01',
        commits: 1,
        lines_added: 10,
        lines_removed: 2,
        files_changed: 1,
        prs_opened: 0,
        prs_merged: 0,
        review_comments_given: 0,
        avg_time_to_merge_hours: null,
        code_churn_rate: 0,
        ai_signature_score: 0,
        avg_commit_size: 10,
        commit_burst_count: 0,
        ...over,
    };
}

/** A `git_providers` row for one container. Encryption is irrelevant to the cascade. */
function insertProviderRow(db: Database.Database, id: string, container: string): string {
    db.prepare(
        `INSERT INTO git_providers
         (id, type, container, url, include_subgroups, auth_method, auth_username,
          token_ciphertext, token_meta, token_last4, repos_include, repos_exclude,
          enabled, created_at, updated_at, created_by, last_sync_at, last_sync_status, last_sync_error)
         VALUES (?, 'bitbucket', ?, NULL, NULL, 'access_token', NULL, ?, ?, '1234', NULL, NULL,
                 1, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', NULL, NULL, NULL, NULL)`,
    ).run(
        id,
        container,
        Buffer.from('cipher'),
        '{"algo":"AES-256-GCM","iv":"x","auth_tag":"y","key_id":"k1"}',
    );
    return id;
}

function insertPR(db: Database.Database, developerId: string, container: string, prId: string): void {
    db.prepare(
        `INSERT INTO pr_records
         (id, developer_id, provider, container, repo, pr_id, state, created_at, merged_at,
          closed_at, review_comment_count, review_rounds, changes_requested_count,
          time_to_merge_hours, synced_at)
         VALUES (?, ?, 'bitbucket', ?, 'repo1', ?, 'merged', '2026-07-01T00:00:00.000Z',
                 '2026-07-01T06:00:00.000Z', NULL, 1, 1, 0, 6, '2026-07-01T12:00:00.000Z')`,
    ).run(randomUUID(), developerId, container, prId);
}

function setCursors(db: Database.Database, container: string): void {
    for (const [key, value] of [
        [`git_last_sync:bitbucket:${container}`, '2026-07-10T00:00:00.000Z'],
        [`git_earliest_sync:bitbucket:${container}`, '2026-01-10T00:00:00.000Z'],
        [`git_stall:bitbucket:${container}`, '{"runs":2,"since":"2026-07-01T00:00:00.000Z"}'],
    ]) {
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(key, value);
    }
}

function rawRowsFor(db: Database.Database, container: string): unknown[] {
    return db
        .prepare(
            `SELECT ${RAW_COLUMNS} FROM raw_author_daily WHERE container = ?
              ORDER BY date ASC, raw_author_key ASC`,
        )
        .all(container);
}

function snapshotCell(
    db: Database.Database,
    developerId: string,
    date: string,
): Record<string, unknown> | undefined {
    return db
        .prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM git_snapshots WHERE developer_id = ? AND date = ?`)
        .get(developerId, date) as Record<string, unknown> | undefined;
}

describe('deleteProviderWithCascade (#264)', () => {
    let db: Database.Database;
    let devId: string;
    /** The provider rows for the two workspaces. */
    let providerA: string;
    let providerB: string;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db, MIGRATIONS_DIR);
        addTeam(db, 'eng');
        devId = addDeveloper(db, 'Alice', 'eng', 'alice@example.com', undefined, {
            bitbucket: 'alice',
        }).id;

        // ws-a and ws-b BOTH contribute to alice on 2026-07-01; only ws-a is active on 07-02.
        upsertRawAuthorDaily(db, rawRow({container: 'ws-a', commits: 3, lines_added: 30}), OBSERVED_AT);
        upsertRawAuthorDaily(db, rawRow({container: 'ws-b', commits: 5, lines_added: 50}), OBSERVED_AT);
        upsertRawAuthorDaily(
            db,
            rawRow({container: 'ws-a', date: '2026-07-02', commits: 7, lines_added: 70}),
            OBSERVED_AT,
        );
        projectSnapshots(db, {dates: ['2026-07-01', '2026-07-02']});

        insertPR(db, devId, 'ws-a', 'a-1');
        insertPR(db, devId, 'ws-b', 'b-1');
        setCursors(db, 'ws-a');
        setCursors(db, 'ws-b');

        providerA = insertProviderRow(db, 'prov-a', 'ws-a');
        providerB = insertProviderRow(db, 'prov-b', 'ws-b');
    });

    afterEach(() => db.close());

    it('the two workspaces are independently attributed and folded into one day-row', () => {
        // Precondition for everything below: 3 + 5 commits on the shared day.
        expect(snapshotCell(db, devId, '2026-07-01')?.commits).toBe(8);
        expect(snapshotCell(db, devId, '2026-07-02')?.commits).toBe(7);
    });

    it('leaves the sibling workspace byte-identical, incl. days both contributed to', () => {
        const before = rawRowsFor(db, 'ws-b');
        deleteProviderWithCascade(db, providerA, new Set());
        expect(rawRowsFor(db, 'ws-b')).toEqual(before);
        // Its PR record and its cursors survive untouched too.
        expect(
            db.prepare("SELECT COUNT(*) AS n FROM pr_records WHERE container = 'ws-b'").get(),
        ).toEqual({n: 1});
        expect(
            db
                .prepare("SELECT value FROM sync_state WHERE key = 'git_last_sync:bitbucket:ws-b'")
                .get(),
        ).toEqual({value: '2026-07-10T00:00:00.000Z'});
    });

    it('retracts exactly the deleted container rows and reports what it removed', () => {
        const result = deleteProviderWithCascade(db, providerA, new Set());

        expect(result.raw_author_rows).toBe(2); // 07-01 + 07-02
        expect(result.pr_records).toBe(1);
        expect(result.days).toBe(2);
        expect(result.developers_affected).toBe(1);
        expect(result.cursor_keys_purged).toBe(3);
        expect(result.cascade_skipped).toBe(false);
        expect(result.snapshot_cells_legacy_skipped).toBe(0);
        // 07-01 still has ws-b behind it → rewritten; 07-02 has nothing → retracted.
        expect(result.snapshot_cells_rewritten).toBe(1);
        expect(result.snapshot_cells_retracted).toBe(1);

        expect(rawRowsFor(db, 'ws-a')).toEqual([]);
        expect(getProvider(db, providerA)).toBeUndefined();
        expect(getProvider(db, providerB)).toBeDefined();
    });

    it('re-projects a shared day to the survivor’s contribution ALONE, and removes an orphaned day', () => {
        deleteProviderWithCascade(db, providerA, new Set());

        const shared = snapshotCell(db, devId, '2026-07-01');
        // Recomputed, not merely decremented: exactly ws-b's own numbers.
        expect(shared?.commits).toBe(5);
        expect(shared?.lines_added).toBe(50);
        expect(shared?.is_projected).toBe(1);
        // The day only ws-a contributed to is gone entirely.
        expect(snapshotCell(db, devId, '2026-07-02')).toBeUndefined();
    });

    it('purges the deleted container’s three cursor kinds and nothing else', () => {
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run('copilot_last_sync', 'x');
        deleteProviderWithCascade(db, providerA, new Set());
        const keys = (
            db.prepare('SELECT key FROM sync_state ORDER BY key').all() as {key: string}[]
        ).map((r) => r.key);
        expect(keys).toEqual([
            'copilot_last_sync',
            'git_earliest_sync:bitbucket:ws-b',
            'git_last_sync:bitbucket:ws-b',
            'git_stall:bitbucket:ws-b',
        ]);
    });

    it('never touches developers, their identities, or their team membership', () => {
        const before = db.prepare('SELECT * FROM developers ORDER BY id').all();
        const teamsBefore = db.prepare('SELECT * FROM teams ORDER BY name').all();
        deleteProviderWithCascade(db, providerA, new Set());
        expect(db.prepare('SELECT * FROM developers ORDER BY id').all()).toEqual(before);
        expect(db.prepare('SELECT * FROM teams ORDER BY name').all()).toEqual(teamsBefore);
    });

    it('removes even a developer’s LAST remaining activity without removing the developer', () => {
        // Drop ws-b first, so ws-a is alice's only remaining source.
        deleteProviderWithCascade(db, providerB, new Set());
        deleteProviderWithCascade(db, providerA, new Set());
        expect(db.prepare('SELECT COUNT(*) AS n FROM raw_author_daily').get()).toEqual({n: 0});
        expect(db.prepare('SELECT COUNT(*) AS n FROM git_snapshots').get()).toEqual({n: 0});
        expect(db.prepare('SELECT COUNT(*) AS n FROM developers').get()).toEqual({n: 1});
    });

    // AC6: a config-file provider for the same (type, container) keeps owning the data, so
    // retracting it would delete history its live owner is still maintaining — and purging
    // its cursor would make the next scheduled run re-import an already-counted window.
    it('SKIPS the cascade when a config-file provider owns the same (type, container)', () => {
        const configOwned = new Set([containerKey('bitbucket', 'ws-a')]);
        const result = deleteProviderWithCascade(db, providerA, configOwned);

        expect(result.cascade_skipped).toBe(true);
        expect(result.raw_author_rows).toBe(0);
        expect(result.cursor_keys_purged).toBe(0);
        // Only the DB row went.
        expect(getProvider(db, providerA)).toBeUndefined();
        expect(rawRowsFor(db, 'ws-a')).toHaveLength(2);
        expect(
            db.prepare("SELECT COUNT(*) AS n FROM pr_records WHERE container = 'ws-a'").get(),
        ).toEqual({n: 1});
        expect(
            db
                .prepare("SELECT COUNT(*) AS n FROM sync_state WHERE key LIKE 'git_%:bitbucket:ws-a'")
                .get(),
        ).toEqual({n: 3});
        // And the shared day still counts both workspaces.
        expect(snapshotCell(db, devId, '2026-07-01')?.commits).toBe(8);
    });

    it('a config sibling for a DIFFERENT container does not skip the cascade', () => {
        const result = deleteProviderWithCascade(
            db,
            providerA,
            new Set([containerKey('bitbucket', 'ws-b'), containerKey('github', 'ws-a')]),
        );
        expect(result.cascade_skipped).toBe(false);
        expect(rawRowsFor(db, 'ws-a')).toEqual([]);
    });

    it('throws a typed not_found for an unknown id, changing nothing', () => {
        const before = db.prepare('SELECT COUNT(*) AS n FROM raw_author_daily').get();
        try {
            deleteProviderWithCascade(db, 'ghost', new Set());
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(GitProviderStoreError);
            expect((e as GitProviderStoreError).code).toBe('not_found');
        }
        expect(db.prepare('SELECT COUNT(*) AS n FROM raw_author_daily').get()).toEqual(before);
    });

    // The nesting check the issue asks for explicitly: `projectSnapshots` opens its OWN
    // db.transaction, and better-sqlite3 is supposed to promote that to a SAVEPOINT that
    // joins the cascade's transaction. If it committed independently instead, the
    // retraction below would survive a failure in a LATER step. Proven, not assumed.
    it('rolls the WHOLE cascade back (incl. the projection) when a later step fails', () => {
        db.exec(
            `CREATE TRIGGER boom BEFORE DELETE ON git_providers
             BEGIN SELECT RAISE(ABORT, 'boom'); END`,
        );
        const rawBefore = db.prepare(`SELECT ${RAW_COLUMNS} FROM raw_author_daily ORDER BY container, date`).all();
        const snapsBefore = db.prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM git_snapshots ORDER BY date`).all();
        const prsBefore = db.prepare('SELECT * FROM pr_records ORDER BY pr_id').all();
        const stateBefore = db.prepare('SELECT * FROM sync_state ORDER BY key').all();
        const providersBefore = db.prepare('SELECT id FROM git_providers ORDER BY id').all();

        expect(() => deleteProviderWithCascade(db, providerA, new Set())).toThrow(/boom/);

        expect(db.prepare(`SELECT ${RAW_COLUMNS} FROM raw_author_daily ORDER BY container, date`).all()).toEqual(rawBefore);
        expect(db.prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM git_snapshots ORDER BY date`).all()).toEqual(snapsBefore);
        expect(db.prepare('SELECT * FROM pr_records ORDER BY pr_id').all()).toEqual(prsBefore);
        expect(db.prepare('SELECT * FROM sync_state ORDER BY key').all()).toEqual(stateBefore);
        expect(db.prepare('SELECT id FROM git_providers ORDER BY id').all()).toEqual(providersBefore);
    });
});

describe('providerDeleteImpact (#264)', () => {
    let db: Database.Database;
    let devId: string;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db, MIGRATIONS_DIR);
        addTeam(db, 'eng');
        devId = addDeveloper(db, 'Alice', 'eng', 'alice@example.com', undefined, {
            bitbucket: 'alice',
        }).id;
        // Alice (resolvable) plus an unmatched author, across two days of ws-a.
        upsertRawAuthorDaily(db, rawRow({container: 'ws-a', commits: 3}), OBSERVED_AT);
        upsertRawAuthorDaily(db, rawRow({container: 'ws-a', date: '2026-07-04', commits: 4}), OBSERVED_AT);
        upsertRawAuthorDaily(
            db,
            rawRow({
                container: 'ws-a',
                raw_author_key: 'bitbucket:login:ghost',
                author_login: 'ghost',
                author_email: 'ghost@example.com',
                date: '2026-07-04',
                commits: 2,
            }),
            OBSERVED_AT,
        );
        insertPR(db, devId, 'ws-a', 'a-1');
        setCursors(db, 'ws-a');
        insertProviderRow(db, 'prov-a', 'ws-a');
    });

    afterEach(() => db.close());

    it('reports the real history, author and developer counts', () => {
        const impact = providerDeleteImpact(db, getProvider(db, 'prov-a')!, new Set());
        expect(impact).toEqual({
            provider: 'bitbucket',
            container: 'ws-a',
            raw_author_rows: 3,
            days: 2,
            earliest_date: '2026-07-01',
            latest_date: '2026-07-04',
            commits: 9,
            pr_records: 1,
            authors: 2,
            // Only alice resolves to a registered developer; the unmatched author counts as
            // an AUTHOR but not as a developer whose totals change.
            developers_affected: 1,
            cursor_keys: 3,
            cascade_skipped: false,
        });
    });

    it('reports a zeroed, skipped impact when a config-file provider owns the container', () => {
        const impact = providerDeleteImpact(
            db,
            getProvider(db, 'prov-a')!,
            new Set([containerKey('bitbucket', 'ws-a')]),
        );
        expect(impact.cascade_skipped).toBe(true);
        expect(impact.raw_author_rows).toBe(0);
        expect(impact.days).toBe(0);
        expect(impact.commits).toBe(0);
        expect(impact.pr_records).toBe(0);
        expect(impact.developers_affected).toBe(0);
        expect(impact.earliest_date).toBeNull();
    });

    it('reports zeros (not nulls-as-unknown) for a provider that never imported anything', () => {
        insertProviderRow(db, 'prov-empty', 'ws-empty');
        const impact = providerDeleteImpact(db, getProvider(db, 'prov-empty')!, new Set());
        expect(impact.raw_author_rows).toBe(0);
        expect(impact.commits).toBe(0);
        expect(impact.authors).toBe(0);
        expect(impact.days).toBe(0);
        expect(impact.earliest_date).toBeNull();
        expect(impact.cursor_keys).toBe(0);
    });

    it('is read-only — computing it changes nothing', () => {
        const before = db.prepare('SELECT COUNT(*) AS n FROM raw_author_daily').get();
        providerDeleteImpact(db, getProvider(db, 'prov-a')!, new Set());
        expect(db.prepare('SELECT COUNT(*) AS n FROM raw_author_daily').get()).toEqual(before);
    });
});
