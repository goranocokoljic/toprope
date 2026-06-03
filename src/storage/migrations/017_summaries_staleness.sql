-- Task 3.9 (#78): Summary staleness detection columns.
--
-- The summaries table (migration 005) already carries data_hash — the V1 "hash
-- of input data for regeneration detection". Phase 3 names the input-payload hash
-- explicitly as input_hash and adds an is_stale flag the staleness check raises
-- when a summary's underlying aggregate changed after it was written (e.g.
-- late-arriving data recomputed the period). Both are nullable / default 0 so the
-- existing rows from V1 remain valid.
--
-- input_hash mirrors data_hash on write (the generator stores the same payload
-- hash in both), so the legacy column stays populated while input_hash becomes
-- the column the staleness comparison reads.
ALTER TABLE summaries ADD COLUMN input_hash TEXT;
ALTER TABLE summaries ADD COLUMN is_stale INTEGER DEFAULT 0;
