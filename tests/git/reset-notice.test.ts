import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {
    GIT_RESET_NOTICE_KEY,
    clearGitResetNotice,
    gitResetNotice,
    gitResetNoticeMessage,
} from '../../src/connectors/git/reset-notice';

/**
 * The git-data reset notice (#266) — the operator signal a pure-SQL migration cannot print.
 *
 * The failure it exists to prevent: migration 043 empties `raw_author_daily`, `pr_records`,
 * the projected `git_snapshots` cells and the `git_*` cursors, but the derived
 * weekly/monthly/quarterly/yearly rollups are a SECOND projection the scheduler only
 * recomputes for the just-closed period — so `/api/aggregates` keeps serving months of
 * pre-reset totals over zero snapshots, with nothing erroring.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

describe('git reset notice (#266)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        runMigrations(db, MIGRATIONS_DIR);
    });

    afterEach(() => {
        db.close();
    });

    it('reports no notice on a fresh install', () => {
        expect(gitResetNotice(db)).toBeNull();
    });

    it('reports no notice — rather than crashing — on a database with no sync_state table', () => {
        // `toprope doctor` is exactly the tool you run on a half-set-up install; it must reach the
        // "migrations pending" verdict rather than throw before printing it. And the answer is
        // honest: `sync_state` predates 043, so no table means 043 has not run.
        const bare = new Database(':memory:');
        expect(gitResetNotice(bare)).toBeNull();
        bare.close();
    });

    it('reads the migration id a raised notice carries', () => {
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
            GIT_RESET_NOTICE_KEY,
            '043',
        );
        expect(gitResetNotice(db)).toBe('043');
    });

    it('clears a pending notice and reports that one WAS pending', () => {
        db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
            GIT_RESET_NOTICE_KEY,
            '043',
        );
        expect(clearGitResetNotice(db)).toBe(true);
        expect(gitResetNotice(db)).toBeNull();
    });

    it('reports FALSE when there was nothing to clear, so a no-op is not read as a success', () => {
        expect(clearGitResetNotice(db)).toBe(false);
    });

    it('names both halves of the rebuild in its message', () => {
        // Re-syncing alone is not enough — that is the whole point of the notice. If the message
        // stopped naming the backfill, an operator would do half the rebuild and clear it.
        const message = gitResetNoticeMessage('043');
        expect(message).toContain('043');
        expect(message).toContain('re-synced');
        expect(message).toContain('aggregate backfill');
        expect(message).toContain('clear-reset-notice');
    });
});
