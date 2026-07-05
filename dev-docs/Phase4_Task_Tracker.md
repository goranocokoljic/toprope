# Toprope — Phase 4 Task Tracker

**Phase 4: Complete the Data Picture + Close Analytics Gaps**

13 Tasks | Estimated 3–4 weeks | Tier-aware (git-only at launch, strengthens as connectors connect)

> Each task below is a COMPLETE GitHub issue — schema, formulas, API specs, and
> acceptance criteria all inline. A developer should be able to implement any task
> from its issue alone without referring to other documents.

---

## Workflow Per Task (same as prior phases)

```
1. Create GitHub Issue (copy the full description below)
2. Create branch: task/4.X-short-name
3. Implement in Claude Code (reference acceptance criteria)
4. Write tests alongside implementation
5. Run full test suite: npm test
6. Push + open PR (reference issue: "Closes #N")
7. AI-assisted code review (paste diff into Claude)
8. Address feedback + re-test
9. Merge to main
10. Tag: v0.4.X
11. Verify against acceptance criteria
```

## Recommended Build Order

```
Data sources:  4.6 → 4.1 → 4.2 → 4.5 → 4.4 → 4.3
Analytics:     4.7 → 4.8 → 4.9 → 4.10 → 4.11
Config/close:  4.12 → 4.13
```

Rationale: Cursor (4.6) is the most isolated and reuses the proven
ConnectorInterface, so it's a clean warm-up. Self-reporting (4.1/4.2) then
expense depth (4.5/4.4) complete the data picture. Surveys (4.3) depend on
triggers that anomaly detection (4.7) also feeds, so they come after. Analytics
follow once data is complete. Settings (4.12) consolidates the new config.

## Phase 4 Context (applies to every task)

All developers are git-only (MEDIUM tier) at launch; tool connectors come online
progressively as the AI usage strategy rolls out. Therefore:
- New analytics operate on git-derived metrics + cost now, tool metrics later
- Confidence/tier labeling carries through every new surface
- Nothing fabricates direct-usage data; features strengthen automatically when
  tool data arrives
- New config uses the Phase 2 pattern: global default + optional per-team
  override + manager-permission toggle

---

# TASK 4.6: Cursor Connector (Full Parity)

**Branch:** `task/4.6-cursor-connector`
**Depends on:** Phase 1 ConnectorInterface
**Estimate:** 2–3 days

### GitHub Issue Description

```
## Task 4.6: Cursor Connector (Full Parity)

### Context
Adds Cursor as a fully-supported tool connector, matching the Copilot/Claude
Code/Windsurf connectors built in Phase 1. Cursor is #1 in startups/SMBs and #2
in enterprise, so this is important for product completeness beyond WMG (which
may not use Cursor at launch). Built to full parity so it lights up immediately
for any team that uses Cursor.

### API Reference
- Cursor Analytics API (Enterprise plan) + admin/team dashboard data
- Service-key authentication
- Per-user metrics: completions, chat, agent/Composer usage, model usage,
  acceptance rates; team breakdowns; daily granularity

### Deliverables
- [ ] src/connectors/cursor/client.ts — Analytics API client (service-key auth)
- [ ] src/connectors/cursor/transformer.ts — Cursor response → tool_snapshots
      - data_source = "api", data_quality = "high"
      - Map Cursor user identifiers to developer_id via external_ids
      - interaction_count, acceptance_count, acceptance_rate
      - features_used JSON: {"autocomplete": N, "composer": N, "chat": N}
      - models_used JSON
      - estimated_cost where derivable
- [ ] src/connectors/cursor/sync.ts — implements ConnectorInterface
      - CLI: `toprope sync cursor`
      - folded into `toprope sync all`
      - scheduled sync slot (configurable time)
      - pagination, rate limits, errors handled gracefully
      - sync-state tracking (no duplicate processing)
- [ ] Config block under connectors.cursor (enabled, service_key, sync_interval,
      sync_time)
- [ ] `toprope doctor` check: Cursor service key valid + analytics accessible
- [ ] `toprope dev link --cursor <identifier>` already exists from Phase 1;
      confirm it maps correctly

### Acceptance Criteria
- [ ] `toprope sync cursor` pulls data and creates tool_snapshots (one row per
      developer per day)
- [ ] interaction/acceptance counts and acceptance_rate correct
- [ ] features_used distinguishes autocomplete vs Composer vs chat (enables the
      under-utilization insight)
- [ ] Implements the SAME ConnectorInterface as the other three connectors
- [ ] Service-key auth works; invalid key surfaces a clear doctor error
- [ ] Folded into `sync all` and the scheduler
- [ ] Sync is idempotent (re-run produces no duplicates)
- [ ] API errors handled gracefully (logged, partial data saved, no crash)
- [ ] Unit tests with fixture data: normal, empty, pagination, rate limit
```

---

# TASK 4.1: Self-Reporting Core (Data Model + CLI)

**Branch:** `task/4.1-self-reporting-core`
**Depends on:** Phase 1 (tool_snapshots, developers)
**Estimate:** 2 days

### GitHub Issue Description

```
## Task 4.1: Self-Reporting Core (Data Model + CLI)

### Context
Captures AI usage for developers the platform can't reach via admin API —
personal/reimbursed accounts, tools without integration, or AI use that produces
no commits (chat, debugging, learning). This is the foundation; the Slack bot
(4.2) is a second interface on top of the same core.

### Schema (NEW)
CREATE TABLE self_reports (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  date TEXT NOT NULL,                  -- YYYY-MM-DD (the usage date)
  tool TEXT NOT NULL,                  -- copilot|cursor|claude_code|windsurf|chatgpt|other
  minutes INTEGER,                     -- optional rough effort
  task_descriptor TEXT,                -- optional free text (never sent to models)
  source_interface TEXT NOT NULL,      -- cli|slack
  created_at TEXT NOT NULL
);

### Aggregation into snapshots
- Self-reports aggregate into tool_snapshots with:
  - data_source = "self_report"
  - data_quality = "medium"  (self-reported is inferred-grade, not measured)
  - is_active = 1 for the reported date/tool
  - interaction_count left null (we don't fabricate counts from a time estimate)
  - features_used null (not known from self-report)
- Self-reports NEVER overwrite API data: if a developer has API data for a
  tool/date, that wins and the self-report is supplementary (kept in self_reports
  for the record but not used to override the snapshot)

### Deliverables
- [ ] Migration creating self_reports
- [ ] src/selfreport/core.ts — create/store a self-report, aggregate into
      tool_snapshots respecting the API-wins rule
- [ ] CLI: `toprope log --tool <tool> [--minutes N] [--task "..."] [--date YYYY-MM-DD]`
      (date defaults to today)
- [ ] Authenticated to the developer (uses their own identity; a developer can
      only log for themselves)
- [ ] task_descriptor treated as private free text: stored, shown only in the
      developer's own view, never sent to any model, never shown to managers
      beyond aggregate activity

### Acceptance Criteria
- [ ] `toprope log --tool cursor --minutes 90 --task "refactor auth"` stores a
      self_report and marks the developer active for that tool/date
- [ ] Self-report appears as data_source="self_report", data_quality="medium" in
      the developer's snapshots
- [ ] API data wins: if API data exists for the same tool/date, the snapshot is
      NOT overwritten by the self-report
- [ ] A developer cannot log usage for another developer
- [ ] task_descriptor is never included in any model input or manager-facing view
- [ ] minutes and task are optional; tool + date are sufficient
- [ ] Unit tests: log creation, aggregation, API-wins rule, self-only scoping,
      privacy of task_descriptor
```

---

# TASK 4.2: Slack Bot for Self-Reporting

**Branch:** `task/4.2-slack-selfreport`
**Depends on:** 4.1
**Estimate:** 2–3 days

### GitHub Issue Description

```
## Task 4.2: Slack Bot for Self-Reporting

### Context
The lowest-friction self-reporting interface, expected to drive the most
adoption. Sits on top of the 4.1 core. A developer logs usage with a few taps
rather than a terminal command.

### Deliverables
- [ ] Slack app integration (bot token, signing secret in config/env)
- [ ] Slash command (e.g. /toprope-log) opening a quick interactive form:
      tool (buttons), optional rough time (buttons: <30m / ~1h / ~half-day /
      ~full-day), optional task text
- [ ] Optional scheduled gentle prompt (configurable): e.g. end-of-day
      "Did you use AI today? Tap to log." — opt-in, not nagging
- [ ] Maps the Slack user to a developer_id (via a stored Slack-id ↔ developer
      mapping; add to external_ids or a small mapping)
- [ ] Submitting writes through the 4.1 core (same API-wins + privacy rules)
- [ ] Confirmation message on success; graceful handling if the Slack user
      isn't linked to a developer
- [ ] Config: slack.enabled, bot_token, signing_secret, optional daily-prompt
      time + which channels/DM

### Acceptance Criteria
- [ ] Slash command opens the interactive logging form
- [ ] Submitting logs usage via the 4.1 core (source_interface = "slack")
- [ ] Slack user correctly mapped to developer_id; unlinked users get a clear
      "ask your admin to link your account" message
- [ ] Optional daily prompt fires only if enabled, and is dismissible
- [ ] Slack request signature verified (security)
- [ ] No usage logged for the wrong developer
- [ ] Unit/integration tests: command handling, mapping, write-through,
      signature verification, unlinked-user path
```

---

# TASK 4.5: Richer Expense Import

**Branch:** `task/4.5-richer-expense-import`
**Depends on:** Phase 1 expense import (Task 1.8)
**Estimate:** 2 days

### GitHub Issue Description

```
## Task 4.5: Richer Expense Import

### Context
Phase 1 delivered basic CSV import with configurable column mapping. This deepens
it so cost data is complete and trustworthy across the messy real world of
personal/reimbursed accounts and varied expense systems. (Reconciliation is the
sibling task 4.4.)

### Deliverables
- [ ] Support multiple import formats / source profiles (e.g., Expensify, SAP
      Concur, generic sheet) via named column-mapping profiles in config
- [ ] Improved developer matching: multiple emails, name-variant matching,
      manual-resolution queue for unmatched rows
- [ ] Dedup: detect the same charge imported twice (by developer+tool+period+amount)
- [ ] Recurring vs one-time charge handling (monthly subscription vs annual
      prepay vs one-off)
- [ ] Billing-model inference where possible: personal-card reimbursement vs
      company-managed (heuristics from the expense source / fields), writing to
      subscriptions.billing_model, flagged as inferred where uncertain
- [ ] Import summary report: rows imported, matched, unmatched, duplicates skipped
- [ ] CLI: `toprope expenses import <file> [--profile <name>]`

### Acceptance Criteria
- [ ] At least 3 distinct import profiles work against fixture files
- [ ] Unmatched rows are queued (not silently dropped) for resolution
- [ ] Duplicate charges are detected and skipped with a report entry
- [ ] Recurring vs one-time correctly classified
- [ ] Billing-model inference populates billing_model, marked inferred when unsure
- [ ] Import summary accurately reports matched/unmatched/duplicate counts
- [ ] Unit tests: each profile, dedup, multi-email matching, recurring/one-time,
      inference, unmatched queue
```

---

# TASK 4.4: Expense Reconciliation

**Branch:** `task/4.4-expense-reconciliation`
**Depends on:** 4.5, Phase 1 subscriptions
**Estimate:** 2–3 days

### GitHub Issue Description

```
## Task 4.4: Expense Reconciliation

### Context
Makes the platform's cost numbers trustworthy by matching imported expenses
against the subscription registry and flagging mismatches — catching reimbursed
subscriptions that exist in expenses but were never registered, registered seats
no longer being paid for, and cost discrepancies. This is what lets a manager
believe the "total monthly AI spend" figure.

### Schema (NEW)
CREATE TABLE reconciliation_results (
  id TEXT PRIMARY KEY,
  run_at TEXT NOT NULL,
  period TEXT NOT NULL,                 -- the month/period reconciled
  result_type TEXT NOT NULL,            -- expense_no_subscription |
                                        -- subscription_no_expense |
                                        -- cost_discrepancy
  developer_id TEXT REFERENCES developers(id),
  tool TEXT,
  expense_amount REAL,
  registry_amount REAL,
  details TEXT,                         -- JSON specifics
  status TEXT NOT NULL DEFAULT 'open',  -- open | resolved | ignored
  resolution TEXT,                      -- free text / chosen action
  resolved_at TEXT
);

### Reconciliation logic (per period)
For each tool/developer in the period:
  - expense exists, no matching active subscription → expense_no_subscription
    (untracked tool / unregistered reimbursed seat)
  - active subscription exists, no matching expense → subscription_no_expense
    (are we still paying? or company-managed seat not in expense feed — note:
     company-managed seats may legitimately not appear in reimbursement expenses,
     so classify by billing_model to reduce false flags)
  - both exist but amounts differ beyond a tolerance → cost_discrepancy

### Deliverables
- [ ] Migration creating reconciliation_results
- [ ] src/expenses/reconcile.ts implementing the logic above
- [ ] Tolerance for cost_discrepancy configurable (e.g., ignore < $1 rounding)
- [ ] billing_model-aware: company-managed seats not expected in reimbursement
      feeds are not falsely flagged as subscription_no_expense
- [ ] CLI: `toprope expenses reconcile [--period YYYY-MM]`
- [ ] Admin UI surface: list of open reconciliation results with resolve/ignore
      actions (resolve records a note; ignore suppresses that result)
- [ ] API: GET /api/admin/reconciliation, POST /api/admin/reconciliation/:id/resolve

### Acceptance Criteria
- [ ] Reconciliation correctly produces each of the three result types against
      fixtures
- [ ] Company-managed seats absent from a reimbursement feed are NOT false-flagged
- [ ] Cost discrepancies within tolerance are ignored; beyond tolerance flagged
- [ ] Resolve/ignore workflow updates status and persists the note
- [ ] Re-running reconciliation doesn't duplicate already-open results for the
      same condition
- [ ] Admin endpoints admin-gated
- [ ] Unit tests: each result type, tolerance, billing-model awareness, resolve/
      ignore, idempotency
```

---

# TASK 4.3: Data-Prompted Surveys

**Branch:** `task/4.3-surveys`
**Depends on:** 4.2 (Slack delivery), 4.7 (anomaly triggers — soft dep), 4.12 (settings)
**Estimate:** 3 days

### GitHub Issue Description

```
## Task 4.3: Data-Prompted Surveys

### Context
Turns the platform's observations into targeted questions — far more useful than
open-ended interviews. "We see your Copilot usage dropped 40% — did you switch
tools, reduce AI use, or something else?" Closes the loop between observation and
explanation. Manager-configurable per trigger: auto-send or manual approval.

### Schema (NEW)
CREATE TABLE surveys (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  trigger_type TEXT NOT NULL,           -- usage_drop | unused_new_seat |
                                        -- plan_change | anomaly | manual
  trigger_context TEXT,                 -- JSON: what was observed
  question_text TEXT NOT NULL,
  status TEXT NOT NULL,                 -- queued | sent | answered | declined | dismissed
  delivery TEXT,                        -- slack | email
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE TABLE survey_responses (
  id TEXT PRIMARY KEY,
  survey_id TEXT NOT NULL REFERENCES surveys(id),
  response_text TEXT,
  response_choice TEXT,                 -- if a multiple-choice answer
  answered_at TEXT NOT NULL
);

### Triggers & config
- Trigger types: usage_drop, unused_new_seat, plan_change, anomaly, manual
- Per trigger type, a setting controls auto vs manual:
  - auto  → survey created status=queued then auto-sent
  - manual → survey created status=queued, waits for manager to send
- Setting is global default + per-team override (via 4.12 settings)
- Question templates per trigger type (concise, respectful, with a few tap-to-
  answer choices + optional free text)

### Deliverables
- [ ] Migrations creating surveys + survey_responses
- [ ] src/surveys/triggers.ts — detects trigger conditions (usage_drop from
      deltas, unused_new_seat from waste logic, plan_change from lifecycle,
      anomaly from 4.7). manual triggers created via UI/CLI.
- [ ] src/surveys/templates.ts — question template per trigger type
- [ ] src/surveys/dispatch.ts — auto vs manual per config; delivery via Slack
      (preferred, reuses 4.2 bot) or email
- [ ] Responses captured and stored; surfaced to manager as context next to the
      triggering data point ("usage dropped 40%; developer reports switched to Cursor")
- [ ] Manager UI: queue of manual surveys to review/send; view responses
- [ ] API: list/send/respond endpoints
- [ ] Privacy/framing: voluntary; developer can decline; responses give context,
      never used punitively

### Acceptance Criteria
- [ ] Each trigger type can create a survey with appropriate question text
- [ ] auto trigger sends automatically; manual trigger queues for manager approval
      (respecting global + per-team setting)
- [ ] Slack delivery works (reuses 4.2); email fallback works
- [ ] Responses stored and shown alongside the triggering data
- [ ] Declining is supported and recorded (status=declined)
- [ ] A developer only ever receives/answers their own surveys
- [ ] Manager sees response context but not in a punitive framing (copy reviewed)
- [ ] Unit tests: trigger detection, auto/manual dispatch, response capture,
      decline path, settings-driven behavior
```

---

# TASK 4.7: Anomaly Detection Engine

**Branch:** `task/4.7-anomaly-engine`
**Depends on:** Phase 3 aggregates/deltas, 4.12 (settings)
**Estimate:** 3 days

### GitHub Issue Description

```
## Task 4.7: Anomaly Detection Engine

### Context
Automatically flags when a developer or team metric deviates significantly from
its baseline — catching usage drops, runaway spend, compromised keys, or a team
that quietly stopped adopting. Two methods, configurable per metric. Tier-aware:
operates on git metrics now, extends to tool metrics when connected. Must NOT
fire until a metric has enough baseline history (prevents false positives in the
early weeks at WMG).

### Schema (NEW)
CREATE TABLE anomalies (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,                  -- developer | team
  scope_id TEXT NOT NULL,               -- developer_id or team name
  metric TEXT NOT NULL,                 -- commits | prs_merged | churn |
                                        -- ai_signature | interactions |
                                        -- acceptance_rate | cost | ...
  period TEXT NOT NULL,                 -- the period evaluated
  method TEXT NOT NULL,                 -- statistical | percentage_change
  observed_value REAL NOT NULL,
  expected_value REAL NOT NULL,         -- mean (statistical) or prior baseline
  deviation REAL NOT NULL,              -- std-devs (statistical) or % change
  severity TEXT NOT NULL,               -- info | notable | high
  basis TEXT NOT NULL,                  -- git_estimate | measured (tier)
  status TEXT NOT NULL DEFAULT 'open',  -- open | acknowledged | resolved
  detected_at TEXT NOT NULL
);

### Detection methods
STATISTICAL (mean + std-dev) — for noisy-but-stationary metrics (commits,
interactions, churn):
  baseline window = last N periods (configurable, default 8)
  mean  = average of metric over baseline window
  std   = standard deviation over baseline window
  z     = (observed - mean) / max(std, epsilon)
  flag if |z| >= threshold (configurable, default 2.0)
  deviation = z ; expected_value = mean

PERCENTAGE_CHANGE vs baseline — for metrics where a directional shift matters
regardless of variance (usage level, cost):
  baseline = prior period value (or trailing average, configurable)
  pct = (observed - baseline) / max(|baseline|, epsilon) * 100
  flag if |pct| >= threshold (configurable, default 40%)
  deviation = pct ; expected_value = baseline

### Per-metric configuration (via 4.12 settings)
Each metric configured with: method (statistical | percentage_change),
threshold, and baseline window. Global default + per-team override.

### Minimum-baseline guard (CRITICAL)
A metric must have >= MIN_BASELINE_PERIODS of history (configurable, default 4)
before anomaly detection runs for it. Below that, the metric is "building
baseline" → no anomalies fired. This prevents early-weeks false positives.

### Severity bands
- statistical: |z| 2.0–2.5 = notable, > 2.5 = high (config tunable)
- percentage_change: |pct| threshold–2x = notable, > 2x = high

### Tier-awareness
- At launch, runs on git-derived + cost metrics; basis = "git_estimate"
- Extends to tool metrics (interactions, acceptance_rate) when those exist;
  basis = "measured"
- basis stored on every anomaly so surfaces (4.8) can label honestly

### Deliverables
- [ ] Migration creating anomalies
- [ ] src/anomaly/engine.ts implementing both methods + severity + guard
- [ ] Runs after aggregation jobs (scheduled); evaluates current period per
      metric per scope
- [ ] Per-metric config resolution (global + per-team) via settings
- [ ] Minimum-baseline guard enforced
- [ ] basis (tier) set correctly per metric
- [ ] Idempotent: re-running a period doesn't duplicate anomalies
- [ ] CLI: `toprope anomaly scan [--period <p>]`

### Acceptance Criteria
- [ ] Statistical method flags a value > threshold std-devs from baseline mean
- [ ] Percentage_change method flags a shift >= threshold % vs baseline
- [ ] Per-metric method/threshold config respected (incl. per-team override)
- [ ] Minimum-baseline guard: NO anomalies fired for metrics with < MIN periods
      of history (verified — this is the key early-weeks protection)
- [ ] Severity bands assigned correctly
- [ ] basis = "git_estimate" at launch on git metrics; "measured" when on tool
      metrics
- [ ] Divide-by-zero guarded (epsilon) in both methods
- [ ] Idempotent re-run
- [ ] Unit tests: each method, threshold edges, baseline guard, severity bands,
      tier basis, per-metric config, zero-variance/zero-baseline guards
```

---

# TASK 4.8: Anomaly Surfacing (Dashboard + Slack + Summaries)

**Branch:** `task/4.8-anomaly-surfacing`
**Depends on:** 4.7, Phase 3 summaries, Phase 2 dashboard
**Estimate:** 2–3 days

### GitHub Issue Description

```
## Task 4.8: Anomaly Surfacing

### Context
Anomalies are only useful if seen. Surface them in three places (decision):
dashboard alerts, Slack notifications, and folded into the AI summaries — the
last in plain, tier-aware language so a manager notices in their weekly read.

### Deliverables
DASHBOARD:
- [ ] Anomalies panel (manager): open anomalies with scope, metric, deviation,
      severity, basis (tier label), detected date; acknowledge/resolve actions
- [ ] Inline flags on the relevant metric/chart where an anomaly exists
- [ ] Severity-based visual treatment (info/notable/high)
- [ ] basis labeled ("git-based estimate" at launch)

SLACK:
- [ ] Push notification to the manager on new notable/high anomalies (respects
      alert settings + channel config); reuses the 4.2 Slack app
- [ ] Concise message: scope, metric, what changed, severity, link to dashboard

AI SUMMARIES:
- [ ] Anomaly data fed into the Phase 3 summary input builder for the period
- [ ] Summary prompt extended to narrate notable anomalies in plain language
- [ ] TIER-AWARE: git-metric anomalies described honestly ("commit activity
      dropped 60%"), never as fabricated tool-usage language
- [ ] Only notable/high anomalies surface in summaries (avoid noise)

### Acceptance Criteria
- [ ] Dashboard anomalies panel lists open anomalies with correct detail + basis
- [ ] Inline metric flags appear where anomalies exist
- [ ] Acknowledge/resolve updates status and removes from the open list
- [ ] Slack notifications fire for notable/high anomalies, respect settings
- [ ] Summaries mention notable anomalies in plain language
- [ ] ADVERSARIAL TEST: with git-only data, anomaly text in summaries contains NO
      fabricated tool-usage terms (reuse Phase 3 forbidden-terms test)
- [ ] Low-severity (info) anomalies don't spam Slack or summaries
- [ ] All surfaces label basis/tier honestly
- [ ] Unit/integration tests: dashboard panel, Slack dispatch gating, summary
      integration, tier-aware phrasing
```

---

# TASK 4.9: Team Comparison — Rich Side-by-Side (≤ 4 Teams)

**Branch:** `task/4.9-team-compare-rich`
**Depends on:** Phase 2 dashboard, Phase 3 aggregates
**Estimate:** 2–3 days

### GitHub Issue Description

```
## Task 4.9: Team Comparison — Rich Side-by-Side

### Context
Lets a manager deeply compare 2–4 teams side-by-side — e.g., "Team A on Copilot
vs Team B on Cursor, who's getting more value?" Capped at 4 because per-metric
rows and overlaid charts get unreadable beyond that (the large-org case is the
sortable table in 4.10).

### Deliverables
- [ ] Team selector: pick 2–4 teams to compare
- [ ] Side-by-side per-metric rows: utilization, active developers, adoption
      trend, total cost, cost-per-PR, churn, AI maturity score, tool mix
- [ ] Overlaid trend charts (one line per team) using shared chart components +
      the time-range selector (30d/90d/year/lifetime/custom)
- [ ] Tier labeling: each team shows its data-quality tier so a fully-connected
      team isn't visually equated with a git-only team
- [ ] API: GET /api/compare?teams=a,b,c&range=<range>
- [ ] Enforce max 4 teams (UI prevents selecting more; API validates)

### Acceptance Criteria
- [ ] 2–4 teams compared side-by-side with all listed metrics
- [ ] Overlaid trend charts render correctly with the time-range selector
- [ ] Selecting > 4 teams is prevented (UI) and rejected (API)
- [ ] Each team's data-quality tier is clearly shown
- [ ] Maturity scores labeled git-based estimate at launch
- [ ] Matches aesthetic + dark mode; loads < 2s
- [ ] Unit tests: comparison data assembly, max-4 enforcement, tier labeling,
      range handling
```

---

# TASK 4.10: Team Comparison — Sortable All-Teams Table

**Branch:** `task/4.10-team-compare-table`
**Depends on:** Phase 2 Teams List, Phase 3 aggregates
**Estimate:** 1–2 days

### GitHub Issue Description

```
## Task 4.10: Team Comparison — Sortable All-Teams Table

### Context
The large-org case: "I manage 12 teams, rank them by adoption." A sortable table
of all teams a manager oversees, one row each, sortable by any metric. Extends
the Phase 2 Teams List rather than duplicating it.

### Deliverables
- [ ] All-teams table: one row per team the manager oversees
- [ ] Columns: utilization, active devs, total cost, cost-per-PR, churn, AI
      maturity score, waste, data-quality tier
- [ ] Sortable by any column (asc/desc)
- [ ] Period selector (which period's aggregates to show)
- [ ] Tier indicator per row
- [ ] Reuses/extends the Phase 2 Teams List component where sensible
- [ ] API: GET /api/teams/compare-table?period=<p> (or extend existing teams endpoint)

### Acceptance Criteria
- [ ] All overseen teams listed, one row each
- [ ] Sorting works correctly on every column
- [ ] Period selector changes the underlying aggregates shown
- [ ] Tier indicator present per team
- [ ] Maturity labeled git-based estimate at launch
- [ ] Handles many teams (e.g., 12+) without performance issues (pre-computed
      aggregates)
- [ ] Matches aesthetic + dark mode
- [ ] Unit tests: sorting, period selection, tier display
```

---

# TASK 4.11: Developer Adoption-Journey Visualization

**Branch:** `task/4.11-adoption-journey`
**Depends on:** Phase 2 (lifecycle data, My Dashboard), Phase 3 (maturity/trend)
**Estimate:** 2–3 days

### GitHub Issue Description

```
## Task 4.11: Developer Adoption-Journey Visualization

### Context
A polished timeline of a developer's AI adoption — from first activity to current
maturity — including tool/plan transitions. The growth story, not a report card.
Appears in the developer's own private view and in the manager's aggregate view
of a developer (framed as journey/health, never ranked judgment).

### Deliverables
- [ ] Timeline visualization from first detected AI activity to now
- [ ] Tool/plan transitions plotted from Phase 2 lifecycle data (revoke-old +
      create-new events): "Cursor Pro (Feb) → Claude Code (Apr)"
- [ ] Activity / maturity trajectory overlaid on the timeline
- [ ] Key moments annotated: first active week, sustained ramp, plateau
- [ ] Tier-aware: at launch built from git signals + estimated AI signature,
      labeled accordingly
- [ ] Placement:
      - Developer's own My Dashboard (private growth story)
      - Manager's developer-detail view (journey/health framing, aggregate, no
        ranking)
- [ ] API: GET /api/developers/:id/journey (manager, aggregate) and
      GET /api/me/journey (developer's own)
- [ ] Respects existing privacy scoping (developer sees own; manager sees
      aggregate journey, never prompt content)

### Acceptance Criteria
- [ ] Timeline renders from first activity to present
- [ ] Tool/plan transitions correctly plotted from lifecycle data
- [ ] Trajectory overlay reflects real activity/maturity over time
- [ ] Annotations mark key moments correctly
- [ ] Tier labeling present (git-based estimate at launch)
- [ ] Developer's own journey is private; manager view is aggregate/non-ranked
- [ ] Matches aesthetic + dark mode; loads < 2s
- [ ] Unit tests: timeline assembly, transition plotting, scoping (own vs
      manager), tier labeling
```

---

# TASK 4.12: Settings Extensions

**Branch:** `task/4.12-settings-extensions`
**Depends on:** Phase 2 settings system
**Estimate:** 1–2 days

### GitHub Issue Description

```
## Task 4.12: Settings Extensions

### Context
Phase 4 introduces several configurable behaviors. This task extends the Phase 2
settings system (global default + per-team override + manager-permission toggle)
to cover them, in one consolidated place. Build this early — 4.3 and 4.7 depend
on it.

### New settings
SURVEYS:
- survey_<trigger>_mode: auto | manual  (per trigger type: usage_drop,
  unused_new_seat, plan_change, anomaly)
- surveys_managers_can_override: bool

ANOMALY DETECTION (per metric):
- anomaly_<metric>_method: statistical | percentage_change
- anomaly_<metric>_threshold: number
- anomaly_<metric>_baseline_window: number
- anomaly_min_baseline_periods: number (global guard, default 4)
- anomaly_managers_can_override: bool

ALERT CHANNELS:
- anomaly_alert_slack_enabled: bool
- anomaly_alert_min_severity: notable | high
- (Slack channel/DM target config)

### Deliverables
- [ ] Extend the settings table usage with the new keys (no schema change — the
      Phase 2 settings table is key/value by scope)
- [ ] Effective-value resolution honors global + per-team override + the
      managers_can_* permission flags
- [ ] Settings UI sections (admin area): Surveys, Anomaly Detection, Alerts
- [ ] Sensible defaults for all new keys
- [ ] API: extend GET/PATCH /api/settings/global and /api/settings/team/:team

### Acceptance Criteria
- [ ] All new settings persist and resolve correctly
- [ ] Per-team override applies only when the matching managers_can_* flag is true
- [ ] Defaults are sensible and documented
- [ ] anomaly_min_baseline_periods actually gates the 4.7 engine
- [ ] survey_<trigger>_mode actually drives 4.3 auto/manual behavior
- [ ] Non-admins cannot change global settings
- [ ] Unit tests: resolution, permission gating, defaults, that the values drive
      the dependent engines
```

---

# TASK 4.13: Phase 4 Integration Testing + Dogfood Verification

**Branch:** `task/4.13-integration-dogfood`
**Depends on:** all prior Phase 4 tasks
**Estimate:** 2 days

### GitHub Issue Description

```
## Task 4.13: Phase 4 Integration Testing + Dogfood Verification

### Context
End-to-end verification of the Phase 4 additions against real WMG git-only data
before relying on them, confirming tier-awareness holds and the early-weeks
false-positive guards work.

### Deliverables
- [ ] E2E self-reporting: CLI log + Slack log → appears as self_report/medium,
      API-wins rule verified against any connected tool
- [ ] E2E Cursor connector: sync → tool_snapshots (if a test Cursor org is
      available; else fixture-based)
- [ ] E2E expense: richer import + reconciliation → mismatches flagged, resolve
      workflow works, total spend trustworthy
- [ ] E2E anomaly: seed data with a known deviation → anomaly detected, correct
      method/severity/basis; verify minimum-baseline guard suppresses early-weeks
      noise
- [ ] E2E surveys: trigger → auto vs manual per settings → Slack delivery →
      response captured and shown as context
- [ ] E2E comparison: rich ≤4 + sortable all-teams, tier labeling correct
- [ ] E2E journey: developer + manager views, transitions plotted, scoping correct
- [ ] TIER-AWARENESS VERIFICATION: anomaly text in summaries has no fabricated
      usage language (reuse Phase 3 forbidden-terms test)
- [ ] Performance: new dashboard views < 2s on real data
- [ ] Update setup/onboarding doc with Phase 4 (self-report, Slack, surveys,
      anomaly config, Cursor)
- [ ] Update the roadmap source-of-truth: move Phase 4 to DONE with feature
      inventory; bump version + changelog

### Acceptance Criteria
- [ ] All E2E flows pass
- [ ] Minimum-baseline guard verified (no early-weeks false anomalies)
- [ ] API-wins rule verified (self-report never overrides measured data)
- [ ] Reconciliation makes total spend trustworthy (manual spot-check)
- [ ] Summaries with anomalies contain no fabricated usage language
- [ ] New views performant and on-aesthetic
- [ ] Onboarding doc updated
- [ ] Roadmap source-of-truth updated (Phase 4 → DONE)
```

---

## Phase 4 Completion Checklist

```
[ ] Cursor connector at full parity; lights up for any Cursor team
[ ] Self-reporting works via both CLI and Slack; marked self_report/medium
[ ] Self-reports never override measured API data (API-wins)
[ ] Expense import richer (profiles, dedup, billing-model inference)
[ ] Reconciliation flags expense/registry mismatches; total spend trustworthy
[ ] Data-prompted surveys fire (auto or manual per trigger setting), via Slack
[ ] Survey responses surface as context next to the triggering data
[ ] Anomaly detection: both methods, per-metric config, tier-aware
[ ] Minimum-baseline guard prevents early-weeks false positives (verified)
[ ] Anomalies surface in dashboard + Slack + AI summaries (tier-aware language)
[ ] Team comparison: rich side-by-side (≤4) + sortable all-teams table
[ ] Developer adoption-journey visualization (private + manager-aggregate)
[ ] New settings consolidated (surveys, anomaly, alerts) with permission model
[ ] npm test — all pass, including baseline-guard and no-fabricated-usage tests
[ ] Roadmap source-of-truth updated: Phase 4 → DONE
```

**Phase 4 is complete when the blind spots are closed — a developer on a personal
account can self-report in seconds, cost numbers are reconciled and trustworthy,
and the platform proactively flags the unusual and explains it in plain language —
with every new feature honest about its data tier.**

Next: Phase 5 — Developer Coaching.

---

*End of Document — Toprope Phase 4 Task Tracker*
