-- Task 5.4 (#125): Prompt Capture Mechanism — the opt-in deep layer (Pillar 3).
--
-- prompt_captures stores a developer's own captured AI prompts/responses, but
-- ONLY ever as ciphertext encrypted CLIENT-SIDE with a developer-controlled key.
-- The server is deliberately a blind store: it persists `ciphertext` (the opaque
-- encrypted blob) and `encryption_meta` (algo / iv / auth-tag / key-id REFERENCE)
-- and NOTHING that could decrypt it — never the key, never plaintext. Key
-- management/recovery is Task 5.5; this table only references a key id.
--
-- Privacy model: every row is scoped to its developer_id and is private to that
-- developer. There is no manager/aggregate path over this table — the ingestion
-- and read routes both derive developer_id from the session, never from input,
-- so one developer can never reach another's captures.
--
-- Both capture mechanisms (a local agent OR an editor/IDE extension) write the
-- SAME row shape; `mechanism` records which path produced each capture. Capture
-- is inert unless the developer opted in (Task 5.10 `capture_opt_in`) AND the org
-- permits it (`coaching_capture_permitted`) — enforced at the ingestion route.
--
-- NOT append-only in the snapshot sense: rows are independent captured sessions,
-- inserted once and owned by the developer (who may later delete their own).
CREATE TABLE prompt_captures (
    id TEXT PRIMARY KEY,
    -- CASCADE: a developer's private captures should die with the developer record
    -- (no orphaned encrypted blobs), and the choice is made explicit here rather
    -- than inheriting NO ACTION — matching how every sibling FK declares its intent.
    developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,             -- groups captures from one capture session
    captured_at TEXT NOT NULL,            -- when the interaction happened (UTC ISO)
    tool TEXT,                            -- which AI tool, if known
    -- Encrypted payload: prompts + responses, encrypted with the dev's key.
    -- Stored as an opaque BLOB; the server can never read it.
    ciphertext BLOB NOT NULL,
    -- JSON: { algo, iv, auth_tag, key_id } — the public crypto parameters needed
    -- to decrypt WITH the developer's key. Never the key itself.
    encryption_meta TEXT NOT NULL,
    mechanism TEXT NOT NULL,              -- local_agent | editor_extension
    -- Lightweight NON-sensitive metadata for the developer's own indexing only.
    prompt_count INTEGER,
    created_at TEXT NOT NULL              -- when the server stored the row (UTC ISO)
);

-- The developer's own listing is "my captures, newest first" and "this session's
-- captures" — both keyed on developer_id, so index it alongside captured_at and
-- session_id for the private read paths.
CREATE INDEX idx_prompt_captures_dev_captured ON prompt_captures(developer_id, captured_at);
CREATE INDEX idx_prompt_captures_dev_session ON prompt_captures(developer_id, session_id);
