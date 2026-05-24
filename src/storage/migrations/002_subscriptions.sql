CREATE TABLE subscriptions (
    id TEXT PRIMARY KEY,
    developer_id TEXT NOT NULL REFERENCES developers(id),
    tool TEXT NOT NULL,
    plan TEXT,
    billing_model TEXT NOT NULL,
    monthly_cost REAL,
    seat_assigned_at TEXT,
    seat_revoked_at TEXT,
    data_source TEXT NOT NULL
);
