CREATE TABLE developers (
    id TEXT PRIMARY KEY,
    external_ids TEXT,
    name TEXT NOT NULL,
    email TEXT,
    team TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE teams (
    name TEXT PRIMARY KEY,
    department TEXT,
    manager TEXT,
    created_at TEXT NOT NULL
);
