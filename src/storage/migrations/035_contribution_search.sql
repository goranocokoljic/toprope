-- Task 6.1.5 (#155): Search over the shared content spine — one search across all
-- contributions (best practices + showcase examples today) so both features are
-- discoverable. Like the rest of Epic 6.1 this is FEATURE-AGNOSTIC: it indexes the
-- spine's own columns (title, the current version's opaque body, tags) and knows
-- nothing about what a best practice or a showcase example is.
--
-- WHY FTS5 + triggers (not a code-maintained index):
-- The acceptance criterion "the index updates when content is published/edited/
-- unpublished" is met most robustly at the DB layer. A standalone FTS5 table kept
-- in sync by triggers cannot be left stale by a caller that forgot to reindex — and
-- because the features that drive content through the spine (6.2/6.3) are not built
-- yet, triggers mean search simply works as content moves, with no feature wiring.
--
-- WHAT lives in the FTS table vs. what is joined live:
--   * Only the FREE-TEXT columns (title, body, tags) are indexed here. The body is
--     the spine's opaque JSON payload, indexed VERBATIM — the spine must not parse
--     it, so a feature wanting cleaner tokenization can layer extracted text later.
--   * The FILTER / SCOPE columns (content_type, scope, scope_target, state) are NOT
--     duplicated here. Search JOINs back to the live `contributions` table for those,
--     so filtering and 6.1.4 scope resolution always read the authoritative, fresh
--     values rather than a copy that could drift.
--
-- WHY the FTS row is recomputed from the live tables on every relevant change:
-- The searchable text is a denormalized projection of three tables — title lives on
-- `contributions`, the body on the CURRENT version in `contribution_versions`, and
-- the tags in `contribution_tags`. Rather than try to patch individual columns (and
-- get the create/edit insert ORDERING wrong — `createContribution` writes the spine
-- row before its version 1, and `addContributionVersion` writes the version row
-- before bumping `current_version`), every trigger DELETEs the contribution's FTS
-- row and re-INSERTs it from a SELECT over the live tables. Triggers fire AFTER the
-- change, so the SELECT always sees the new state; the transient states inside a
-- single transaction never escape it.
--
-- IF NOT EXISTS / idempotent: re-running the migration is a no-op.

-- Standalone FTS5 index. `contribution_id` is UNINDEXED — it is the join key back to
-- the spine, not something we full-text search. unicode61 (the default tokenizer) is
-- stated explicitly with diacritic folding so "café" and "cafe" match.
CREATE VIRTUAL TABLE IF NOT EXISTS contribution_search USING fts5(
    contribution_id UNINDEXED,
    title,
    body,
    tags,
    tokenize = 'unicode61 remove_diacritics 2'
);

-- AFTER INSERT ON contributions: the spine row exists but (for createContribution)
-- its version 1 does not yet — body resolves empty here and is filled by the
-- contribution_versions insert trigger below, both inside the same transaction.
CREATE TRIGGER IF NOT EXISTS contribution_search_ai
AFTER INSERT ON contributions
BEGIN
    DELETE FROM contribution_search WHERE contribution_id = NEW.id;
    INSERT INTO contribution_search (contribution_id, title, body, tags)
    SELECT c.id,
           c.title,
           COALESCE((SELECT v.body FROM contribution_versions v
                     WHERE v.contribution_id = c.id AND v.version = c.current_version), ''),
           COALESCE((SELECT group_concat(t.tag, ' ') FROM contribution_tags t
                     WHERE t.contribution_id = c.id), '')
    FROM contributions c WHERE c.id = NEW.id;
END;

-- AFTER UPDATE ON contributions: covers a title edit, a state change
-- (publish/unpublish/remove), and — crucially — a `current_version` bump from an
-- edit/revert, which re-points body at the new current version.
CREATE TRIGGER IF NOT EXISTS contribution_search_au
AFTER UPDATE ON contributions
BEGIN
    DELETE FROM contribution_search WHERE contribution_id = NEW.id;
    INSERT INTO contribution_search (contribution_id, title, body, tags)
    SELECT c.id,
           c.title,
           COALESCE((SELECT v.body FROM contribution_versions v
                     WHERE v.contribution_id = c.id AND v.version = c.current_version), ''),
           COALESCE((SELECT group_concat(t.tag, ' ') FROM contribution_tags t
                     WHERE t.contribution_id = c.id), '')
    FROM contributions c WHERE c.id = NEW.id;
END;

-- AFTER DELETE ON contributions: hard-delete drops the FTS row. (Soft "removed"
-- state goes through the UPDATE trigger and stays indexed but filterable by state.)
CREATE TRIGGER IF NOT EXISTS contribution_search_ad
AFTER DELETE ON contributions
BEGIN
    DELETE FROM contribution_search WHERE contribution_id = OLD.id;
END;

-- AFTER INSERT ON contribution_versions: a new version's body becomes searchable.
-- On create this fills the body the contributions-insert trigger left empty; on edit
-- the version is inserted BEFORE current_version is bumped, so body here still
-- resolves to the OLD current version — the contributions UPDATE trigger that bumps
-- current_version then re-points it at the new one. Net effect after the transaction:
-- body reflects the current version.
CREATE TRIGGER IF NOT EXISTS contribution_search_vi
AFTER INSERT ON contribution_versions
BEGIN
    DELETE FROM contribution_search WHERE contribution_id = NEW.contribution_id;
    INSERT INTO contribution_search (contribution_id, title, body, tags)
    SELECT c.id,
           c.title,
           COALESCE((SELECT v.body FROM contribution_versions v
                     WHERE v.contribution_id = c.id AND v.version = c.current_version), ''),
           COALESCE((SELECT group_concat(t.tag, ' ') FROM contribution_tags t
                     WHERE t.contribution_id = c.id), '')
    FROM contributions c WHERE c.id = NEW.contribution_id;
END;

-- AFTER INSERT / DELETE ON contribution_tags: keep the indexed tag blob in sync.
CREATE TRIGGER IF NOT EXISTS contribution_search_ti
AFTER INSERT ON contribution_tags
BEGIN
    DELETE FROM contribution_search WHERE contribution_id = NEW.contribution_id;
    INSERT INTO contribution_search (contribution_id, title, body, tags)
    SELECT c.id,
           c.title,
           COALESCE((SELECT v.body FROM contribution_versions v
                     WHERE v.contribution_id = c.id AND v.version = c.current_version), ''),
           COALESCE((SELECT group_concat(t.tag, ' ') FROM contribution_tags t
                     WHERE t.contribution_id = c.id), '')
    FROM contributions c WHERE c.id = NEW.contribution_id;
END;

CREATE TRIGGER IF NOT EXISTS contribution_search_td
AFTER DELETE ON contribution_tags
BEGIN
    DELETE FROM contribution_search WHERE contribution_id = OLD.contribution_id;
    INSERT INTO contribution_search (contribution_id, title, body, tags)
    SELECT c.id,
           c.title,
           COALESCE((SELECT v.body FROM contribution_versions v
                     WHERE v.contribution_id = c.id AND v.version = c.current_version), ''),
           COALESCE((SELECT group_concat(t.tag, ' ') FROM contribution_tags t
                     WHERE t.contribution_id = c.id), '')
    FROM contributions c WHERE c.id = OLD.contribution_id;
END;

-- Backfill: index any contributions that already existed before this migration
-- (the triggers only fire on changes made after they are created). On a fresh DB
-- this selects nothing; on an existing one it makes prior content searchable. Safe
-- to run once at apply time — the FTS table was just created empty above.
INSERT INTO contribution_search (contribution_id, title, body, tags)
SELECT c.id,
       c.title,
       COALESCE((SELECT v.body FROM contribution_versions v
                 WHERE v.contribution_id = c.id AND v.version = c.current_version), ''),
       COALESCE((SELECT group_concat(t.tag, ' ') FROM contribution_tags t
                 WHERE t.contribution_id = c.id), '')
FROM contributions c;
