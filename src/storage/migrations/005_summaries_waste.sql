CREATE TABLE summaries (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    scope_name TEXT NOT NULL,
    period_type TEXT NOT NULL,
    period_value TEXT NOT NULL,
    summary_text TEXT NOT NULL,
    model_used TEXT NOT NULL,
    data_hash TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    regenerated_count INTEGER DEFAULT 0
);

CREATE TABLE waste_alerts (
    id TEXT PRIMARY KEY,
    developer_id TEXT REFERENCES developers(id),
    team TEXT NOT NULL,
    alert_type TEXT NOT NULL,
    tool TEXT,
    details TEXT NOT NULL,
    monthly_waste REAL,
    detected_at TEXT NOT NULL,
    resolved_at TEXT,
    resolution TEXT
);
