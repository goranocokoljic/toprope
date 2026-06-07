-- Self-reported AI usage (Task 4.1). Captures usage the admin APIs can't reach:
-- personal/reimbursed accounts, tools without integration, or AI use that
-- produces no commits (chat, debugging, learning). These raw entries are kept
-- verbatim here and aggregated into tool_snapshots (data_source = "self_report"),
-- where API data always wins for the same developer/date/tool.
CREATE TABLE self_reports (
    id TEXT PRIMARY KEY,
    developer_id TEXT NOT NULL REFERENCES developers(id),
    date TEXT NOT NULL,                  -- YYYY-MM-DD (the usage date)
    tool TEXT NOT NULL,                  -- copilot|cursor|claude_code|windsurf|chatgpt|other
    minutes INTEGER,                     -- optional rough effort
    task_descriptor TEXT,                -- optional private free text (never sent to models)
    source_interface TEXT NOT NULL,      -- cli|slack
    created_at TEXT NOT NULL
);

CREATE INDEX idx_self_reports_dev_date ON self_reports(developer_id, date);
CREATE INDEX idx_self_reports_dev_date_tool ON self_reports(developer_id, date, tool);
