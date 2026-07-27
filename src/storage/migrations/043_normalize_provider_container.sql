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
--  1. `git_providers` rows that cannot survive canonically are removed: a container that is
--     blank or non-ASCII once trimmed (SQLite cannot casefold it the way JS does), or a
--     duplicate spelling of an older sibling. Everything else is RE-SPELLED in place, so a
--     mis-cased or space-padded connection keeps its encrypted token — re-pasting every
--     credential would be a worse upgrade than a resync.
--  2. The container-keyed IMPORTED data (`raw_author_daily`, `pr_records`), the projected
--     `git_snapshots` cells and the `git_*` cursors are RESET — UNCONDITIONALLY, exactly as
--     042 did one migration ago.
--  3. Either outcome — a reset, or a removed connection — raises a `git_data_reset_pending`
--     notice that `toprope doctor` fails on until an operator acknowledges the rebuild.
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
-- than the code's rule (SQLite `lower()` is ASCII-only), so a conditional probe would MISS
-- exactly the invisible rows that matter and leave their data and cursors in place —
-- re-arming the double-count from inside the migration meant to end it. 042 reset
-- unconditionally one migration ago; matching it keeps one contract ("upgrading rebuilds git
-- data") instead of two.
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
-- ─── AFTERWARDS ──────────────────────────────────────────────────────────────────────
--  (1) RESYNC. Admin UI → per-provider "Sync now" with an explicit months window gives a
--      controlled rebuild. Config-file providers are read-only in the UI and sync only via the
--      pipeline — use `toprope sync git` for those.
--  (2) REBUILD THE DERIVED ROLLUPS, which this file does not touch. The
--      weekly/monthly/quarterly/yearly aggregates plus `pr_review_metrics` and
--      `coaching_signals` are a SECOND projection that the scheduler only recomputes for the
--      just-closed period, so every older period still holds pre-reset totals and
--      `/api/aggregates` serves them. Run
--        toprope aggregate backfill --from <the earliest day ANY pre-reset rollup covers>
--      and note the `--from`: it must reach back to the oldest period that holds stale totals,
--      NOT merely to the start of the window the resync just imported. Choosing a narrow resync
--      window in (1) makes that more important, not less, because nothing else clears a period
--      outside `[from, to]`. `aggregate backfill` also does NOT cover `pr_review_metrics` or
--      `coaching_signals`; only the next scheduled weekly/monthly job refreshes those, and only
--      for its recent trailing window, so older periods of those two stay stale.
--  (3) CHECK Admin → Connectors → Git for a MISSING provider — see step 1 above.
--  (4) ACKNOWLEDGE with `toprope git clear-reset-notice`, which is what stops `toprope doctor`
--      from failing. The same text is on the notice itself, so an operator who never reads this
--      file still gets it.
--
-- NOTE ON IDEMPOTENCE: like 042 this file is DESTRUCTIVE and is not safe to re-execute
-- against a populated database. The `schema_migrations` ledger runs it exactly once.

-- ─── git_providers: prune what cannot survive canonically ──────────────────────
-- Done FIRST, before anything else, for one reason: the operator signal below is gated on
-- `changes()`, which is the row count of the immediately preceding statement. Removing a
-- connection is the most consequential thing this file does — its encrypted token is not
-- recoverable and its repo include/exclude list goes with it — so that count has to be the one
-- the notice reads.
--
-- The normalization mirrors `normalizeContainer` in
-- `src/connectors/git/providers/container.ts`: strip surrounding whitespace, then casefold.
--
-- The WHITESPACE half is exact, not approximate. SQLite's bare `trim(X)` strips ASCII spaces
-- only, so the character set is spelled out to be the full set JS `String.prototype.trim`
-- removes: the ASCII controls and space, every Unicode Zs (U+00A0 NBSP, U+1680, U+2000–U+200A,
-- U+202F, U+205F, U+3000), the line separators U+2028/U+2029, and U+FEFF. NBSP and U+FEFF matter:
-- they are the likeliest invisible characters in a value pasted out of a rendered page, and JS
-- strips both — so a container padded with one is RE-SPELLED at the bottom of this file, not
-- mistaken for un-normalizable and deleted. (U+200B ZWSP is deliberately absent: JS does not
-- strip it either, so it is part of the container's name under both rules.)
--
-- The CASEFOLD half is exact only for ASCII, because SQLite's `lower()` is ASCII-only where JS
-- `toLowerCase()` is Unicode-aware. So this statement removes exactly the rows that cannot be
-- re-spelled correctly, and the final UPDATE then re-spells every survivor unguarded.
--
-- ONE statement, TWO reasons a row goes:
--
--  (a) Its trimmed container is blank, or still holds a non-ASCII character. Storing a guessed
--      spelling would be worse than removing the row: the value would be one no write path can
--      ever produce, so the delete cascade keyed on `record.container` would retract nothing and
--      report success — a permanent ghost. There is deliberately no attempt to guess; the one
--      place allowed to spell a container is `normalizeContainer`, and this file cannot call it.
--      (`length(TEXT)` counts characters while `length(BLOB)` counts bytes, so they are equal
--      exactly when every character is single-byte UTF-8. An embedded NUL also compares unequal,
--      since `length(TEXT)` stops at the first one — that direction is safe, it lands here.)
--      Note this is broader than strictly necessary: an already-lowercase non-ASCII container
--      would normalize identically under both rules. It is unreachable in practice (GitHub org
--      logins, Bitbucket workspace slugs and GitLab group paths are ASCII), and erring toward
--      "remove and let the admin re-add" is the fail-closed direction.
--
--  (b) A STRICTLY OLDER sibling normalizes to the same container, i.e. one workspace was
--      connected twice under two spellings. Keep the oldest (`created_at`, then `id` as a total
--      tiebreak — the same deterministic keep-rule as 042): it is the row whose container the
--      operator originally chose. `EXISTS` is total (a row goes only when such a sibling exists),
--      which is why — exactly as in 042 — no NULL guards are needed.
--
--      The sibling must itself SURVIVE clause (a), or a canonical row could be dropped in favour
--      of an older one being deleted in the same breath, freeing the container entirely. Both
--      clauses are evaluated against the pre-statement snapshot, so that qualifier is what makes
--      the two reasons compose instead of interfering.
--
-- Merging the two reasons into ONE statement is not just shorter than two DELETEs — it is what
-- lets a SINGLE `changes()`-gated notice cover both. Split, the second delete's count is the only
-- one `changes()` can see, and a deduped connection would disappear with no signal anywhere.
DELETE FROM git_providers
 WHERE length(trim(container, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))) = 0
    OR length(trim(container, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))
     <> length(CAST(trim(container, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) AS BLOB))
    OR EXISTS (
        SELECT 1 FROM git_providers o
         WHERE o.type = git_providers.type
           AND lower(trim(o.container, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))
             = lower(trim(git_providers.container, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))
           AND length(trim(o.container, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))) > 0
           AND length(trim(o.container, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))
             = length(CAST(trim(o.container, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) AS BLOB))
           AND (
                o.created_at < git_providers.created_at
                OR (o.created_at = git_providers.created_at AND o.id < git_providers.id)
           )
       );

-- ─── The operator signal (raised BEFORE the resets erase its evidence) ─────────
-- A pure-SQL migration cannot print, and `runMigrations` reports only a count — so the one
-- durable place to leave "you owe a resync + a rollup rebuild" is `sync_state`, which
-- `toprope doctor` reads. Without it the only evidence of this reset is a dashboard quietly
-- serving pre-reset rollups over zero snapshots (the graduated #235 rule: a completion signal
-- is not a currency claim).
--
-- The RESET below is unconditional; the NOTICE is not. It fires only when there was actually
-- something to lose, so a fresh install is not told to rebuild data it never had.
--
-- `changes() > 0` is the first arm: it is the row count of the DELETE immediately above, so a
-- removed connection always raises the notice — even on an install that held no git data at all,
-- which is precisely the never-synced-duplicate case. (A zero-row DELETE sets `changes()` to 0
-- rather than retaining an earlier statement's count.)
--
-- The remaining arms answer "did this database ever hold git data" — which needs no
-- normalization logic at all, NOT "is any container mis-spelled", which SQL cannot decide the
-- way the code does. WHY THEY DO NOT PROBE ONLY THE TABLES THIS FILE EMPTIES: migration 042
-- (#264) emptied `raw_author_daily`, `pr_records`, `git_snapshots` and the `git_*` cursors — and
-- it runs in the SAME `runMigrations` pass, immediately before this one, leaving no marker of its
-- own. So on the pre-042 upgrade path (the install with the MOST to lose) all four are already
-- empty by the time this statement runs, and a predicate built only from them would report
-- "nothing to rebuild" for a database whose rollups still hold months of pre-reset totals. The
-- two extra probes are the ones 042 does not touch:
--   * `git_providers.last_sync_at` — written only by a git sync, and nulled by THIS file
--     further down, so it has to be read here, before that UPDATE;
--   * `weekly_aggregates.total_commits` — git-derived and surviving both resets, so a non-zero
--     value is direct evidence of a rollup that is now stale. A tool-only install (Copilot and
--     no git) has rows here with `total_commits = 0` and correctly raises nothing.
--
-- `ON CONFLICT` because the key is deliberately migration-agnostic: a later reset migration will
-- write it too, and a marker already present must be re-stamped rather than abort the migration
-- (`runMigrations` wraps each file in a transaction, so an abort would retry and fail identically
-- at every subsequent server start).
INSERT INTO sync_state (key, value)
SELECT 'git_data_reset_pending', '043'
 WHERE changes() > 0
    OR EXISTS (SELECT 1 FROM raw_author_daily)
    OR EXISTS (SELECT 1 FROM pr_records)
    OR EXISTS (SELECT 1 FROM git_snapshots WHERE is_projected = 1)
    OR EXISTS (
        SELECT 1 FROM sync_state
         WHERE key LIKE 'git_last_sync:%'
            OR key LIKE 'git_earliest_sync:%'
            OR key LIKE 'git_stall:%'
       )
    OR EXISTS (SELECT 1 FROM git_providers WHERE last_sync_at IS NOT NULL)
    OR EXISTS (SELECT 1 FROM weekly_aggregates WHERE total_commits > 0)
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

-- Re-spell every survivor. UNGUARDED, and provably safe: the DELETE at the top of this file
-- removed every row whose trimmed container is blank or non-ASCII, so `lower(trim(x))` here
-- produces exactly the string `normalizeContainer(x)` does; and no two survivors can collide,
-- because `normalizeContainer` is idempotent (`old(Y) = norm(X)` implies `norm(Y) = norm(X)`,
-- which the dedupe clause already removed).
--
-- `updated_at` is deliberately NOT bumped: this is a re-spelling of a value the operator already
-- chose, not an edit they made, and the column is shown in the admin UI as "when this connection
-- was last changed".
UPDATE git_providers
   SET container = lower(trim(container, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)));
