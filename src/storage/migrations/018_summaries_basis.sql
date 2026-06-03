-- Task 3.11 (#80): persist the maturity basis + data-quality tier on each summary
-- at generation time.
--
-- The Phase 3 API must label a summary as a "git-based estimate" (the basis) and
-- expose the data-quality tier it was computed at. Recomputing those from
-- snapshots on every read meant re-folding the whole member pool per list row;
-- recording them here makes the read an O(1) column lookup and — more honestly —
-- captures what the narrative was actually written under, not a value recomputed
-- later. Nullable with no default: the generator sets them explicitly, and any
-- pre-Phase-3 row stays NULL until it is regenerated.
ALTER TABLE summaries ADD COLUMN ai_maturity_basis TEXT;
ALTER TABLE summaries ADD COLUMN data_quality TEXT;
