import type Database from 'better-sqlite3';

/**
 * The "git data was reset by a migration — you owe a rebuild" notice (#266).
 *
 * Migration 043 clears the container-keyed imported data (`raw_author_daily`, `pr_records`),
 * the projected `git_snapshots` cells and the `git_*` cursors, so every provider must be
 * re-synced. But the DERIVED rollups are a second projection: `weekly_aggregates`,
 * `monthly_aggregates`, `quarterly_aggregates`, `yearly_aggregates`, `pr_review_metrics` and
 * `coaching_signals` are UPSERTed per period key, and the aggregation scheduler only recomputes
 * the just-closed period. Every older period therefore still holds pre-reset totals, and
 * `/api/aggregates` serves them.
 *
 * That is the graduated #235 rule in its worst form: the migration completes, the server
 * starts, nothing errors, and the dashboard shows months of adoption history backed by zero
 * snapshots. A pure-SQL migration cannot print anything (`runMigrations` reports only a
 * count, and runs silently at server start and at the top of every scheduled sync), so the
 * only durable place to leave the signal is a `sync_state` row — which is what this module
 * reads and clears, and what `toprope doctor` surfaces until an operator acknowledges it.
 *
 * The notice is deliberately NOT self-clearing on the next sync: re-importing the snapshots
 * is only half the rebuild. The other half is the rollup recompute, which nothing can detect
 * the completion of, so the acknowledgement is explicit ({@link clearGitResetNotice}).
 *
 * `toprope doctor` is currently the only surface that reports it. That is a real gap for a
 * service deployment, where 043 fires inside the Fastify process or the scheduler and nothing
 * reads the marker — an admin-page banner reading {@link gitResetNoticeMessage} is the missing
 * half, deferred as a UI change out of #266's scope.
 */

// The `sync_state` key migration 043 writes. Module-local: every read/write goes through the
// functions below, and the migration spells the literal because SQL cannot import a constant.
const GIT_RESET_NOTICE_KEY = 'git_data_reset_pending';

/** The migration id that raised the notice, or null when there is none pending. */
export function gitResetNotice(db: Database.Database): string | null {
    // Tolerates a database with no `sync_state` table, because `toprope doctor` and
    // `clear-reset-notice` may both run before migrations on a half-set-up install and must
    // reach their verdict rather than crash. The absence of the table is not an unknown state:
    // `sync_state` predates 043, so if it does not exist then 043 has not run and there is
    // genuinely no notice. Checked against `sqlite_master` rather than by catching the error,
    // so a real query failure still throws.
    const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_state'")
        .get() as {name: string} | undefined;
    if (table === undefined) return null;

    const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(GIT_RESET_NOTICE_KEY) as
        | {value: string}
        | undefined;
    return row?.value ?? null;
}

/**
 * Acknowledge a specific pending notice. Returns true when THAT notice was the one removed.
 *
 * Value-scoped and transactional on purpose. `runMigrations` executes at server start and at the
 * top of every scheduled sync, so an acknowledgement can race a process that is raising (or
 * re-stamping) the marker — and the key is deliberately migration-agnostic, so a later reset
 * migration will write it too. An unconditional `DELETE … WHERE key = ?` would then acknowledge a
 * notice the operator never saw, for a rebuild that has not started: the #235 false all-clear,
 * reached through the command written to close it. Deleting only the exact value that was read,
 * inside one transaction, makes that impossible rather than unlikely.
 */
export function clearGitResetNotice(db: Database.Database, migrationId: string): boolean {
    return db.transaction((): boolean => {
        return (
            db
                .prepare('DELETE FROM sync_state WHERE key = ? AND value = ?')
                .run(GIT_RESET_NOTICE_KEY, migrationId).changes > 0
        );
    })();
}

/**
 * The operator-facing text for a pending notice — one wording, shared by every surface.
 *
 * Every clause is load-bearing, because a notice that prescribes a remedy narrower than the
 * damage it describes IS the false all-clear it exists to prevent:
 *   - `toprope aggregate backfill` only rebuilds periods inside its `--from`..`--to` range, and a
 *     controlled resync deliberately imports a NARROWER span than the pre-reset data covered. So
 *     `--from` has to reach the oldest period holding stale totals, not the start of the window
 *     just imported. Migration 042 said this and it is repeated here rather than re-lost.
 *   - `aggregate backfill` does not touch `pr_review_metrics` or `coaching_signals` at all; only
 *     the next scheduled weekly/monthly job refreshes those, and only for its recent trailing
 *     window, so older periods of those two stay stale permanently.
 *   - Migration 043 can REMOVE a connection — one whose container it cannot canonicalize, or a
 *     duplicate spelling of an older one — and that row holds the only copy of its encrypted
 *     token and its repo include/exclude list. "A provider is missing from the list" has to be a
 *     stated outcome, not something the admin discovers and reads as data loss.
 */
export function gitResetNoticeMessage(migrationId: string): string {
    return (
        `Migration ${migrationId} reset the imported git data (commits, PRs, projected ` +
        'snapshots and sync cursors) — every git provider must be re-synced. ' +
        '(1) Re-sync each provider (config-file providers sync only via `toprope sync git`). ' +
        '(2) Rebuild the derived rollups, which the reset did NOT clear: `toprope aggregate ' +
        'backfill --from <the earliest day ANY pre-reset rollup covers — NOT merely the start of ' +
        'the window the resync imported>`. That covers the weekly/monthly/quarterly/yearly ' +
        'aggregates only; pr_review_metrics and coaching_signals are not covered by any command, ' +
        'and only the next scheduled weekly/monthly job refreshes them for its recent trailing ' +
        'window — older periods of those two stay stale. Until the backfill runs, ' +
        '/api/aggregates serves pre-reset totals for older periods. ' +
        '(3) Check Admin → Connectors → Git for a MISSING provider: a connection whose ' +
        'org/workspace/group could not be canonicalized, or that duplicated another spelling of ' +
        'the same workspace, was removed and must be re-added with its token and repo scope. ' +
        '(4) Acknowledge with `toprope git clear-reset-notice`.'
    );
}
