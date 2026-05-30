-- Per-user authentication (Task 2.2 / #37).
-- Phase 1 used a single admin password in config; Phase 2 introduces real
-- accounts with roles. A developer-role user is linked to a developers row so
-- their session can be scoped strictly to their own data.
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'developer')),
    -- SET NULL so removing a developer leaves their login intact as an
    -- unlinked account rather than failing the delete or orphaning the FK.
    developer_id TEXT REFERENCES developers(id) ON DELETE SET NULL,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    deactivated_at TEXT
);

-- Opaque server-side sessions. The session id is the bearer token itself (a
-- 256-bit random value); logout deletes the row and expiry is checked against
-- expires_at. Cascade so deactivating/removing a user drops their sessions.
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
