-- Team archival (Task 2.13 / #48 — Admin Management UI).
-- Teams are archived rather than deleted so historical snapshots and
-- subscriptions that reference the team by name stay intact. An archived team
-- is hidden from active management lists but never removed.
ALTER TABLE teams ADD COLUMN archived_at TEXT;
