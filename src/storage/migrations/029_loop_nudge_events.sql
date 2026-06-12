-- Task 5.6 (#127): Real-Time Loop Detection + Prompt-Quality Nudges (Pillar 3).
--
-- Lightweight coaching that runs ENTIRELY LOCALLY at the capture layer (the local
-- agent or editor extension): loop detection is token-set similarity matching over
-- a rolling window of the session's recent prompts held in local memory; nudges are
-- structural checks on the outgoing prompt. Neither needs a model and neither sends
-- prompt text anywhere — the detection happens on the developer's machine.
--
-- These two tables persist ONLY the non-sensitive METADATA a developer may choose
-- to sync (counts, a nudge type, timestamps, a dismissal flag). They deliberately
-- have NO column that could hold prompt content — that is the structural privacy
-- guarantee, mirroring how prompt_captures only ever stores ciphertext. The prompt
-- text that drove a detection NEVER leaves the machine and is never stored here.
--
-- Privacy model: every row is scoped to its developer_id and is private to that
-- developer. There is NO manager/aggregate path over either table — the record and
-- read routes both derive developer_id from the session, never from input, so one
-- developer can never reach another's loop/nudge events. (Aggregate-only team
-- coaching, if any, is a separate Task 5.11 concern built from its own tables.)

CREATE TABLE loop_events (
    id TEXT PRIMARY KEY,
    -- CASCADE so a developer's private coaching metadata dies with the developer
    -- record (no orphaned rows), matching every sibling FK's declared intent.
    developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,             -- groups events from one local session
    detected_at TEXT NOT NULL,            -- when the loop was detected (UTC ISO)
    -- How many similar prompts formed the loop. METADATA ONLY — a count, never the
    -- prompts themselves. NOT NULL: a loop event without its count is meaningless,
    -- and the record route requires it (>= 2), so there is no path that stores null.
    similar_prompt_count INTEGER NOT NULL,
    created_at TEXT NOT NULL              -- when the server stored the row (UTC ISO)
);

CREATE TABLE nudge_events (
    id TEXT PRIMARY KEY,
    developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    -- Which structural nudge fired. A closed set, enforced here so a malformed
    -- producer can't widen it: the four checks the local coach runs.
    nudge_type TEXT NOT NULL CHECK (
        nudge_type IN ('short_prompt', 'missing_context', 'missing_error', 'repeated_prompt')
    ),
    delivered_at TEXT NOT NULL,           -- when the nudge was shown (UTC ISO)
    -- Whether the developer dismissed the nudge. Nudges are non-blocking and
    -- dismissible; this records that choice as metadata only. 0 = active, 1 = dismissed.
    dismissed INTEGER NOT NULL DEFAULT 0 CHECK (dismissed IN (0, 1)),
    created_at TEXT NOT NULL
);

-- The developer's own listing is "my loop events, newest first" — keyed on
-- developer_id and ordered by detected_at, so index leads with both.
CREATE INDEX idx_loop_events_dev_detected ON loop_events(developer_id, detected_at);
-- Same private read shape for nudges, ordered by delivery time.
CREATE INDEX idx_nudge_events_dev_delivered ON nudge_events(developer_id, delivered_at);
