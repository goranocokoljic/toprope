# Toprope — Idempotent Git Ingestion Task Tracker

**Feature: sha-keyed `raw_commits` as the git source of record — double-counting becomes structurally impossible**

1 Epic + 4 dependency-ordered children | Design: `dev-docs/Idempotent_Git_Ingestion_Design.md` (**the design doc is
the contract — this tracker adds task boundaries, acceptance criteria, and drift guards; where the two could ever be
read differently, the design doc wins and the discrepancy is raised to the user, not resolved silently**).
Source: the #262→#313 review-loop post-mortem (2026-08-10) — the additive-merge/disjoint-window invariant was the
loop's fuel supply.

> Same epic-and-subtask format as the Phase / GC1 / DO1 trackers. The epic is the tracking parent carrying full
> context + cross-cutting acceptance criteria (written once); children are day-or-less, independently-testable,
> PR-per-unit work items that inherit the epic's context by reference and carry their own mechanical criteria.
>
> Two-level numbering: epic = `IG1`; children = `IG1.1` … `IG1.4`. Feed the LEAF numbers into the
> dev-cycle-phases skill as executable units (epic-batching mode recommended — see **How to run** at the bottom).
>
> GitHub: the epic is a parent issue with a `## Subtasks` checklist **and** each child linked as a **native
> sub-issue** (`gh api …/sub_issues` — a `## Children` header alone silently fails harness epic detection).
> Children carry an `Epic: #NN` line. The epic closes when all children are done.

---

## Why we are doing this (the problem)

`raw_author_daily`'s commit counters are **added** across sync runs. That is only correct if every run's commit
window is provably disjoint from everything already stored — and that proof is carried by sync cursors, which every
feature since #229 (backfill, delete, re-add, scoped sync, retry, catch-up caps, stall detection) has had to be
individually prevented from invalidating. That one design commitment generated most of the #262→#313 review loop.

Two tables in the same pipeline are already idempotent and have generated ~zero corruption findings:
`commit_diffstats` (sha-keyed memo, #273) and `pr_records` (state-keyed replace, #264 key). The commit counters are
additive only because commits are aggregated **before** persisting, discarding the sha that would make the write
idempotent. **Keep the sha and the invariant evaporates.**

### The strategy (from the design doc — repeated here as the epic's shared mental model)

1. New source-of-record table **`raw_commits`**, PK `(provider, container, repo, sha)`, written
   `INSERT … ON CONFLICT DO NOTHING`. A re-observed sha is the same fact; overlap is a no-op.
2. **`raw_author_daily` becomes a projection**: every cell an ingest touches is recomputed by aggregate over
   `raw_commits` in the same transaction (`INSERT OR REPLACE`, never `+=`) — exactly the move #253 already made for
   `git_snapshots`. PR counters keep their existing `pr_records`-derived path.
3. **Cursors demote to fetch hints.** A stale, lost, or overlapping cursor costs API calls, never correctness.
4. Pre-production reset (042/043 precedent) + resync; prune the KB rules the new model satisfies by construction.

### What this epic is NOT (locked out-of-scope — spawning any of these from a review is a policy violation)

- **No provider-adapter rewrite.** `github.ts`/`gitlab.ts`/`bitbucket.ts` fetch logic, retry, paging, progress
  reporting and advisory accounting stay as they are. Slimming the adapters is a *possible follow-up epic* after
  this one lands — not a child, not a stretch goal.
- **No `client.ts` decision.** The legacy `GitClient` question (dead code or production caller?) stays in the
  parking lot.
- **No change to `tool_snapshots` or any non-git snapshot table.** Append-only there is untouched.
- **No privacy-model change.** `raw_commits` stores counts + the same identity fields `raw_author_daily` already
  holds; file paths stay only in `commit_diffstats` under its documented retention decision.
- **No new config knobs, no compatibility mode, no dual-path writes.** The old merge path is deleted, not toggled.

---

## Epic IG1 — Idempotent git ingestion: sha-keyed `raw_commits` as the source of record

**Cross-cutting acceptance criteria** (inherited by every child; the epic-finalize review anchors on these):

- **A. Idempotence is provable, not argued.** Running the same sync twice over the same window (same fixtures)
  yields byte-identical `raw_commits`, `raw_author_daily`, and `git_snapshots` contents. There is a test that does
  exactly this (see Verification matrix V1).
- **B. Single-run equivalence.** For a fresh database and one sync run, the recomputed `raw_author_daily` cells are
  **value-identical to what today's pipeline produces** for the same fixtures (golden test pinned BEFORE the write
  path changes — IG1.1 records the golden, IG1.2 must match it). This is the no-silent-semantics-drift guard.
- **C. The disjointness machinery is gone, not bypassed.** `mergeDailyAcrossRuns`, `mergeDailyDisjoint`, and
  `commitWeightedAvg` (`src/connectors/git/raw-author-daily.ts:257-360`) are deleted. Any surviving caller is a
  build error, not a runtime fallback.
- **D. Write-boundary refusals survive.** The `ROW_LEVEL_REFUSALS` vocabulary and semantics
  (`raw-author-daily.ts:539`, #302/#306/#307/#309 behavior — including `future_date` and the systemic fail-closed
  escalation) guard the new write path with unchanged observable behavior; the existing refusal test suites pass
  with only mechanical fixture updates.
- **E. Projection contract unchanged downstream.** `projectSnapshots` / `replayDeveloper` / `replayDevelopers`
  (`src/connectors/git/projection.ts:381,476,507`) keep their signatures and observable behavior —
  `git_snapshots` remains a pure projection of `(raw_author_daily, identity map)` bounded by `is_projected`.
- **F. Verification matrix complete.** Every row of the matrix below has a named, passing test when the epic PR
  opens. A row without a test is an unmet epic criterion — the finalize review must treat it as a blocker.
- TypeScript strict throughout; no `any`; explicit return types on exported functions; all timestamps UTC ISO.

### Verification matrix — design §3, each hazard mapped to the test that proves it is structurally gone

| # | Old hazard (defended by invariant) | Proof test (child) |
|---|---|---|
| V1 | Overlapping windows double-count | sync same window twice → identical tables (IG1.2) |
| V2 | Delete + re-add re-imports and double-counts (#262) | delete container → re-add → resync → counts equal first import (IG1.3) |
| V3 | Backfill must prove disjointness (#229/#233) | backfill an overlapping older span → no cell changes twice (IG1.3) |
| V4 | Cursor must advance atomically with data (#231) | delete the cursor mid-history → resync → identical tables, only extra fetches (IG1.2) |
| V5 | Scoped sync clobbers merged rows (#192/#205) | sync provider A then B into one developer-day → recompute preserves both (IG1.2) |
| V6 | Partial-run data discarded / ratcheted (#231/#273) | failed run's inserted `raw_commits` rows survive and next run completes without double-count (IG1.2) |
| V7 | Late-added developer replay (#253) | add developer after sync → `replayDeveloper` attributes retained history (existing tests keep passing) (IG1.3) |

---

### IG1.1 — Schema: `raw_commits` + migration 046 (reset, marker, golden baseline)

**Scope.** The table, the reset migration, and the pre-change golden fixture that IG1.2 must reproduce.

**Design anchors (verbatim constraints — deviations are drift):**
- Table exactly as design §1: PK `(provider, container, repo, sha)` `WITHOUT ROWID`; provider CHECK on the closed
  set `('github','bitbucket','gitlab')`; non-blank CHECKs on `container`/`repo`/`sha`/`raw_author_key`;
  `author_day` GLOB-pinned `YYYY-MM-DD`; counters `>= 0`; `is_merge`/`ai_signature` in `(0,1)`; `committed_at` and
  `first_seen` UTC ISO instants; single secondary index
  `idx_raw_commits_author_day (provider, container, raw_author_key, author_day)`. No extra columns, no extra
  indexes (the design's `commit_diffstats` no-secondary-index reasoning applies).
- Migration 046 clears: `raw_author_daily` (all rows), `git_snapshots` (all rows — 042 precedent), every
  `git_last_sync:*` and `git_earliest_sync:*` row in `sync_state` (`src/connectors/git/sync.ts:1606,1616` key
  shapes), and `commit_diffstats` (the 044 header's reset contract: *"any future migration or command that resets
  git data must add `DELETE FROM commit_diffstats`"*).
- **Locked decision — `pr_records` is NOT cleared.** The design's "pr_records' derived day-counters" live in
  `raw_author_daily` rows (already cleared); `pr_records` itself is state-keyed idempotent and resync re-upserts
  it. Clearing it would be scope creep, not fidelity.
- Reset marker: reuse the existing mechanism — `git_data_reset_pending` via
  `src/connectors/git/reset-notice.ts` (`gitResetNotice` / `clearGitResetNotice` / `gitResetNoticeMessage`), with
  migration id `046`. Do NOT hand-roll a second notice path (canonical-helper rule); `toprope doctor` must fail
  until the resync is acknowledged exactly as it did for 043.
- Golden baseline: BEFORE any write-path change, capture today's `raw_author_daily` output for a deterministic
  multi-provider fixture run (frozen clock) into a committed golden fixture + a test asserting today's pipeline
  reproduces it. IG1.2 inherits this test unchanged — it is criterion B's instrument.

**MUST NOT:** touch `sync.ts` write logic; touch `raw-author-daily.ts` beyond (if needed) exporting a read hook for
the golden test; write any code that reads `raw_commits` yet (the table lands empty and unread — that is correct
for this child).

**Done means:** migration applies idempotently on a fresh AND an existing dev db; schema matches design §1
byte-for-byte on the constraints above; doctor fails with the 046 notice until acknowledged; golden test green.

**Criterion → test:** schema CHECKs each have a rejection test (mirror `raw-author-daily-migration.test.ts` style);
reset behavior test (rows gone, cursors gone, diffstats gone, notice present); golden fixture test.
**Est. diff:** ~250 lines + fixtures. **Review sizing:** child fast-lens SEC (epic mode default).

---

### IG1.2 — Write boundary: per-commit inserts + per-cell recompute (the core)

**Scope.** Rewrite the ingest tail of `sync.ts` and the write half of `raw-author-daily.ts`.

**Design anchors:**
- Inside the run's existing write transaction (`sync.ts` ~2435): for each analyzed commit, one
  `INSERT INTO raw_commits … ON CONFLICT DO NOTHING` row carrying the same per-commit facts
  `aggregateDailyMetrics` (`src/connectors/git/analyzer.ts:131`) consumes today.
- Collect the touched set of `(provider, container, raw_author_key, author_day)` cells; recompute each touched cell
  from `raw_commits` by aggregate and write with `INSERT OR REPLACE` — **never `+=`, never a merge of stored+new**.
  The recompute always sees ALL of the cell's commits, so no commit-count weighting exists anywhere anymore.
- PR counters (`prs_opened`, `prs_merged`, `review_comments_given`, `avg_time_to_merge_hours`) keep their existing
  `pr_records`-derived path (`sync.ts` ~3712) — merged into the recomputed cell write, not moved into
  `raw_commits`. `raw_commits` is commits only.
- Delete `mergeDailyAcrossRuns`, `mergeDailyDisjoint`, `commitWeightedAvg` and the disjointness commentary
  (criterion C). Delete the cursor-atomicity **correctness** coupling; keep cursor advance as a fetch optimization
  with its existing keys — an operator's mental model of "where the sync got to" does not change.
- `assertValidInput` / `ROW_LEVEL_REFUSALS` (including #309's `future_date` and #306's systemic fail-closed
  escalation) now guard the `raw_commits` insert; a refused commit inserts nothing and reports exactly as today
  (criterion D). `upsertRawAuthorDaily`'s external error contract (`RawAuthorDailyError`, codes) is preserved for
  its callers even as its internals become insert+recompute.
- `commit_diffstats` stays exactly as is — the per-commit memo that avoids re-FETCHING; `raw_commits` is what makes
  the result of that fetch permanent. They are complementary, per the design's §3 table row on partial runs.

**MUST NOT:** change provider adapters (`github.ts`/`gitlab.ts`/`bitbucket.ts`) beyond, at most, threading an
already-available field; change any advisory/progress/report string except where a deleted mechanism's text refers
to the old merge; add a config knob or dual path; reorder the run's phase structure; touch the delete cascade or
backfill routes (that is IG1.3 — this child may leave them temporarily broken ONLY if the epic branch stays
unmerged, and their suites are updated in IG1.3, not skipped).

**Done means:** criteria A (V1), B (golden test unchanged and green), C, D met; V4, V5, V6 tests written and green;
full gate green except any cascade/backfill suites explicitly handed to IG1.3 (list them in the child PR body if
so — silent skips are drift).

**Criterion → test:** V1 (same window twice, byte-identical tables); V4 (cursor deleted mid-history → identical
tables); V5 (two providers, one developer-day); V6 (failed run keeps `raw_commits` progress, completion doesn't
double); golden equivalence (from IG1.1); every `ROW_LEVEL_REFUSALS` code exercised against the new path.
**Est. diff:** large (~800–1,200 lines net-negative on src). **Review sizing:** this child is the one that warrants
the fast SEC lens run even in epic mode — do not skip it.

---

### IG1.3 — Grain consumers: delete cascade, backfill, replay on the new model

**Scope.** Rewire the three paths that today lean on the invariant.

**Design anchors:**
- **Provider delete cascade (#264)** — `src/dashboard/api/admin/git-providers.ts` route: retracting a container
  becomes `DELETE FROM raw_commits WHERE provider=? AND container=?` (plus the existing `commit_diffstats` and
  `pr_records` deletes), then recompute the affected `raw_author_daily` cells (empty set ⇒ cell row deleted) and
  re-project `git_snapshots` for the affected days via the existing `projectSnapshots` path. The `is_projected`
  bound still holds: the projection deletes only what it produced.
- **"Sync older history" backfill (#229/#232)** — becomes: fetch older span, `INSERT … ON CONFLICT DO NOTHING`,
  recompute touched cells. The earliest-watermark disjointness proof (#233) is deleted; `git_earliest_sync` stays
  as the fetch hint that decides what "older" means. The route's existing 409s that are pure UX (inverted request)
  stay; any 409 that exists only to protect the merge invariant is deleted — classify each in the PR body.
- **Replay (#253)** — `replayDeveloper`/`replayDevelopers`/`projectSnapshots` are read-side and should need **no
  behavioral change** (they consume `raw_author_daily`, which is still there — just projected now). This child's
  job for replay is verification, not modification: run their suites, and add V7's explicit end-to-end if #253's
  existing tests don't already cover add-developer-after-sync → replay (they do — confirm and cite, don't
  duplicate).

**MUST NOT:** introduce a second recompute implementation — IG1.2's cell-recompute is the single canonical one,
exported and reused here (canonical-helper rule); change route DTOs/status codes except where a deleted guard makes
one unreachable (document each in the PR body); touch identity-mapping/onboarding logic (`onboarding.ts`) beyond
its call into the shared recompute.

**Done means:** V2, V3, V7 green; every cascade/backfill suite handed over from IG1.2 restored and green; the #264
"each provider lives and dies independently" property demonstrably survives (existing tests pass on the new
mechanism).

**Criterion → test:** V2 (delete → re-add → equal counts); V3 (overlapping backfill is a no-op on overlapped
cells); V7 (cited or added); cascade leaves other containers' rows untouched (existing #264 tests).
**Est. diff:** ~400–600 lines. **Review sizing:** child fast-lens SEC.

---

### IG1.4 — Reset, resync, verify, prune (the epic's landing gear)

**Scope.** The operational cutover plus the documentation/KB debt the new model retires. No product code changes
except `toprope doctor` copy if the 046 notice needs it.

**Checklist (each item is an acceptance criterion):**
1. Run migration 046 on the dev database; run `toprope sync all` against the real configured providers; verify
   `toprope doctor` goes green after `clearGitResetNotice` ack; spot-check ≥3 developer-days per provider against
   the provider UI and record the comparison in the PR body (row counts + one named developer-day each).
2. Rewrite the **CLAUDE.md Key Constraints** append-only exception block: the #253/#264/042/043 essay collapses to
   the new model's statement — `raw_commits` is the immutable source of record; `raw_author_daily` and
   `git_snapshots` are recomputed projections; `commit_diffstats` unchanged; `tool_snapshots` strictly append-only.
   (Docs-must-match-code is a graduated rule; the old essay describing deleted machinery is a violation the moment
   IG1.2 merges.)
3. Update `dev-docs/Idempotent_Git_Ingestion_Design.md` status header from "proposal" to "landed (IG1, #NN)".
4. KB prune — run `node scripts/kb/graduate.mjs --retire <id>` for lessons the model now satisfies by
   construction, then regenerate. Candidate list (verify each against the landed code before retiring; retiring a
   still-live rule is drift in the other direction):
   `an-additive-merge-may-only-sum-genuinely-disjoint-deltas-com`,
   `before-deleting-state-ask-which-invariant-reads-it-as-proof`,
   `a-scoped-single-source-write-into-a-multi-source-aggregated-`, and the cursor-proof halves of
   `a-completion-signal-is-not-a-currency-claim` (retire only if the remaining half is re-filed as a narrower
   lesson — otherwise keep).
5. Parking-lot triage: strike the entries the epic retires (mark with `~~…~~ retired by IG1`), leave the rest.

**MUST NOT:** retire `a-stricter-guard-needs-the-input-class-that-only-it-handles`,
`never-memoize-a-value-derived-from-a-response-you-have-just-`, or any testing/docs rule — those are
model-independent.

**Est. diff:** docs + jsonl only. **Review sizing:** skip lenses; the epic finalize review covers the stack.

---

## Dependencies

`IG1.1 → IG1.2 → IG1.3 → IG1.4`, strictly sequential (each child builds on the previous one's schema/write/consumer
layer). No parallelism inside this epic — the value of stacking is one full review of the coherent whole.

## How to run

1. Import to GitHub: epic issue `IG1` (full "Why" + strategy + cross-cutting criteria + verification matrix +
   `## Subtasks` checklist), four child issues each with `Epic: #NN`, its own section from this tracker verbatim,
   and — required — linked as **native sub-issues**:
   `gh api repos/{owner}/{repo}/issues/{epic}/sub_issues -f sub_issue_id=<child-node-id>`.
2. Run via the harness in epic-batching mode (children stack on `epic/issue-{NN}-idempotent-ingestion`, fast SEC
   lens per child, one full five-lens review at finalize):
   `./tr-harness.ps1 <IG1.1#> <IG1.2#> <IG1.3#> <IG1.4#> <IG1#> …` per the harness's epic flags.
3. The convergence guard applies throughout: out-of-diff findings park, spawn budget max 1 per completed issue,
   chain depth ≤ 2 without human approval. The epic's own **locked out-of-scope list** (top of this file) binds
   reviewers too: an adapter-rewrite or client.ts finding is a parking-lot entry, not a blocker.

## Drift protocol

If, mid-implementation, a child discovers the design is wrong or incomplete (not merely inconvenient): **stop, do
not improvise a deviation.** Write the discrepancy into the epic issue as a comment, propose the design-doc edit,
and get the user's sign-off; then update the design doc AND this tracker in the same commit as the code that
depends on the change. The design doc and the code must never disagree silently — that is the exact failure mode
(docs-must-match-code, 26 recurrences) this tracker exists to prevent.
