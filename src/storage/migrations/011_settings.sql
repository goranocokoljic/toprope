-- Settings & per-user preferences (Task 2.16 / #51).
--
-- Two-level configuration: a global default row plus optional per-team
-- overrides. The `scope` column distinguishes the two; `scope_name` holds the
-- team name for team rows and is the empty string for global rows (kept as a
-- non-null sentinel so it can sit in the primary key). Values are stored as
-- JSON text and coerced back to their declared type (bool/number) by the
-- settings registry, so the schema stays type-agnostic as new keys are added.
CREATE TABLE settings (
    scope TEXT NOT NULL CHECK (scope IN ('global', 'team')),
    scope_name TEXT NOT NULL DEFAULT '',
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope, scope_name, key)
);

-- Team overrides are keyed by team name (scope_name) rather than a column FK,
-- because the same table also holds global rows (scope_name = ''), which no
-- team row could satisfy. This trigger gives team rows the equivalent of
-- ON DELETE CASCADE: removing a team drops its override rows, so a later team
-- that reuses the name can't silently inherit ghost overrides.
CREATE TRIGGER settings_team_cascade_delete
AFTER DELETE ON teams
BEGIN
    DELETE FROM settings WHERE scope = 'team' AND scope_name = OLD.name;
END;

-- Per-user UI preferences (e.g. default_time_range, dark_mode). Cascade so a
-- removed user's preferences are cleaned up with their account.
CREATE TABLE user_preferences (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
);
