-- Task 6.1.4 (#154): Org/Team Inheritance + Scope Resolution.
--
-- The scope columns themselves (scope, scope_target) already live on the
-- `contributions` spine (6.1.1 / #151). What 6.1.4 adds to the schema is the ONE
-- piece of state the inheritance model needs that the spine row cannot carry: a
-- per-team OVERRIDE of an org item's visibility — "this team has hidden this
-- org-wide contribution for itself".
--
-- Mirrors the Phase 2 settings inheritance shape: an org-level default (the org
-- contribution, visible to all) plus optional per-team overrides stored in their
-- own rows. A row here is the analog of a `settings` team-override row — it is
-- only HONORED while hiding is permitted (the permission gate lives in code,
-- exactly as the settings managers_can_* flag gates whether an override counts).
--
-- Only ORG-scoped contributions are ever hidden this way (a team item is already
-- confined to its team, so there is nothing to override). The code enforces that;
-- the table stays minimal and feature-agnostic — nothing here knows what a best
-- practice or showcase example is.
--
-- IF NOT EXISTS so re-running the migration is a no-op (idempotent).

CREATE TABLE IF NOT EXISTS contribution_team_hides (
    -- The org contribution being hidden. CASCADE: if the contribution is hard
    -- deleted, its per-team hide rows go with it (mirrors the spine's cascades).
    contribution_id TEXT NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
    -- The team that hid it for itself. The override is scoped to this one team;
    -- every other team still sees the org item. NOTE: unlike `hidden_by` this is a
    -- FUNCTIONAL key the resolver matches a viewer's team against — not an audit
    -- attribution — so it must be the team's CANONICAL name (the same value carried
    -- on developers.team / teams.name). A mis-cased or typo'd team here records a
    -- hide that silently affects nothing; the governance flow resolves the team
    -- server-side, so the value's validity is guaranteed at the write boundary
    -- rather than by an FK (kept off for the same reason as the audit columns).
    team TEXT NOT NULL,
    -- Who performed the hide. Audit column, like the spine's actor columns — a
    -- plain id with NO FK to developers so the record outlives the actor it names
    -- (the id is set server-side by the governance flow, never from request input).
    hidden_by TEXT NOT NULL,
    hidden_at TEXT NOT NULL,                   -- UTC ISO
    -- One hide per (contribution, team): hiding is idempotent and a team either
    -- has or has not hidden a given org item.
    PRIMARY KEY (contribution_id, team)
);

-- The resolution read path: "which org items has THIS team hidden", used to
-- subtract hidden org items out of a viewer's visible set.
CREATE INDEX IF NOT EXISTS idx_contribution_team_hides_team ON contribution_team_hides(team);
