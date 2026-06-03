-- Task 3.2 (#71): Quarterly + Yearly rollups.
--
-- yearly_aggregates is new (team-level, one row per team per calendar year).
-- quarterly_aggregates already exists from the V1 schema (migration 004) but
-- predates the ai_maturity_basis column the quarterly rollup writes, so add it
-- here. The column is nullable with no default — the rollup sets it explicitly
-- ('git_estimate' at launch) and existing rows stay NULL until recomputed.
ALTER TABLE quarterly_aggregates ADD COLUMN ai_maturity_basis TEXT;

CREATE TABLE yearly_aggregates (
    id TEXT PRIMARY KEY,
    team TEXT NOT NULL,
    year TEXT NOT NULL,                    -- YYYY
    developer_count INTEGER DEFAULT 0,
    active_developer_count INTEGER DEFAULT 0,
    utilization_rate REAL,                 -- active / total
    total_subscription_cost REAL,
    total_commits INTEGER DEFAULT 0,
    total_prs_merged INTEGER DEFAULT 0,
    avg_code_churn REAL,
    avg_ai_signature_score REAL,
    cost_per_pr REAL,
    ai_maturity_score REAL,                -- from Task 3.4 (null until computed)
    ai_maturity_basis TEXT,                -- 'git_estimate' | 'mixed' | 'measured'
    utilization_rate_delta REAL,           -- from Task 3.3 (null until computed)
    maturity_score_delta REAL,
    computed_at TEXT NOT NULL,
    UNIQUE(team, year)
);
