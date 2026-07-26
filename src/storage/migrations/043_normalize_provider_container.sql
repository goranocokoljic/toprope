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
--  1. `git_providers.container` is normalized IN PLACE, and rows that collide once
--     normalized are dropped (oldest kept). Provider rows deliberately SURVIVE: they hold
--     the encrypted token, and forcing an admin to re-paste every credential would be a
--     far worse outcome than a resync.
--  2. The container-keyed IMPORTED data (`raw_author_daily`, `pr_records`), the projected
--     `git_snapshots` cells and the `git_*` cursors are RESET — but only when this database
--     actually holds a non-normalized container. On a clean or already-lowercase install
--     every statement below is a no-op.
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
-- AFTERWARDS. If anything was reset, resync (admin UI → per-provider "Sync now" with an
-- explicit months window, for a controlled rebuild) and then run
--   toprope aggregate backfill --from <the earliest day the resync imported>
-- because the derived weekly/monthly/quarterly/yearly rollups are a SECOND projection that
-- the scheduler only recomputes for the just-closed period — every older period still holds
-- pre-reset totals, and `/api/aggregates` serves them.
--
-- NOTE ON IDEMPOTENCE: like 042 this file is DESTRUCTIVE and is not safe to re-execute
-- against a populated database. The `schema_migrations` ledger runs it exactly once.

-- ─── Capture "does anything need normalizing?" BEFORE changing anything ────────
-- Computed once, into a scratch table, because the deletes below would otherwise erase the
-- very evidence the later statements need to test (and because repeating a three-table
-- EXISTS five times invites the two copies to drift).
--
-- The normalization expression mirrors `normalizeContainer` in
-- `src/connectors/git/providers/container.ts`: strip surrounding whitespace, then casefold.
-- SQLite's bare `trim(X)` removes ASCII spaces ONLY, so the whitespace set is spelled out
-- to match JS `String.prototype.trim` on the characters that actually occur in a pasted
-- value (tab, LF, VT, FF, CR, space). SQLite's `lower()` is ASCII-only where JS
-- `toLowerCase()` is Unicode-aware; a container with non-ASCII uppercase letters would
-- therefore be normalized by the code but not detected here. Provider org/workspace/group
-- slugs are ASCII in all three platforms, so that gap is theoretical — and the code path is
-- the enforcing one either way.
CREATE TABLE _m043_reset (needed INTEGER NOT NULL);
INSERT INTO _m043_reset (needed)
SELECT CASE WHEN EXISTS (
    SELECT 1 FROM git_providers
     WHERE container <> lower(trim(container, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)))
    UNION ALL
    SELECT 1 FROM raw_author_daily
     WHERE container <> lower(trim(container, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)))
    UNION ALL
    SELECT 1 FROM pr_records
     WHERE container <> lower(trim(container, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)))
) THEN 1 ELSE 0 END;

-- ─── Conditional reset of the container-keyed data + its cursors ───────────────
-- Projected snapshot cells first: they are derived from the raw rows below, so removing
-- them before their source keeps the intermediate state readable ("nothing projected yet")
-- rather than "projected from rows that are gone".
DELETE FROM git_snapshots
 WHERE is_projected = 1
   AND (SELECT needed FROM _m043_reset) = 1;

DELETE FROM raw_author_daily WHERE (SELECT needed FROM _m043_reset) = 1;
DELETE FROM pr_records       WHERE (SELECT needed FROM _m043_reset) = 1;

DELETE FROM sync_state
 WHERE (SELECT needed FROM _m043_reset) = 1
   AND (key LIKE 'git_last_sync:%'
     OR key LIKE 'git_earliest_sync:%'
     OR key LIKE 'git_stall:%');

-- ─── git_providers: drop post-normalization duplicates, then normalize ─────────
-- Two rows that differ only by case/whitespace are one workspace connected twice. Keep the
-- OLDEST (`created_at`, then `id` as a total tiebreak — same deterministic keep-rule as
-- 042): it is the row whose container the operator originally chose, and the newer one's
-- imported data is being reset above anyway. Both `o.*` sides are normalized so the
-- comparison groups the variants; the `IS NOT NULL` guards keep a corrupt NULL row from
-- falling out of the keep-set in both directions and surviving as a duplicate that the
-- UNIQUE index would then reject.
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
 )
   AND type IS NOT NULL
   AND container IS NOT NULL
   AND id IS NOT NULL
   AND created_at IS NOT NULL;

-- `updated_at` is deliberately NOT bumped: this is a re-spelling of a value the operator
-- already chose, not an edit they made, and the column is shown in the admin UI as "when
-- this connection was last changed".
UPDATE git_providers
   SET container = lower(trim(container, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)))
 WHERE container <> lower(trim(container, ' ' || char(9) || char(10) || char(11) || char(12) || char(13)));

DROP TABLE _m043_reset;
