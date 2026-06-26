# GovProxy — Phase 4 Design Document

**Phase 4: Complete the Data Picture + Close Analytics Gaps**

Status: DESIGN — decisions resolved | Version 1.0 — May 2026

> Companion to the canonical roadmap (GovProxy_Roadmap_Source_of_Truth.md).
> All design decisions below are resolved; this document feeds directly into the
> Phase 4 Task Tracker.

---

## 1. Phase 4 Goal

Phases 1–3 delivered a complete adoption-intelligence platform: data pipeline,
dashboard, aggregation, and AI summaries. But two kinds of gaps remain:

1. **Data blind spots.** At launch, developers on personal/reimbursed accounts,
   tools without admin APIs, or AI use that never reaches git are invisible or
   only partially seen. Phase 4 closes these so the intelligence is *complete*
   rather than partial.

2. **Unbuilt analytics.** Three analytics features were referenced across earlier
   documents but never actually built: anomaly detection, a dedicated team
   comparison view, and a polished developer adoption-journey visualization.
   Phase 4 finishes them.

**Theme:** make the intelligence complete and close the blind spots.

**Tier-aware, as always:** at launch everything operates on git-derived metrics +
expense data, and strengthens automatically as tool connectors come online. No
feature implies data that doesn't exist.

**Duration estimate:** 3–4 weeks (refine at tracker stage).

---

## 2. Scope — Six Areas

| # | Area | Type |
|---|---|---|
| A | Self-reporting (CLI + Slack bot) | Data completeness |
| B | Data-prompted surveys | Data completeness |
| C | Expense / gap-filling depth (reconciliation + richer import) | Data completeness |
| D | Cursor connector (full parity) | Data completeness |
| E | Anomaly detection | Analytics gap |
| F | Team comparison (rich ≤4 + sortable all-teams) | Analytics gap |
| G | Developer adoption-journey visualization | Analytics gap |

---

## 3. Area A — Self-Reporting (CLI + Slack Bot)

**Purpose:** capture AI usage for developers the platform can't reach via admin
API — personal accounts, reimbursed subscriptions, tools without integration, or
AI use that doesn't produce commits (chat, debugging, learning).

**Decision:** build BOTH a CLI and a Slack bot. CLI is simplest and works for the
terminal-native; the Slack bot is lowest-friction and will drive the most
adoption.

**How it works:**
- A developer logs usage in seconds: which tool, rough time/effort, optional task
  descriptor. Example CLI: `govproxy log --tool cursor --minutes 90 --task "refactor auth"`
- Slack bot: a slash command or a quick interactive message ("Used AI today?
  Which tool? Roughly how long?") with tap-to-answer buttons
- Self-reported data lands as `tool_snapshots` with `data_source = "self_report"`
  and `data_quality = "medium"` (or its own tier — see open consideration), clearly
  distinguished from API data
- Self-reports never overwrite API data; for a developer with both, API data wins
  and self-report is supplementary/ignored for that tool

**Privacy & framing:** self-reporting is voluntary and framed as "help us
understand your AI usage so we can support it," never as mandatory time tracking.
Task descriptors are optional and treated like any free text — not sent to models,
not shown to managers beyond the developer's own aggregate.

**Data model:** reuse `tool_snapshots` with `data_source = "self_report"`. No new
core table needed; possibly a small `self_reports` raw table for the verbatim
entries before aggregation into snapshots.

---

## 4. Area B — Data-Prompted Surveys

**Purpose:** turn the platform's own observations into targeted questions, far
more useful than open-ended interviews. "We see your Copilot usage dropped 40%
this month — did you switch tools, reduce AI use, or something else?"

**Decision:** manager-configurable per trigger — the manager chooses, per trigger
type, whether surveys auto-send or require manual approval before going to a
developer.

**How it works:**
- Triggers are conditions detected from the data: significant usage drop, a new
  seat unused for N days, a plan change, an anomaly (ties to Area E)
- Each trigger type has a setting: `auto` (fires automatically) or `manual`
  (queues for the manager to review and send) — global default + per-team override,
  consistent with the Phase 2 settings pattern
- Surveys delivered via the Slack bot (preferred) or email
- Responses stored and surfaced to the manager as context alongside the data
  ("usage dropped 40%; developer reports they switched to Cursor") — closing the
  loop between observation and explanation
- Question templates per trigger type; concise, respectful, easy to answer

**Privacy & framing:** surveys are about understanding, not interrogation. A
developer can decline. Responses give the manager context but are never used
punitively — same coaching-not-surveillance principle.

---

## 5. Area C — Expense / Gap-Filling Depth

**Purpose:** go beyond Phase 1's basic CSV import to make cost data trustworthy
and complete, especially for personal/reimbursed accounts.

**Decision:** BOTH reconciliation and richer import.

**Reconciliation:**
- Match imported expense records against known subscriptions in the registry
- Flag mismatches: an expense with no matching subscription (untracked tool?), a
  subscription with no matching expense (are we still paying?), cost discrepancies
  (expense says $40, registry says $20)
- Present reconciliation results to the admin for resolution
- This catches the real-world mess: reimbursed subscriptions that exist in
  expense reports but were never registered, or registered seats no longer being
  paid for

**Richer import:**
- More formats and column mappings (different expense systems, manual sheets)
- Better dedup and developer-matching (multiple emails, name variants)
- Handling for recurring vs one-time charges
- Billing model inference where possible (a personal card reimbursement vs a
  company-managed seat)

**Outcome:** the cost side of the platform becomes trustworthy — a manager can
believe the "total monthly AI spend" number because it's been reconciled against
actual expenses, not just whatever was hand-entered.

---

## 6. Area D — Cursor Connector

**Purpose:** add the remaining major tool integration. Cursor is the strongest
tool in startups/SMBs and #2 in enterprise, so full coverage matters for the
product beyond WMG.

**Decision:** full parity with the other connectors.

**How it works:**
- Implements the same ConnectorInterface as Copilot/Claude Code/Windsurf
- Cursor Analytics API (Enterprise) + service-key auth
- Per-user metrics: completions, chat, agent/Composer usage, model usage,
  acceptance rates, team breakdowns
- Transforms to `tool_snapshots` with `data_source = "api"`, `data_quality = "high"`
- Scheduled sync slotted into the existing pipeline
- `govproxy sync cursor` + folded into `govproxy sync all` + `doctor` check
- Feature breakdown distinguishes autocomplete vs Composer vs chat (the
  under-utilization insight: "paying for it but only using autocomplete")

**Note:** WMG may not use Cursor at launch, so this connector's main value is
product completeness for external customers — but it's built to the same standard
and will light up immediately for any team that uses Cursor.

---

## 7. Area E — Anomaly Detection

**Purpose:** automatically flag when a developer or team metric deviates
significantly from its baseline — catching usage drops, runaway spend, compromised
keys, or a team that quietly stopped adopting.

**Decision:** BOTH methods, configurable per metric in the dashboard.

**Two detection methods:**
- **Statistical (mean + std-dev):** flags values unusually far from the metric's
  rolling mean (e.g., > 2 std-devs). Right for noisy-but-stationary metrics —
  daily commits, interactions, churn rate.
- **Percentage-change vs baseline:** flags a meaningful shift regardless of
  variance (e.g., usage down 50% vs prior period). Right for metrics where a
  directional move matters even when naturally spiky.
- Each metric is configured (in the dashboard) to use one method or the other,
  with tunable thresholds (std-dev multiplier or percentage threshold).

**Tier-aware (launch behavior):**
- At launch, anomaly detection operates on git-derived metrics (commit velocity,
  PR throughput, churn, AI signature) and cost metrics
- As tool connectors come online, it automatically extends to tool metrics
  (interactions, acceptance rate) — same tier-aware pattern as maturity/summaries
- Anomalies on git metrics are described as such; no fabricated tool-usage framing

**Minimum-baseline guard (critical):**
- A metric must have accumulated enough history before anomaly detection fires
  (configurable minimum, e.g., 3–4 periods). Until then, the metric is "building
  baseline" and produces no anomalies — this prevents the first weeks at WMG from
  being all false positives.

**Where anomalies appear (decision: all three):**
- **Dashboard alerts:** an anomalies panel + inline flags on the relevant metric
- **Slack notifications:** pushed to the manager (respecting the alert settings)
- **Folded into AI summaries:** the weekly/monthly summary narrates notable
  anomalies in plain language ("unusual: backend team commit activity dropped 60%
  this week"). Tier-aware phrasing — git metrics described honestly, never invented
  usage language.

**Settings:** per-metric method + threshold, minimum-baseline period, and the
alert-channel preferences — global default + per-team override (Phase 2 pattern).

---

## 8. Area F — Team Comparison

**Purpose:** let a manager compare teams — both deeply (side-by-side) and broadly
(all teams at once).

**Decision:** BOTH — rich side-by-side for up to 4 teams, plus a sortable
all-teams table for the larger case.

**Rich comparison (≤ 4 teams):**
- User selects 2–4 teams
- Side-by-side per-metric rows: utilization, adoption trend, cost, cost-per-PR,
  churn, AI maturity score, tool mix
- Overlaid trend charts (each team a line) with the shared time-range selector
- Useful for "Team A on Copilot vs Team B on Cursor — who's getting more value?"

**Sortable all-teams table:**
- Every team the manager oversees, one row each
- Sortable by any metric (utilization, cost, maturity, waste, etc.)
- Handles the large-org case ("I manage 12 teams, rank them by adoption")
- Extends the Phase 2 Teams List rather than duplicating it

**Tier-aware:** comparisons clearly mark which teams have which data quality, so a
manager doesn't compare a fully-connected team against a git-only one as if the
numbers were equivalent. Confidence markers carry through.

---

## 9. Area G — Developer Adoption-Journey Visualization

**Purpose:** a polished timeline of a developer's AI adoption — from first activity
to current maturity — including tool and plan transitions. The growth story, not
a report card.

**Where it lives:**
- The developer's own view (My Dashboard) — their private growth story
- The manager's view of a developer's aggregate detail — but framed as journey/
  health, never as ranked judgment (consistent with Phase 2 privacy principles)

**What it shows:**
- Timeline from first detected AI activity to now
- Tool/plan transitions plotted (from the Phase 2 lifecycle data): "started on
  Cursor Pro in Feb, switched to Claude Code in April"
- Maturity / activity trajectory overlaid
- Key moments annotated (first active week, a sustained ramp, a plateau)
- Tier-aware: at launch the journey is built from git signals + estimated AI
  signature, labeled accordingly

**Why it matters:** it turns dry metrics into a narrative a developer recognizes
as their own, reinforcing the coaching-not-surveillance posture and setting up
Phase 5 (coaching) nicely.

---

## 10. Cross-Cutting: Settings & Tier-Awareness

Two themes thread through Phase 4, consistent with prior phases:

**Settings pattern (Phase 2):** every new configurable behavior — survey
auto/manual per trigger, anomaly method/threshold per metric, minimum-baseline
period, alert channels — uses the global-default + optional-per-team-override
model with the manager-permission toggle.

**Tier-awareness (Phases 2–3):** every new feature operates on available data,
labels confidence, never fabricates, and strengthens automatically as tool
connectors connect. New data sources (self-report, reconciled expense) slot into
the existing data-quality tiers.

---

## 11. Schema Impact (Preview — detailed in tracker)

Likely additions (finalized per task in the tracker):
- `self_reports` — raw verbatim self-report entries before aggregation
- `surveys` + `survey_responses` — survey triggers, sends, and answers
- `anomalies` — detected anomalies (metric, scope, method, severity, period,
  status, basis/tier)
- `reconciliation_results` — expense-vs-registry mismatches awaiting resolution
- Settings keys for survey triggers, anomaly config, alert channels
- `tool_snapshots` gains `self_report` as a `data_source` value (no schema change,
  just a new enum value) and Cursor as a tool

No changes to the immutable daily-snapshot or aggregate design — Phase 4 adds
sources and analytics on top of the existing foundation.

---

## 12. Proposed Task Breakdown (Draft — for the tracker)

- **4.1** Self-reporting core (data model + CLI `govproxy log`)
- **4.2** Slack bot for self-reporting (interactive logging)
- **4.3** Data-prompted surveys (triggers, templates, auto/manual config, responses)
- **4.4** Expense reconciliation (match, flag mismatches, resolution UI)
- **4.5** Richer expense import (formats, dedup, billing-model inference)
- **4.6** Cursor connector (full parity, ConnectorInterface)
- **4.7** Anomaly detection engine (both methods, per-metric config, baseline guard, tier-aware)
- **4.8** Anomaly surfacing (dashboard panel + Slack + summary integration)
- **4.9** Team comparison — rich side-by-side (≤4 teams)
- **4.10** Team comparison — sortable all-teams table
- **4.11** Developer adoption-journey visualization
- **4.12** Settings extensions (survey, anomaly, alert-channel config)
- **4.13** Phase 4 integration testing + dogfood verification

---

## 13. Resolved Design Decisions (Reference)

1. **Self-reporting:** both CLI and Slack bot.
2. **Anomaly method:** both statistical and percentage-change, configurable per
   metric in the dashboard.
3. **Cursor connector:** full parity with other connectors.
4. **Expense depth:** both reconciliation and richer import.
5. **Team comparison:** both rich side-by-side (≤4 teams) and sortable all-teams
   table.
6. **Anomaly alert channels:** dashboard + Slack + folded into AI summaries.
7. **Survey control:** manager-configurable per trigger (auto or manual).
8. **Anomaly tiering:** works on git metrics now, extends to tool metrics when
   connected; minimum-baseline guard before firing.

---

## 14. Phase 4 Milestone (Proposed)

By the end of Phase 4:

- A developer on a personal Cursor account that the platform can't reach via API
  can self-report usage in seconds via Slack, and it shows up (clearly marked
  self-reported) in their adoption picture
- A manager gets a Slack alert and a dashboard flag when a team's activity drops
  anomalously, and the weekly summary mentions it in plain language
- The cost numbers are trustworthy because expenses have been reconciled against
  the subscription registry, with mismatches flagged
- A manager can compare their top 4 teams side-by-side, or rank all 12 teams by
  adoption in a sortable table
- A developer sees their own adoption journey as a growth story, transitions and all
- Cursor users get the same full intelligence as Copilot/Claude Code/Windsurf users
- Every blind spot from launch is now either closed or honestly visible as a gap

---

*End of Document — GovProxy Phase 4 Design (decisions resolved)*
