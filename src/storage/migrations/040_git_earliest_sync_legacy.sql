-- #233: mark LEGACY git providers whose earliest-synced floor is unrecoverable.
--
-- #229 added the "sync older history" backfill, which extends a provider's synced
-- window BACKWARD by additively merging the strictly-older slice
-- [new_target, earliest_watermark]. That merge is only correct because the slice is
-- DISJOINT from everything already imported — the watermark is what proves it.
--
-- Providers first synced by the #229 build (and later) record the real floor at
-- first-sync time, so their watermark is exact. A provider whose first sync PREDATES
-- #229 has a forward cursor but NO watermark, and its true floor
-- (`first_sync_time − window`) is not recoverable from any stored data:
--   * `sync_state` keeps only the forward cursor — not when the first sync ran, nor
--     the window it used.
--   * `git_snapshots` is UNIQUE(developer_id, date) with every provider's activity
--     merged into one row, so the earliest activity date cannot be attributed back
--     to a single provider.
-- Before this migration such a provider fell back to a LAZY DEFAULT (`now − 6mo`),
-- which is systematically too RECENT (the true floor is older by however long ago the
-- provider first synced). Too-recent is exactly the double-count direction: the first
-- backfill re-covers the overlap and additively inflates commit counts, permanently.
--
-- There is no safe value to seed. Guessing too-recent double-counts; guessing too-old
-- (e.g. an epoch sentinel) makes the span between the guess and the true floor
-- silently un-importable forever. So we do NOT guess: we record that the floor is
-- UNKNOWN and fail closed. The backfill route refuses a provider marked here with a
-- typed 409 instead of guessing, and an admin who knows the real floor declares it
-- with `toprope git set-history-floor` (which writes the exact watermark and clears
-- the marker below).
--
-- The marker lives in its own key namespace rather than being encoded as a sentinel
-- VALUE under `git_earliest_sync:` — a watermark column must only ever hold a real
-- instant, never a magic string that a future reader could compare as an ISO date.
--
-- Seeded ONLY for providers that have a forward cursor (`git_last_sync:…`) but no
-- watermark. A provider with no cursor has never synced at all: nothing is imported,
-- so its default floor is not a guess and its backfill stays disjoint by construction.
--
-- Idempotent: re-running is a no-op (NOT EXISTS + ON CONFLICT DO NOTHING).
INSERT INTO sync_state (key, value)
SELECT
    'git_earliest_unknown:' || substr(cursor_state.key, length('git_last_sync:') + 1),
    '1'
FROM sync_state AS cursor_state
WHERE cursor_state.key LIKE 'git_last_sync:%'
  AND NOT EXISTS (
      SELECT 1
      FROM sync_state AS watermark
      WHERE watermark.key =
          'git_earliest_sync:' || substr(cursor_state.key, length('git_last_sync:') + 1)
  )
ON CONFLICT(key) DO NOTHING;
