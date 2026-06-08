-- Expense reconciliation (Task 4.4 / #99).
--
-- reconciliation_results records every mismatch found when matching imported
-- expense charges against the subscription registry for a period, so a manager
-- can trust the platform's cost numbers. Three mismatch types:
--   - expense_no_subscription : a recurring expense exists for a developer/tool
--     but no active subscription is registered (untracked / unregistered seat).
--   - subscription_no_expense : an active subscription exists but no matching
--     expense charge was seen. Only raised for billing models expected to appear
--     in a reimbursement feed (reimbursed/personal); company-managed seats are
--     NOT flagged, since they legitimately never show up in reimbursement data.
--   - cost_discrepancy : both exist but the amounts differ beyond a tolerance.
--
-- Each result starts 'open' and is moved to 'resolved' (with a note) or 'ignored'
-- via the admin surface. Re-running reconciliation does not duplicate a result
-- that is already open or ignored for the same (period, type, developer, tool)
-- condition, so the queue stays idempotent.
CREATE TABLE reconciliation_results (
    id TEXT PRIMARY KEY,
    run_at TEXT NOT NULL,
    period TEXT NOT NULL,                 -- the month/period reconciled (YYYY-MM)
    result_type TEXT NOT NULL,            -- expense_no_subscription |
                                          -- subscription_no_expense |
                                          -- cost_discrepancy
    developer_id TEXT REFERENCES developers(id),
    tool TEXT,
    expense_amount REAL,
    registry_amount REAL,
    details TEXT,                         -- JSON specifics
    status TEXT NOT NULL DEFAULT 'open',  -- open | resolved | ignored
    resolution TEXT,                      -- free text / chosen action
    resolved_at TEXT
);

-- The idempotency lookup keys on the condition identity (period, type, developer,
-- tool) filtered by status; index it so re-runs over a large history stay cheap.
CREATE INDEX idx_reconciliation_condition
    ON reconciliation_results(period, result_type, developer_id, tool, status);

-- The admin queue lists by status (open first); index supports that filter.
CREATE INDEX idx_reconciliation_status ON reconciliation_results(status);
