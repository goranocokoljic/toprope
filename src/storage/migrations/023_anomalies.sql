-- Anomaly detection engine (Task 4.7 / #102).
--
-- Stores anomalies detected when a developer or team metric deviates
-- significantly from its baseline. Two detection methods (statistical z-score
-- and percentage-change), tier-aware via `basis`, with a minimum-baseline guard
-- enforced in the engine (not the schema) so early-weeks data never fires.
--
-- Idempotency is enforced by the UNIQUE(scope, scope_id, metric, period) index:
-- re-running a period UPSERTs the single row for that coordinate rather than
-- inserting a duplicate. `status` is human state (open → acknowledged →
-- resolved) and is deliberately preserved across re-detection of the same
-- coordinate (see src/anomaly/store.ts).
CREATE TABLE anomalies (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('developer', 'team')),
    scope_id TEXT NOT NULL,                 -- developer_id or team name
    metric TEXT NOT NULL,                   -- commits | prs_merged | churn |
                                            -- ai_signature | interactions |
                                            -- acceptance_rate | cost
    period TEXT NOT NULL,                   -- the period evaluated (week_start)
    method TEXT NOT NULL CHECK (method IN ('statistical', 'percentage_change')),
    observed_value REAL NOT NULL,
    expected_value REAL NOT NULL,           -- mean (statistical) or prior baseline
    deviation REAL NOT NULL,                -- std-devs (statistical) or % change
    severity TEXT NOT NULL CHECK (severity IN ('info', 'notable', 'high')),
    basis TEXT NOT NULL CHECK (basis IN ('git_estimate', 'measured')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
    detected_at TEXT NOT NULL
);

-- One anomaly per (scope, scope_id, metric, period): the idempotency key.
CREATE UNIQUE INDEX idx_anomalies_coordinate
    ON anomalies (scope, scope_id, metric, period);

-- Surfacing (Task 4.8) lists open anomalies by scope and recency.
CREATE INDEX idx_anomalies_scope_status
    ON anomalies (scope, scope_id, status);
CREATE INDEX idx_anomalies_period
    ON anomalies (period);
