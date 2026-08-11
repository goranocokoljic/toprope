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

- [#310, from #304 review] `src/connectors/git/sync.ts` advisory tiering — self-healing and out-of-window drops rank as permanent losses, and the forward cursor can roll backward (High). Tiering is cosmetic-operator-surface; ~~the cursor-rollback half~~ **retired by IG1 (#316)** — the cursor is a fetch hint, so a rollback re-asks a window and re-observes shas that are already stored. The advisory-tiering half still stands.
- [#312, from #306 review, SO-3] `src/connectors/git/raw-author-daily.ts` — `invalid_identity` sits on the wrong side of the `ROW_LEVEL_REFUSALS` split, and a truthy non-string author survives the adapter (High). Refusal-accounting taxonomy. **NOT retired — the 2026-08-09 prediction that "the grain disappears under idempotent ingestion" was wrong:** epic criterion D required `ROW_LEVEL_REFUSALS` to survive with unchanged observable behavior, and it did (#318). Still live at the same grain.
- [#313, from #306 review, SEC-3] `pr_records` grain — a 100% row-level refusal still fails open: `records_skipped` moves but nothing escalates (High). **NOT retired:** IG1 gave the commit path a single idempotent write boundary but left `pr_records`' refusal accounting exactly as it was, so folding this in did not happen.

## 2026-08-10 — #309 review (first cycle under the convergence guard)

Out-of-diff observations from the four-lens review of PR #315, deduped. Full
context: `reviews/issue-309-multi-pass-1.md`.

- [#309 review] `src/connectors/git/providers/{bitbucket.ts:436, github.ts:866, gitlab.ts:326}` + `client.ts:238,293` — PR walks and client methods still hand-roll `since ? new Date(since) : null`, fail-open for any direct caller that bypasses `fetchProviderData`'s hoisted validation; the `GitProvider` contract doesn't state bound validity is the caller's obligation. **Half retired by IG1 (#316):** a bad bound can no longer corrupt a counter (it mis-scopes a fetch, and a re-ask is a no-op), so what is left is the undocumented contract, not a data hazard.
- ~~[#309 review] `src/connectors/git/raw-author-daily.ts` — future developer-days imported before #309 remain stored and keep projecting into `git_snapshots`; no doctor detection or cleanup path. Remedy today is the pre-production drop-and-resync.~~ **retired by IG1** — migration 046 + the #320 resync executed exactly that remedy, and #309's `future_date` refusal keeps new ones out.
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
- ~~[#317 review] `src/connectors/git/providers/delete-cascade.ts` — does not retract `raw_commits`; correct for IG1.1 (the table is empty and unread), but the epic's hazard table promises the cascade retracts it. Must land with #318/#319 or the first provider delete after the write path switches leaves the new source of record behind.~~ **retired by IG1** — #319 landed `deleteContainerRawCommits` in the cascade.
- ~~[#317 review] `src/storage/migrations/046_raw_commits.sql` — 046 clears the cursors AND `commit_diffstats`, so the next scheduled run walks full history with a cold diffstat ratchet, the most expensive shape of resync under #231's all-or-nothing rule. 042's header advised using the admin per-provider "Sync now" with an explicit window before the scheduler fires; 046 does not repeat that advice (Low).~~ **retired by IG1** on both halves: #318 deleted the all-or-nothing rule (an incomplete provider now KEEPS its rows and holds only its cursor, so a re-walk resumes rather than restarts), and the one cutover this warned about was performed under #320.
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

## 2026-08-11 — #320 (IG1.4) SEC fast-lens

The High (the `toprope git cache clear` remedy promising a repair the write path refuses for
two of the three fields it named) and every Medium/Low were fixed in the commit itself. What
is left is out-of-diff — both are the SAME defect as that High, in code #318 landed and #320
did not touch.

- [#320 review] `src/connectors/git/sync.ts:771-786` (`permanentSpanRepair`) — the shared
  remedy string says a cursor rewind "re-asks it and lands the missing detail", which is false
  for `code_churn_rate` and `ai_signature_score` in exactly the `DIFFS_NOT_SUPPLIED_PREFIX` /
  `COMMIT_CHURN_UNKNOWN_PREFIX` cases it is printed for: those commits are already in
  `raw_commits`, so the rewind adds no commits and `mergeObservedRates` deliberately carries
  the stored (degraded) rates forward. Its own doc-comment claims the graduated remedy rule's
  COMPLETE arm was checked. `git-cache.ts` was corrected under #320; this is the same sentence
  on the surface `doctor` and `sync.ts` share, and it should say the same thing (High).
- [#320 review] `src/connectors/git/providers/delete-cascade.ts:51-57` — the period-keyed
  rollups the cascade cannot retract depend on ONE caller (`admin/git-providers.ts`) invoking
  `aggregation/retract.ts` afterwards; any other path to the same delete leaves them holding
  the deleted container's totals, and `pr_review_metrics` / `coaching_signals` have no
  covering command at all. Now carried as an active KB lesson
  (`a-retraction-stops-at-the-grain-it-is-keyed-by`) rather than a code change.
- [#320 cutover, not a review finding] `src/cli.ts` `sync git` / `sync all` — the CLI path passes
  no `firstSyncWindowMonths`, so on a provider with no cursor `firstSyncSince` returns `''` and the
  first sync walks ALL history. Deliberate and documented ("degrades to the legacy behavior rather
  than importing a wrong window"), and harmless to accuracy now that a cursor is a fetch hint — but
  it means the ONLY bounded first sync is the admin route, and an operator following 046's notice
  ("config-file providers sync only via `toprope sync git`") gets the unbounded one. Observed live
  during the #320 cutover: still walking past 2025-07 after 2h40m on a 3-repo workspace. A `--months`
  flag on `sync git` reusing `parseFirstSyncWindowMonths` is the obvious shape (Medium, out-of-diff).

## 2026-08-11 — #316 (IG1 epic finalize) full five-lens review

Deduped across SO/SEC/OR/TST/DUP. The three High findings (the incomplete `permanentSpanRepair`
remedy, and the two untested refusal-accounting branches) were FIXED in the review cycle and are
not listed here. Everything below is Medium/Low, deferred deliberately.

**Out-of-diff observations (never blockers, per the guard):**

- [#316 review SO/SEC] `src/storage/migrations/046_raw_commits.sql` — `raw_commits`' PK carries
  the mutable short repo name, so a repo RENAMED between the original import and a re-ask stores
  its commits twice and the cell sums both. Inherited from `commit_diffstats` (#273). Reachability
  rose with #319: `getEarliestSyncedWatermark` returning `now` makes "sync older history" issue a
  maximally overlapping backfill by button press rather than by hand-edited SQL. Keying on a stable
  repo id, or deduping the recompute on `(container, sha)`, is the fix (SO-9/SEC out-of-diff, Low).
- [#316 review SEC] `src/connectors/git/sync.ts:4385-4398` — `recordRowRefusal`/`clearRowRefusal`
  stayed inside the complete-only `cursorAdvances` closure while refusal REPORTING moved to both
  arms, so a permanently-incomplete provider refusing rows every run raises the advisory line but
  never the durable `doctor` alert. Already parked under #318; re-confirmed here.
- [#316 review SEC] `src/connectors/git/sync.ts:4470-4471` — the commit-insert loop re-scans the
  full `commits` array once per login, so it is O(logins x commits) per provider instance; a
  `Map<login, AnalysisCommit[]>` built once matches the no-fan-out rule the neighbouring burst read
  cites.
- [#316 review TST] `tsconfig.json` excludes `tests/`, so TypeScript never checks the suite — the
  enabling condition for stale test call sites like the 2-arg `toAnalysisCommit` calls in
  `tests/connectors/git/cross-provider-analysis.test.ts`.
- [#316 review TST] `src/connectors/git/projection.ts:295-299` — `foldDisjointMetrics`' weighted
  `avg_time_to_merge_hours` branch has no test; it was untested under `mergeDailyDisjoint` too.
- [#316 review OR] `src/connectors/git/sync.ts:3883` — `runSync` is a single ~1,065-line method.
  Pre-existing; this epic added two passes to it rather than being able to split it.

**In-diff Medium/Low, deferred (not reset-recoverable, but non-blocking):**

- [#316 review SO-2/SEC-3] `src/connectors/git/sync.ts:2377` + `dashboard/api/admin/git-providers.ts:1168-1190`
  — deleting the #233 `unknown` verdict makes "sync older history" on a legacy provider fetch an
  uncapped `[now - months, now]` window that bypasses `catchUpUntil`, and because the floor is only
  lowered on `result.complete`, an incomplete run re-issues the identical unbounded window next
  press. Bound the legacy fallback at `min(now, cursor)`, or apply the catch-up cap to the
  backfill's `until` (Medium — the highest-value deferred item).
- [#316 review SEC-2/SO-6] `src/connectors/git/raw-commits.ts:233-240` — the `ON CONFLICT DO UPDATE`
  clause never updates `raw_author_key` or the identity columns, so an author whose login appears on
  re-observation strands their commits under the old key while the recompute writes a zeroed cell
  under the new one. `is_merge` is frozen the same way and is currently hardcoded `0`, so a later
  child that teaches the adapters merge status cannot backfill it by re-sync (Medium).
- [#316 review SO-3] `src/connectors/git/sync.ts:4702` — the partial-cell exclusion from
  `retainedRowCount` is one-sided, so a systematic per-commit defect touching >=5 author-days drives
  the denominator to 0 and escalates a <1% loss to a failed run. Counting a partial cell in neither
  side is the only option that yields a 0 denominator; a fractional or separate accounting would not
  (Medium). Note the guard itself is now tested (this review's TST-1 fix).
- [#316 review SO-4] `src/connectors/git/sync.ts:4111` — `commitInserts` is run-scoped, so peak RSS
  now scales with the SUM of all providers' commits rather than the largest one; the failure mode is
  an OOM before the transaction opens, discarding hours of fetching (Medium).
- [#316 review SO-5] `src/connectors/git/sync.ts:4532` — `cellObservations.set` is last-write-wins
  where `mergeDailyDisjoint` folded, affecting the six non-projected fields. **Corrects the #318
  parking entry**, which claimed the lowercase-email mechanism was unreachable: it is reachable —
  `toAnalysisCommit` sets `authorLogin = username || email`, so a provider omitting `username` sends
  two mixed-case spellings of one address into two `metricsMap` groups that collapse to one cell key
  (Medium).
- [#316 review OR-1] ~75 IG1-attributed comment sites across 14 `src/` files restate one fact, three
  of them in already-applied migration files. The next model change repeats this diff. Collapse to
  one sentence per site with the argument left in the design doc (Medium).
- [#316 review OR-2/OR-3] `src/connectors/git/sync.ts:4217`/`4227`/`4648-4677` — `recordedSkips` and
  `cellsWithRefusedCommits` are one map wearing two hats, the 3-part cell key is rebuilt inline at
  three sites, and `daysByAuthor` is a nested map for a flat key whose `?? [cell.date]` fallback is
  unreachable (Medium/Low).
- [#316 review DUP-1] `src/connectors/git/sync.ts:4450` — `aggregateDailyMetrics` still runs a full
  `detectBurstsByDate` pass whose result is now discarded, so burst detection runs twice per sync and
  `avg_commit_size` is restated in two places (Medium — cost and drift, not wrong numbers).
- [#316 review DUP-2/OR-6] `tests/connectors/git/grain-consumers.test.ts:61` and
  `raw-commits-write-boundary.test.ts:72` — `dumpTables` is a byte-identical clone carrying a
  hand-maintained 3-table column list on which both files' byte-identity claims depend. Extract it,
  ideally deriving the columns from `PRAGMA table_info` (Medium).
- [#316 review TST-3/TST-4] `repo` threading (1/4 of the PK) and the `ai_signature` derivation at
  `sync.ts:4504` both survive mutation to a constant with 1,474 tests green. Add a same-sha-two-repos
  row to V6, and read `raw_commits.ai_signature` back after the golden run (Medium).
- [#316 review TST-5..TST-10, SO-7/SEC-5, SO-8, SEC-4-adjacent, OR-4/OR-5/OR-7] smaller test and
  clarity items: the skip dedup has no N>1-commits-per-day fixture; `commitWeightedMean` lost its
  `total === 0` arm; V4's "only extra fetches" half is a tautology; the migration test pins a
  `DO NOTHING` shape production does not use; the golden re-records itself when absent; the V7
  citation check matches `.skip`ped cases; `readAuthorBurstsByDay`'s "bounded" docstring does not
  hold on a first sync; the deleted-cursor remedy overstates the first-sync bound for the
  config-file path (partially corrected in this cycle); `refusalReports` closures are byte-identical;
  two new functions return values no production caller reads (Low).

## 2026-08-11 — #316 (IG1 epic finalize) review cycle 2 (SEC + TST, right-sized)

Cycle 2's two High findings (the untested COVERED arm of `formatSkippedAuthorDays`, and
`formatSkippedPRRecords` claiming permanence unconditionally) were FIXED, along with SEC2-2 (the
`sync older history` clause that cannot reach the span it was prescribed for). Remaining:

- [#316 review c2 TST2-3] `src/connectors/git/sync.ts:4507` — `author_day` is sliced from the RAW
  commit date while `committed_at` is normalized by `toUtcInstant`, and the comment argues the two
  must NOT be unified. No fixture carries an offset-bearing date whose local day differs from its
  UTC day, so mutating `author_day` to re-derive from the normalized instant passes 1,477 tests
  including the golden. If it ever drifts the failure is silent: commits stored, cell recomputes to
  `commits = 0`, real day gets no row. Add one `…T23:30:00.000+02:00` GitLab-shaped commit
  (Medium — the highest-value remaining test gap).
- [#316 review c2 SEC2-3] `src/connectors/git/raw-commits.ts:25-26` — `commit_burst_count` is
  documented as PROJECTED but is a PARTIAL projection: a burst whose first-commit day falls outside
  the run's touched set is attributed to a day the run does not rewrite, so that day's stored count
  stays stale. Criterion A is unaffected (the day set is a function of the fetch) and the value
  matches the pre-IG1 result, so this is a doc-accuracy item, not a regression (Low).
- [#316 review c2 TST2-4] `src/connectors/git/sync.ts:611` (`formatSystemicRowRefusal`) and
  `src/connectors/git/providers/window-bounds.ts:109` — two operator remedies IG1 REVERSED
  ("do NOT purge the cursors" → "purge, safe now"; "do NOT move the cursor backward" → "lowering is
  safe") have no test asserting either the new or the old sentence. `permanentSpanRepair` is now
  pinned; these two are the asymmetry (Low).
- [#316 review c2 TST2-5] `tests/connectors/git/sync.test.ts:5776-5794` — the `DIFFS_NOT_SUPPLIED`
  permanence line is asserted with only the pre-fix subset, while its sibling
  `COMMIT_CHURN_UNKNOWN` line carries the full caveat assertions. Pinned today only by
  `permanentSpanRepair()` being a single copy; three `toContain` lines close it (Low).

## Backlog (pre-policy deferrals)

- Deferred Medium/Low findings from before this policy live in PR comments
  ("Deferred review findings" on each merged PR) and in
  `reviews/issue-*-multi-pass-*.md`. They stay where they are; do not import
  them here wholesale.
