-- Task 6.1.1 (#151): Shared Content Spine — the feature-agnostic foundation that
-- both the Best Practices (6.2) and Showcase (6.3) features sit on, so they are
-- one coherent system rather than two bolted-on corners.
--
-- The machinery that is SHARED across both features lives here: moving content
-- through states, recording who did what (audit trail), versioning edits, and
-- scoping to org/team. The type-specific rules and payload shapes are delegated
-- to the features via companion tables that reference this spine — NO
-- best-practice- or showcase-specific column ever lands in these four tables.
--
-- `content_type` is an OPEN enum (best_practice | showcase_example today,
-- extensible later) — deliberately NO CHECK constraint, so a new content type is
-- a code change in a feature, not a migration to the spine.
--
-- All four CREATEs use IF NOT EXISTS so re-running the migration is a no-op
-- (idempotent) even outside the schema_migrations ledger.

CREATE TABLE IF NOT EXISTS contributions (
    id TEXT PRIMARY KEY,
    -- Open enum: best_practice | showcase_example, extensible. No CHECK on purpose.
    content_type TEXT NOT NULL,
    title TEXT NOT NULL,
    -- The authoring developer. CASCADE: a contribution is an authored artifact
    -- attributed to a developer; if the developer record is removed it goes with
    -- them rather than orphaning, mirroring the Phase 5 showcase FK intent.
    author_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
    -- Sharing reach. CHECK locks it to the two known scopes so a corrupt value
    -- can't masquerade as one the (later) scope-resolution / browse code trusts.
    scope TEXT NOT NULL CHECK (scope IN ('org', 'team')),
    -- The team name when team-scoped; NULL for org-wide.
    scope_target TEXT,
    -- Lifecycle state. CHECK keeps the column honest; the actual transition rules
    -- (which state may follow which) are owned by 6.1.2's state machine, not here.
    state TEXT NOT NULL CHECK (state IN ('draft', 'submitted', 'published', 'unpublished', 'removed')),
    -- Points at the live version in contribution_versions; starts at 1.
    current_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,                  -- UTC ISO
    updated_at TEXT NOT NULL                   -- UTC ISO
);

CREATE TABLE IF NOT EXISTS contribution_versions (
    id TEXT PRIMARY KEY,
    contribution_id TEXT NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    -- The versioned payload, an opaque JSON string. The spine never interprets
    -- it — feature code owns the shape — keeping the spine feature-agnostic.
    body TEXT NOT NULL,
    author_id TEXT NOT NULL,                   -- who authored this version
    change_note TEXT,
    created_at TEXT NOT NULL,                  -- UTC ISO
    UNIQUE (contribution_id, version)
);

CREATE TABLE IF NOT EXISTS contribution_tags (
    contribution_id TEXT NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (contribution_id, tag)
);

CREATE TABLE IF NOT EXISTS contribution_review_events (
    id TEXT PRIMARY KEY,
    contribution_id TEXT NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
    -- The governance/lifecycle action recorded. Open string (no CHECK): the
    -- audit trail must be able to record any action a feature's governance flow
    -- performs (submitted|approved|published|unpublished|removed|redacted today).
    event TEXT NOT NULL,
    actor_id TEXT NOT NULL,                     -- who performed the action
    note TEXT,
    occurred_at TEXT NOT NULL                   -- UTC ISO, when the action happened
);

-- Listing/filtering the spine by what & where (feature browse, scope resolution).
CREATE INDEX IF NOT EXISTS idx_contributions_type_state ON contributions(content_type, state);
CREATE INDEX IF NOT EXISTS idx_contributions_author ON contributions(author_id);
CREATE INDEX IF NOT EXISTS idx_contributions_scope ON contributions(scope, scope_target);
-- Reverse tag lookup (a contribution by tag) for the later search child.
CREATE INDEX IF NOT EXISTS idx_contribution_tags_tag ON contribution_tags(tag);
-- The audit trail read path: all events for a contribution, in time order.
CREATE INDEX IF NOT EXISTS idx_contribution_review_events_contribution ON contribution_review_events(contribution_id, occurred_at);
