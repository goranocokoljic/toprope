import type Database from 'better-sqlite3';

/**
 * The "git data was reset by a migration — you owe a rebuild" notice (#266).
 *
 * Migration 043 clears the container-keyed imported data (`raw_author_daily`, `pr_records`),
 * the projected `git_snapshots` cells and the `git_*` cursors, so every provider must be
 * re-synced. But the DERIVED rollups are a second projection: `weekly_aggregates`,
 * `monthly_aggregates`, `quarterly_aggregates`, `yearly_aggregates` and `pr_review_metrics`
 * are UPSERTed per period key, and the aggregation scheduler only recomputes the just-closed
 * period. Every older period therefore still holds pre-reset totals, and `/api/aggregates`
 * serves them.
 *
 * That is the graduated #235 rule in its worst form: the migration completes, the server
 * starts, nothing errors, and the dashboard shows months of adoption history backed by zero
 * snapshots. A pure-SQL migration cannot print anything (`runMigrations` reports only a
 * count, and runs silently at server start and at the top of every scheduled sync), so the
 * only durable place to leave the signal is a `sync_state` row — which is what this module
 * reads and clears, and what `toprope doctor` surfaces until an operator acknowledges it.
 *
 * The notice is deliberately NOT self-clearing on the next sync: re-importing the snapshots
 * is only half the rebuild. The other half is `toprope aggregate backfill`, which nothing can
 * detect the completion of, so the acknowledgement is explicit
 * (`toprope git clear-reset-notice`).
 */

/** The `sync_state` key migration 043 writes. Read/cleared only through this module. */
export const GIT_RESET_NOTICE_KEY = 'git_data_reset_pending';

/**
 * The migration id that raised the notice, or null when there is none pending.
 *
 * Tolerates a database with no `sync_state` table at all, because `toprope doctor` is precisely
 * the tool you run on a half-set-up install and it must not crash before it can tell you the
 * migrations are pending. The absence of the table is not an unknown state: `sync_state` predates
 * 043, so if it does not exist then 043 has not run and there is genuinely no notice. Checked
 * against `sqlite_master` rather than by catching the error, so a real query failure still throws.
 */
export function gitResetNotice(db: Database.Database): string | null {
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
 * Acknowledge the notice. Returns true when one was actually pending, so the CLI can tell
 * "cleared" from "there was nothing to clear" instead of reporting a no-op as a success.
 */
export function clearGitResetNotice(db: Database.Database): boolean {
    return db.prepare('DELETE FROM sync_state WHERE key = ?').run(GIT_RESET_NOTICE_KEY).changes > 0;
}

/** The operator-facing text for a pending notice — one wording, shared by every surface. */
export function gitResetNoticeMessage(migrationId: string): string {
    return (
        `Migration ${migrationId} reset the imported git data (commits, PRs, projected ` +
        'snapshots and sync cursors) — every git provider must be re-synced. The derived ' +
        'weekly/monthly/quarterly/yearly rollups and PR-review metrics were NOT reset, so ' +
        'until they are rebuilt /api/aggregates still serves pre-reset totals for older ' +
        'periods. Re-sync each provider, then run `toprope aggregate backfill --from <the ' +
        'earliest day the resync imported>`, then acknowledge with `toprope git ' +
        'clear-reset-notice`.'
    );
}
