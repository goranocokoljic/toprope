-- Task 5.8 (#129): Exemplary-Conversation Showcase — the bridge from private
-- self-coaching to organizational learning.
--
-- This is a SEPARATE SHARED STORE, deliberately distinct from the private
-- encrypted `prompt_captures`. A row here only ever exists because its author
-- consciously promoted ONE of their own conversations, reviewed and REDACTED it,
-- and explicitly published it. The act of publishing IS the act of
-- de-privatizing that one conversation:
--
--   * `content` is the developer's REDACTED, deliberately-shared text — NOT
--     encrypted with the dev's private key. It has been made org-visible by the
--     owner's choice, so it lives under normal org access controls, not the
--     dev-only-key encryption that protects prompt_captures.
--   * Nothing is ever auto-harvested or system-selected. There is no code path
--     that copies a capture's plaintext into this table; the only writer is the
--     owner-initiated publish flow, which persists exactly the content the owner
--     submits.
--   * The private capture is NEVER touched by publishing. This table holds no
--     pointer back to prompt_captures (no session_id / capture_id column) — the
--     two stores are connected only by the developer's explicit promote action,
--     never by a stored link.
CREATE TABLE showcase_examples (
    id TEXT PRIMARY KEY,
    -- CASCADE: a showcased example is an authored artifact attributed to a
    -- developer; if the developer record is removed, the attributed example goes
    -- with it rather than being orphaned. Mirrors how every sibling Phase 5 FK
    -- declares its delete intent.
    author_developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
    published_at TEXT NOT NULL,                 -- when the owner published (UTC ISO)
    -- Sharing reach, chosen by the owner WITHIN the org's showcase_scope_permitted
    -- boundary (Task 5.10). CHECK locks it to the two known scopes so a corrupt
    -- value can't masquerade as one the browse surface trusts.
    scope TEXT NOT NULL CHECK (scope IN ('team', 'org')),
    -- The author's team name when team-scoped; NULL for org-wide. Set server-side
    -- from the author's own team, never from request input, so a developer can
    -- never publish into another team's showcase.
    scope_target TEXT,
    title TEXT NOT NULL,                         -- owner-supplied headline
    task_type TEXT,                              -- debugging | refactor | feature | … (optional)
    tool TEXT,                                   -- which AI tool the conversation used (optional)
    -- The deliberately-shared, REDACTED conversation content. Plaintext, org-visible
    -- by the owner's choice — this is the ONLY plaintext the publish flow persists.
    content TEXT NOT NULL,
    author_note TEXT,                            -- optional "why this is a good example"
    -- Lifecycle. 5.8 only ever writes 'published'; 'unpublished'/'removed' are the
    -- governance states Task 5.9 transitions into. CHECK keeps the column honest.
    status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'unpublished', 'removed')),
    created_at TEXT NOT NULL                     -- when the server stored the row (UTC ISO)
);

-- Browse paths (5.9) filter by scope/scope_target and list newest-first; the
-- owner's "what have I published" view filters by author. Index both up front.
CREATE INDEX idx_showcase_scope ON showcase_examples(scope, scope_target, published_at);
CREATE INDEX idx_showcase_author ON showcase_examples(author_developer_id, published_at);
