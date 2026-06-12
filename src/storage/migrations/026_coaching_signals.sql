-- Task 5.1 (#122): Available-Data Coaching.
--
-- coaching_signals: generated coaching observations grounded in data the
-- platform already has (git_snapshots churn, tool_snapshots acceptance, the
-- Phase 4 adoption journey). One row per (developer, period, signal_type),
-- private to the developer — managers only ever see aggregate trends derived
-- from these rows, never an individual's observation text.
--
-- Like pr_review_metrics this is NOT append-only: the generator recomputes a
-- trailing window of periods each sync (a churn/acceptance baseline keeps
-- converging as more history lands), so a period's signals are replaced in
-- place. The UNIQUE(developer_id, period, signal_type) key makes that recompute
-- idempotent and documents that at most one signal of each type exists per
-- developer per period.
CREATE TABLE coaching_signals (
    id TEXT PRIMARY KEY,
    developer_id TEXT NOT NULL REFERENCES developers(id),
    period TEXT NOT NULL,                 -- YYYY-Www or YYYY-MM
    signal_type TEXT NOT NULL,            -- churn_reflection | acceptance_trend |
                                          -- journey_coaching | personal_insight
    basis TEXT NOT NULL,                  -- git_estimate | measured
    observation TEXT NOT NULL,            -- the coaching text (private to dev)
    metric_context TEXT,                  -- JSON: the numbers behind it
    created_at TEXT NOT NULL,
    UNIQUE(developer_id, period, signal_type)
);

CREATE INDEX idx_coaching_signals_dev_period ON coaching_signals(developer_id, period);
