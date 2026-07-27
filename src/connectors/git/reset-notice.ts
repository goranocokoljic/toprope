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

/** Acknowledge the notice, if one is pending. */
export function clearGitResetNotice(db: Database.Database): void {
    db.prepare('DELETE FROM sync_state WHERE key = ?').run(GIT_RESET_NOTICE_KEY);
}

/**
 * The operator-facing text for a pending notice — one wording, shared by every surface.
 *
 * It names the rollup rebuild EXPLICITLY rather than saying "run aggregate backfill", because
 * `toprope aggregate backfill` covers only the four weekly/monthly/quarterly/yearly levels: it
 * does not touch `pr_review_metrics` or `coaching_signals`, which only the next scheduled
 * weekly/monthly job refreshes, and only for its recent trailing window. A notice that
 * prescribed a command narrower than the damage it describes would be exactly the false
 * all-clear it exists to prevent.
 *
 * It also names the possibility that a CONNECTION disappeared. Migration 043 deletes a provider
 * row whose container SQL cannot canonicalize the way the code does, and that row holds the only
 * copy of its encrypted token — so "a provider is missing from the list" has to be a stated
 * outcome, not something the admin discovers and reads as data loss.
 */
export function gitResetNoticeMessage(migrationId: string): string {
    return (
        `Migration ${migrationId} reset the imported git data (commits, PRs, projected ` +
        'snapshots and sync cursors) — every git provider must be re-synced. (1) Re-sync each ' +
        'provider. (2) Rebuild the derived rollups, which the reset did NOT clear: run ' +
        '`toprope aggregate backfill --from <the earliest day the resync imported>` for the ' +
        'weekly/monthly/quarterly/yearly aggregates — note it does NOT cover pr_review_metrics ' +
        'or coaching_signals, which only the next scheduled weekly/monthly job refreshes, and ' +
        'only for its recent trailing window. Until then /api/aggregates serves pre-reset ' +
        'totals for older periods. (3) Check Admin → Connectors → Git for a MISSING provider: ' +
        'a connection whose org/workspace/group could not be canonicalized was removed and ' +
        'must be re-added with its token. (4) Acknowledge with `toprope git clear-reset-notice`.'
    );
}

/** What {@link acknowledgeGitReset} did, so the CLI can report it without re-deriving anything. */
export type AcknowledgeResult =
    | {kind: 'cleared'; migrationId: string}
    | {kind: 'nothing_pending'}
    | {kind: 'raised_by_this_run'; migrationId: string};

/**
 * Acknowledge a pending notice — but refuse to acknowledge one that was raised by the SAME
 * process that is acknowledging it.
 *
 * `noticeBefore` is the notice as it stood before this process applied any migration.
 * `runMigrations` has to run before `sync_state` can be read on an un-migrated database, so the
 * acknowledgement command can be the very thing that performs the reset — and then clear the
 * marker for a rebuild that has definitionally not started, leaving `toprope doctor` green over
 * stale rollups. That is the #235 false all-clear, reached through the command meant to close
 * it. Refusing is the fail-closed choice: the operator re-runs after the rebuild.
 */
export function acknowledgeGitReset(
    db: Database.Database,
    noticeBefore: string | null,
): AcknowledgeResult {
    const pending = gitResetNotice(db);
    if (pending === null) return {kind: 'nothing_pending'};
    if (noticeBefore === null) return {kind: 'raised_by_this_run', migrationId: pending};
    clearGitResetNotice(db);
    return {kind: 'cleared', migrationId: pending};
}
