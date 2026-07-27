import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {
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

    it('clearGitResetNotice removes only the notice value it was handed', () => {
        raise();
        expect(clearGitResetNotice(db, '043')).toBe(true);
        expect(gitResetNotice(db)).toBeNull();
        // …and reports FALSE rather than a phantom success when there was nothing matching, so a
        // no-op is never read as an acknowledgement.
        expect(clearGitResetNotice(db, '043')).toBe(false);
    });

    it('REFUSES to clear a notice whose value changed since it was read', () => {
        // The hazard the value scoping closes: `runMigrations` runs at server start and at the top
        // of every scheduled sync, and the marker key is deliberately migration-agnostic — so a
        // later reset migration re-stamps it. An unconditional `DELETE WHERE key = ?` would
        // acknowledge a notice the operator never saw, for a rebuild that has not started.
        raise('043');
        const observed = gitResetNotice(db);
        expect(observed).toBe('043');
        // Another process raises/re-stamps it meanwhile.
        db.prepare('UPDATE sync_state SET value = ? WHERE key = ?').run('044', KEY);
        expect(clearGitResetNotice(db, observed as string)).toBe(false);
        expect(gitResetNotice(db)).toBe('044');
    });

    it('names every step of the rebuild, including what `aggregate backfill` does NOT cover', () => {
        // `toprope aggregate backfill` rebuilds only periods inside its --from..--to range, and only
        // the four aggregate levels. If this message stopped saying so, an operator could follow it
        // exactly, clear the marker, and leave stale rows behind with no signal remaining — the
        // #235 false all-clear, one layer out.
        const message = gitResetNoticeMessage('043');
        expect(message).toContain('043');
        expect(message).toContain('Re-sync each provider');
        expect(message).toContain('toprope sync git');
        expect(message).toContain('aggregate backfill');
        // The --from caveat migration 042 carried and 043 must not re-lose.
        expect(message).toContain('NOT merely the start of the window the resync imported');
        expect(message).toContain('pr_review_metrics');
        expect(message).toContain('coaching_signals');
        // …and that a CONNECTION may have been removed, for either of the two reasons.
        expect(message).toContain('MISSING provider');
        expect(message).toContain('duplicated another spelling');
        expect(message).toContain('clear-reset-notice');
    });
});
