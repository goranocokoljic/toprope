# Idempotent Git Ingestion — design sketch

**Status:** proposal (2026-08-09). Written as the structural exit from the
#262→#313 review loop: instead of defending the disjoint-window/additive-merge
invariant with one more guard per review cycle, remove the invariant.

## The problem, in one sentence

`raw_author_daily`'s commit counters (`commits`, `lines_added`, `lines_removed`,
`files_changed`, and the rates derived from them) are **added** across sync
runs, which is only correct if every run's commit window is provably disjoint
from everything already stored — and that proof is carried by sync cursors,
which every feature since #229 (backfill, delete, re-add, scoped sync, retry,
catch-up caps, stall detection) has had to be individually prevented from
invalidating.

That single design commitment is the root of most of the loop's findings:
#231 (cursor must advance atomically with data), #233 (backfill atomicity,
lexical watermark comparison), #235 (stalled-provider bounding), #246/#247/#248
(cursor-derived health readers), #262 (delete re-arms double-count), #264
(per-container attribution so deletes can retract), #266 (container
normalization so cursors aren't orphaned), #302/#304/#309 (date pinning so a
bad date can't roll a window back). Each fix is locally correct; collectively
they are case law defending one fragile invariant.

## The insight the codebase already contains

Two tables in this pipeline are already idempotent and have generated ~zero
review findings about corruption:

- **`commit_diffstats`** (#273): keyed `(provider, container, repo, sha)`.
  A memo of an immutable fact. Re-fetching is harmless; deleting is harmless;
  overlap is harmless. No cursor proof needed.
- **`pr_records`** (#264 key): keyed `(provider, container, repo, pr_id)`,
  upsert-replace of *state*. PRs are re-delivered by `updated_at` on every
  run and that's fine, because a replace of state is idempotent.

The remaining additive piece — the per-day commit counters — is additive only
because the pipeline aggregates commits *before* persisting them, throwing
away the commit identity (sha) that would make the write idempotent. Keep the
sha, and the whole invariant evaporates.

## Target design

### 1. New source-of-record table: `raw_commits`

```sql
CREATE TABLE raw_commits (
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

CREATE INDEX idx_raw_commits_author_day ON raw_commits(provider, container, raw_author_key, author_day);
```

Write path: `INSERT ... ON CONFLICT DO NOTHING` (a commit is named by the hash
of its content; a re-observed sha is the same fact — exactly the
`commit_diffstats` argument). One row per commit, written inside the run's
write transaction as today.

**Sizing:** one row per distinct commit ever synced — the same growth class as
`commit_diffstats`, which stores strictly more per row (the full per-file JSON)
and was accepted in #273. Millions of rows is a normal SQLite workload, and the
`WITHOUT ROWID` PK makes the hot upsert a single B-tree seek.

### 2. `raw_author_daily` becomes a projection

Exactly the move #253 already made for `git_snapshots`. The commit counters
for a `(provider, container, raw_author_key, author_day)` cell are recomputed
by `SUM(...)` over `raw_commits` for every cell an ingest touched, in the same
transaction, replacing the stored value (`INSERT OR REPLACE`, not `+=`).
`avg_commit_size`, `code_churn_rate`, `ai_signature_score`,
`commit_burst_count` are derived in the same recompute — no commit-count
weighting needed, because the recompute always sees *all* the commits, not a
delta. PR counters keep their existing `pr_records`-derived path.

> **Amendment pending sign-off (raised by IG1.2 / #318, drift notice on epic #316).**
> Two of those four are **not derivable from the §1 schema**, so as landed they are
> supplied by the caller from its own observation of the cell rather than projected:
> `ai_signature_score` is a 0–100 score read from the commit *message*
> (`scoreAiSignature`) and §1 stores a 0/1 `ai_signature` flag and no message;
> `code_churn_rate` needs per-*file* paths and a 48 h cross-day window
> (`calculateDailyChurnRates`) and §1 stores no paths — which §5 deliberately forbids.
> `avg_commit_size` and `commit_burst_count` **are** projected, as written.
> Nothing is additive either way, so the epic's guarantee (a re-observed commit cannot
> inflate a counter) holds whole, and criterion B (golden equivalence) is met exactly.
> Making the other two true projections needs a §1 amendment — an `ai_signature_score
> REAL` column, plus either per-file paths (a §5 privacy-model change) or an accepted
> semantics change for churn. That is a user decision, not a child's.
>
> Two smaller deviations from the same notice: `is_merge` is always `0`, because no
> in-tree provider exposes a merge flag on `GitCommit` and this epic may not change the
> adapters; and the `raw_commits` conflict clause is `DO UPDATE … WHERE` a strictly more
> informative observation arrives, not a bare `DO NOTHING`, so a commit first seen with a
> degraded diffstat (#288) is not frozen at zero while the later run's advisory clears.

`git_snapshots` stays exactly what it is: a projection of
`(raw_author_daily, identity map)`.

### 3. What each hazard class becomes

| Today (invariant-defended) | After (structural) |
|---|---|
| Overlapping sync windows double-count | Same sha upserts once — overlap is a no-op |
| Delete + re-add re-imports a span and double-counts (#262) | Cascade deletes the container's `raw_commits`; re-import re-inserts the same rows |
| Backfill must prove disjointness vs watermark (#229/#233) | Backfill is just "fetch older, insert-or-ignore, re-project" |
| Cursor must advance atomically with data (#231) | Cursor is a *fetch optimization* (where to start asking), never a correctness proof; a stale cursor costs API calls, not correctness |
| Scoped/per-provider sync clobbers the merged row (#192/#205) | Projection recomputes from all rows; scope only affects what was fetched |
| A bad/future date rolls a window back and re-adds (#302/#304/#309) | A bad date mis-buckets one commit's day (still worth pinning at the boundary, once) — it cannot double anything |
| Partial-run data must be discarded (#231) and ratcheted back in (#273) | Partial inserts are permanently safe; the failed run's rows are simply already there next time. `commit_diffstats` remains as the diffstat memo, or folds away later since `raw_commits` persists per commit |

The rules in `review-rules.md` that exist to defend the additive merge
("additive merge may only sum genuinely-disjoint deltas", "before deleting
state, ask which invariant reads it as proof", the cursor halves of
"completion signal is not a currency claim" and "remedy must be safe") become
satisfied-by-construction. After the refactor lands, prune them from the KB —
a 22 KB always-loaded rulebook is itself loop fuel (it primes every reviewer
to hunt the same class).

### 4. Migration & rollout

Pre-production with disposable data (project memory, 2026-07-26), so no
backfill gymnastics — this is the cheapest it will ever be:

1. Migration `046`: create `raw_commits`; clear `raw_author_daily`,
   `git_snapshots`, `pr_records`' derived day-counters, the `git_*` sync
   cursors, and `commit_diffstats` (per the 044 reset contract); leave a
   `git_data_reset_pending` marker exactly as 043 did, so `toprope doctor`
   fails until a resync is acknowledged.
2. Rewrite the ingest tail of `sync.ts`: per-commit rows in, per-cell
   projection out. Delete `mergeDailyAcrossRuns` and the disjointness
   commentary; delete the cursor-atomicity coupling (keep cursors as fetch
   hints only).
3. Resync all providers. Verify row counts and spot-check a handful of
   developer-days against provider UIs.
4. Prune the obsoleted KB rules and regenerate `review-rules.md`.

### 5. What this does NOT change

- **Append-only for true snapshot tables** (`tool_snapshots` etc.) — untouched.
- **The privacy model** — `raw_commits` stores no file paths (those stay in
  `commit_diffstats` under its documented retention decision), only counts and
  the same identity fields `raw_author_daily` already holds.
- **The provider fetch layer** — retry, paging, rate limits, progress
  reporting all stay. Only the *write boundary* changes shape.

### Expected size

Roughly: one migration, one focused rewrite of the `sync.ts` write tail plus
`raw-author-daily.ts` (the two files are 4,821 and 1,093 lines today largely
*because* of the invariant they defend — expect net-negative LOC), and test
updates. One epic with 3–4 children, run under the new convergence guard.
