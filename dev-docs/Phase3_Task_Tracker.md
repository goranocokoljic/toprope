# GovProxy — Phase 3 Task Tracker

**Phase 3: Aggregation Engine + AI-Generated Summaries**

13 Tasks | Estimated 2–3 weeks | Tier-aware (all developers git-only at launch)

> Each task below is a COMPLETE GitHub issue — schema, formulas, prompts, API specs, and acceptance criteria all inline. A developer should be able to implement any task from its issue alone without referring to other documents.

---

## Workflow Per Task (same as Phases 1 & 2)

```
1. Create GitHub Issue (copy the full description below)
2. Create branch: task/3.X-short-name
3. Implement in Claude Code (reference acceptance criteria)
4. Write tests alongside implementation
5. Run full test suite: npm test
6. Push + open PR (reference issue: "Closes #N")
7. AI-assisted code review (paste diff into Claude)
8. Address feedback + re-test
9. Merge to main
10. Tag: v0.3.X
11. Verify against acceptance criteria
```

## Recommended Build Order

```
Aggregation core:  3.1 → 3.2 → 3.3 → 3.4 → 3.5 → 3.6
Summaries:         3.7 → 3.8 → 3.9 → 3.10
Surface:           3.11 → 3.12
Close-out:         3.13
```

## Phase 3 Context (applies to every task)

Every developer is git-only (MEDIUM tier) at launch — the new AI usage strategy is still rolling out, so tool API connectors (Copilot/Claude Code/Windsurf) are not yet connected. Therefore:

- Aggregates and summaries describe git-derived signals + expense data only
- Tool-usage columns exist in the schema but are NULL until connectors come online
- The AI maturity score is computed but labeled a "git-based estimate"
- Summaries must never invent direct-usage language ("acceptance rate," "interactions") that isn't in the data
- The whole system is designed to strengthen automatically when tool data arrives, without schema migration or score-meaning changes

---

# TASK 3.1: Aggregation Engine Core (Weekly + Monthly)

**Branch:** `task/3.1-aggregation-core`
**Depends on:** Phase 1 (daily snapshots), Phase 2 complete
**Estimate:** 3 days

### GitHub Issue Description

```
## Task 3.1: Aggregation Engine Core (Weekly + Monthly)

### Context
Phase 2 computes dashboard views on the fly from daily snapshots — fine at
launch scale, but it doesn't scale to long ranges and provides no stored prior
period for deltas or summaries. This task builds the weekly and monthly rollup
jobs that pre-compute per-developer aggregates from immutable daily snapshots.
(Quarterly/yearly come in 3.2; deltas in 3.3; maturity score in 3.4.)

All developers are git-only at launch, so tool-usage fields are computed as
NULL where no tool data exists, but the columns are populated so the schema is
ready when connectors come online.

### Schema (weekly_aggregates and monthly_aggregates already exist in V1 schema)
Confirm these columns exist; add any missing. weekly_aggregates:

  id TEXT PRIMARY KEY
  developer_id TEXT NOT NULL REFERENCES developers(id)
  week_start TEXT NOT NULL              -- YYYY-MM-DD (Monday)
  team TEXT NOT NULL
  active_days INTEGER DEFAULT 0
  total_interactions INTEGER DEFAULT 0  -- tool-derived; NULL/0 at launch
  total_acceptances INTEGER DEFAULT 0   -- tool-derived; NULL/0 at launch
  avg_acceptance_rate REAL              -- tool-derived; NULL at launch
  tools_used TEXT                       -- JSON array
  estimated_total_cost REAL
  total_commits INTEGER DEFAULT 0
  total_lines_added INTEGER DEFAULT 0
  total_prs_merged INTEGER DEFAULT 0
  avg_code_churn REAL
  avg_ai_signature_score REAL
  subscription_cost REAL
  cost_per_pr REAL
  is_active INTEGER DEFAULT 0
  data_quality TEXT                     -- high|medium|low for this dev/period
  computed_at TEXT NOT NULL
  UNIQUE(developer_id, week_start)

monthly_aggregates: same shape with `month TEXT` (YYYY-MM) instead of week_start,
plus active_weeks INTEGER, and the delta columns added in Task 3.3.

### Deliverables
- [ ] src/aggregation/weekly.ts — computes one developer's weekly aggregate from
      daily snapshots (tool_snapshots + git_snapshots) for a given week
- [ ] src/aggregation/monthly.ts — same for a calendar month
- [ ] Aggregation reads from daily snapshots directly (not from lower aggregates)
      to avoid compounding rounding
- [ ] Week boundary: ISO week, Monday start
- [ ] active_days = distinct days with any commit OR any tool signal
- [ ] is_active = active_days > 0
- [ ] Git metrics summed from git_snapshots
- [ ] avg_code_churn, avg_ai_signature_score = means over active days
- [ ] tools_used = distinct tools with activity in the period (JSON array)
- [ ] subscription_cost = cost of active subscriptions during the period
      (prorated correctly if a subscription started/ended mid-period — see 3.x
       lifecycle from Phase 2)
- [ ] cost_per_pr = subscription_cost / total_prs_merged (null if 0 PRs)
- [ ] data_quality = highest tier available for that developer that period
      (high if tool data present, else medium if git present, else low)
- [ ] Idempotent: recomputing a period overwrites that period's row (UPSERT on
      the UNIQUE constraint)
- [ ] All displayed numbers rounded appropriately (no float artifacts)

### Acceptance Criteria
- [ ] Weekly aggregate correctly sums git metrics for a known fixture week
- [ ] Monthly aggregate correctly aggregates a known fixture month
- [ ] active_days counts distinct active days, not total events
- [ ] data_quality = "medium" for git-only developers (the launch case)
- [ ] tool-usage fields are null/zero when no tool data exists, WITHOUT error
- [ ] subscription_cost is correct including mid-period subscription changes
- [ ] cost_per_pr is null (not divide-by-zero) when no PRs merged
- [ ] Recomputing the same period is idempotent (UPSERT, no duplicate rows)
- [ ] Unit tests: full-data week, git-only week, zero-activity week, mid-period
      subscription change, rounding correctness
```

---

# TASK 3.2: Quarterly + Yearly Rollups

**Branch:** `task/3.2-quarterly-yearly`
**Depends on:** 3.1
**Estimate:** 2 days

### GitHub Issue Description

```
## Task 3.2: Quarterly + Yearly Rollups

### Context
Quarterly and yearly aggregates are team-level (not per-developer) and feed the
executive-facing summaries and the maturity trend. quarterly_aggregates exists
in the V1 schema; yearly_aggregates is new.

### Schema
quarterly_aggregates (confirm/extend existing V1 table):

  id TEXT PRIMARY KEY
  team TEXT NOT NULL
  quarter TEXT NOT NULL                 -- YYYY-Q1 ... YYYY-Q4
  developer_count INTEGER
  active_developer_count INTEGER
  utilization_rate REAL                 -- active / total
  total_subscription_cost REAL
  total_estimated_api_cost REAL         -- 0 at launch (no API-billed usage)
  unused_seat_count INTEGER
  wasted_spend REAL
  avg_acceptance_rate REAL              -- null at launch (no tool data)
  avg_code_churn REAL
  total_prs_merged INTEGER
  cost_per_pr REAL
  ai_maturity_score REAL                -- from Task 3.4
  ai_maturity_basis TEXT                -- 'git_estimate'|'mixed'|'measured'
  utilization_rate_delta REAL           -- from Task 3.3
  maturity_score_delta REAL
  computed_at TEXT NOT NULL
  UNIQUE(team, quarter)

yearly_aggregates (NEW — create via migration):

  id TEXT PRIMARY KEY
  team TEXT NOT NULL
  year TEXT NOT NULL                    -- YYYY
  developer_count INTEGER
  active_developer_count INTEGER
  utilization_rate REAL
  total_subscription_cost REAL
  total_commits INTEGER
  total_prs_merged INTEGER
  avg_code_churn REAL
  avg_ai_signature_score REAL
  cost_per_pr REAL
  ai_maturity_score REAL
  ai_maturity_basis TEXT
  utilization_rate_delta REAL
  maturity_score_delta REAL
  computed_at TEXT NOT NULL
  UNIQUE(team, year)

### Deliverables
- [ ] Migration creating yearly_aggregates
- [ ] src/aggregation/quarterly.ts — team-level quarterly rollup from daily data
- [ ] src/aggregation/yearly.ts — team-level yearly rollup from daily data
- [ ] Quarter boundaries: Q1 Jan–Mar, Q2 Apr–Jun, Q3 Jul–Sep, Q4 Oct–Dec
- [ ] utilization_rate = active_developer_count / developer_count
- [ ] unused_seat_count and wasted_spend reuse the Phase 1 waste-detection logic
      for the period
- [ ] ai_maturity_basis set to 'git_estimate' at launch (all git-only)
- [ ] Idempotent UPSERT on the UNIQUE constraints

### Acceptance Criteria
- [ ] yearly_aggregates table created by migration
- [ ] Quarterly aggregate correct for a known fixture quarter
- [ ] Yearly aggregate correct for a known fixture year
- [ ] utilization_rate computed correctly, including teams with inactive members
- [ ] ai_maturity_basis = 'git_estimate' at launch
- [ ] avg_acceptance_rate is null at launch without error
- [ ] Idempotent recomputation
- [ ] Unit tests: full quarter, partial quarter (team formed mid-quarter),
      year spanning team changes
```

---

# TASK 3.3: Delta Computation

**Branch:** `task/3.3-deltas`
**Depends on:** 3.1, 3.2
**Estimate:** 2 days

### GitHub Issue Description

```
## Task 3.3: Delta Computation

### Context
Deltas power "up 8% vs last month" language in both the dashboard and the
summaries. Each aggregate stores its change from the previous comparable period.
First-period aggregates have null deltas (no prior period to compare) — the UI
and summaries must say "first period — no comparison yet" rather than showing 0%.

### Formulas
  commit_velocity_delta_pct = (this.total_commits - prev.total_commits)
                              / max(prev.total_commits, 1) * 100
  prs_merged_delta_pct      = (this.total_prs_merged - prev.total_prs_merged)
                              / max(prev.total_prs_merged, 1) * 100
  churn_rate_delta          = this.avg_code_churn - prev.avg_code_churn
                              (percentage points, not %)
  ai_signature_delta        = this.avg_ai_signature_score - prev.avg_ai_signature_score
  cost_per_pr_delta_pct     = (this.cost_per_pr - prev.cost_per_pr)
                              / max(prev.cost_per_pr, 0.01) * 100
  utilization_rate_delta    = this.utilization_rate - prev.utilization_rate
  maturity_score_delta      = this.ai_maturity_score - prev.ai_maturity_score

### Schema additions
Add delta columns to monthly_aggregates (and confirm on quarterly/yearly):
  ALTER TABLE monthly_aggregates ADD COLUMN commit_velocity_delta_pct REAL;
  ALTER TABLE monthly_aggregates ADD COLUMN prs_merged_delta_pct REAL;
  ALTER TABLE monthly_aggregates ADD COLUMN churn_rate_delta REAL;
  ALTER TABLE monthly_aggregates ADD COLUMN ai_signature_delta REAL;
  ALTER TABLE monthly_aggregates ADD COLUMN cost_per_pr_delta_pct REAL;
(weekly_aggregates may also carry deltas if useful for the weekly summary)

### Deliverables
- [ ] src/aggregation/deltas.ts — computes deltas given current + previous period
- [ ] Delta computation invoked as the final step of each rollup job
- [ ] "Previous period" lookup: prior week / prior month / prior quarter / prior year
- [ ] Null deltas when no prior period exists (NOT 0)
- [ ] Guard against divide-by-zero using the max(prev, floor) pattern shown above
- [ ] Deltas recomputed correctly when a period is re-run (e.g., late data)

### Acceptance Criteria
- [ ] Each delta formula produces correct values against fixtures
- [ ] First period (no prior) yields null deltas, not 0
- [ ] Divide-by-zero is impossible (verified with prev=0 fixtures)
- [ ] churn_rate_delta and utilization_rate_delta are in percentage POINTS;
      *_delta_pct fields are percentage CHANGE — documented and tested distinctly
- [ ] Re-running a period with changed data updates deltas correctly
- [ ] Unit tests: normal delta, first-period null, prev=0 guard, late-data recompute
```

---

# TASK 3.4: AI Maturity Score (Tier-Aware)

**Branch:** `task/3.4-maturity-score`
**Depends on:** 3.1, 3.2
**Estimate:** 2–3 days

### GitHub Issue Description

```
## Task 3.4: AI Maturity Score (Tier-Aware)

### Context
A composite 0–100 score per team per period giving leadership one number for
"how mature is our AI adoption." At launch it's computed from git signals and
labeled a "git-based estimate." It's designed so components switch from inferred
to measured as tool connectors arrive, WITHOUT the 0–100 scale or meaning
changing — so trend history built now stays valid later.

### Formula — git-only composition (launch)
All component inputs normalized to 0–1 before weighting.

  adoption_breadth     = active_developer_count / developer_count
  adoption_consistency = mean(active_days / possible_days) across team members
  output_health        = clamp(0.5 + prs_merged_delta_pct/200, 0, 1)
                         // positive PR trend pushes above 0.5, negative below
  churn_quality        = clamp(1 - avg_code_churn, 0, 1)
                         // low churn = high quality (churn is 0–1 rate)
  cost_efficiency      = clamp(team_cost_per_pr <= org_avg_cost_per_pr
                               ? 1 - (team_cost_per_pr / (2*org_avg_cost_per_pr))
                               : org_avg_cost_per_pr / (2*team_cost_per_pr), 0, 1)
                         // ~0.5 at org average, higher when cheaper per PR

  maturity = 100 * (
      0.30 * adoption_breadth
    + 0.25 * adoption_consistency
    + 0.20 * output_health
    + 0.15 * churn_quality
    + 0.10 * cost_efficiency
  )
  ai_maturity_score = round(maturity)
  ai_maturity_basis = 'git_estimate'

### Formula — full composition (once tool data exists, FUTURE)
Document but do not implement now. When tool connectors arrive:
  - adoption_breadth/consistency measured from tool usage, not inferred from git
  - add acceptance_quality component (acceptance rate)
  - weights rebalance; scale and interpretation unchanged
  - ai_maturity_basis becomes 'mixed' then 'measured'
Leave a clear extension point in code + a comment block with the future formula.

### Benchmark
org_avg_cost_per_pr = cost_per_pr averaged across all teams for the same period.
(Internal org-average benchmark — cross-company benchmarks are a later phase.)

### Deliverables
- [ ] src/aggregation/maturity.ts implementing the git-only formula above
- [ ] Writes ai_maturity_score + ai_maturity_basis to quarterly/yearly aggregates
      (and weekly/monthly if we surface team maturity at those levels)
- [ ] org_avg_cost_per_pr computed per period across teams
- [ ] All component values clamped to [0,1]; final score 0–100, rounded
- [ ] Code structured with a clear extension point for the future full formula,
      including the documented future formula as a comment
- [ ] Every persisted score carries ai_maturity_basis = 'git_estimate' at launch

### Acceptance Criteria
- [ ] Score is 0–100 for all fixture inputs (never out of range)
- [ ] A team with full adoption + low churn + good cost efficiency scores high
- [ ] A team with low adoption scores low even if churn is good (breadth weight)
- [ ] output_health correctly reflects PR trend direction
- [ ] cost_efficiency ~0.5 when team is at org average
- [ ] ai_maturity_basis = 'git_estimate' on every score at launch
- [ ] Extension point + future formula documented in code
- [ ] Unit tests: high-maturity team, low-adoption team, at-benchmark team,
      clamping at extremes, basis labeling
```

---

# TASK 3.5: Backfill Command

**Branch:** `task/3.5-backfill`
**Depends on:** 3.1, 3.2, 3.3, 3.4
**Estimate:** 1–2 days

### GitHub Issue Description

```
## Task 3.5: Backfill Command

### Context
On first deployment (or onboarding a company with existing git history), this
computes all historical aggregates from existing daily snapshots, producing
trend depth immediately instead of waiting weeks for it to accumulate forward.
Critical for the WMG dogfood: once Phase 1 has pulled git history, backfill
gives instant trends.

### Default behavior
Default depth: 12 months back from today, configurable via --from.

### Deliverables
- [ ] src/aggregation/backfill.ts
- [ ] CLI: govproxy aggregate backfill [--from <date>] [--to <date>]
      - default --from = today minus 12 months
      - default --to = today
- [ ] Iterates every period boundary in range and computes weekly, monthly,
      quarterly, yearly aggregates + deltas + maturity for each
- [ ] Processes in chronological order so deltas have their prior period available
- [ ] Idempotent: re-running backfill overwrites, never duplicates
- [ ] Progress output (periods processed / total)
- [ ] Safe to run while daily snapshots continue arriving

### Acceptance Criteria
- [ ] Backfill with no args covers the trailing 12 months
- [ ] Custom --from / --to range respected
- [ ] Aggregates produced at all four levels for the full range
- [ ] Deltas correct because periods processed chronologically
- [ ] Maturity scores present and labeled git_estimate across backfilled periods
- [ ] Re-running backfill is idempotent
- [ ] Progress output is clear
- [ ] Integration test: seed N months of daily fixtures → backfill → verify
      aggregate counts and a spot-checked period's values
```

---

# TASK 3.6: Aggregation Scheduling

**Branch:** `task/3.6-aggregation-scheduler`
**Depends on:** 3.1, 3.2, 3.3, 3.4
**Estimate:** 1–2 days

### GitHub Issue Description

```
## Task 3.6: Aggregation Scheduling

### Context
Automates rollup computation at period boundaries via node-cron, so aggregates
stay current without manual intervention.

### Schedule (UTC)
  Weekly:    Monday 04:00 — prior week
  Monthly:   1st 04:30 — prior month
  Quarterly: quarter start 05:00 — prior quarter
  Yearly:    Jan 1 05:00 — prior year

### Deliverables
- [ ] src/aggregation/scheduler.ts using node-cron
- [ ] Each job computes the just-completed period for all developers/teams
- [ ] Jobs run after daily sync has completed (schedule ordering vs Phase 1 sync)
- [ ] Manual triggers:
      govproxy aggregate --period weekly --date <date>
      govproxy aggregate --period monthly --date <date>
      govproxy aggregate --period quarterly --date <date>
      govproxy aggregate --period yearly --date <date>
- [ ] Job logging: start, end, periods/rows computed, errors
- [ ] A failed job logs and alerts but does not block other scheduled jobs
- [ ] Idempotent (safe to re-run any job for any period)

### Acceptance Criteria
- [ ] Scheduled jobs fire at configured boundaries
- [ ] Each job computes the correct just-completed period
- [ ] Manual trigger produces identical results to the scheduled run
- [ ] A failing job is isolated (others still run) and logged
- [ ] Re-running any period is idempotent
- [ ] Unit tests: schedule wiring, manual trigger, error isolation, idempotency
```

---

# TASK 3.7: Summary Model Client + Input Builder

**Branch:** `task/3.7-summary-model-client`
**Depends on:** 3.1–3.4
**Estimate:** 2 days

### GitHub Issue Description

```
## Task 3.7: Summary Model Client + Input Builder

### Context
Summaries are generated by a configurable model defaulting to LOCAL (Ollama),
for privacy — no code, no commit contents, no prompt content ever leaves the
network. The model receives ONLY aggregate numerical data. Default is a LARGER
local model for better narrative quality (decision: quality matters most for
executive-facing output); confirm the specific model runs acceptably on dogfood
infra during this task.

### Deliverables
- [ ] src/summaries/model-client.ts — configurable endpoint
      - type: ollama | anthropic | openai (default ollama)
      - per-level model override (weekly can stay small/local; monthly+ can use
        a larger or cloud model if configured)
      - mirrors the Phase 1 model-client config pattern
- [ ] src/summaries/input-builder.ts — assembles an aggregate row (+ prior period
      for deltas + org benchmark context) into a compact, numbers-only input
      payload. NEVER includes code, commit messages, or any free text from repos.
- [ ] Input payload explicitly includes a "data_basis" field stating the tier
      (e.g., "git analysis + expense data; no direct tool usage") so the prompt
      (Task 3.8) can carry it into the narrative
- [ ] Config (govproxy.config.yaml) for summaries:
      summaries:
        model:
          type: ollama
          endpoint: http://localhost:11434
          model_name: <larger-local-model>     # confirm on dogfood infra
        weekly:   { model_name: <can override> }
        monthly:  { model_name: <can override> }
        quarterly:{ model_name: <can override> }
        yearly:   { model_name: <can override> }
- [ ] Graceful failure: if the model endpoint is unreachable, log + skip (don't
      crash the scheduler); summary marked not-generated, retryable

### Acceptance Criteria
- [ ] Model client talks to a local Ollama endpoint by default
- [ ] Per-level model override works (e.g., monthly uses a different model)
- [ ] Input builder produces numbers-only payloads — verified: no code, no commit
      messages, no repo free-text present in any payload
- [ ] data_basis field correctly states the tier for the period
- [ ] Unreachable model endpoint is handled gracefully (logged, retryable, no crash)
- [ ] The chosen default local model is documented with infra requirements
- [ ] Unit tests: payload construction, privacy check (no forbidden content),
      config override resolution, endpoint-failure handling
```

---

# TASK 3.8: Tier-Aware Prompt Templates

**Branch:** `task/3.8-prompt-templates`
**Depends on:** 3.7
**Estimate:** 2 days

### GitHub Issue Description

```
## Task 3.8: Tier-Aware Prompt Templates

### Context
THE critical Phase 3 discipline. The prompts must make the model describe
git-derived signals honestly and NEVER invent direct-usage language
("acceptance rate," "interactions," "suggestions accepted") that the git-only
data doesn't contain. This is the task most likely to be subtly wrong, so it
gets dedicated adversarial testing.

### Prompt requirements (all four levels)
The system/template must instruct the model to:
- Describe only metrics present in the input payload
- Refer to git-derived signals as such ("commit activity," "merged PRs,"
  "estimated AI-assistance signal," "code churn")
- NEVER use the words/concepts "acceptance rate," "interactions,"
  "suggestions accepted," or any direct-tool-usage metric unless those fields
  are present and non-null in the payload
- Carry the data_basis into the narrative (e.g., "based on git activity, since
  direct tool usage isn't yet connected")
- Frame everything as review/insight, never as judgment of individuals
- Use aggregate framing; may note a specific developer for a neutral, factual
  reason (e.g., "inactive 5 days — worth a check-in") but never evaluatively
- Respect the configured default voice: concise, analytical, review-oriented
- State deltas only when present; for first periods say "first period — no prior
  comparison" rather than inventing a baseline

### Per-level templates
- [ ] Weekly: ~2 short paragraphs, team manager audience, operational focus
      (who was active, notable changes, one or two action prompts)
- [ ] Monthly: ~1 page, department head audience, trends + cost efficiency +
      seat optimization candidates
- [ ] Quarterly: ~2–3 pages, VP/leadership, investment-vs-return framing,
      maturity score movement + basis, strategic recommendations
- [ ] Yearly: full narrative, board/annual-review audience, the year's adoption
      journey, ROI framing, forward recommendations
- [ ] Each template injects the data_basis and explicitly forbids fabricated
      usage language

### Deliverables
- [ ] src/summaries/prompts.ts with the four templates
- [ ] A shared preamble enforcing the tier-aware + privacy + framing rules
- [ ] Templates parameterized by the input payload from Task 3.7

### Acceptance Criteria
- [ ] Each level produces output of roughly the intended length/depth
- [ ] ADVERSARIAL TEST (required): feed a git-only payload (tool fields null) and
      verify the generated text contains NONE of: "acceptance rate,"
      "interactions," "suggestions accepted," or other direct-usage terms
- [ ] Generated text states the data_basis (git-based) at least once
- [ ] First-period payloads produce "no prior comparison" language, not invented deltas
- [ ] No individual is described evaluatively/negatively; neutral factual mentions only
- [ ] Output uses the concise analytical default voice
- [ ] Tests run against a deterministic/mocked model so assertions are stable,
      PLUS a documented manual spot-check against the real local model
```

---

# TASK 3.9: Summary Generation + Storage + Staleness

**Branch:** `task/3.9-summary-generation`
**Depends on:** 3.7, 3.8
**Estimate:** 2 days

### GitHub Issue Description

```
## Task 3.9: Summary Generation + Storage + Staleness

### Context
Orchestrates generating a summary (build input → render prompt → call model →
store result), handles regeneration, and detects when a summary became stale
because its underlying aggregate changed (e.g., late-arriving data).

### Schema (summaries table exists in V1; add staleness columns)
  ALTER TABLE summaries ADD COLUMN input_hash TEXT;   -- hash of input payload
  ALTER TABLE summaries ADD COLUMN is_stale INTEGER DEFAULT 0;
summaries columns (existing): id, scope, scope_name, period_type, period_value,
  summary_text, model_used, generated_at, regenerated_count

### Deliverables
- [ ] src/summaries/generator.ts — orchestrates the full pipeline
- [ ] src/summaries/staleness.ts — compares stored input_hash to a freshly built
      input's hash; marks is_stale = 1 on mismatch
- [ ] Generate flow: build input (3.7) → render prompt (3.8) → call model (3.7)
      → store text + model_used + input_hash + generated_at
- [ ] Regeneration: POST regenerate increments regenerated_count, optional focus
      parameter passed into the prompt (e.g., "focus on cost")
- [ ] Staleness check runs after each aggregate recompute: if an aggregate for a
      period changed and a summary exists for it, mark the summary stale
- [ ] CLI: govproxy summary generate --level <l> --period <p> --scope <s>
- [ ] CLI: govproxy summary show --level <l> --period <p> --scope <s>

### Acceptance Criteria
- [ ] Generating a summary stores text, model_used, input_hash, generated_at
- [ ] Regeneration increments the counter and respects an optional focus param
- [ ] Changing an aggregate after generation marks the summary is_stale = 1
- [ ] A fresh generation clears staleness (new matching input_hash)
- [ ] CLI generate and show work for all four levels and all scopes
- [ ] Generation failure (model down) leaves no partial row and is retryable
- [ ] Unit tests: generate, regenerate with focus, staleness detection,
      failure-no-partial-write
```

---

# TASK 3.10: Summary Auto-Generation Scheduling

**Branch:** `task/3.10-summary-scheduler`
**Depends on:** 3.6, 3.9
**Estimate:** 1 day

### GitHub Issue Description

```
## Task 3.10: Summary Auto-Generation Scheduling

### Context
Weekly and monthly summaries auto-generate on schedule so they're waiting in the
dashboard when the manager arrives. Quarterly and yearly are on-demand — a
manager generates them when needed and typically reviews/tweaks before sharing
upward.

### Schedule (UTC, after aggregation jobs complete)
  Weekly summaries:  Monday ~04:15 (after weekly aggregation at 04:00)
  Monthly summaries: 1st ~04:45 (after monthly aggregation at 04:30)
  Quarterly:         NOT scheduled — on-demand via CLI/API only
  Yearly:            NOT scheduled — on-demand via CLI/API only

### Deliverables
- [ ] Extend the scheduler to auto-generate weekly + monthly summaries for all
      scopes (team + org/department) after the corresponding aggregation job
- [ ] Quarterly/yearly explicitly excluded from auto-generation
- [ ] Auto-generation respects model config (default local)
- [ ] If aggregation for a period didn't complete, skip summary generation and
      log (don't generate from missing data)
- [ ] Auto-generation failures are isolated and logged (one team's failure
      doesn't block others)

### Acceptance Criteria
- [ ] Weekly summaries auto-generate after weekly aggregation
- [ ] Monthly summaries auto-generate after monthly aggregation
- [ ] Quarterly and yearly are NOT auto-generated (on-demand only) — verified
- [ ] Missing aggregate → summary skipped + logged, no crash
- [ ] One scope's generation failure doesn't block others
- [ ] Unit tests: weekly/monthly auto path, quarterly/yearly exclusion,
      missing-aggregate skip, failure isolation
```

---

# TASK 3.11: New API Endpoints

**Branch:** `task/3.11-phase3-api`
**Depends on:** 3.1–3.4, 3.9
**Estimate:** 2 days

### GitHub Issue Description

```
## Task 3.11: New API Endpoints

### Context
Exposes aggregates, the maturity trend, and summaries to the dashboard.
All admin-gated except where a developer views their own aggregate data.

### Endpoints
- [ ] GET /api/aggregates/:scope/:level?period=<p>
      scope = team:<name> | org ; level = weekly|monthly|quarterly|yearly
      returns the pre-computed aggregate row(s)
- [ ] GET /api/maturity/:team/trend?range=<range>
      maturity score over time (uses the shared range parser: 30d|90d|year|
      lifetime|custom) — returns score + basis per period for charting
- [ ] GET /api/summaries?level=<l>&scope=<s>
      list summaries (most recent first), including is_stale flag
- [ ] GET /api/summaries/:id
      one summary's full text + metadata (model_used, generated_at, is_stale,
      regenerated_count)
- [ ] POST /api/summaries/:id/regenerate
      optional body { focus: "<text>" }; triggers regeneration (Task 3.9)
- [ ] POST /api/summaries/generate
      body { level, period, scope } — on-demand generation (for quarterly/yearly)
- [ ] All maturity/summary responses include the basis/tier so the UI can label
      "git-based estimate"
- [ ] Admin-gated; developers may read their own aggregate via existing /api/me/*
      pattern if surfaced (optional this task)

### Acceptance Criteria
- [ ] Each endpoint returns correctly shaped data from fixtures
- [ ] Maturity trend endpoint respects all range types incl. lifetime + custom
- [ ] Summaries list includes is_stale and orders most-recent-first
- [ ] Regenerate endpoint passes the focus param through and updates the record
- [ ] On-demand generate works for quarterly/yearly
- [ ] basis/tier present on maturity + summary responses
- [ ] Admin-role gating enforced (403 for developer role on admin endpoints)
- [ ] Response times < 200ms for aggregate reads (they're pre-computed)
- [ ] Unit tests per endpoint incl. range variations and gating
```

---

# TASK 3.12: Dashboard Integration

**Branch:** `task/3.12-dashboard-integration`
**Depends on:** 3.11, Phase 2 dashboard
**Estimate:** 2–3 days

### GitHub Issue Description

```
## Task 3.12: Dashboard Integration

### Context
Surfaces Phase 3 outputs in the existing Phase 2 dashboard: the maturity trend
chart, and the summaries view with regeneration. Everything carries the
git-based-estimate labeling and MEDIUM-tier confidence markers at launch.

### Deliverables
- [ ] Maturity trend chart (org + per-team) using the shared chart components and
      the time-range selector; line carries a "git-based estimate" label and the
      MEDIUM confidence marker; hover shows the basis
- [ ] Summaries panel:
      - Latest weekly + monthly summary surfaced prominently (auto-generated)
      - Summary history list (from /api/summaries) with is_stale badge
      - View full summary text
      - Regenerate button (with optional focus input) → POST regenerate
      - On-demand Generate for quarterly/yearly (button → POST generate)
- [ ] Stale summaries show a clear "underlying data changed — regenerate" badge
- [ ] Manager Organization Overview gains the maturity trend; Team Detail gains
      the team maturity trend + that team's latest summary
- [ ] All new UI respects light/dark mode and the established aesthetic

### Acceptance Criteria
- [ ] Maturity trend renders for org and teams, labeled git-based estimate
- [ ] Time-range selector works on the maturity chart
- [ ] Latest weekly + monthly summaries appear without manual action
      (auto-generated)
- [ ] Quarterly/yearly can be generated on demand from the UI
- [ ] Regenerate (with focus) works and updates the displayed summary
- [ ] Stale summaries are visibly flagged with a regenerate affordance
- [ ] All views match aesthetic + dark mode
- [ ] Loads < 2 seconds with real data
```

---

# TASK 3.13: Phase 3 Integration Testing + Dogfood Verification

**Branch:** `task/3.13-integration-dogfood`
**Depends on:** all prior Phase 3 tasks
**Estimate:** 2 days

### GitHub Issue Description

```
## Task 3.13: Phase 3 Integration Testing + Dogfood Verification

### Context
End-to-end verification of the aggregation + summaries pipeline against real
WMG git-only data before relying on it. Confirms the tier-aware discipline holds
end to end.

### Deliverables
- [ ] E2E: seed daily snapshots → run all aggregation jobs → verify aggregates
      at all four levels with correct deltas + maturity
- [ ] E2E: backfill 12 months → verify trend depth appears in dashboard
- [ ] E2E: auto-generate weekly + monthly → verify they appear in dashboard
- [ ] E2E: on-demand generate quarterly + yearly → verify
- [ ] TIER-AWARENESS VERIFICATION (critical): inspect generated summaries against
      real git-only WMG data and confirm NO fabricated direct-usage language
- [ ] Staleness: change an aggregate → verify dependent summary flagged stale
- [ ] Performance: dashboard long-range views fast on pre-computed aggregates
- [ ] Maturity score sanity-check against teams whose habits you know (does the
      number feel right? document calibration notes)
- [ ] Update setup/onboarding doc with Phase 3 (aggregation + summaries config)

### Acceptance Criteria
- [ ] Full aggregation pipeline verified at all four levels with real data
- [ ] Backfill produces correct historical trend depth
- [ ] Weekly/monthly auto-generate; quarterly/yearly generate on demand
- [ ] Generated summaries contain NO fabricated usage language (manual review)
- [ ] Maturity scores labeled git-based estimate everywhere they appear
- [ ] Staleness flagging works end to end
- [ ] Long-range dashboard views are fast (pre-computed)
- [ ] Maturity calibration notes recorded for future tuning
- [ ] Onboarding doc updated
```

---

## Phase 3 Completion Checklist

```
[ ] Aggregates pre-computed at weekly/monthly/quarterly/yearly
[ ] Deltas correct; first periods show "no comparison," never fake 0%
[ ] AI maturity score computed, 0–100, labeled "git-based estimate" everywhere
[ ] Backfill produced 12 months of trend history from WMG git data
[ ] Weekly + monthly summaries auto-generate and wait in the dashboard
[ ] Quarterly + yearly generate on demand
[ ] Summaries run on the larger local model by default — nothing leaves the network
[ ] Summaries contain NO fabricated direct-usage language (verified against real data)
[ ] Stale summaries flagged when underlying data changes
[ ] Maturity trend + summaries visible in the dashboard with confidence labeling
[ ] Long-range dashboard views fast on pre-computed aggregates
[ ] npm test — all tests pass, including the adversarial no-fabricated-usage test
```

**Phase 3 is complete when a manager opens the dashboard Monday morning to an
accurate, honestly-labeled weekly summary of their team's git-based AI activity —
generated locally, describing only what the data actually supports.**

Next: connect tool API connectors as the AI usage strategy rolls out — at which
point aggregates, maturity, and summaries automatically strengthen from
git-estimate to measured, with no schema changes.

---

*End of Document — GovProxy Phase 3 Task Tracker*
