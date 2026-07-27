-- #266: normalize `container` so the duplicate-container guard cannot be defeated by
-- letter case or surrounding whitespace.
--
-- WHAT WAS BROKEN. #264 made `(type, container)` the attribution key of every imported
-- `raw_author_daily`/`pr_records` row and of the three `git_*` cursors, and added a
-- `UNIQUE(type, container)` guard so one workspace has exactly one provider. But the guard
-- compared raw text with SQLite's `=`, which is case-sensitive on TEXT, and nothing trimmed
-- the value. So `Wireless_Media`, `wireless_media`, `WIRELESS_MEDIA` and `Wireless_Media `
-- (a trailing space, trivially pasted) were FOUR different containers for one real
-- workspace: the same commits imported four times into four independent buckets, which
-- `git_snapshots` then summed — a permanent double-count reached through the front door of
-- the feature added to prevent it, and one where deleting a single spelling retracts only
-- its own quarter.
--
-- The fix in code is the graduated #255 rule: normalize ONCE (trim + casefold, in
-- `providers/container.ts`) at the canonical extraction every consumer already goes
-- through, so the value the duplicate guard compares is the value the row persists and the
-- value the cursors and imported rows are keyed by. This migration brings EXISTING rows to
-- that same spelling.
--
-- ─── WHAT THIS MIGRATION DOES ────────────────────────────────────────────────────────
--  1. The container-keyed IMPORTED data (`raw_author_daily`, `pr_records`), the projected
--     `git_snapshots` cells and the `git_*` cursors are RESET — UNCONDITIONALLY, exactly as
--     042 did one migration ago.
--  2. `git_providers.container` is normalized IN PLACE for every row SQL can provably
--     normalize the same way the code does; a row it cannot is DELETED. Provider rows
--     otherwise survive: they hold the encrypted token, and forcing an admin to re-paste
--     every credential would be a worse outcome than a resync.
--
-- WHY THE DATA IS RESET RATHER THAN RE-KEYED (AC6: "state which"). Two case-variant
-- containers are, by definition, the same real workspace imported twice — so their rows are
-- (partly) the SAME commits counted twice, and nothing recorded distinguishes the duplicate
-- from the original. Re-keying them to the normalized container would either collide on
-- `UNIQUE(provider, container, raw_author_key, date)` and abort the migration, or — if the
-- losers were dropped — silently pick a winner among rows whose metrics were never meant to
-- coexist. `git_snapshots` has already summed both. The project is pre-production and its
-- data is disposable, so the honest state is empty and rebuilt by resync: the same
-- reasoning, and the same remedy, as migration 042.
--
-- WHY UNCONDITIONALLY, AND NOT ONLY "IF SOMETHING NEEDS NORMALIZING". A conditional reset
-- makes "the migration ran" stop implying "the data is being rebuilt", and the two outcomes
-- are indistinguishable from outside: `runMigrations` executes silently at server start and
-- at the top of every scheduled sync, printing only a count. An operator would have no way
-- to know whether they owe a resync — and the derived rollups (below) would keep serving
-- pre-reset totals either way. Detecting "needs normalizing" in SQL is also strictly weaker
-- than the code's rule (SQLite `lower()` is ASCII-only; bare `trim()` strips spaces only),
-- so a conditional probe would MISS exactly the invisible rows that matter and leave their
-- data and cursors in place — re-arming the double-count from inside the migration meant to
-- end it. 042 reset unconditionally one migration ago; matching it keeps one contract
-- ("upgrading rebuilds git data") instead of two.
--
-- Cursors go WITH the data, never on their own (the graduated #262 rule). A forward cursor
-- is the only evidence that the next run's window is disjoint from what is already stored,
-- which is what licenses `mergeDailyAcrossRuns` to ADD commit counts. Purging cursors while
-- leaving imported rows behind would re-arm that double-count permanently; here the rows
-- and the cursors are removed in the same transaction, so the next run starts from nothing
-- with nothing behind it.
--
-- `git_snapshots` is cleared only where `is_projected = 1`. It is a pure PROJECTION of
-- (raw_author_daily, identity map) (#253), so dropping projected cells is recomputation,
-- not history rewriting. Legacy (`is_projected = 0`) cells are outside the projection's
-- bound and only migration 042 was licensed to remove them — and 042 emptied the table, so
-- after it no legacy cell exists to begin with.
--
-- AFTERWARDS. Resync (admin UI → per-provider "Sync now" with an explicit months window,
-- for a controlled rebuild) and then run
--   toprope aggregate backfill --from <the earliest day the resync imported>
-- because the derived weekly/monthly/quarterly/yearly rollups and `pr_review_metrics` are a
-- SECOND projection that the scheduler only recomputes for the just-closed period — every
-- older period still holds pre-reset totals, and `/api/aggregates` serves them. The
-- `git_data_reset_pending` marker written below is what makes that visible: `toprope doctor`
-- reports it until an operator clears it with `toprope git clear-reset-notice`, so a silently
-- stale dashboard is not the only evidence that a rebuild is owed. It is raised only when this
-- database actually held git data — a fresh install has nothing to rebuild.
--
-- NOTE ON IDEMPOTENCE: like 042 this file is DESTRUCTIVE and is not safe to re-execute
-- against a populated database. The `schema_migrations` ledger runs it exactly once.

-- ─── The operator signal (raised BEFORE the deletes erase its evidence) ────────
-- A pure-SQL migration cannot print, and `runMigrations` reports only a count — so the one
-- durable place to leave "you owe a resync + an aggregate backfill" is `sync_state`, which
-- `toprope doctor` reads. Without it the only evidence of this reset is a dashboard quietly
-- serving pre-reset rollups over zero snapshots (the graduated #235 rule: a completion signal
-- is not a currency claim).
--
-- The RESET below is unconditional; the NOTICE is not. It fires only when there was actually
-- something to lose, so a fresh install is not told to rebuild data it never had. Note what
-- the predicate is and is not: "does any git data or cursor exist", which needs no
-- normalization logic at all — NOT "is any container mis-spelled", which SQL cannot decide the
-- way the code does and would therefore miss exactly the rows that matter.
INSERT INTO sync_state (key, value)
SELECT 'git_data_reset_pending', '043'
 WHERE EXISTS (SELECT 1 FROM raw_author_daily)
    OR EXISTS (SELECT 1 FROM pr_records)
    OR EXISTS (SELECT 1 FROM git_snapshots WHERE is_projected = 1)
    OR EXISTS (
        SELECT 1 FROM sync_state
         WHERE key LIKE 'git_last_sync:%'
            OR key LIKE 'git_earliest_sync:%'
            OR key LIKE 'git_stall:%'
       )
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;

-- ─── Reset the container-keyed data + its cursors ──────────────────────────────
-- Projected snapshot cells first: they are derived from the raw rows below, so removing
-- them before their source keeps the intermediate state readable ("nothing projected yet")
-- rather than "projected from rows that are gone".
DELETE FROM git_snapshots WHERE is_projected = 1;
DELETE FROM raw_author_daily;
DELETE FROM pr_records;

DELETE FROM sync_state
 WHERE key LIKE 'git_last_sync:%'
    OR key LIKE 'git_earliest_sync:%'
    OR key LIKE 'git_stall:%';

-- The provider rows' own sync display columns describe a run whose data no longer exists.
-- Leaving them would make the admin list read "synced 2 hours ago · ok" for a provider with
-- zero rows and `first_sync_pending: true` — a completion signal read as a currency claim.
UPDATE git_providers
   SET last_sync_at = NULL, last_sync_status = NULL, last_sync_error = NULL;

-- ─── git_providers: drop post-normalization duplicates, then normalize ─────────
-- The normalization expression below mirrors `normalizeContainer` in
-- `src/connectors/git/providers/container.ts` (strip surrounding whitespace, then casefold),
-- and the equivalence is PROVABLE — but only for ASCII input. SQLite's `lower()` is
-- ASCII-only where JS `toLowerCase()` is Unicode-aware, and SQLite's bare `trim(X)` strips
-- ASCII spaces only, so the whitespace set is spelled out to match the characters JS
-- `String.prototype.trim` removes from an ASCII string (tab, LF, VT, FF, CR, space). For a
-- container whose every character is ASCII, those two facts make `sqlNormalize(x)` and
-- `normalizeContainer(x)` identical strings. For anything non-ASCII they can differ (NBSP,
-- BOM, a non-ASCII capital), which is what the fail-closed delete further down handles.
--
-- Two rows that differ only by case/whitespace are one workspace connected twice. Keep the
-- OLDEST (`created_at`, then `id` as a total tiebreak — same deterministic keep-rule as
-- 042): it is the row whose container the operator originally chose, and the newer one's
-- imported data has been reset above anyway. Both sides of the comparison are normalized so
-- the variants group together. `EXISTS` is total (a row is deleted only when a strictly
-- older sibling exists), which is why — exactly as in 042 — no NULL guards are needed.
DELETE FROM git_providers
 WHERE EXISTS (
    SELECT 1 FROM git_providers o
     WHERE o.type = git_providers.type
       AND lower(trim(o.container, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)))
         = lower(trim(git_providers.container, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)))
       AND (
            o.created_at < git_providers.created_at
            OR (o.created_at = git_providers.created_at AND o.id < git_providers.id)
       )
 );

-- Normalize the survivors. Restricted to ASCII-only containers, where the expression is
-- provably the same string `normalizeContainer` produces. `length(TEXT)` counts characters
-- while `length(BLOB)` counts bytes, so they are equal exactly when every character is
-- single-byte UTF-8, i.e. ASCII.
--
-- `updated_at` is deliberately NOT bumped: this is a re-spelling of a value the operator
-- already chose, not an edit they made, and the column is shown in the admin UI as "when
-- this connection was last changed".
UPDATE git_providers
   SET container = lower(trim(container, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)))
 WHERE length(container) = length(CAST(container AS BLOB));

-- FAIL CLOSED on a container SQL cannot canonicalize the way the code does — a non-ASCII
-- one, or one whose normalized form is empty. Such a row would be INVISIBLE to the running
-- system: `findProviderByTypeContainer` normalizes both sides in JS so it would still be
-- found (that is the code-side guarantee), but the row's stored spelling is one no write
-- path can ever produce, so the delete cascade keyed on `record.container` would retract
-- nothing and report success. Its data has already been reset above, so removing the
-- connection costs the admin one re-add — visible and recoverable — where keeping it costs
-- a permanent ghost. There is deliberately no attempt to guess a normalized form here: the
-- one place allowed to spell a container is `normalizeContainer`, and this file cannot call it.
DELETE FROM git_providers
 WHERE length(container) <> length(CAST(container AS BLOB))
    OR length(trim(container, ' ' || char(9) || char(10) || char(11) || char(12) || char(13))) = 0;

