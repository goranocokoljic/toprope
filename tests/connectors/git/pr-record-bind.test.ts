/**
 * #302 — `findPRRecordDefect` must agree with the write it guards.
 *
 * `pr_records` is the SECOND write inside the git sync's single all-providers transaction, and
 * `upsertPRRecord` binds `repo` / `pr_id` / `state` / `created_at` — all `NOT NULL` — from
 * fields the providers CAST out of a response body rather than validate. A value SQLite refuses
 * therefore does not cost a PR: it throws from inside `insertMany`, rolls back every other
 * provider's window, advances no cursor, and does it again identically on the next run.
 *
 * The raw-author-daily side of this issue makes agreement structural — the skip and the store's
 * refusal literally share a body. There is no equivalent seam here, because the "spec" is a SQL
 * statement rather than a validator, so `findPRRecordDefect` is a hand-maintained mirror. This
 * file is what keeps the mirror honest: every refusal code is driven through BOTH the guard and
 * the real statement on a migrated database, in both directions.
 *
 * WHAT THIS FILE DOES AND DOES NOT PROVE (#302 review cycle 3, SO-3). For every field in
 * `FAULTS` it proves both directions: the guard refuses exactly what the statement refuses, and
 * accepts what it accepts. It does NOT prove the mirror is COMPLETE. An earlier version of this
 * comment claimed that adding a `NOT NULL` column bound from a response-derived field without
 * extending `findPRRecordDefect` turns the controls below red; that only holds if the new
 * column is also left unset by the `record()` factory, and the normal way a field is added is
 * to extend `PRRecordInput` and populate the factory in the same commit — which passes both
 * directions silently. `FAULTS` is a hand-maintained list over the same columns the guard
 * hand-maintains, so completeness is a review obligation, not a tested property.
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper} from '../../../src/registry/developers';
import {
    findPRRecordDefect,
    upsertPRRecord,
    type PRRecordInput,
} from '../../../src/connectors/git/sync';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');
const SYNCED_AT = '2024-01-20T00:00:00.000Z';

function record(over: Partial<PRRecordInput> = {}): PRRecordInput {
    return {
        provider: 'github',
        container: 'test-org',
        repo: 'repo1',
        prId: '1',
        authorLogin: 'alice-gh',
        authorEmail: null,
        state: 'merged',
        createdAt: '2024-01-15T08:00:00.000Z',
        mergedAt: '2024-01-15T18:00:00.000Z',
        closedAt: '2024-01-15T18:00:00.000Z',
        reviewCommentCount: 2,
        changesRequestedCount: 1,
        reviewEventCount: 3,
        commentsOk: true,
        reviewsOk: true,
        ...over,
    };
}

/**
 * Every bind fault the guard names, with the value that produces it.
 *
 * `as never` throughout: the point of each case is a runtime value the interface says cannot
 * occur, which is exactly what an unvalidated cast over a response body delivers.
 */
const FAULTS: Array<{name: string; over: Partial<PRRecordInput>; code: string}> = [
    {name: 'a null repo', over: {repo: null as never}, code: 'unstorable_repo'},
    
    {name: 'an object repo', over: {repo: {} as never}, code: 'unstorable_repo'},
    {name: 'a null pr id', over: {prId: null as never}, code: 'unstorable_pr_id'},
    
    {name: 'a missing state', over: {state: undefined as never}, code: 'unstorable_state'},
    
    {name: 'a null created_at', over: {createdAt: null as never}, code: 'unstorable_created_at'},
    {name: 'a missing created_at', over: {createdAt: undefined as never}, code: 'unstorable_created_at'},
    
    {name: 'an object merged_at', over: {mergedAt: {} as never}, code: 'unstorable_merged_at'},
    {name: 'an object closed_at', over: {closedAt: {} as never}, code: 'unstorable_closed_at'},
];

describe('findPRRecordDefect agrees with the pr_records write it guards (#302)', () => {
    let db: Database.Database;
    let developerId: string;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db, MIGRATIONS_DIR);
        addTeam(db, 'eng');
        developerId = addDeveloper(db, 'alice', 'eng', 'alice@example.com', 'Alice').id;
    });

    afterEach(() => {
        db.close();
    });

    it('passes a well-formed record, which then really does write', () => {
        // The control, and the half that catches DRIFT: if a future `NOT NULL` column is added
        // to the statement and not to the guard, this record still passes the guard and this
        // `upsertPRRecord` throws — which is the failure mode the whole file exists for.
        const input = record();
        expect(findPRRecordDefect(input)).toBeNull();
        expect(() => upsertPRRecord(db, input, developerId, SYNCED_AT)).not.toThrow();
        expect(
            (db.prepare('SELECT COUNT(*) AS n FROM pr_records').get() as {n: number}).n,
        ).toBe(1);
    });

    for (const fault of FAULTS) {
        it(`refuses ${fault.name} as ${fault.code}, and the raw write really does fail on it`, () => {
            const input = record(fault.over);

            // Direction 1 — the guard names it, with the code the advisory will group by.
            expect(findPRRecordDefect(input)).toBe(fault.code);

            // Direction 2 — and it is not over-cautious: the write it is standing in front of
            // genuinely cannot take this value. Without this half the guard could refuse a
            // perfectly writable record and silently discard PR history.
            expect(() => upsertPRRecord(db, input, developerId, SYNCED_AT)).toThrow();
            expect(
                (db.prepare('SELECT COUNT(*) AS n FROM pr_records').get() as {n: number}).n,
            ).toBe(0);
        });
    }

    /**
     * Values the guard must NOT refuse, because the write takes them.
     *
     * This half caught a real over-refusal: the first version of `findPRRecordDefect` asked
     * `typeof === 'string'`, so an empty repo and a numeric `state` were reported as unwritable
     * and their PR history discarded — when SQLite stores both perfectly well (TEXT affinity
     * converts a number). A guard that is too strict loses data just as silently as one that is
     * too loose lets the run brick; only driving both directions against the real statement
     * catches the first kind.
     */
    const WRITABLE: Array<{name: string; over: Partial<PRRecordInput>}> = [
        {name: 'an empty repo', over: {repo: ''}},
        {name: 'an empty pr id', over: {prId: ''}},
        {name: 'an empty state', over: {state: ''}},
        {name: 'a numeric state', over: {state: 7 as never}},
        {name: 'a numeric merged_at', over: {mergedAt: 1_700_000_000_000 as never}},
        {name: 'a null merged_at and closed_at', over: {mergedAt: null, closedAt: null}},
    ];

    for (const ok of WRITABLE) {
        it(`does NOT refuse ${ok.name}, because the write takes it`, () => {
            const input = record(ok.over);
            expect(findPRRecordDefect(input)).toBeNull();
            expect(() => upsertPRRecord(db, input, developerId, SYNCED_AT)).not.toThrow();
            expect(
                (db.prepare('SELECT COUNT(*) AS n FROM pr_records').get() as {n: number}).n,
            ).toBe(1);
        });
    }

    it('does NOT refuse an odd-but-present created_at, which the column stores verbatim', () => {
        // Deliberately narrower than the raw store's day validator. `pr_records.created_at` is
        // unconstrained TEXT and its only readers bound it two-sidedly (`coaching/pr-review`),
        // so refusing an expanded year here would discard PR history over a shape nothing
        // downstream requires — a real loss traded for no protection.
        const input = record({createdAt: '+033658-09-27T00:00:00.000Z'});
        expect(findPRRecordDefect(input)).toBeNull();
        expect(() => upsertPRRecord(db, input, developerId, SYNCED_AT)).not.toThrow();
    });
});
