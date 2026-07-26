import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper} from '../../../src/registry/developers';
import {upsertRawAuthorDaily, type RawAuthorDailyInput} from '../../../src/connectors/git/raw-author-daily';
import {
    ProjectionError,
    projectSnapshots,
    replayDeveloper,
    type GitSnapshotRow,
} from '../../../src/connectors/git/projection';
import type {GitProviderType} from '../../../src/connectors/git/providers/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');

/** Every column the projection owns, so a comparison can't miss a drifting field. */
const PROJECTED_COLUMNS = `developer_id, date, commits, lines_added, lines_removed, files_changed,
     prs_opened, prs_merged, review_comments_given, avg_time_to_merge_hours, code_churn_rate,
     ai_signature_score, avg_commit_size, commit_burst_count, data_source, is_projected`;

interface StoredSnapshot extends GitSnapshotRow {
    is_projected: number;
}

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function seedTeam(db: Database.Database): void {
    try {
        addTeam(db, 'eng');
    } catch {
        // already present
    }
}

/**
 * A raw daily fact for one author/day. Defaults are a single 60-line commit so a caller
 * only states the fields its assertion actually turns on.
 */
function rawRow(overrides: Partial<RawAuthorDailyInput> & {raw_author_key: string}): RawAuthorDailyInput {
    const defaults: RawAuthorDailyInput = {
        provider: 'github' as GitProviderType,
        container: 'acme',
        author_login: null,
        author_email: null,
        author_display_name: null,
        date: '2024-01-15',
        commits: 1,
        lines_added: 50,
        lines_removed: 10,
        files_changed: 2,
        prs_opened: 0,
        prs_merged: 0,
        review_comments_given: 0,
        avg_time_to_merge_hours: null,
        code_churn_rate: 0,
        ai_signature_score: 0,
        avg_commit_size: 60,
        commit_burst_count: 0,
        raw_author_key: overrides.raw_author_key,
    };
    return {...defaults, ...overrides};
}

function readSnapshots(db: Database.Database): StoredSnapshot[] {
    return db
        .prepare(`SELECT ${PROJECTED_COLUMNS} FROM git_snapshots ORDER BY date, developer_id`)
        .all() as StoredSnapshot[];
}

function readCell(db: Database.Database, developerId: string, date: string): StoredSnapshot | undefined {
    return db
        .prepare(`SELECT ${PROJECTED_COLUMNS} FROM git_snapshots WHERE developer_id = ? AND date = ?`)
        .get(developerId, date) as StoredSnapshot | undefined;
}

describe('projectSnapshots — git_snapshots as a projection of raw_author_daily (#253)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        seedTeam(db);
    });

    afterEach(() => {
        db.close();
    });

    it('projects a matched author into the cell their raw rows resolve to, stamped projection-owned', () => {
        const dev = addDeveloper(db, 'Alice', 'eng', 'alice@example.com', 'alice');
        upsertRawAuthorDaily(db, rawRow({raw_author_key: 'github:login:alice', author_login: 'alice'}));

        const result = projectSnapshots(db, {cells: [{developer_id: dev.id, date: '2024-01-15'}]});

        expect(result).toEqual({cellsWritten: 1, cellsSkippedLegacy: 0, cellsRetracted: 0, datesCovered: 1});
        const cell = readCell(db, dev.id, '2024-01-15')!;
        expect(cell.commits).toBe(1);
        expect(cell.lines_added).toBe(50);
        expect(cell.data_source).toBe('github');
        expect(cell.is_projected).toBe(1);
    });

    it('never consults the provider-LOGIN namespace for an email-keyed author (SEC-1)', () => {
        // `toAnalysisCommit` fills authorLogin as `username || email`, so an author with
        // no linked provider account carries their self-asserted `git config user.email`
        // in the login position — and git accepts ANY string there, including a bare word
        // that happens to be someone else's GitHub username.
        //
        // Alice is registered by her github login. Mallory can push to a scanned repo and
        // sets user.email to the bare word 'alice'. Retention keys her row
        // `github:email:alice` (the EMAIL form — no provider username was reported), and
        // both identity columns carry 'alice'. If the resolver probed
        // `github:${login}` for this row it would hand Mallory's commits to Alice — and
        // because the row is now RETAINED, every later whole-day rebuild would re-apply
        // it, while the review queue stayed silent because the row "resolves".
        const alice = addDeveloper(db, 'Alice', 'eng', 'alice@example.com', 'alice');
        upsertRawAuthorDaily(
            db,
            rawRow({
                raw_author_key: 'github:email:alice',
                author_login: 'alice',
                author_email: 'alice',
                commits: 7,
            }),
        );

        projectSnapshots(db, {dates: ['2024-01-15']});

        // Nothing is attributed to Alice: the login branch is not consulted for an
        // email-keyed row, and `email:alice` matches no registered address.
        expect(readCell(db, alice.id, '2024-01-15')).toBeUndefined();
        expect(readSnapshots(db)).toEqual([]);

        // Positive control: the SAME login still resolves when the provider genuinely
        // reported it, so the guard blocks the forged case rather than everything.
        upsertRawAuthorDaily(
            db,
            rawRow({raw_author_key: 'github:login:alice', author_login: 'alice', commits: 3}),
        );
        projectSnapshots(db, {dates: ['2024-01-15']});
        expect(readCell(db, alice.id, '2024-01-15')!.commits).toBe(3);
    });

    it('RETAINS but does not project an author with no developer record', () => {
        upsertRawAuthorDaily(db, rawRow({raw_author_key: 'github:login:ghost', author_login: 'ghost'}));

        const result = projectSnapshots(db, {dates: ['2024-01-15']});

        expect(result.cellsWritten).toBe(0);
        expect(readSnapshots(db)).toEqual([]);
        // The fact itself survives — that is the whole point of the raw store.
        expect(
            (db.prepare('SELECT COUNT(*) AS n FROM raw_author_daily').get() as {n: number}).n,
        ).toBe(1);
    });

    it('merges two providers\' same-day rows into ONE cell with data_source = multi', () => {
        const dev = addDeveloper(db, 'Alice', 'eng', 'alice@example.com', 'alice', {bitbucket: 'alice-bb'});
        upsertRawAuthorDaily(db, rawRow({raw_author_key: 'github:login:alice', author_login: 'alice', commits: 2, lines_added: 100}));
        upsertRawAuthorDaily(db, rawRow({
            provider: 'bitbucket',
            raw_author_key: 'bitbucket:login:alice-bb',
            author_login: 'alice-bb',
            commits: 3,
            lines_added: 30,
        }));

        projectSnapshots(db, {dates: ['2024-01-15']});

        const cell = readCell(db, dev.id, '2024-01-15')!;
        expect(cell.commits).toBe(5);
        expect(cell.lines_added).toBe(130);
        expect(cell.data_source).toBe('multi');
        expect(readSnapshots(db)).toHaveLength(1);
    });

    it('resolves a raw row by commit email when the login maps to nobody', () => {
        // No github external id at all — only the email can attribute this row.
        const dev = addDeveloper(db, 'Carol', 'eng', 'carol@example.com');
        upsertRawAuthorDaily(db, rawRow({
            raw_author_key: 'github:login:carol-gh',
            author_login: 'carol-gh',
            author_email: 'Carol@Example.com',
            commits: 4,
        }));

        projectSnapshots(db, {dates: ['2024-01-15']});

        expect(readCell(db, dev.id, '2024-01-15')!.commits).toBe(4);
    });

    it('is IDEMPOTENT — re-projecting the same raw store + identity map changes nothing', () => {
        const dev = addDeveloper(db, 'Alice', 'eng', 'alice@example.com', 'alice', {bitbucket: 'alice-bb'});
        upsertRawAuthorDaily(db, rawRow({raw_author_key: 'github:login:alice', author_login: 'alice', prs_opened: 2, prs_merged: 1, avg_time_to_merge_hours: 12}));
        upsertRawAuthorDaily(db, rawRow({provider: 'bitbucket', raw_author_key: 'bitbucket:login:alice-bb', author_login: 'alice-bb', commits: 7, code_churn_rate: 0.4}));

        projectSnapshots(db, {dates: ['2024-01-15']});
        const first = readSnapshots(db);
        projectSnapshots(db, {dates: ['2024-01-15']});
        projectSnapshots(db, {cells: [{developer_id: dev.id, date: '2024-01-15'}]});
        const third = readSnapshots(db);

        // Byte-identical across every projected column, not merely "still one row".
        expect(third).toEqual(first);
        expect(first).toHaveLength(1);
    });

    it('cells mode rebuilds ONLY the requested cells — another developer\'s same-day row is untouched', () => {
        const alice = addDeveloper(db, 'Alice', 'eng', 'alice@example.com', 'alice');
        const bob = addDeveloper(db, 'Bob', 'eng', 'bob@example.com', 'bob');
        upsertRawAuthorDaily(db, rawRow({raw_author_key: 'github:login:alice', author_login: 'alice', commits: 1}));
        upsertRawAuthorDaily(db, rawRow({raw_author_key: 'github:login:bob', author_login: 'bob', commits: 9}));

        const result = projectSnapshots(db, {cells: [{developer_id: alice.id, date: '2024-01-15'}]});

        expect(result.cellsWritten).toBe(1);
        expect(readCell(db, alice.id, '2024-01-15')!.commits).toBe(1);
        expect(readCell(db, bob.id, '2024-01-15')).toBeUndefined();
    });

    it('dates mode RETRACTS a projection-owned cell that lost its raw provenance', () => {
        const alice = addDeveloper(db, 'Alice', 'eng', 'alice@example.com', 'alice');
        upsertRawAuthorDaily(db, rawRow({raw_author_key: 'github:login:alice', author_login: 'alice'}));
        projectSnapshots(db, {dates: ['2024-01-15']});
        expect(readCell(db, alice.id, '2024-01-15')).toBeDefined();

        // The raw fact goes away (the author was re-keyed / the row purged).
        db.prepare('DELETE FROM raw_author_daily').run();
        const result = projectSnapshots(db, {dates: ['2024-01-15']});

        expect(result.cellsRetracted).toBe(1);
        expect(readCell(db, alice.id, '2024-01-15')).toBeUndefined();
    });

    it('dates mode NEVER retracts a legacy (pre-#253) row — only projection-owned cells', () => {
        const alice = addDeveloper(db, 'Alice', 'eng', 'alice@example.com', 'alice');
        // A row as an old sync would have left it: is_projected defaults to 0.
        db.prepare(
            `INSERT INTO git_snapshots (id, developer_id, date, commits, data_source)
             VALUES ('legacy-1', ?, '2024-01-15', 42, 'github')`,
        ).run(alice.id);
        // Something else that day gives the projection a reason to scan it.
        upsertRawAuthorDaily(db, rawRow({raw_author_key: 'github:login:ghost', author_login: 'ghost'}));

        const result = projectSnapshots(db, {dates: ['2024-01-15']});

        expect(result.cellsRetracted).toBe(0);
        expect(readCell(db, alice.id, '2024-01-15')!.commits).toBe(42);
    });

    it('NEVER overwrites a legacy (pre-#253) cell — a backfill cannot rewrite it partially (SO-2)', () => {
        // The other half of the legacy-row contract. Retraction was already pinned above;
        // the OVERWRITE side was not, and it is the dangerous one: `runSync`'s backfill
        // drives this same write path over arbitrary past windows, per provider. A day
        // whose legacy cell held GitHub + Bitbucket activity, backfilled on GitHub alone,
        // would be rewritten as GitHub-only — permanently losing the other provider's
        // contribution to a day the forward cursor never re-fetches.
        const alice = addDeveloper(db, 'Alice', 'eng', 'alice@example.com', 'alice');
        // 100 commits = the merged multi-provider total an old sync accumulated.
        db.prepare(
            `INSERT INTO git_snapshots (id, developer_id, date, commits, data_source)
             VALUES ('legacy-1', ?, '2024-01-15', 100, 'multi')`,
        ).run(alice.id);
        // Retention covers only what one provider's backfill re-fetched: 3 commits.
        upsertRawAuthorDaily(db, rawRow({raw_author_key: 'github:login:alice', author_login: 'alice', commits: 3}));

        const result = projectSnapshots(db, {dates: ['2024-01-15']});

        // The legacy total stands, untouched and still legacy-owned…
        const cell = readCell(db, alice.id, '2024-01-15')!;
        expect(cell.commits).toBe(100);
        expect(cell.is_projected).toBe(0);
        // …and the refusal is reported rather than silent.
        expect(result.cellsSkippedLegacy).toBe(1);
        expect(result.cellsWritten).toBe(0);
    });

    it('ignores malformed dates rather than widening or corrupting the scan', () => {
        const alice = addDeveloper(db, 'Alice', 'eng', 'alice@example.com', 'alice');
        upsertRawAuthorDaily(db, rawRow({raw_author_key: 'github:login:alice', author_login: 'alice'}));

        expect(projectSnapshots(db, {dates: ['not-a-date', '2024/01/15', '']})).toEqual({
            cellsWritten: 0,
            cellsRetracted: 0,
            cellsSkippedLegacy: 0,
            datesCovered: 0,
        });
        expect(readCell(db, alice.id, '2024-01-15')).toBeUndefined();
        // …and the well-formed day still projects, so the filter is not vacuous.
        expect(projectSnapshots(db, {dates: ['bad', '2024-01-15']}).cellsWritten).toBe(1);
    });

    it('projects nothing for an empty target instead of scanning every date', () => {
        upsertRawAuthorDaily(db, rawRow({raw_author_key: 'github:login:alice', author_login: 'alice'}));
        addDeveloper(db, 'Alice', 'eng', 'alice@example.com', 'alice');

        expect(projectSnapshots(db, {dates: []}).cellsWritten).toBe(0);
        expect(projectSnapshots(db, {cells: []}).cellsWritten).toBe(0);
        expect(readSnapshots(db)).toEqual([]);
    });
});

describe('replayDeveloper — attributing retained history (#253)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        seedTeam(db);
    });

    afterEach(() => {
        db.close();
    });

    it('attributes history retained BEFORE the developer existed, across every date it touches', () => {
        // Sync happened first: two days of facts for an author nobody had registered.
        upsertRawAuthorDaily(db, rawRow({raw_author_key: 'github:login:dana', author_login: 'dana', date: '2024-01-15', commits: 3}));
        upsertRawAuthorDaily(db, rawRow({raw_author_key: 'github:login:dana', author_login: 'dana', date: '2024-01-16', commits: 5}));
        expect(readSnapshots(db)).toEqual([]);

        const dana = addDeveloper(db, 'Dana', 'eng', 'dana@example.com', 'dana');
        const result = replayDeveloper(db, dana.id);

        expect(result.cellsWritten).toBe(2);
        expect(result.datesCovered).toBe(2);
        expect(readCell(db, dana.id, '2024-01-15')!.commits).toBe(3);
        expect(readCell(db, dana.id, '2024-01-16')!.commits).toBe(5);
    });

    it('resolves a key whose days carry TWO emails, matching on either one (SO-1)', () => {
        // `sync.ts` stamps one run's sample commit email onto every date row that run
        // writes, so one login key legitimately carries different emails on different days.
        // A per-key rollup collapses those to MAX(author_email) — 'jane@personal.com'
        // byte-sorts ABOVE 'jane@corp.com', so the rollup answers 'jane@personal.com',
        // which resolves to NOBODY here. The whole key would then be filtered out of the
        // replay scope: empty date set, a reassuring `datesCovered: 0`, and the
        // jane@corp.com day left permanently unattributed even though it resolves
        // perfectly well — later syncs project in `cells` mode and never revisit it.
        // Resolution must happen per identity variant: the key is in scope if ANY variant
        // resolves, and each ROW then attributes on its own merits.
        upsertRawAuthorDaily(
            db,
            rawRow({
                raw_author_key: 'github:login:jane',
                author_login: 'jane',
                author_email: 'jane@corp.com',
                date: '2024-01-15',
                commits: 3,
            }),
        );
        upsertRawAuthorDaily(
            db,
            rawRow({
                raw_author_key: 'github:login:jane',
                author_login: 'jane',
                author_email: 'jane@personal.com',
                date: '2024-01-16',
                commits: 5,
            }),
        );

        // Registered by the LOSING email only — no github login, so the key is reachable
        // only through the variant MAX(author_email) would have discarded.
        const jane = addDeveloper(db, 'Jane', 'eng', 'jane@corp.com');
        const result = replayDeveloper(db, jane.id);

        // The key made it into scope (pre-fix this was 0 and nothing below was written).
        expect(result.datesCovered).toBe(2);
        // Her corp-email day is attributed…
        expect(readCell(db, jane.id, '2024-01-15')!.commits).toBe(3);
        // …while the personal-email day stays unattributed, which is correct: nothing
        // tells the system that address is hers. Registering it would attribute it too.
        expect(readCell(db, jane.id, '2024-01-16')).toBeUndefined();
    });

    it('is idempotent — replaying twice does not double-count', () => {
        upsertRawAuthorDaily(db, rawRow({raw_author_key: 'github:login:dana', author_login: 'dana', commits: 3}));
        const dana = addDeveloper(db, 'Dana', 'eng', 'dana@example.com', 'dana');

        replayDeveloper(db, dana.id);
        const first = readSnapshots(db);
        replayDeveloper(db, dana.id);
        replayDeveloper(db, dana.id);

        expect(readSnapshots(db)).toEqual(first);
        expect(first[0].commits).toBe(3);
    });

    it('RE-MAP: moving an author from developer A to B adds to B and retracts from A', () => {
        const alice = addDeveloper(db, 'Alice', 'eng', 'alice@example.com', 'alice');
        const bob = addDeveloper(db, 'Bob', 'eng', 'bob@example.com', 'bob');
        upsertRawAuthorDaily(db, rawRow({raw_author_key: 'github:login:alice', author_login: 'alice', commits: 6}));

        replayDeveloper(db, alice.id);
        expect(readCell(db, alice.id, '2024-01-15')!.commits).toBe(6);
        expect(readCell(db, bob.id, '2024-01-15')).toBeUndefined();

        // The identity moves: the github login now belongs to Bob, and Alice keeps none.
        db.prepare(`UPDATE developers SET external_ids = '{}' WHERE id = ?`).run(alice.id);
        db.prepare(`UPDATE developers SET external_ids = '{"github":"alice"}' WHERE id = ?`).run(bob.id);

        // Replaying EITHER side fixes both, because a replay rebuilds whole days.
        const result = replayDeveloper(db, bob.id);

        expect(result.cellsWritten).toBe(1);
        expect(result.cellsRetracted).toBe(1);
        expect(readCell(db, bob.id, '2024-01-15')!.commits).toBe(6);
        expect(readCell(db, alice.id, '2024-01-15')).toBeUndefined();
        // Exactly one attribution survives — no double-count.
        expect(readSnapshots(db)).toHaveLength(1);
    });

    it('RE-MAP from the LOSING side: replaying A — who now resolves NO keys — still retracts A', () => {
        // The asymmetric half. A key-derived date scope sees nothing for A here (A has no
        // keys left), so without the "days I am currently attributed on" half of the scope
        // this replay is a no-op and A keeps a permanent duplicate of B's history.
        const alice = addDeveloper(db, 'Alice', 'eng', 'alice@example.com', 'alice');
        const bob = addDeveloper(db, 'Bob', 'eng', 'bob@example.com', 'bob');
        upsertRawAuthorDaily(db, rawRow({raw_author_key: 'github:login:alice', author_login: 'alice', commits: 6}));
        replayDeveloper(db, alice.id);
        expect(readCell(db, alice.id, '2024-01-15')!.commits).toBe(6);

        db.prepare(`UPDATE developers SET external_ids = '{}', email = NULL WHERE id = ?`).run(alice.id);
        db.prepare(`UPDATE developers SET external_ids = '{"github":"alice"}' WHERE id = ?`).run(bob.id);

        const result = replayDeveloper(db, alice.id);

        expect(result.cellsRetracted).toBe(1);
        expect(readCell(db, alice.id, '2024-01-15')).toBeUndefined();
        // …and the same rebuild attributed the day to its new owner.
        expect(readCell(db, bob.id, '2024-01-15')!.commits).toBe(6);
        expect(readSnapshots(db)).toHaveLength(1);
    });

    it('never retracts a LEGACY cell when replaying a developer who lost every key', () => {
        const alice = addDeveloper(db, 'Alice', 'eng', 'alice@example.com', 'alice');
        db.prepare(
            `INSERT INTO git_snapshots (id, developer_id, date, commits, data_source)
             VALUES ('legacy-1', ?, '2024-01-15', 42, 'github')`,
        ).run(alice.id);

        expect(replayDeveloper(db, alice.id)).toEqual({cellsWritten: 0, cellsSkippedLegacy: 0, cellsRetracted: 0, datesCovered: 0});
        expect(readCell(db, alice.id, '2024-01-15')!.commits).toBe(42);
    });

    it('an external_ids entry literally named "email" cannot hijack another developer\'s commits', () => {
        const victim = addDeveloper(db, 'Victim', 'eng', 'victim@corp.com');
        const attacker = addDeveloper(db, 'Attacker', 'eng', 'attacker@corp.com');
        // The reserved `email:` namespace, reached through the free-form external_ids blob.
        db.prepare(`UPDATE developers SET external_ids = '{"email":"victim@corp.com"}' WHERE id = ?`)
            .run(attacker.id);
        upsertRawAuthorDaily(db, rawRow({
            raw_author_key: 'github:email:victim@corp.com',
            author_email: 'victim@corp.com',
        }));

        projectSnapshots(db, {dates: ['2024-01-15']});

        expect(readCell(db, victim.id, '2024-01-15')!.commits).toBe(1);
        expect(readCell(db, attacker.id, '2024-01-15')).toBeUndefined();
    });

    it('a re-map that only PARTLY moves an author leaves the remainder on A', () => {
        const alice = addDeveloper(db, 'Alice', 'eng', 'alice@example.com', 'alice', {bitbucket: 'alice-bb'});
        const bob = addDeveloper(db, 'Bob', 'eng', 'bob@example.com', 'bob');
        upsertRawAuthorDaily(db, rawRow({raw_author_key: 'github:login:alice', author_login: 'alice', commits: 6}));
        upsertRawAuthorDaily(db, rawRow({provider: 'bitbucket', raw_author_key: 'bitbucket:login:alice-bb', author_login: 'alice-bb', commits: 4}));
        replayDeveloper(db, alice.id);
        expect(readCell(db, alice.id, '2024-01-15')!.commits).toBe(10);

        // Only the github identity moves to Bob.
        db.prepare(`UPDATE developers SET external_ids = '{"bitbucket":"alice-bb"}' WHERE id = ?`).run(alice.id);
        db.prepare(`UPDATE developers SET external_ids = '{"github":"alice"}' WHERE id = ?`).run(bob.id);
        replayDeveloper(db, bob.id);

        expect(readCell(db, bob.id, '2024-01-15')!.commits).toBe(6);
        expect(readCell(db, alice.id, '2024-01-15')!.commits).toBe(4);
        expect(readCell(db, alice.id, '2024-01-15')!.data_source).toBe('bitbucket');
    });

    it('throws a typed developer_not_found rather than silently rebuilding nothing', () => {
        expect(() => replayDeveloper(db, 'no-such-developer')).toThrow(ProjectionError);
        try {
            replayDeveloper(db, 'no-such-developer');
        } catch (err) {
            expect((err as ProjectionError).code).toBe('developer_not_found');
        }
    });

    it('is a no-op for a real developer with no retained authorship', () => {
        const dev = addDeveloper(db, 'New', 'eng', 'new@example.com', 'new');
        expect(replayDeveloper(db, dev.id)).toEqual({cellsWritten: 0, cellsSkippedLegacy: 0, cellsRetracted: 0, datesCovered: 0});
        expect(readSnapshots(db)).toEqual([]);
    });

    it('replays only the target developer\'s dates, leaving an unrelated day alone', () => {
        const dana = addDeveloper(db, 'Dana', 'eng', 'dana@example.com', 'dana');
        const bob = addDeveloper(db, 'Bob', 'eng', 'bob@example.com', 'bob');
        upsertRawAuthorDaily(db, rawRow({raw_author_key: 'github:login:dana', author_login: 'dana', date: '2024-01-15'}));
        upsertRawAuthorDaily(db, rawRow({raw_author_key: 'github:login:bob', author_login: 'bob', date: '2024-02-20', commits: 8}));

        const result = replayDeveloper(db, dana.id);

        expect(result.datesCovered).toBe(1);
        expect(readCell(db, bob.id, '2024-02-20')).toBeUndefined();
    });
});
