-- DO1.2 (#252): raw_author_daily — the RETAINED authorship spine (Epic DO1 / #250).
--
-- Why it exists: `git_snapshots` is keyed by the MUTABLE `developer_id`, so a commit
-- whose author has no developer record at sync time is dropped and can never be
-- recovered (the incremental cursor never re-fetches its window). This table records
-- one daily fact row for EVERY author — matched and unmatched alike — keyed by the
-- IMMUTABLE raw git identity, so attributing a newly-added developer is just a
-- re-projection over retained rows rather than a re-fetch.
--
-- The metric columns mirror exactly what `aggregateDailyMetrics` produces, so a
-- projection into git_snapshots (DO1.3 / #253) is a pure function of
-- (raw_author_daily, identity map) — idempotent, never double-counting.
--
-- Fail-closed at the schema edge, matching the CHECK-heavy convention of 037/039:
-- `provider` is a closed set, the counters cannot go negative, and `date` is pinned
-- to a UTC YYYY-MM-DD shape so a malformed day can never sort into a window it does
-- not belong to. IF NOT EXISTS keeps re-running the file a no-op (idempotent) even
-- outside the schema_migrations ledger.
CREATE TABLE IF NOT EXISTS raw_author_daily (
    id TEXT PRIMARY KEY,                     -- uuid
    -- Provider family. Closed set, DB-enforced — same vocabulary as git_providers.
    provider TEXT NOT NULL CHECK (provider IN ('github', 'bitbucket', 'gitlab')),
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
    -- run that recorded this (provider, key, date) and the most recent run to touch it.
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    -- The merge identity. Every write is an upsert on this triple.
    UNIQUE(provider, raw_author_key, date)
);

-- The candidate/replay path reads "everything this author ever did": index the key.
CREATE INDEX IF NOT EXISTS idx_raw_author_daily_key ON raw_author_daily(provider, raw_author_key);
-- The projection path reads "every author active on these dates": index the day.
CREATE INDEX IF NOT EXISTS idx_raw_author_daily_date ON raw_author_daily(date);
