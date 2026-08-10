-- #317 (IG1.1, epic #316): `raw_commits` — the sha-keyed source of record that makes git
-- ingestion idempotent — plus the pre-production reset that clears the data the OLD, additive
-- model produced.
--
-- Canonical design: `dev-docs/Idempotent_Git_Ingestion_Design.md` §1 and §4. The CREATE
-- statements below are copied VERBATIM from §1 (only `IF NOT EXISTS` is added) and are fenced by
-- the `DESIGN §1 CANONICAL SQL` markers; `tests/git/raw-commits-migration.test.ts` re-reads both
-- files and fails if they drift apart, so the doc and the schema cannot disagree silently.
--
-- WHAT THIS EXISTS TO REMOVE. `raw_author_daily`'s commit counters are ADDED across sync runs,
-- which is correct only if every run's window is provably disjoint from everything already
-- stored — and that proof is carried by the sync cursors, which every feature since #229
-- (backfill, delete + re-add, scoped sync, retry, catch-up caps, stall detection) has had to be
-- individually prevented from invalidating. Two tables in the same pipeline are already
-- idempotent and have produced ~zero corruption findings: `commit_diffstats` (#273, a sha-keyed
-- memo) and `pr_records` (#264, a state-keyed replace). The commit counters are additive only
-- because the pipeline aggregates commits BEFORE persisting them, discarding the sha that would
-- make the write idempotent. This table keeps the sha, and the invariant evaporates.
--
-- THIS CHILD LANDS THE TABLE EMPTY AND UNREAD, which is the plan, not an omission. Nothing
-- writes or reads `raw_commits` until IG1.2 (#318) rewrites the ingest tail: the epic forbids a
-- dual write path, and criterion B needs the golden baseline
-- (`tests/connectors/git/golden-raw-author-daily.test.ts`) recorded against the UNTOUCHED write
-- path before that rewrite lands.
--
-- ─── WHY A RESET, AND WHY IT IS UNCONDITIONAL ────────────────────────────────────────
-- Same reasoning as 042 and 043, and the project is still pre-production with disposable data
-- (project memory, 2026-07-26). The stored `raw_author_daily` rows are the OUTPUT of the additive
-- merge this epic deletes; they cannot be re-derived into the new model, because the shas that
-- would make them recomputable were thrown away at aggregation time. Rebuilding by resync is the
-- only honest state, and a resync is cheap here in a way it will never be again.
--
-- Unconditional, exactly as 042 and 043 were: a conditional reset makes "the migration ran" stop
-- implying "the data is being rebuilt", and the two outcomes are indistinguishable from outside —
-- `runMigrations` executes silently at server start and at the top of every scheduled sync,
-- reporting only a count. The NOTICE below is the part that is conditional, so a fresh install is
-- never told to rebuild data it never had.
--
-- Cursors go WITH the data, never on their own (the graduated #262 rule): a forward cursor is the
-- only evidence that the next run's window is disjoint from what is stored, so purging cursors
-- while leaving imported rows behind would re-arm the double-count permanently. Here rows and
-- cursors go in the same transaction, so the next run starts from nothing with nothing behind it.
--
-- ─── WHAT IS CLEARED ─────────────────────────────────────────────────────────────────
--   * `git_snapshots` — every row. It is a pure PROJECTION of (raw_author_daily, identity map)
--     since #253, so dropping projected cells is recomputation, not history rewriting. The delete
--     is deliberately NOT scoped to `is_projected = 1` (043 scoped its own): a legacy
--     (`is_projected = 0`) cell can never be retracted or overwritten by the projection, so
--     leaving one behind would make every later provider-delete cascade silently partial —
--     which is precisely why 042 emptied the table outright. 042 having done so means no legacy
--     cell can exist on any store that ran it; the unscoped form is what keeps that true for a
--     fixture- or import-seeded row that appeared since. Same one-time, pre-production license as
--     042, and no RUNTIME path may do this.
--   * `raw_author_daily` — every row. The additive output described above.
--   * All FOUR per-provider `sync_state` namespaces — the forward cursor (`git_last_sync:*`),
--     the earliest-synced watermark (`git_earliest_sync:*`), the consecutive-stall streak
--     (`git_stall:*`, #235) and the row-refusal record (`git_row_refusal:*`, #306). Key shapes:
--     `syncStateKey` / `earliestSyncStateKey` / `stallStateKey` / `rowRefusalStateKey` in
--     `src/connectors/git/sync.ts`; the same four `containerCursorKeys` the per-container delete
--     cascade purges (`providers/delete-cascade.ts`), and the same set 042 and 043 cleared.
--
--     THE TWO HEALTH NAMESPACES GO WITH THE DATA, not because they are cursors but because both
--     count RUNS, and this file deletes the data every one of those runs produced. A streak of 2
--     (invisible — `GIT_STALL_ALERT_RUNS` is 3) survives the reset, so the FIRST post-reset run
--     that fails for any transient reason reports the provider stalled "since" a pre-reset date,
--     with `doctor`'s "cursor held, importing nothing" naming a cursor this file deleted. The
--     refusal record is worse: its escalated flag is sticky, and the remedy `doctor` prints for
--     it warns against purging cursors because that "permanently DOUBLES every commit metric on
--     the rows that survived" — after this reset no rows survived and the cursors are already
--     gone, so the warning is inverted. Neither is self-healing in the direction that matters:
--     `clearProviderStall` fires only on a COMPLETE run, and until one lands the streak is
--     extended, preserving its original `since`.
--   * `commit_diffstats` — every row, per the reset contract 044's own header states: *"any
--     future migration or command that resets git data must add DELETE FROM commit_diffstats"*.
--     A resync that reads the memo does NOT re-ask the provider; it replays whatever is cached,
--     so a reset that skipped it would converge back on the numbers it was run to discard.
--     Emptying it costs only re-fetching — the table is a memo of an immutable fact, never a
--     source of record.
--
-- ─── WHAT IS DELIBERATELY NOT CLEARED ────────────────────────────────────────────────
--   * `pr_records` — LOCKED DECISION (tracker, IG1.1). The design's "pr_records' derived
--     day-counters" live in `raw_author_daily` rows, which this file empties. `pr_records` itself
--     is state-keyed (`provider, container, repo, pr_id`) and replace-idempotent, so a resync
--     re-upserts every row it re-lists. Clearing it would be scope creep, not fidelity — and it
--     is the one git table whose re-fetch this reset cannot make cheaper.
--   * The DERIVED rollups — `weekly_aggregates` and its siblings, `pr_review_metrics`,
--     `coaching_signals`. They are a SECOND projection that no migration rebuilds, which is
--     exactly why the notice below exists and why its remedy names `toprope aggregate backfill`.
--
-- ─── AFTERWARDS ──────────────────────────────────────────────────────────────────────
-- The notice below raises the same `git_data_reset_pending` marker 043 used, stamped `046`, via
-- the ONE mechanism `src/connectors/git/reset-notice.ts` owns — `toprope doctor` fails on it, and
-- `gitResetNoticeMessage` prints the full remedy (resync, `toprope aggregate backfill` with a
-- `--from` reaching the OLDEST period holding stale rollups, check for a missing provider,
-- acknowledge with `toprope git clear-reset-notice`). No second notice path is hand-rolled here.
--
-- NOTE ON IDEMPOTENCE: the CREATE statements are `IF NOT EXISTS` and safe to re-execute; the
-- DELETEs are DESTRUCTIVE and are not, exactly as in 042/043. The `schema_migrations` ledger runs
-- this file exactly once.

-- >>> DESIGN §1 CANONICAL SQL — verbatim from `Idempotent_Git_Ingestion_Design.md` §1.
-- Do not edit either copy alone; the migration test compares them.
--
-- The shape, in one line each:
--   * PK `(provider, container, repo, sha)` — the SAME attribution key `commit_diffstats` (#273)
--     and `pr_records` (#264) use, which is what lets the provider delete cascade retract exactly
--     one container's contribution. `WITHOUT ROWID` makes the hot upsert a single B-tree seek.
--   * `raw_author_key` is the stable identity `rawAuthorKeyFor` derives; the three nullable
--     author columns carry the same partially-known identity `raw_author_daily` already holds.
--     No file paths — those stay in `commit_diffstats` under its documented retention decision,
--     so the privacy model is unchanged.
--   * `author_day` is GLOB-pinned to `YYYY-MM-DD` because the projection groups by it and the
--     day key is compared as a STRING; `committed_at` and `first_seen` are UTC ISO instants.
--     READ THE TWO INLINE COMMENTS AS A CONTRACT ON THE WRITER, NOT AS A SCHEMA GUARANTEE:
--     "lowercased at the write boundary" (`author_email`) and "pinned UTC ISO instant"
--     (`committed_at`) carry no CHECK, exactly as their `raw_author_daily` counterparts do not.
--     #318 must enforce both in code — `normalizeEmail` and the existing `isUtcIsoInstant` gate —
--     and the day key is the one this schema does pin, because it is the one compared as a
--     string. Adding CHECKs here would edit design §1, which this child may not do unilaterally
--     (the epic's drift protocol: a design change is raised and signed off, never improvised).
--   * ONE secondary index, on the projection's grain. Both hot patterns are left-prefix seeks —
--     the per-commit upsert on the PK, the per-cell recompute and the delete cascade on the index
--     — so a second index would tax every write and buy nothing (the `commit_diffstats`
--     no-secondary-index reasoning, applied to the one pattern that is not a PK prefix).
CREATE TABLE IF NOT EXISTS raw_commits (
    provider   TEXT NOT NULL CHECK (provider IN ('github','bitbucket','gitlab')),
    container  TEXT NOT NULL CHECK (length(container) > 0),
    repo       TEXT NOT NULL CHECK (length(repo) > 0),
    sha        TEXT NOT NULL CHECK (length(sha) > 0),
    raw_author_key       TEXT NOT NULL CHECK (length(raw_author_key) > 0),
    author_login         TEXT,
    author_email         TEXT,            -- lowercased at the write boundary
    author_display_name  TEXT,
    author_day TEXT NOT NULL CHECK (author_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    committed_at TEXT NOT NULL,           -- pinned UTC ISO instant
    lines_added   INTEGER NOT NULL CHECK (lines_added   >= 0),
    lines_removed INTEGER NOT NULL CHECK (lines_removed >= 0),
    files_changed INTEGER NOT NULL CHECK (files_changed >= 0),
    is_merge      INTEGER NOT NULL CHECK (is_merge IN (0,1)),
    ai_signature  INTEGER NOT NULL CHECK (ai_signature IN (0,1)),
    first_seen TEXT NOT NULL,
    PRIMARY KEY (provider, container, repo, sha)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_raw_commits_author_day ON raw_commits(provider, container, raw_author_key, author_day);
-- <<< DESIGN §1 CANONICAL SQL

-- ─── The operator signal (raised BEFORE the resets erase its evidence) ─────────
-- A pure-SQL migration cannot print, and `runMigrations` reports only a count — so the one
-- durable place to leave "you owe a resync + a rollup rebuild" is `sync_state`, which
-- `toprope doctor` reads and fails on. Without it the only evidence of this reset is a dashboard
-- quietly serving pre-reset rollups over zero snapshots (the graduated #235 rule: a completion
-- signal is not a currency claim).
--
-- The arms answer ONE question — "did this database ever hold git data" — which needs no
-- knowledge of the new model at all. Relative to 043's arms (`043:198-209`) there are exactly
-- four differences, all deliberate: its `changes() > 0` arm is dropped (it read the row count of
-- a `git_providers` DELETE this file does not perform); a `commit_diffstats` arm is added,
-- because this file empties that table too; the `git_snapshots` arm is widened from
-- `is_projected = 1` to unscoped, matching the unscoped DELETE below; and the cursor arm keeps
-- only the two data-bearing namespaces, since a database whose ONLY git evidence is a
-- `git_stall:` / `git_row_refusal:` row has no data for this file to delete and owes no rebuild
-- (those rows are still cleared below — they describe runs whose data is gone).
--
-- The arms deliberately reach beyond the tables emptied below:
--   * `pr_records` — not cleared here, but its presence is direct evidence of imported git data
--     whose per-day counters this file DOES empty;
--   * `git_providers.last_sync_at` — written only by a git sync, and nulled further down, so it
--     must be read here, before that UPDATE;
--   * `weekly_aggregates.total_commits` — git-derived and surviving this reset, so a non-zero
--     value is direct evidence of a rollup that is now stale. A tool-only install (Copilot and no
--     git) has rows here with `total_commits = 0` and correctly raises nothing.
--
-- `ON CONFLICT` because the key is deliberately migration-agnostic: 043 writes it too, and a
-- marker already present must be RE-STAMPED rather than abort the migration (`runMigrations`
-- wraps each file in a transaction, so an abort would retry and fail identically at every
-- subsequent server start). Re-stamping to `046` is also the honest value: the newest unmet
-- rebuild is the one an operator owes, and `clearGitResetNotice` is value-scoped, so
-- acknowledging `043` can never silently acknowledge this one.
INSERT INTO sync_state (key, value)
SELECT 'git_data_reset_pending', '046'
 WHERE EXISTS (SELECT 1 FROM raw_author_daily)
    OR EXISTS (SELECT 1 FROM git_snapshots)
    OR EXISTS (SELECT 1 FROM pr_records)
    OR EXISTS (SELECT 1 FROM commit_diffstats)
    OR EXISTS (
        SELECT 1 FROM sync_state
         WHERE key LIKE 'git_last_sync:%'
            OR key LIKE 'git_earliest_sync:%'
       )
    OR EXISTS (SELECT 1 FROM git_providers WHERE last_sync_at IS NOT NULL)
    OR EXISTS (SELECT 1 FROM weekly_aggregates WHERE total_commits > 0)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;

-- ─── The reset ─────────────────────────────────────────────────────────────────
-- Projected snapshot cells first: they are derived from the raw rows below, so removing them
-- before their source keeps the intermediate state readable ("nothing projected yet") rather than
-- "projected from rows that are gone".
DELETE FROM git_snapshots;
DELETE FROM raw_author_daily;

-- The diffstat memo (044's reset contract). Deleting it costs only re-fetching.
DELETE FROM commit_diffstats;

-- All four per-provider namespaces: the forward cursor, the earliest-synced watermark, and the
-- two run-health records whose runs this file has just deleted the output of (see the header).
DELETE FROM sync_state
 WHERE key LIKE 'git_last_sync:%'
    OR key LIKE 'git_earliest_sync:%'
    OR key LIKE 'git_stall:%'
    OR key LIKE 'git_row_refusal:%';

-- The provider rows' own sync-outcome columns describe a run whose data no longer exists. Leaving
-- them would make the admin list read "synced 2 hours ago · ok" for a provider with zero rows and
-- `first_sync_pending: true` — a completion signal read as a currency claim (#235).
--
-- ALL FOUR of them, which is one more than 043 cleared: #289 added `last_sync_advisories` one
-- migration ago, and `recordSyncOutcome` writes all four in a single UPDATE as ONE record of the
-- last scoped run. Leaving the advisories behind would keep rendering a loss report (e.g. a
-- `COMMITS_DROPPED` advisory about commits behind an already-advanced cursor) for a run whose
-- cursor and rows are gone — and it would not clear on the remedy this notice prescribes, since
-- only the admin per-provider routes ever write that column, never the scheduler or the CLI.
UPDATE git_providers
   SET last_sync_at = NULL,
       last_sync_status = NULL,
       last_sync_error = NULL,
       last_sync_advisories = NULL;
