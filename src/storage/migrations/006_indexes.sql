CREATE INDEX idx_tool_snapshots_date ON tool_snapshots(date);
CREATE INDEX idx_tool_snapshots_dev_date ON tool_snapshots(developer_id, date);
CREATE INDEX idx_git_snapshots_date ON git_snapshots(date);
CREATE INDEX idx_git_snapshots_dev_date ON git_snapshots(developer_id, date);
CREATE INDEX idx_weekly_agg_week ON weekly_aggregates(week_start);
CREATE INDEX idx_monthly_agg_month ON monthly_aggregates(month);
CREATE INDEX idx_subscriptions_dev ON subscriptions(developer_id);
CREATE INDEX idx_waste_alerts_team ON waste_alerts(team);
