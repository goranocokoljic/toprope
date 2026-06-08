-- Richer expense import (Task 4.5). Two changes:
--
-- 1. subscriptions.billing_model_inferred — flags a subscription whose billing
--    model was *inferred* (from the import profile / heuristics) rather than read
--    verbatim from the expense row. 0 = explicit/known, 1 = inferred (treat as a
--    best guess that an admin may want to confirm).
--
-- 2. expense_charges — an append-only ledger of every charge row seen by the
--    importer. It powers two things basic CSV import could not:
--      - Dedup: the same charge re-imported (developer+tool+period+amount) is
--        detected via dedup_key and skipped instead of double-counted.
--      - Unmatched-resolution queue: rows whose developer could not be matched
--        are recorded with match_status = 'unmatched' (developer_id NULL) so they
--        are queued for manual resolution rather than silently dropped.
ALTER TABLE subscriptions ADD COLUMN billing_model_inferred INTEGER NOT NULL DEFAULT 0;

CREATE TABLE expense_charges (
    id TEXT PRIMARY KEY,
    -- developer+tool+period+amount fingerprint; unique charges only. A re-import
    -- of the same charge matches an existing dedup_key and is reported as a
    -- duplicate without a second ledger row.
    dedup_key TEXT NOT NULL,
    developer_id TEXT REFERENCES developers(id),  -- NULL while unmatched
    raw_email TEXT,                  -- email as seen in the row (for re-matching)
    raw_name TEXT,                   -- name as seen in the row (for re-matching)
    tool TEXT NOT NULL,
    plan TEXT,
    amount REAL,                     -- raw charge amount as imported
    currency TEXT,
    period TEXT,                     -- normalized billing period (e.g. 2026-06) or ''
    charge_type TEXT NOT NULL,       -- recurring_monthly | recurring_annual | one_time
    monthly_cost REAL,               -- normalized monthly cost (NULL for one_time)
    billing_model TEXT NOT NULL,
    billing_model_inferred INTEGER NOT NULL DEFAULT 0,
    match_status TEXT NOT NULL,      -- matched | unmatched
    match_method TEXT,               -- email | git_email | name | manual
    source_profile TEXT NOT NULL,
    source_file TEXT,
    resolved_at TEXT,                -- set when an unmatched row is resolved
    created_at TEXT NOT NULL
);

CREATE INDEX idx_expense_charges_dedup ON expense_charges(dedup_key);
CREATE INDEX idx_expense_charges_match_status ON expense_charges(match_status);
