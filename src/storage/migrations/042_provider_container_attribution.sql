-- #264: attribute imported git data per provider CONTAINER, so each provider is an
-- independent unit that can be deleted without touching any other one.
--
-- The problem this closes: `raw_author_daily` and `pr_records` were keyed by provider
-- FAMILY (`github`/`bitbucket`/`gitlab`) with no container column, so every Bitbucket
-- workspace summed into the same rows. The pipeline's cursors, by contrast, have always
-- been keyed `git_last_sync:<type>:<container>` — so data and cursors disagreed about the
-- grain, and deleting a provider could purge the cursors that licensed rows nobody could
-- retract. Re-importing the window then double-counted permanently (#262).
--
-- Attribution key is now `(type, container)` on BOTH sides. Once data and cursors share a
-- key, the #262 failure mode becomes UNREACHABLE rather than guarded: a delete drops the
-- container's rows and its cursors together, so a re-added provider inherits nothing.
--
-- `git_snapshots` is deliberately NOT given a container column. It is documented (#253) as
-- a pure projection of (raw_author_daily, identity map) at the (developer_id, date) grain,
-- so a delete RE-PROJECTS the affected days from the surviving raw rows instead of deleting
-- blindly — a day-row may still carry another container's contribution. No new column, no
-- change for its many readers.
--
-- WHY THIS IS A RESET, NOT A BACKFILL. Existing rows cannot be split retroactively: which
-- workspace a merged `(github, alice, 2026-07-01)` row came from is simply not recorded.
-- The project is pre-production and its data is disposable, so the three data tables are
-- emptied and the `git_*` cursors cleared; a resync rebuilds everything cleanly and
-- correctly attributed.
--
-- Clearing `git_snapshots` is a CORRECTNESS requirement here, not convenience. Legacy cells
-- (`is_projected = 0`, migration 041) are immutable to the projection in BOTH directions, so
-- a delete cascade could never retract a deleted provider's contribution to one. Emptying
-- the table means every rebuilt row is projection-owned and therefore retractable, which is
-- what makes the cascade complete rather than partial.
--
-- THE DERIVED ROLLUPS DO *NOT* FOLLOW AUTOMATICALLY. `weekly_aggregates`,
-- `monthly_aggregates`, `quarterly_aggregates`, `yearly_aggregates` and `pr_review_metrics`
-- are a SECOND projection, UPSERTed per period key — and the aggregation scheduler recomputes
-- only the just-closed period (plus a short trailing window for the coaching engines). Every
-- older period therefore still holds totals for the `git_snapshots` rows this migration
-- deletes, and `/api/aggregates` serves those rows. After the post-migration resync, run
-- `toprope aggregate backfill --from <first-synced-day>` to rebuild them; the provider delete
-- path does this automatically for its own span (see `aggregation/retract.ts`), but a
-- migration cannot, because it does not know what the resync will import.
--
-- NOTE ON IDEMPOTENCE: unlike 040/041 this file is deliberately DESTRUCTIVE and is NOT
-- safe to re-execute against a populated database — re-running it would wipe a synced
-- store. The `schema_migrations` ledger runs it exactly once. The `IF EXISTS` clauses make
-- it safe against a *fresh* database only.
--
-- OPERATOR NOTE — WHAT THE FIRST RUN AFTER THIS MIGRATION DOES. `runMigrations` executes at
-- server start and at the top of every scheduled sync, so this reset applies without a
-- prompt. Because it clears the forward cursors, the next SCHEDULED run passes no first-sync
-- window, `firstSyncSince` returns '' (see sync.ts), and the pipeline walks the FULL history
-- of every configured provider — the first post-upgrade nightly sync is a complete re-import,
-- not a resumption. That is intended (the data is being rebuilt), but it is long and it
-- consumes provider rate limit; for a controlled rebuild, use the admin UI's per-provider
-- "Sync now" with an explicit months window before the scheduler fires.
--
-- EITHER WAY, FINISH WITH A BACKFILL. Whichever path is taken, the derived rollups are still
-- holding pre-042 totals for the rows deleted above, and only the just-closed period is
-- recomputed on its own. After the resync, run
--   toprope aggregate backfill --from <the earliest day the resync imported>
-- The "Sync now with a months window" path makes that MORE important, not less: it imports a
-- narrower span, so `--from` must still reach back to the oldest period that holds stale
-- totals, not merely to the start of the window just imported.

-- ─── raw_author_daily: + container, unique key widened ────────────────────────
DROP TABLE IF EXISTS raw_author_daily;

CREATE TABLE raw_author_daily (
    id TEXT PRIMARY KEY,                     -- uuid
    -- Provider family. Closed set, DB-enforced — same vocabulary as git_providers.
    provider TEXT NOT NULL CHECK (provider IN ('github', 'bitbucket', 'gitlab')),
    -- The provider INSTANCE this row was imported from: org (github) / workspace
    -- (bitbucket) / group (gitlab). Together with `provider` this is the attribution key
    -- a delete retracts by, and the same pair the pipeline's cursors are keyed on. Never
    -- blank — a blank container would collapse two workspaces back into one bucket, which
    -- is precisely the defect this column exists to remove.
    container TEXT NOT NULL CHECK (length(container) > 0),
    -- The immutable identity this row is keyed by:
    --   `${provider}:login:${login}`  (preferred), else
    --   `${provider}:email:${lowercased-email}`.
    -- Never blank — a truly-anonymous commit yields a null key and is skipped by the
    -- caller rather than collapsing every anonymous author into one `""` bucket.
    raw_author_key TEXT NOT NULL CHECK (length(raw_author_key) > 0),
    -- Best-known raw identity fields, for candidate pre-fill (DO1.4). Nullable: which
    -- one is known depends on the provider and on whether the commit carried an email.
    author_login TEXT,
    author_email TEXT,                       -- lowercased at the write boundary
    author_display_name TEXT,
    -- UTC day. Shape-pinned so string comparison (>=, ORDER BY, BETWEEN) is sound.
    date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    -- Commit-derived counters. Accumulate additively across runs (disjoint windows).
    commits INTEGER NOT NULL CHECK (commits >= 0),
    lines_added INTEGER NOT NULL CHECK (lines_added >= 0),
    lines_removed INTEGER NOT NULL CHECK (lines_removed >= 0),
    files_changed INTEGER NOT NULL CHECK (files_changed >= 0),
    -- PR/review counters. RE-DELIVERED by providers on every run (they fetch PRs by
    -- updated_at), so these combine with max() — never additively. See
    -- mergeDailyAcrossRuns in raw-author-daily.ts for the full reasoning.
    prs_opened INTEGER NOT NULL CHECK (prs_opened >= 0),
    prs_merged INTEGER NOT NULL CHECK (prs_merged >= 0),
    review_comments_given INTEGER NOT NULL CHECK (review_comments_given >= 0),
    avg_time_to_merge_hours REAL,            -- NULL when nothing merged that day
    -- Rate/score fields. Commit-count-weighted on merge so a 1-commit delta cannot
    -- drag a 100-commit accumulated row toward a plain mean.
    code_churn_rate REAL NOT NULL,
    ai_signature_score REAL NOT NULL,
    avg_commit_size REAL NOT NULL,
    commit_burst_count INTEGER NOT NULL CHECK (commit_burst_count >= 0),
    -- Provenance of the row itself (UTC ISO instants, not day strings): the earliest
    -- run that recorded this (provider, container, key, date) and the most recent run
    -- to touch it.
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    -- The merge identity. Every write is an upsert on this quad. Widened from
    -- (provider, raw_author_key, date) by #264: two workspaces of one family are two
    -- independent contributions to the same author-day, not one row to be max()-merged.
    UNIQUE(provider, container, raw_author_key, date)
);

-- The candidate/replay path reads "everything this author ever did", ACROSS containers:
-- who a raw identity is does not depend on which workspace they committed in.
CREATE INDEX IF NOT EXISTS idx_raw_author_daily_key ON raw_author_daily(provider, raw_author_key);
-- The projection path reads "every author active on these dates": index the day.
CREATE INDEX IF NOT EXISTS idx_raw_author_daily_date ON raw_author_daily(date);
-- The delete cascade (#264) reads/removes "everything this container ever imported" —
-- the date scan and the DELETE both key on (provider, container).
CREATE INDEX IF NOT EXISTS idx_raw_author_daily_container
    ON raw_author_daily(provider, container);

-- ─── pr_records: + container, unique key widened ──────────────────────────────
-- Same reasoning: a PR id is unique only WITHIN a container, and the cascade has to be
-- able to remove exactly one container's PRs. Recreated rather than ALTERed because the
-- unique key changes and `container` is NOT NULL with no honest backfill value.
DROP TABLE IF EXISTS pr_records;

CREATE TABLE pr_records (
    id TEXT PRIMARY KEY,
    developer_id TEXT NOT NULL REFERENCES developers(id),
    provider TEXT NOT NULL,
    -- The provider INSTANCE (org/workspace/group) this PR was imported from — the other
    -- half of the attribution key the delete cascade retracts by.
    container TEXT NOT NULL CHECK (length(container) > 0),
    repo TEXT NOT NULL,
    pr_id TEXT NOT NULL,
    state TEXT NOT NULL,                       -- open | merged | closed
    created_at TEXT NOT NULL,
    merged_at TEXT,
    closed_at TEXT,
    review_comment_count INTEGER NOT NULL DEFAULT 0,
    -- Review cycles: 0 = never reviewed; otherwise 1 + changes_requested_count.
    -- Persisted so a partial-fetch carry-forward can restore this verdict-derived
    -- value directly rather than recomputing it from a mix of fresh/stale inputs.
    review_rounds INTEGER NOT NULL DEFAULT 0,
    -- Number of normalized "changes requested" review events on this PR.
    changes_requested_count INTEGER NOT NULL DEFAULT 0,
    time_to_merge_hours REAL,
    synced_at TEXT NOT NULL,
    UNIQUE(provider, container, repo, pr_id)
);

CREATE INDEX IF NOT EXISTS idx_pr_records_dev_created ON pr_records(developer_id, created_at);
-- The cascade's per-container DELETE.
CREATE INDEX IF NOT EXISTS idx_pr_records_container ON pr_records(provider, container);

-- ─── git_snapshots: emptied (schema unchanged) ────────────────────────────────
-- DELETE rather than DROP/CREATE: the table's shape is still correct, and restating it
-- here would fork the definition that lives in 003/009/041. Every surviving row would be
-- either a stale merged multi-container total or a legacy (`is_projected = 0`) cell the
-- projection may never retract — so the honest state is empty, rebuilt by resync.
DELETE FROM git_snapshots;

-- ─── git_* cursors: cleared ───────────────────────────────────────────────────
-- The forward cursor, the earliest-synced watermark and the stall counter all license
-- data that no longer exists. Leaving any of them would make the next sync resume from a
-- cursor with nothing behind it — the #262 gap, re-created by the migration itself.
DELETE FROM sync_state
 WHERE key LIKE 'git_last_sync:%'
    OR key LIKE 'git_earliest_sync:%'
    OR key LIKE 'git_stall:%';

-- ─── git_providers: UNIQUE(type, container) ───────────────────────────────────
-- 039 created only a non-unique INDEX on (type, container), so two rows for one
-- workspace were allowed — and both would have synced it through the one shared
-- container-keyed cursor, fighting each other and double-importing into one data bucket.
-- That is a latent bug independent of this issue; making the pair unique closes it and
-- makes "one provider = one independent data set" true by construction.
--
-- Duplicates must be resolved before the unique index can be built. Keep the OLDEST row
-- per (type, container) — deterministic via (created_at, id), and the older row is the one
-- whose id the admin has been operating on. This can only ever delete a row that was
-- already unreachable-by-design (its container's data and cursor belonged to the sibling),
-- and the imported data it would have owned is being cleared above regardless.
-- Phrased as "delete any row that has an OLDER sibling for the same pair" rather than as a
-- NOT IN over a keep-set: it is one level instead of three, and it is TOTAL. A NOT IN
-- formulation compares with `=`, which yields NULL (not false) for a NULL column, so a row
-- with a NULL type/container/id would fall out of the keep-set logic in both directions and
-- survive as a duplicate — making the unqualified CREATE UNIQUE INDEX below throw and abort
-- the whole migration. `EXISTS` has no such hole, and the explicit tiebreak on `id` keeps the
-- ordering total when two duplicates share a `created_at`.
DELETE FROM git_providers
 WHERE EXISTS (
    SELECT 1 FROM git_providers o
     WHERE o.type = git_providers.type
       AND o.container = git_providers.container
       AND (
            o.created_at < git_providers.created_at
            OR (o.created_at = git_providers.created_at AND o.id < git_providers.id)
       )
 );

-- Replace the non-unique index with a UNIQUE one under the same name. The DROP is
-- required: `CREATE UNIQUE INDEX IF NOT EXISTS` against an existing non-unique index of
-- the same name is a silent no-op, which would leave the constraint unenforced.
DROP INDEX IF EXISTS idx_git_providers_type_container;
CREATE UNIQUE INDEX idx_git_providers_type_container ON git_providers(type, container);
