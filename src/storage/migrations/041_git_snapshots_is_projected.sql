-- DO1.3 (#253): mark which git_snapshots rows are PROJECTION-OWNED (Epic DO1 / #250).
--
-- From #253 on, `git_snapshots` is a deterministic projection of `raw_author_daily`
-- through the identity map, not a directly-accumulated table. A re-projection of a
-- date must therefore be able to RETRACT a cell that no longer has any raw rows
-- resolving to it — otherwise re-mapping an author from developer A to developer B
-- adds the history to B while leaving a stale copy on A (a permanent double-count).
--
-- Retraction has to be surgical, though: rows this projection did not produce must
-- survive it untouched. Two kinds exist —
--   1. rows written by a sync that ran BEFORE this migration (no raw authorship was
--      retained then, so no projection can ever reconstruct them), and
--   2. rows written directly by fixtures/imports outside the git sync path.
-- Both would be silently deleted by a blind "delete every cell with no projection".
--
-- `is_projected` is that provenance bit, and deliberately a STABLE flag rather than a
-- `projected_at` timestamp: projection must be byte-idempotent (re-projecting the same
-- raw store + identity map yields an identical row), which a per-run instant would
-- break. Default 0 = "not projection-owned", so every pre-existing row is preserved by
-- construction, and only rows the projection itself stamps with 1 are ever retracted.
--
-- KNOWN, BOUNDED UPGRADE CAVEAT: a legacy (is_projected = 0) cell is still OVERWRITTEN
-- — not merged with — when the projection later produces a value for that same
-- (developer, date). Because the git cursor is forward-only, the only cells that can be
-- both legacy-accumulated and re-projected are the days straddling the upgrade (the
-- partially-synced current day, or a day a backfill re-covers); every older day is
-- never re-fetched and so is never projected. See projectSnapshots in projection.ts.
ALTER TABLE git_snapshots ADD COLUMN is_projected INTEGER NOT NULL DEFAULT 0;

-- The retraction scan is "which projection-owned cells exist on these dates" — served
-- by the existing idx_git_snapshots_date; this partial index keeps it to the (usually
-- much smaller) projected subset without touching the legacy rows at all.
CREATE INDEX IF NOT EXISTS idx_git_snapshots_projected_date
    ON git_snapshots(date) WHERE is_projected = 1;
