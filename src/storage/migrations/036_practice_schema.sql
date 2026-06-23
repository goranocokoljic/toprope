-- Task 6.2.1 (#156): Best-Practice Schema — the FOUR companion tables the Best
-- Practices feature (Epic 6.2) adds on top of the 6.1 contribution spine.
--
-- Nothing best-practice-specific ever lands on the spine itself (6.1.1 / #151):
-- a best practice IS a `contributions` row with content_type = 'best_practice',
-- its title/scope/state/version lineage live on the spine, and its prose body
-- lives (opaque) in `contribution_versions`. What the spine cannot carry — the
-- practice-only fields, the manual pin/suppress overrides, the per-developer
-- feedback signal, and the usage-event log for later correlation — lives here,
-- each row hanging off a contribution by reference. This keeps Best Practices
-- and Showcase one coherent system on shared primitives rather than parallel
-- content stacks (Epic 6.2 cross-cutting criterion).
--
-- All four CREATEs use IF NOT EXISTS so re-running the migration is a no-op
-- (idempotent) even outside the schema_migrations ledger.

-- Practice-specific fields for a contribution. A 1:1 companion (contribution_id
-- is the PRIMARY KEY) — at most one details row per practice. CASCADE: these
-- fields are meaningless without their contribution, so a hard-deleted
-- contribution takes its details with it (mirrors the spine's owned-data cascades).
CREATE TABLE IF NOT EXISTS practice_details (
    contribution_id TEXT PRIMARY KEY REFERENCES contributions(id) ON DELETE CASCADE,
    -- The AI model used if the practice was AI-assisted authoring; NULL otherwise.
    model_used TEXT,
    -- Hybrid contribution-model (6.2.2) lead-endorsement flag. CHECK keeps it an
    -- honest boolean (0/1) rather than letting an arbitrary integer masquerade.
    endorsed INTEGER NOT NULL DEFAULT 0 CHECK (endorsed IN (0, 1))
);

-- Manual pin/suppress overrides used by the contextual-surfacing query (6.2.6):
-- a curator can force a practice to appear next to a metric (pin) or keep it from
-- appearing (suppress). Append-style log keyed by its own id — the surfacing code
-- (6.2.7) reduces the rows per (contribution, metric) to a current decision.
CREATE TABLE IF NOT EXISTS practice_metric_pins (
    id TEXT PRIMARY KEY,
    -- CASCADE: a pin/suppress is an override OF a contribution; it goes when the
    -- contribution is hard-deleted.
    contribution_id TEXT NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
    -- Which metric the override targets (churn | acceptance_rate | cost_per_pr | …).
    -- Open string (no CHECK): the metric vocabulary lives in the metrics layer and
    -- grows independently of this table.
    metric TEXT NOT NULL,
    -- The override direction. Closed set, DB-enforced like the spine's scope/state:
    -- a corrupt value must not slip into the surfacing query as a third meaning.
    action TEXT NOT NULL CHECK (action IN ('pin', 'suppress')),
    -- Who set the override. Audit attribution — a plain id with NO FK to developers
    -- so the record outlives the actor it names (the id is set server-side by the
    -- governance flow, never from request input), matching the spine's actor columns.
    actor_id TEXT NOT NULL,
    created_at TEXT NOT NULL                    -- UTC ISO
);

-- Per-developer helpful / not-helpful signal on a practice. One CURRENT signal per
-- developer per contribution (UNIQUE) — the data layer UPSERTs so a developer can
-- flip their vote without accumulating rows. Feeds the feedback ranking (6.2.4).
CREATE TABLE IF NOT EXISTS practice_feedback (
    id TEXT PRIMARY KEY,
    -- CASCADE: feedback is about a contribution; it goes with it.
    contribution_id TEXT NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
    -- Whose signal this is. A FUNCTIONAL key (the UNIQUE below dedups one-per-dev),
    -- so unlike the audit columns it carries an FK to developers; CASCADE so a
    -- removed developer's personal signals are cleared with them.
    developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
    -- Closed set, DB-enforced — feedback is binary helpful / not_helpful.
    signal TEXT NOT NULL CHECK (signal IN ('helpful', 'not_helpful')),
    created_at TEXT NOT NULL,                   -- UTC ISO; restamped on each UPSERT
    -- One current signal per developer per contribution.
    UNIQUE (contribution_id, developer_id)
);

-- Append-only log of developers engaging with a practice — the raw material the
-- later usage-signal correlation (6.2.4) joins against metric movement to answer
-- "does engaging with a practice correlate with the metric improving?".
CREATE TABLE IF NOT EXISTS practice_usage_events (
    id TEXT PRIMARY KEY,
    -- CASCADE: an event is about a contribution; it goes with it.
    contribution_id TEXT NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
    -- Who engaged. Like the spine's audit columns this is FK-less on purpose: an
    -- event log must outlive the actor it names, and the id is set server-side.
    developer_id TEXT NOT NULL,
    -- What happened (viewed | applied today, self-marked). Open enum like the
    -- spine's review-event column — the interaction vocabulary may grow (dismissed,
    -- expanded, …) without a migration, so NO CHECK here.
    event TEXT NOT NULL,
    -- The metric the practice was surfaced against when the event happened; the
    -- correlation join key. NULL when the engagement had no metric context.
    metric_context TEXT,
    occurred_at TEXT NOT NULL                   -- UTC ISO
);

-- Surfacing read path: the current overrides for a contribution, and all overrides
-- on a given metric (the surfacing query filters by the metric being shown).
CREATE INDEX IF NOT EXISTS idx_practice_metric_pins_contribution ON practice_metric_pins(contribution_id);
CREATE INDEX IF NOT EXISTS idx_practice_metric_pins_metric ON practice_metric_pins(metric, action);
-- Correlation read path: a contribution's usage events in time order.
CREATE INDEX IF NOT EXISTS idx_practice_usage_events_contribution ON practice_usage_events(contribution_id, occurred_at);
