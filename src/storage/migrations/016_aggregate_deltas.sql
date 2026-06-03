-- Task 3.3 (#72): Period-over-period delta columns.
--
-- Deltas store each aggregate's change from the previous comparable period.
-- weekly_aggregates carried no delta columns yet, so all seven per-developer
-- deltas are added here. monthly_aggregates already had interaction_delta_pct,
-- acceptance_rate_delta, commit_velocity_delta_pct, and churn_rate_delta from
-- the V1 schema (migration 004); only the three remaining ones are added.
--
-- quarterly_aggregates and yearly_aggregates already carry utilization_rate_delta
-- and maturity_score_delta (migrations 004 / 015) — no schema change needed there;
-- Task 3.3 populates those existing columns.
--
-- All delta columns are nullable with no default: the first period for a row has
-- no prior period to compare against and stays NULL (never a fabricated 0).

-- weekly_aggregates — all seven per-developer deltas (none existed before).
ALTER TABLE weekly_aggregates ADD COLUMN interaction_delta_pct REAL;
ALTER TABLE weekly_aggregates ADD COLUMN acceptance_rate_delta REAL;
ALTER TABLE weekly_aggregates ADD COLUMN commit_velocity_delta_pct REAL;
ALTER TABLE weekly_aggregates ADD COLUMN prs_merged_delta_pct REAL;
ALTER TABLE weekly_aggregates ADD COLUMN churn_rate_delta REAL;
ALTER TABLE weekly_aggregates ADD COLUMN ai_signature_delta REAL;
ALTER TABLE weekly_aggregates ADD COLUMN cost_per_pr_delta_pct REAL;

-- monthly_aggregates — the three not already present from migration 004.
ALTER TABLE monthly_aggregates ADD COLUMN prs_merged_delta_pct REAL;
ALTER TABLE monthly_aggregates ADD COLUMN ai_signature_delta REAL;
ALTER TABLE monthly_aggregates ADD COLUMN cost_per_pr_delta_pct REAL;
