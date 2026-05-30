-- Plan-change events (Task 2.14 / #49 — Subscription Lifecycle Handling).
--
-- Every plan upgrade/downgrade or tool switch records a row here in addition to
-- the revoke-old + create-new subscription rows. This preserves an explicit,
-- queryable transition log: the before/after plan and cost, when it happened,
-- and (for tool switches) which tool was left behind.
--
-- The table is intentionally a superset of the columns the Plan-ROI feature
-- (Task 2.15) will consume. The baseline_usage / post_change_usage / evaluated_at
-- / roi_flagged columns are written by 2.14 as NULL / 0 and filled in later by the
-- ROI evaluator; 2.14 only populates the transition facts.
--
-- old_plan / old_monthly_cost / old_tool are NULL when there was no prior
-- subscription (a genuinely new seat does NOT create an event — only a change
-- to an existing seat does). new_plan / new_monthly_cost are nullable because
-- subscriptions themselves allow a null plan and a null cost (e.g. an
-- expense-only record with no resolved price); we still record the transition
-- rather than crash on the missing value.
CREATE TABLE plan_change_events (
    id TEXT PRIMARY KEY,
    developer_id TEXT NOT NULL REFERENCES developers(id),
    tool TEXT NOT NULL,                 -- the tool of the NEW subscription
    old_tool TEXT,                      -- set only for a tool switch (else NULL = same tool)
    old_plan TEXT,
    new_plan TEXT,
    old_monthly_cost REAL,
    new_monthly_cost REAL,
    changed_at TEXT NOT NULL,
    baseline_usage REAL,                -- avg daily usage in N days before change (filled by 2.15)
    baseline_window_days INTEGER,
    post_change_usage REAL,             -- avg daily usage after settling period (filled by 2.15)
    evaluated_at TEXT,                  -- when post-change comparison ran (NULL until settled)
    roi_flagged INTEGER NOT NULL DEFAULT 0
);

-- Adoption-journey and ROI queries both fetch a single developer's events in
-- chronological order.
CREATE INDEX idx_plan_change_events_developer
    ON plan_change_events(developer_id, changed_at);
