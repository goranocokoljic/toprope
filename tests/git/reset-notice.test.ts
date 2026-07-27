import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {
    acknowledgeGitReset,
    clearGitResetNotice,
    gitResetNotice,
    gitResetNoticeMessage,
} from '../../src/connectors/git/reset-notice';

/**
 * The git-data reset notice (#266) — the operator signal a pure-SQL migration cannot print.
 *
 * The failure it exists to prevent: migration 043 empties `raw_author_daily`, `pr_records`,
 * the projected `git_snapshots` cells and the `git_*` cursors, but the derived
 * weekly/monthly/quarterly/yearly rollups plus `pr_review_metrics` and `coaching_signals` are a
 * SECOND projection the scheduler only recomputes for the just-closed period — so
 * `/api/aggregates` keeps serving months of pre-reset totals over zero snapshots, with nothing
 * erroring.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');
const KEY = 'git_data_reset_pending';

describe('git reset notice (#266)', () => {
    let db: Database.Database;

    const raise = (value = '043'): void => {
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(KEY, value);
    };

    beforeEach(() => {
        db = new Database(':memory:');
        runMigrations(db, MIGRATIONS_DIR);
        // Every install that runs the chain from empty has nothing to rebuild, so 043 raises
        // nothing — that is the baseline these tests start from.
        expect(gitResetNotice(db)).toBeNull();
    });

    afterEach(() => {
        db.close();
    });

    it('reads the migration id a raised notice carries', () => {
        raise();
        expect(gitResetNotice(db)).toBe('043');
    });

    it('reports no notice — rather than crashing — on a database with no sync_state table', () => {
        // `toprope doctor` and `clear-reset-notice` both read this BEFORE migrations can have run
        // on a half-set-up install; they must reach their verdict rather than throw. And the answer
        // is honest: `sync_state` predates 043, so no table means 043 has not run.
        const bare = new Database(':memory:');
        expect(gitResetNotice(bare)).toBeNull();
        bare.close();
    });

    it('clearGitResetNotice removes a pending notice and is a no-op when there is none', () => {
        raise();
        clearGitResetNotice(db);
        expect(gitResetNotice(db)).toBeNull();
        expect(() => clearGitResetNotice(db)).not.toThrow();
        expect(gitResetNotice(db)).toBeNull();
    });

    it('names every step of the rebuild, including the two projections `aggregate backfill` misses', () => {
        // `toprope aggregate backfill` drives only the four weekly/monthly/quarterly/yearly
        // levels. If this message stopped saying so, an operator could follow it exactly, clear
        // the marker, and leave `pr_review_metrics`/`coaching_signals` holding pre-reset rows with
        // no signal remaining — the #235 false all-clear, one layer out.
        const message = gitResetNoticeMessage('043');
        expect(message).toContain('043');
        expect(message).toContain('Re-sync each provider');
        expect(message).toContain('aggregate backfill');
        expect(message).toContain('pr_review_metrics');
        expect(message).toContain('coaching_signals');
        // …and that a CONNECTION may have been removed, since its token is unrecoverable.
        expect(message).toContain('MISSING provider');
        expect(message).toContain('clear-reset-notice');
    });

    describe('acknowledgeGitReset', () => {
        it('clears a notice that predates this run', () => {
            raise();
            const before = gitResetNotice(db);
            expect(acknowledgeGitReset(db, before)).toEqual({kind: 'cleared', migrationId: '043'});
            expect(gitResetNotice(db)).toBeNull();
        });

        it('reports nothing_pending instead of a phantom success', () => {
            expect(acknowledgeGitReset(db, null)).toEqual({kind: 'nothing_pending'});
        });

        it('REFUSES to clear a notice raised by this same run', () => {
            // The hazard: `clear-reset-notice` has to run migrations before `sync_state` exists, so
            // its own invocation can be what performs the reset — and clearing the marker then
            // acknowledges a rebuild that has definitionally not started, leaving `doctor` green
            // over stale rollups. Fail closed: the operator re-runs after the rebuild.
            const before = gitResetNotice(db); // null — nothing pending yet
            raise(); // …then "the migration ran inside this process"
            expect(acknowledgeGitReset(db, before)).toEqual({
                kind: 'raised_by_this_run',
                migrationId: '043',
            });
            // And the marker survives, which is the whole point.
            expect(gitResetNotice(db)).toBe('043');
        });
    });
});
