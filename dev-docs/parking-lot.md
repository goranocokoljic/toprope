# Parking lot — deferred review findings

Review findings that did **not** clear the dev-cycle Convergence guard's
issue-spawning bar (see `.claude/skills/dev-cycle-phases/SKILL.md`). Nothing
here is lost — it is just not allowed to self-schedule. Triage deliberately,
in batches, when a milestone calls for it (e.g. before the develop→main
promotion, or when the git pipeline leaves pre-production and drop-and-resync
stops being an acceptable remedy).

Format: `- [#origin] file/area — one-sentence description (reviewer severity)`

## 2026-08-09 — parked when the #262→#313 loop was closed out

Formerly open issues, closed in favor of this list. Each was real but review-
spawned at chain depth ≥2, remediable by drop-and-resync pre-production, or
made moot if the idempotent-ingestion refactor
(`dev-docs/Idempotent_Git_Ingestion_Design.md`) lands.

- [#310, from #304 review] `src/connectors/git/sync.ts` advisory tiering — self-healing and out-of-window drops rank as permanent losses, and the forward cursor can roll backward (High). Tiering is cosmetic-operator-surface; the cursor-rollback half is obsoleted by idempotent ingestion.
- [#312, from #306 review, SO-3] `src/connectors/git/raw-author-daily.ts` — `invalid_identity` sits on the wrong side of the `ROW_LEVEL_REFUSALS` split, and a truthy non-string author survives the adapter (High). Refusal-accounting taxonomy; grain disappears under idempotent ingestion.
- [#313, from #306 review, SEC-3] `pr_records` grain — a 100% row-level refusal still fails open: `records_skipped` moves but nothing escalates (High). Same class as #306, different grain; fold into the refactor's single write-boundary.

## 2026-08-10 — #309 review (first cycle under the convergence guard)

Out-of-diff observations from the four-lens review of PR #315, deduped. Full
context: `reviews/issue-309-multi-pass-1.md`.

- [#309 review] `src/connectors/git/providers/{bitbucket.ts:436, github.ts:866, gitlab.ts:326}` + `client.ts:238,293` — PR walks and client methods still hand-roll `since ? new Date(since) : null`, fail-open for any direct caller that bypasses `fetchProviderData`'s hoisted validation; the `GitProvider` contract doesn't state bound validity is the caller's obligation. Moot if idempotent ingestion lands.
- [#309 review] `src/connectors/git/raw-author-daily.ts` — future developer-days imported before #309 remain stored and keep projecting into `git_snapshots`; no doctor detection or cleanup path. Remedy today is the pre-production drop-and-resync.
- [#309 review] `src/connectors/git/sync.ts:4541-4557` — the unmatched-authors advisory iterates all `rawWrites` including skipped rows, so an author whose only day was refused can be listed as "retained but unattributed" (comment claims retained-only).
- [#309 review] `src/connectors/git/sync.ts:1877` — `typeof at !== 'string'` guard is subsumed by the now-total `isUtcIsoInstant`; drop on next touch.
- [#309 review] `src/connectors/git/sync.ts:2745` — `catchUpUntil` parses the raw cursor before `resolveCommitWindow` runs, so an unparseable cursor fails through a less-actionable path than the named window refusal.

## 2026-08-10 — #317 (IG1.1) SEC fast-lens

Out-of-diff observations from the child's single-lens SEC pass. In-diff findings
(the `last_sync_advisories` column left behind by the reset, the retained
`git_stall:*` / `git_row_refusal:*` streaks, and a header claim that did not
match the notice predicate) were fixed in the commit itself.

- [#317 review] `src/storage/migrations/{042,043,046}_*.sql` — the git-cursor purges use `LIKE 'git_last_sync:%'`, where `_` is a single-character wildcard, so the pattern is broader than intended; no stored key collides today (all keys are code-generated), but `GLOB 'git_last_sync:*'` is the exact form (Low).
- [#317 review] `src/storage/migrations/{043,046}_*.sql` — the reset-notice arm `weekly_aggregates.total_commits > 0` is NULL-blind (the column is `INTEGER DEFAULT 0`, nullable), so on the one upgrade path where a rollup is the only evidence, a NULL-valued row would produce a silent all-clear. No writer stores NULL today (Low).
- [#317 review] `src/connectors/git/providers/delete-cascade.ts` — does not retract `raw_commits`; correct for IG1.1 (the table is empty and unread), but the epic's hazard table promises the cascade retracts it. Must land with #318/#319 or the first provider delete after the write path switches leaves the new source of record behind (tracked by the epic, not a new issue).
- [#317 review] `src/storage/migrations/046_raw_commits.sql` — 046 clears the cursors AND `commit_diffstats`, so the next scheduled run walks full history with a cold diffstat ratchet, the most expensive shape of resync under #231's all-or-nothing rule. 042's header advised using the admin per-provider "Sync now" with an explicit window before the scheduler fires; 046 does not repeat that advice (Low).
- [#317 review] `tests/connectors/git/golden-raw-author-daily.test.ts` — deleting the golden fixture and re-running silently re-records whatever the pipeline currently produces (first run throws, second passes). Deliberate and documented in the file header; a checksum or an explicit `--update-golden` gate would close it (Low).

## 2026-08-11 — #318 (IG1.2) SEC fast-lens

Out-of-diff observations plus the Medium/Low findings the fast lens deferred. The one
High (a shape-valid but unparseable author-day throwing a `RangeError` out of the run's
write transaction) was fixed in the commit itself. The Medium/Low below carry to the
epic #316 review as well — parked here so they survive if that review does not reach them.

- [#318 review] `src/connectors/git/sync.ts:4551` — `cellObservations.set` is last-write-wins where the deleted fold combined; `rawAuthorKeyFor`'s login branch trims, so `' alice'` and `'alice'` are two `metricsMap` entries collapsing to one cell key and the last one wins for the four PR counters and the two carried rates (commit counters are unaffected — they come from the store). The reviewer's stated lowercase-email mechanism is NOT reachable; this trim-only variant is what survives (Medium).
- [#318 review] `src/cli/doctor.ts:690`, `src/connectors/git/sync.ts:771`/`:575`, `src/connectors/git/providers/window-bounds.ts` — four surfaces now advertise "rewind the cursor and re-import, it only costs API calls" on a sha-keyed-commit argument, but `raw_commits`' PK is `(provider, container, repo, sha)` and the cell recompute SUMs across repos, so a repo renamed between the original import and the rewind double-counts. Needs the qualifier (Low).
- [#318 review] `src/connectors/git/raw-commits.ts:171` — `insertRawCommit` validates `repo`/`sha` with `.trim()` but binds the untrimmed value (the graduated check-and-store-the-same-value rule). Fixing it means moving `commit_diffstats`' sha handling in step (Low).
- [#318 review] `src/connectors/git/sync.ts:4354`/`:4405` — advisory reporting was moved onto both completeness arms but `recordRowRefusal` / `isEscalatedRefusal` stayed on the complete-provider arm, so a provider that refuses rows every run while staying incomplete never writes `git_row_refusal:*` and never trips doctor's alert (Low).
- [#318 review] `src/connectors/git/sync.ts` (`formatSkippedAuthorDays` / `formatLossGroups`) — `raw_author_key` and `date` reach `sync_logs.errors` and the admin UI unsanitized; only `container` goes through `sanitizeAdvisoryLabel` (out-of-diff).
- [#318 review] `src/aggregation/dates.ts:82` (`isUtcDay`) — shape-only, so `raw_author_daily.date` still accepts calendar-impossible days like `2026-02-31`. #318 added `isComputableUtcDay` beside it, so the write boundary now has a total predicate to adopt; adopting it there is a behavior change this child did not make (out-of-diff).
- [#318 review] `src/connectors/git/sync.ts` (`fetchProviderData`) — a commit reachable from two repos of one container is counted once per repo, before and after this change (out-of-diff).

## 2026-08-11 — #319 (IG1.3) SEC fast-lens

The one Medium (the unknown-floor fallback bounding a legacy provider's backfill ABOVE
its real floor, stranding history) was fixed in the commit itself, along with the Low
that overstated the delete preview's `commits` equality. What is left is out-of-diff.

- [#319 review] `src/dashboard/frontend/src/pages/admin/AdminGitProviders.tsx:1826` — the
  "Sync older history" button title says "Fetch never-synced older history for this
  provider", which is now inaccurate for a provider whose floor is a guess: the slice may
  deliberately re-ask a span already held (out-of-diff; the diff's edit to this file is a
  different comment).

## Backlog (pre-policy deferrals)

- Deferred Medium/Low findings from before this policy live in PR comments
  ("Deferred review findings" on each merged PR) and in
  `reviews/issue-*-multi-pass-*.md`. They stay where they are; do not import
  them here wholesale.
