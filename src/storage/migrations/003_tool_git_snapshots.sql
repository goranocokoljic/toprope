CREATE TABLE tool_snapshots (
    id TEXT PRIMARY KEY,
    developer_id TEXT NOT NULL REFERENCES developers(id),
    date TEXT NOT NULL,
    tool TEXT NOT NULL,
    data_source TEXT NOT NULL,
    data_quality TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0,
    interaction_count INTEGER DEFAULT 0,
    acceptance_count INTEGER DEFAULT 0,
    acceptance_rate REAL,
    features_used TEXT,
    models_used TEXT,
    estimated_cost REAL,
    tokens_consumed INTEGER,
    raw_data TEXT,
    UNIQUE(developer_id, date, tool)
);

CREATE TABLE git_snapshots (
    id TEXT PRIMARY KEY,
    developer_id TEXT NOT NULL REFERENCES developers(id),
    date TEXT NOT NULL,
    commits INTEGER DEFAULT 0,
    lines_added INTEGER DEFAULT 0,
    lines_removed INTEGER DEFAULT 0,
    files_changed INTEGER DEFAULT 0,
    prs_opened INTEGER DEFAULT 0,
    prs_merged INTEGER DEFAULT 0,
    review_comments_given INTEGER DEFAULT 0,
    avg_time_to_merge_hours REAL,
    code_churn_rate REAL,
    ai_signature_score REAL,
    avg_commit_size REAL,
    commit_burst_count INTEGER DEFAULT 0,
    UNIQUE(developer_id, date)
);
