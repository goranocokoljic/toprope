# GovProxy — Product Roadmap & Source of Truth

**The canonical reference for what GovProxy is, what's built, and what's next.**

Version 1.2 — June 2026 | Living document — update as phases complete

> This document supersedes the phase definitions and roadmaps in all earlier
> documents (see Section 7, Superseded Documents). When any other document
> conflicts with this one regarding scope, phase numbering, or what is built,
> THIS document is authoritative.

---

## 1. What GovProxy Is

GovProxy is an **AI adoption intelligence platform for engineering organizations**.

It gives engineering leadership a unified, cross-tool view of how their teams
adopt AI-assisted development tools — regardless of which tools are used, how
they're billed, or who manages the accounts. It aggregates data from tool APIs,
git repositories, and expense data; normalizes it into a unified model; and
surfaces the insights no single vendor dashboard provides: who's actually using
what, whether the spend is justified, where money is wasted, how adoption is
trending, and where teams need help.

It is **not** a proxy/gateway (an earlier concept, since abandoned), not a DLP
tool, and not a router. It is an intelligence and reporting layer.

**Primary buyer:** engineering manager / head of engineering / VP engineering at
companies with 20–500 engineers using AI dev tools.

**Core principles (carried through every phase):**
- Multi-source with graceful degradation; always honest about data confidence
- Privacy: individual data visible only to the developer; managers see aggregates
- Coaching, not surveillance
- Tier-aware: nothing implies data we don't have; strengthens as sources connect
- Self-hosted; data stays in the customer's infrastructure

**Working name:** GovProxy (placeholder; final name TBD before public launch).

**Deployment context at WMG (the reference customer / dogfood):** all developers
are git-only at launch because the AI usage strategy is still rolling out; tool
API connectors come online progressively. Primary git provider is Bitbucket.

---

## 2. Phase Status Overview

| Phase | Theme | Status |
|---|---|---|
| Phase 1 | Data pipeline: git analysis + tool connectors + foundation | ✅ DONE |
| Phase 2 | Dashboard: manager + developer views | ✅ DONE |
| Phase 3 | Aggregation engine + AI-generated summaries | ✅ DONE |
| Phase 4 | Complete the data picture + close analytics gaps | ✅ DONE |
| Phase 5 | Developer coaching | ✅ DONE |
| Phase 6 | Production hardening & scale | ▶ NEXT |
| Backlog | Benchmarks, mobile, future connectors | ⬜ UNSCHEDULED |

---

## 3. Completed Phases — Full Feature Inventory

### Phase 1 — Data Pipeline + Foundation ✅

**Project foundation**
- Node.js + TypeScript + Fastify + better-sqlite3 + Commander.js scaffold
- YAML config with JSON Schema validation
- Migration system; full database schema
- CLI tooling, Docker packaging, vitest setup

**Developer & team registry**
- Teams and developers via CLI; config-based team definitions
- Auto-discovery of developers from GitHub org members
- Cross-tool identity mapping (`external_ids`) — one developer ↔ multiple tool
  identities + multiple git author emails

**Tool API connectors** (unified ConnectorInterface)
- GitHub Copilot — per-user daily metrics, acceptance rates, feature/model
  breakdown, seat assignment + inactive-seat detection, team attribution
- Claude Code — sessions, commits, PRs, lines changed, tool acceptance rates,
  cost via Anthropic Enterprise Analytics API
- Windsurf — AI-generated code %, feature usage, team analytics via Enterprise
  API (service-key auth)

**Multi-provider git analysis** (provider abstraction layer)
- Provider interface + factory; normalized git data model
- GitHub provider (REST API)
- Bitbucket provider (REST API 2.0; app-password/token/oauth; raw-author parsing)
- GitLab provider (REST API v4; PAT/oauth/job-token; self-managed support;
  projects/MRs/notes terminology; subgroups)
- Provider-agnostic analysis engine: commit metrics, PR metrics, code churn
  (48h window), AI signature score (0–100 heuristic, conservative, labeled
  "estimated"), commit-burst detection
- Developer mapping across providers (multi-email)

**Expense & subscription**
- CSV importer with configurable column mapping
- Subscription registry: developer ↔ tool ↔ plan ↔ cost
- Billing model classification: company_managed / reimbursed / personal / unknown
- Duplicate subscription detection
- Default cost values from config

**Waste detection**
- Unused seats (14+ days inactive), underutilized (below team threshold),
  duplicate tool coverage, cost outliers
- Waste alert storage + resolution workflow

**API + CLI + automation**
- REST API: overview, teams, team detail, developer detail, timeline, waste,
  snapshots, export
- `govproxy status`, `govproxy doctor` (validates all connectors + git providers)
- Scheduled multi-connector sync pipeline (node-cron), per-connector sync state,
  duplicate prevention, error isolation

### Phase 2 — Dashboard ✅

**Frontend foundation**
- React + TypeScript SPA served by Fastify at /dashboard
- Tailwind, charting library, React Query, client routing, dark mode, distinctive
  typography

**Authentication & accounts**
- Email + password, argon2/bcrypt hashing
- Admin-provisioned accounts; first-login password change; session management
- Role model: admin (manager) vs developer
- Strict per-developer data scoping (a developer can only ever see their own data)

**Manager views**
- Organization Overview: top-line metric cards, tool distribution, hero adoption
  trend, multi-source coverage indicator (data quality + tool connectors + git
  providers with repo counts)
- Teams List: sortable, utilization/cost/waste indicators
- Team Detail: scoped metrics, adoption trend, per-developer aggregate cards
  (utilization health, NOT ranked), team tool breakdown, git provider label,
  inline waste
- Waste Detection screen: categorized alerts, totals, projected savings,
  resolution workflow + audit trail, Plan ROI alerts

**Developer views (private)**
- My Dashboard: personal stats, adoption journey, activity trend (no peer ranking,
  no insights text — deferred to P3 summaries)
- My Tools: per-tool usage detail
- My Activity: git correlation, churn with plain-language explanation

**Data-quality tiers (UX)**
- HIGH/MEDIUM/LOW/NONE confidence markers throughout
- Tier-aware cards (git-only developers show output + estimated signals, never
  fabricated usage)
- Tier-aware waste claims (assertion for HIGH, review-question for MEDIUM)
- Cold-start / genuine-empty / partial-coverage data states

**Subscription lifecycle & ROI**
- Revoke-old + create-new pattern for plan/tool changes; history preserved
- Transition-aware waste detection (no false alarms on recent changes)
- Plan-change ROI detection: baseline capture + post-settling comparison; flags
  upgrades not justified by usage rise; review-framed, not accusatory

**Admin & settings**
- Admin Management UI: users, teams, identity mapping, subscriptions (UI over the
  Phase 1 CLI capabilities)
- Settings: global + per-team toggles with permission model
- Plan ROI thresholds configurable (global default + optional per-team override)
- Per-user UI preferences (default time range, dark mode)

**Shared UI**
- Time-range selector (30d / 90d / year / lifetime / custom) with smart defaults
  based on available history; "lifetime" = from first data; remembered per user
- Coverage/confidence badge; stat cards; chart wrappers; sortable table; loading
  skeletons; role-aware navigation

**Optional leaderboard**
- Ranked team view, ships OFF by default, gated by global + per-team settings
  (built because buyers ask for it; default-off by principle)

**Multi-provider git in dashboard**
- All git-derived views work identically across GitHub/Bitbucket/GitLab

### Phase 3 — Aggregation Engine + AI Summaries ✅

**Aggregation engine**
- Weekly, monthly, quarterly, yearly rollups computed from immutable daily
  snapshots; idempotent; manual triggers
- Delta computation (period-over-period) for all key metrics; null deltas on
  first period (no fake 0%)
- Backfill command (default 12 months, configurable) — instant trend depth
- node-cron scheduling with error isolation

**AI maturity score**
- Tier-aware composite 0–100 per team per period
- Git-only composition at launch (adoption breadth, consistency, output health,
  churn quality, cost efficiency vs org-average benchmark)
- Labeled "git-based estimate" everywhere; designed to strengthen to measured as
  tool data arrives without scale/meaning change
- Documented extension point for the future full formula

**AI-generated summaries**
- Four levels: weekly, monthly, quarterly, yearly
- Configurable model, default LOCAL (Ollama), larger model for narrative quality;
  per-level override
- Input is aggregate numbers only — no code, no commit content, no prompt content
- Tier-aware prompting: describes git signals honestly, never invents direct-usage
  language; adversarially tested
- Weekly + monthly auto-generate on schedule; quarterly + yearly on-demand
- Storage with regeneration (optional focus) + staleness detection
- Single concise analytical default voice

**Surface**
- API: aggregates, maturity trend, summaries (list/get/regenerate/generate)
- Dashboard: maturity trend chart (git-estimate labeled), summaries panel with
  regeneration + on-demand generation + stale flagging

### Phase 4 — Complete the Data Picture + Close Analytics Gaps ✅

**Self-reporting (Tier 4 data)**
- Self-report core: developer logs AI-tool usage (tool, optional minutes, optional
  private task descriptor) → a `self_report`/MEDIUM `tool_snapshot`; never
  fabricates measured interaction counts; private task descriptor never enters the
  aggregated snapshot
- CLI `govproxy log` and an interactive Slack bot (slash command + modal),
  authenticated by Slack request signature
- **API-wins rule:** a self-report never overrides a measured API snapshot for the
  same developer/day/tool, and a later API sync replaces an earlier self-report
  placeholder (the raw self-report is always kept on record)

**Data-prompted surveys**
- Triggers (usage drop, unused new seat, plan change, anomaly) detected from
  aggregates; templated questions with optional choices
- Auto-send vs manager-approval per trigger (global default + per-team override
  under the manager-permission toggle); Slack delivery with email fallback;
  stranded-auto-survey retry on the next sweep
- Responses captured and surfaced to the manager as context next to the triggering
  data; developer answers only their own surveys (strict scoping)

**Expense / gap-filling depth (Tier 3)**
- Richer import: multiple expense-export profiles (standard/expensify/concur/…),
  annual→monthly normalization, dedup, billing-model inference
- Reconciliation: expense charges vs subscription registry per period →
  `expense_no_subscription` / `subscription_no_expense` / `cost_discrepancy`
  mismatches (tolerance-aware, company-managed exempt, annual-coverage aware);
  resolve/ignore workflow so total spend is trustworthy; idempotent re-runs

**Cursor connector** (full ConnectorInterface parity)
- Analytics API → `tool_snapshots` (api/HIGH); identity mapping by cursor
  external_id with email fallback; pagination, 429 retry, idempotent daily writes;
  obeys the API-wins rule against prior self-reports

**Anomaly detection** (tier-aware)
- Both methods — statistical (z-score) and percentage-change — configurable
  per metric (global default + override)
- Minimum-baseline guard suppresses early-weeks false positives until enough prior
  periods exist; idempotent re-scan preserves acknowledged/resolved status
- Carries an honest basis (`git_estimate` at launch); developer-scope anomalies
  stay private, team-scope surface to managers
- Surfacing: dashboard panel (acknowledge/resolve) + Slack alerts (notable/high,
  settings-gated) + folded into AI summaries in plain, honest language

**Team comparison**
- Rich side-by-side for 2–4 teams: every metric, tool mix, overlaid trend,
  per-team data-quality tier (weakest-link rule), maturity with git_estimate basis
- Sortable all-teams table for a selected quarter, every overseen team listed

**Developer adoption-journey visualization**
- Timeline from first to latest AI activity; continuous weekly trajectory (gaps
  zero-filled, AI signature averaged); tool/plan transitions plotted from lifecycle
  data; annotated key moments (first active week, sustained ramp, plateau)
- Tier-labeled; private `/api/me/journey` for the developer, manager-aggregate
  `/api/developers/:id/journey` (developer role confined to their own)

**Cross-cutting**
- Settings extensions for survey triggers, anomaly config, and alert channels,
  following the established global-default + per-team-override + permission model
- Tier-awareness held end to end: every new feature labels its basis and never
  invents direct-usage language — verified by `tests/integration/phase4-pipeline.test.ts`
  (which reuses the Phase 3 forbidden-terms catalogue against anomaly summaries)

---

### Phase 5 — Developer Coaching ✅

The product's differentiator: a private mirror that helps developers improve,
while managers see only team-level patterns. Tier-aware — the first two pillars
work on existing data, so a git-only WMG developer gets useful coaching with no
opt-in. The non-negotiable rule across the phase: **individual coaching signals
are private to the developer; managers see floored team aggregates only**, framed
within-developer-over-time, never as a cross-developer ranking.

**Pillar 1 — Available-data coaching** (works at launch, git-only)
- Churn self-reflection, acceptance-rate trends (only where tool data exists —
  honestly null for git-only), adoption-journey interpretation, and tier-aware
  personal insights, all on the developer's own data (`/api/me/coaching`)
- Manager aggregate carries contributor counts + category tallies only — never the
  observation sentence, with a k-anonymity floor (≥3 contributors)

**Pillar 2 — PR/review outcome coaching** (works at launch, the no-opt-in
highest-value signal)
- From GitHub/Bitbucket/GitLab PR + review data: rework/review-rejection rate,
  review rounds, comment density, time-to-merge, and the churn + review combination
  that disambiguates struggling vs healthy iteration vs effective adoption
- **All-PR (factual)** and **AI-assisted (inferred)** views kept rigorously separate
  and labelled; private developer trajectory (`/api/me/pr-coaching`) vs floored
  manager team aggregate (`/api/coaching/pr-review/...`) with no individual reachable

**Pillar 3 — Opt-in prompt capture** (off until an admin permits; developer's choice)
- Double opt-in: capture at all (opt-in #1) and, separately, cloud retrospective
  analysis (opt-in #2); both mechanisms — local agent + editor extension — feed one
  client-side-encrypted blind store that rejects any plaintext/key material
- Real-time loop detection + prompt-quality nudges run locally at the capture layer
  and sync metadata only; session retrospective defaults to a **local model**
  (prompts never leave org infra), cloud only on the double opt-in + org permission
- Developer-chosen key recovery (no-recovery vs recovery-path); every recovery
  action is logged in a developer-visible feed — no silent use, no admin backdoor

**Showcase — exemplary conversations**
- Deliberate owner act: promote (transient decrypt) → mandatory redact → publish to
  a **separate shared store** at team/org scope; private captures untouched, nothing
  auto-harvested; browse within access scope; owner unpublish; team-lead remove
  (with author notice) but never publish/edit on a developer's behalf

**Cross-cutting**
- Coaching settings & permissions (org policy gates developer choices; pillars
  team-overridable); unified manager coaching panel (`/api/coaching/manager/...`)
  that is structurally aggregate-only
- Privacy verified end to end by `tests/integration/phase5-pipeline.test.ts`: the
  no-plaintext, no-individual-leak, min-group-size, double-opt-in, and
  owner-only-publish guarantees each have a dedicated assertion (Task 5.12)

---

## 4. Definitive Forward Roadmap

> This numbering is authoritative and supersedes all earlier phase definitions.
> The original V1 build-spec phase list (which planned expense import as "Phase 4"
> and trends/analytics as "Phase 5") is OBSOLETE — those items were built earlier,
> across Phases 1–3. See Section 6 for the reconciliation.

### Phase 4 — Complete the Data Picture + Close Analytics Gaps ✅ DONE

Built and verified end to end — see the full feature inventory in Section 3 and
the integration/dogfood suite `tests/integration/phase4-pipeline.test.ts`. The
launch blind spots are now either closed (self-reporting, Cursor, richer expense +
reconciliation) or honestly surfaced as gaps, and the three orphaned analytics
items (anomaly detection, team comparison, adoption-journey visualization) are
built and tier-aware.

### Phase 5 — Developer Coaching ✅ DONE

Built and verified end to end — see the full feature inventory in Section 3 and the
integration/privacy/dogfood suite `tests/integration/phase5-pipeline.test.ts`. Three
coaching pillars (available-data, PR/review outcomes, opt-in prompt capture) plus the
exemplary-conversation showcase, delivered under a strict privacy floor: individual
coaching is private to the developer, managers see only floored team aggregates,
prompt capture is client-side-encrypted with no server-side plaintext or key, the
retrospective defaults to a local model, and the showcase is owner-initiated only.
The product is now something developers *want*, not just tolerate. The dedicated
privacy-verification pass (Task 5.12) is the gate, and it passes.

### Phase 6 — Production Hardening & Scale ▶ NEXT

**Theme:** ready to leave WMG and sell to external customers.

Scope:
- PostgreSQL support (beyond SQLite) with partitioning for scale
- SSO / SAML
- Full RBAC granularity
- Whatever operational hardening external deployment requires (backup, upgrade
  path, multi-node considerations)

Rationale: this is the "ready to sell" phase; do it once the feature set is
proven at WMG.

---

## 5. Captured Backlog (Unscheduled)

Recorded so they're not lost; not yet assigned to a phase:

- **Cross-company anonymized benchmarks** — needs an installed base first; the
  maturity-score benchmark is internal org-average until then
- **Mobile interface** — dedicated effort once desktop is proven
- **Further tool connectors** — as new AI dev tools emerge or customers request
- **Hosted SaaS option** — currently self-hosted only
- **Configurable summary tone/voice** — single default voice for now
- **Richer custom report builder** — beyond the four standard summary levels

---

## 6. Roadmap Reconciliation (Why Numbering Changed)

For clarity, since this caused confusion:

- The **first V1 Build Spec** (proxy era and early intelligence-platform era)
  planned: P3 = aggregation/summaries, P4 = expense import, P5 = trends/analytics,
  P6 = dogfood.
- During detailed planning, **expense import + subscription tracking moved into
  Phase 1** (Task 1.8) and **most trends/analytics moved into Phases 2–3**.
- **Tool connectors (Claude Code, Windsurf) and multi-provider git moved into
  Phase 1**, so the old "Phase 4 = Windsurf + self-reporting + analytics" became
  stale.
- Three analytics items were referenced but never actually built: **anomaly
  detection, dedicated team comparison view, developer adoption-journey
  visualization.** These are now explicitly folded into the new **Phase 4**.
- Dogfood at WMG is continuous (you build and dogfood together), not a discrete
  final phase.

Net effect: everything from the old P3 and P4 is DONE; from the old P5, three
items remain and are captured in the new Phase 4.

---

## 7. Superseded Documents

These earlier documents are now HISTORICAL. Use this roadmap as the source of
truth; consult the originals only for detailed built-feature reference:

- Product_Vision.md / .docx (proxy era) — superseded by Product_Vision_v2
- Technical_Specification.md / .docx (proxy era) — historical
- V1_Build_Specification.md/.docx + GovProxy variants (proxy era) — historical
- V1_Build_Specification_v2.md/.docx (intelligence platform) — phase numbering
  superseded by this document; task detail still valid for built Phase 1
- Additional_Tasks_Git_Providers.md — built; folded into Phase 1 record above
- Product_Vision_v2.md/.docx — still valid as the product vision; this roadmap is
  the authoritative phase plan
- Phase1_Task_Tracker.md, Phase2_*, Phase3_* — the build records for completed
  phases; accurate as historical implementation detail
- Data_Quality_Tiers_UX.md — still valid; describes built tier behavior

Active documents going forward:
- **THIS document** (roadmap / source of truth)
- Phase4_Design_Document.md + Phase4_Task_Tracker.md — the build record for the
  now-complete Phase 4 (historical implementation detail)
- Phase5_Design_Document.md + Phase5_Task_Tracker.md — the build record for the
  now-complete Phase 5 (historical implementation detail)
- Phase 6 design document + task tracker (to be created next)
- Product_Vision_v2 (product vision reference)

---

## 8. Change Log

- v1.2 (June 2026) — Phase 5 (Developer Coaching) marked DONE. Added the Phase 5
  feature inventory (Pillar 1 available-data coaching, Pillar 2 PR/review outcome
  coaching, Pillar 3 opt-in client-side-encrypted prompt capture with local-default
  retrospective + double opt-in + developer-chosen logged key recovery, the
  deliberate promote/redact/publish showcase, coaching settings, and the unified
  aggregate-only manager panel) and the integration + privacy-verification + dogfood
  pass (Task 5.12, `tests/integration/phase5-pipeline.test.ts`). Phase 6 (Production
  Hardening & Scale) is now NEXT.
- v1.1 (June 2026) — Phase 4 marked DONE. Added the Phase 4 feature inventory
  (self-reporting CLI + Slack, data-prompted surveys, richer expense import +
  reconciliation, Cursor connector, tier-aware anomaly detection + surfacing, team
  comparison rich + sortable-table, developer adoption-journey, settings
  extensions) and the integration/dogfood verification (Task 4.13). Phase 5
  (Developer Coaching) is now NEXT.
- v1.0 (May 2026) — initial consolidation. Phases 1–3 recorded as done; Phases
  4–6 defined; old numbering reconciled; superseded documents listed.

---

*End of Document — GovProxy Product Roadmap & Source of Truth*
