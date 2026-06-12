-- Task 5.2 (#123): PR/Review Outcome Metrics Engine.
--
-- pr_records: one row per pull request, the normalized per-PR facts the
-- coaching engine computes from. Written by the git sync (all three providers
-- normalize into this shape) and re-upserted on every sync, so a PR's outcome
-- fields (state, merge time, review rounds) converge as its life progresses.
-- This is deliberately NOT append-only like the snapshot tables: a PR is a
-- living entity until it closes, and the engine wants its latest verdict.
CREATE TABLE pr_records (
    id TEXT PRIMARY KEY,
    developer_id TEXT NOT NULL REFERENCES developers(id),
    provider TEXT NOT NULL,
    repo TEXT NOT NULL,
    pr_id TEXT NOT NULL,
    state TEXT NOT NULL,                       -- open | merged | closed
    created_at TEXT NOT NULL,
    merged_at TEXT,
    closed_at TEXT,
    review_comment_count INTEGER NOT NULL DEFAULT 0,
    -- Review cycles: 0 = never reviewed; otherwise 1 + changes_requested_count.
    review_rounds INTEGER NOT NULL DEFAULT 0,
    -- Number of normalized "changes requested" review events on this PR.
    changes_requested_count INTEGER NOT NULL DEFAULT 0,
    -- Observed count of review verdict events (any state). Persisted as its own
    -- column so a partial-fetch carry-forward can restore the OBSERVED value
    -- rather than reverse-engineering it from review_rounds (which would assume
    -- review_rounds == 1 + changes_requested_count for every historical row).
    review_event_count INTEGER NOT NULL DEFAULT 0,
    time_to_merge_hours REAL,
    synced_at TEXT NOT NULL,
    UNIQUE(provider, repo, pr_id)
);

CREATE INDEX idx_pr_records_dev_created ON pr_records(developer_id, created_at);

-- pr_review_metrics: per-developer per-period PR/review outcome aggregates in
-- two clearly-separated scope variants — all_pr (factual) and ai_assisted_pr
-- (inferred via AI signature, lower confidence). Schema per issue #123.
CREATE TABLE pr_review_metrics (
    id TEXT PRIMARY KEY,
    developer_id TEXT NOT NULL REFERENCES developers(id),
    period TEXT NOT NULL,                 -- YYYY-Www or YYYY-MM
    scope_variant TEXT NOT NULL,          -- all_pr | ai_assisted_pr
    -- Outcome signals
    prs_total INTEGER DEFAULT 0,
    prs_merged INTEGER DEFAULT 0,
    rework_rate REAL,                     -- PRs requiring changes / prs_total
    avg_review_rounds REAL,               -- mean review cycles before merge
    review_rejection_rate REAL,           -- PRs sent back for changes / prs_total
    avg_comment_density REAL,             -- review comments / PR, this period
    comment_density_vs_baseline REAL,     -- ratio to developer's own baseline
    avg_time_to_merge_hours REAL,
    -- Reciprocity signal: comments GIVEN over the whole period. Period-scoped,
    -- not PR-scoped — identical on both variant rows of a developer+period.
    review_comments_given INTEGER,
    -- Combination signal. Approximation: the developer's mean daily churn over
    -- the period (git_snapshots), NOT the churn of exactly these PRs' commits —
    -- commits are not linked to PRs by the provider layer.
    avg_churn REAL,
    combined_signal TEXT,                 -- struggling | healthy_iteration |
                                          -- effective | insufficient_data
    -- Confidence
    basis TEXT NOT NULL,                  -- factual (all_pr) | inferred (ai_assisted_pr)
    computed_at TEXT NOT NULL,
    UNIQUE(developer_id, period, scope_variant)
);

CREATE INDEX idx_pr_review_metrics_dev_period ON pr_review_metrics(developer_id, period);
