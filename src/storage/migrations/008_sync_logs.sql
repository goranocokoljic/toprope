CREATE TABLE sync_logs (
    id TEXT PRIMARY KEY,
    connector TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    records_written INTEGER NOT NULL DEFAULT 0,
    records_skipped INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    errors TEXT,
    status TEXT NOT NULL DEFAULT 'running'
);

CREATE INDEX idx_sync_logs_connector ON sync_logs(connector);
CREATE INDEX idx_sync_logs_started_at ON sync_logs(started_at);
