-- Task 5.9 (#130): Showcase Browse/Discovery + Governance.
--
-- Browse/discovery and owner unpublish need NO new schema: they read and
-- transition the existing `showcase_examples` rows (status published ->
-- unpublished/removed; access scoping reads scope/scope_target). This migration
-- adds only the governance AUDIT + AUTHOR-NOTIFICATION trail that team-lead
-- REMOVAL requires.
--
-- `showcase_removals` is append-only and serves two jobs at once:
--
--   * AUDIT — an immutable record of every team-lead removal: which example, who
--     removed it, the team they acted for, an optional reason, and when. A
--     developer can never remove on another developer's behalf via this table;
--     it records only the moderation action a team lead is permitted to take.
--   * AUTHOR NOTIFICATION — the author's own "an example of mine was removed"
--     feed reads straight from here (filtered to their id). There is no separate
--     notifications store: the same logged row the audit keeps is what the author
--     is shown, so a removal can never happen silently behind the author's back
--     (mirrors how key_recovery_log is both the audit and the developer's view).
--
-- The owner-initiated UNPUBLISH is deliberately NOT logged here: it is the
-- author's own action on their own example, needs no audit-against-the-actor and
-- no notification-to-themselves. Only the team-lead removal — an action BY
-- someone OTHER than the author — earns a row.
CREATE TABLE showcase_removals (
    id TEXT PRIMARY KEY,
    -- The example that was removed. CASCADE so the audit row dies with the
    -- example if the example is later hard-deleted (e.g. via the author CASCADE).
    example_id TEXT NOT NULL REFERENCES showcase_examples(id) ON DELETE CASCADE,
    -- The author whose example it was — the recipient of the notification. CASCADE
    -- so a removed developer carries no orphaned audit (matches every sibling FK).
    author_developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
    -- WHO removed it: the acting team lead's user id + email, captured from their
    -- session so the actor is never anonymous. A user id (the manager/admin role),
    -- NOT a developer id — team leads act through the manager-facing surface.
    removed_by_user_id TEXT NOT NULL,
    removed_by_email TEXT NOT NULL,
    -- The team whose showcase the lead acted for. The removal is only permitted
    -- when the example belongs to this team's showcase (enforced in the service),
    -- so this records the scope of the lead's authority for the action.
    team TEXT,
    -- Optional human-readable reason the lead supplied; shown to the author.
    reason TEXT,
    occurred_at TEXT NOT NULL,                   -- when the removal happened (UTC ISO)
    -- Set when the author dismisses the notification from their feed. NULL while
    -- the notification is unread; the audit row itself is never deleted.
    acknowledged_at TEXT
);

-- The author's notification feed is "removals of MY examples, newest first";
-- index leads with the author id the read predicate filters on, then time.
CREATE INDEX idx_showcase_removals_author ON showcase_removals(author_developer_id, occurred_at);
