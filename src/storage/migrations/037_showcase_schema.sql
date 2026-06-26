-- Task 6.3.1 (#164): Showcase Schema — the FIVE companion tables the Showcase
-- feature (Epic 6.3) adds on top of the 6.1 contribution spine.
--
-- A showcase IS a `contributions` row (content_type = 'showcase_example') with its
-- title/scope/state/version lineage on the spine (6.1.1 / #151) and its prose/
-- conversation lineage in `contribution_versions`. What the spine cannot carry —
-- the showcase-specific publishable payload, inline developer annotations anchored
-- to turns, recorded developer consent + visibility scope, the auto-flag scrubber's
-- findings, and the cross-link to a best practice — lives here, each row hanging
-- off a contribution by reference. This keeps Best Practices (6.2) and Showcase
-- (6.3) ONE coherent system on the shared spine rather than parallel content
-- stacks, and means Showcase reuses the shared store rather than duplicating it
-- (Epic 6.3 cross-cutting criterion). The Phase 5 `showcase_examples` store stays
-- as-is; nothing here duplicates it.
--
-- All CREATEs use IF NOT EXISTS so re-running the migration is a no-op
-- (idempotent) even outside the schema_migrations ledger.

-- The 1:1 showcase-specific payload for a contribution (contribution_id is the
-- PRIMARY KEY — at most one unit per showcase). CASCADE: this payload is
-- meaningless without its contribution, so a hard-deleted contribution takes it
-- with it (mirrors the spine's owned-data cascades and 036's practice_details).
CREATE TABLE IF NOT EXISTS showcase_units (
    contribution_id TEXT PRIMARY KEY REFERENCES contributions(id) ON DELETE CASCADE,
    -- The redacted conversation content (opaque JSON of turns). The spine never
    -- interprets it; the showcase feature owns the shape.
    conversation TEXT NOT NULL,
    -- Optional PR/code/goal reference for the outcome the conversation produced.
    outcome_link TEXT,
    -- MANDATORY curators' note. The column is NOT NULL, but NOT NULL alone permits
    -- an empty string — the real publish gate is enforced in the data layer
    -- (upsertShowcaseUnit rejects a blank/whitespace note), per the 6.3.1 criterion
    -- "enforced NOT NULL at publish (gate, not just column)". The publish flow
    -- (6.3.2 / 6.3.4) builds on that gate.
    curators_note TEXT NOT NULL,
    -- Optional AI prompt-technique annotation (local model, specific-or-silent).
    ai_annotation TEXT,
    -- Which publish path produced this unit. Closed set, DB-enforced like the
    -- spine's scope/state CHECKs so a corrupt value can't masquerade as a path the
    -- consent gate (6.3.2) trusts. self_publish = developer self-publish (initiate);
    -- joint_curation = manager+developer (developer approval still required).
    publish_path TEXT NOT NULL CHECK (publish_path IN ('self_publish', 'joint_curation'))
);

-- Inline developer annotations anchored to a specific conversation turn — the
-- highest-value layer (6.3.3). Append-style log keyed by its own id.
CREATE TABLE IF NOT EXISTS showcase_annotations (
    id TEXT PRIMARY KEY,
    -- CASCADE: an annotation is about a contribution; it goes with it.
    contribution_id TEXT NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
    -- Which turn this annotation anchors to (opaque ref into the conversation JSON).
    turn_ref TEXT NOT NULL,
    -- The developer whose reasoning this is. A FUNCTIONAL key (whose annotation),
    -- so unlike the spine's FK-less audit columns it carries an FK to developers;
    -- CASCADE so a removed developer's annotations are cleared with them (mirrors
    -- 036's practice_feedback.developer_id).
    author_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL                      -- UTC ISO
);

-- Recorded developer consent + the explicit visibility scope of that consent
-- (6.3.2). Developer approval is ALWAYS required before publish in BOTH paths —
-- the defining privacy property of the epic — and this table is where that
-- approval is recorded.
CREATE TABLE IF NOT EXISTS showcase_consent (
    id TEXT PRIMARY KEY,
    -- CASCADE: consent is about a contribution; it goes with it.
    contribution_id TEXT NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
    -- Whose consent this is. FUNCTIONAL key → FK to developers, CASCADE (as above).
    developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
    -- Approval flag. CHECK keeps it an honest boolean (0/1) rather than letting an
    -- arbitrary integer masquerade as approved.
    approved INTEGER NOT NULL DEFAULT 0 CHECK (approved IN (0, 1)),
    -- The reach the developer consented to. NO DEFAULT and NOT NULL: consent must
    -- carry an EXPLICIT visibility scope, never a silent default (6.3.1 criterion).
    -- CHECK locks it to the two known scopes.
    visibility_scope TEXT NOT NULL CHECK (visibility_scope IN ('team', 'org')),
    approved_at TEXT                             -- UTC ISO when approved; NULL until then
);

-- Auto-flag scrubber findings awaiting the mandatory manual review (6.3.5 / 6.3.6).
-- TWO confidence tiers: secret_high (secrets/keys/credentials — flagged firmly) and
-- pii_hint_low (softer PII — a fallible, non-blocking hint). The tier is the whole
-- point of this table, so it is DB-enforced.
CREATE TABLE IF NOT EXISTS scrub_flags (
    id TEXT PRIMARY KEY,
    -- CASCADE: a flag is about a contribution; it goes with it.
    contribution_id TEXT NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
    -- The confidence tier. Closed set, DB-enforced — the two tiers must stay
    -- distinct (6.3.1 criterion "distinguishes the two tiers").
    tier TEXT NOT NULL CHECK (tier IN ('secret_high', 'pii_hint_low')),
    -- What/where the finding is, for the human reviewer.
    finding TEXT NOT NULL,
    -- Resolved flag. CHECK keeps it an honest boolean (0/1); NOT NULL DEFAULT 0 so a
    -- new flag starts unresolved.
    resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
    created_at TEXT NOT NULL                     -- UTC ISO
);

-- Lightweight both-ways cross-link between a showcase and a best practice (6.3.8).
-- Both columns reference the SAME spine table (`contributions`) — a showcase and a
-- practice are both contributions, distinguished by content_type. CASCADE on both
-- ends so the link disappears if either side is hard-deleted.
CREATE TABLE IF NOT EXISTS showcase_practice_links (
    showcase_id TEXT NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
    practice_id TEXT NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
    PRIMARY KEY (showcase_id, practice_id)
);

-- Read paths: a contribution's annotations / consent / scrub flags in time order
-- (the annotation, consent-gate, and manual-review surfaces all read by
-- contribution). For the cross-link, the PRIMARY KEY already indexes the
-- showcase->practice direction; add the reverse (practice->showcase) lookup.
CREATE INDEX IF NOT EXISTS idx_showcase_annotations_contribution ON showcase_annotations(contribution_id, created_at);
CREATE INDEX IF NOT EXISTS idx_showcase_consent_contribution ON showcase_consent(contribution_id);
CREATE INDEX IF NOT EXISTS idx_scrub_flags_contribution ON scrub_flags(contribution_id, created_at);
CREATE INDEX IF NOT EXISTS idx_showcase_practice_links_practice ON showcase_practice_links(practice_id);
