# Toprope — Product Roadmap & Source of Truth

**The canonical reference for what Toprope is, what's built, and what's next.**

Version 1.1 — May 2026 | Living document — update as phases complete

> This document supersedes the phase definitions and roadmaps in all earlier
> documents (see Section 7, Superseded Documents). When any other document
> conflicts with this one regarding scope, phase numbering, or what is built,
> THIS document is authoritative.

---

## 1. What Toprope Is

Toprope is an **AI adoption intelligence platform for engineering organizations**.

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

**Name:** Toprope (formerly GovProxy — renamed July 2026, ahead of public launch). Written lowercase ("toprope") in the wordmark, CLI, and package names. Domains: toprope.dev (primary/docs), toprope.ai (planned).

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
| Phase 6 | Improvement layer: knowledge sharing + showcase | ▶ NEXT |
| Phase 7 | Production hardening & scale | ⬜ PLANNED |
| Backlog | Benchmarks, mobile, future connectors, artifact repository | ⬜ UNSCHEDULED |

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
- `toprope status`, `toprope doctor` (validates all connectors + git providers)
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

**Data completeness**
- Self-reporting: CLI (`toprope log`) + Slack bot (interactive logging);
  data_source="self_report", medium tier; API-wins rule (never overrides measured)
- Data-prompted surveys: triggers (usage drop, unused new seat, plan change,
  anomaly, manual); manager-configurable auto vs manual per trigger; Slack/email
  delivery; responses surfaced as context next to the triggering data
- Expense reconciliation: match expenses vs subscription registry; flag
  expense-no-sub / sub-no-expense / cost-discrepancy; billing-model-aware;
  resolve/ignore workflow
- Richer expense import: multiple format profiles, dedup, multi-email matching,
  recurring vs one-time, billing-model inference
- Cursor connector: full parity (Analytics API, service-key auth, feature
  breakdown autocomplete/Composer/chat)

**Analytics gaps closed**
- Anomaly detection: both statistical (mean+std-dev) and percentage-change,
  configurable per metric; minimum-baseline guard (no early-weeks false positives);
  tier-aware (git metrics now, tool metrics when connected); severity bands
- Anomaly surfacing: dashboard panel + inline flags, Slack notifications, folded
  into AI summaries (tier-aware phrasing)
- Team comparison: rich side-by-side (≤4 teams) + sortable all-teams table
- Developer adoption-journey visualization: timeline with tool/plan transitions,
  trajectory overlay, key-moment annotations (developer-private + manager-aggregate)
- Settings extensions: survey, anomaly, alert-channel config (global + per-team)

### Phase 5 — Developer Coaching ✅

**Pillar 1 — Available-data coaching**
- Churn-based self-reflection, acceptance-rate trends (where tool data exists),
  adoption-journey coaching, personal insights (deferred from Phase 2); tier-aware,
  within-developer framing, private to developer

**Pillar 2 — PR/review outcome analysis**
- Signals from git-provider PR/review data: rework rate, review-rejection rate,
  review rounds, comment density vs own baseline, time-to-merge, review reciprocity
- Churn+review combined signal (struggling / healthy_iteration / effective /
  insufficient_data)
- Two clearly-separated views: all-PR (factual) and AI-assisted-PR (inferred,
  lower confidence); within-developer-over-time; private + manager-aggregate-only

**Pillar 3 — Opt-in prompt capture**
- Double opt-in; capture via local agent OR editor extension (dev picks)
- Client-side encryption; server holds only ciphertext, never the key/plaintext
- Developer-chosen recovery (no-recovery or recovery-path); recovery use logged
  and visible to the developer
- Real-time loop detection + prompt-quality nudges (local at capture layer,
  metadata only)
- Session retrospective: local-model default, cloud as conscious second opt-in;
  plaintext only transient, never persisted

**Showcase (Phase 5 version)**
- Owner-only promote → mandatory redact → publish; separate shared store from
  private captures; browse with access scoping; owner unpublish; lead-remove
  (never publish on a dev's behalf)
  (Note: Phase 6 extends this with joint curation, annotations, and best-practices.)

**Cross-cutting**
- Coaching settings (org policy + developer-level choices; org gates developer
  options); manager aggregate coaching signals with minimum-group-size guard
  (no individual coaching data ever reachable by managers)

---

## 4. Definitive Forward Roadmap

> This numbering is authoritative and supersedes all earlier phase definitions.
> Phases 4 and 5 are now DONE — their full feature inventories are in Section 3.
> The improvement layer (knowledge sharing + showcase) is the new Phase 6;
> production hardening moved to Phase 7. See Section 6 for the reconciliation.

### Phase 6 — Improvement Layer: Knowledge Sharing + Showcase ▶ NEXT

**Theme:** add an *improvement layer* on top of the measurement layer — the
existing product answers "how are we doing?"; this answers "how do we get
better?" — shifting Toprope from intelligence toward intelligence + enablement.

Built on a foundation of **shared primitives first** (contribution flow,
versioning, org/team inheritance, search), then two features on top:

- **Knowledge sharing / best practices** — a space to share best practices for
  working with AI tools, surfaced *contextually* next to the metric they relate to
  (a high-churn figure links to a practice on reviewing AI suggestions) rather than
  in a docs graveyard. Configurable contribution model: top-down (default),
  bottom-up (post + vote), or hybrid (post + lead endorsement), switchable per team.
  Practices attach to metrics via tag-based auto-surfacing with manual override.

- **Showcase — curated exemplar conversations** — standout conversations shared as
  teaching examples, org-internal only. Two publish paths: developer self-publish
  (from their Phase 5 retrospective) OR joint manager+developer curation — developer
  approval ALWAYS required either way. A showcase unit includes: the conversation,
  inline developer annotations anchored to specific turns (the highest-value layer),
  the outcome (PR/code), a mandatory curators' note, optional specific-or-silent AI
  annotation on prompt technique, and a link to any reusable artifact. Content
  scrubbing before publish: auto-flag (a NEW focused secret/PII/credential detector
  — the old proxy-era scanning was removed, so this is new work, not a reuse) PLUS
  mandatory manual review. "How it could be better" is deliberately EXCLUDED from
  the public showcase and offered instead as a private, self-directed tool — public
  stays celebratory, critique stays private.

Deliberately NOT in Phase 6: the internal artifact repository (Feature 2 of the
improvement-layer draft) — it's the strongest standalone candidate and is parked
in the backlog as a possible separate product.

Rationale: the improvement layer is feature work worth dogfooding at WMG while
iterating, and it builds naturally on the Phase 5 coaching/showcase foundation.
The shared-primitives-first sequencing keeps the two features coherent rather than
bolted-on.

### Phase 7 — Production Hardening & Scale ⬜

**Theme:** ready to leave WMG and sell to external customers.

Scope:
- PostgreSQL support (beyond SQLite) with partitioning for scale
- SSO / SAML
- Full RBAC granularity
- Whatever operational hardening external deployment requires (backup, upgrade
  path, multi-node considerations)

Rationale: this is the "ready to sell" phase; do it once the feature set is
proven at WMG. (Was Phase 6; renumbered when the improvement layer was inserted.)

---

## 5. Captured Backlog (Unscheduled)

Recorded so they're not lost; not yet assigned to a phase:

- **Internal artifact repository** (Feature 2 of the improvement-layer draft) —
  installable skills/scripts/MCPs/instructions with org-creates/team-modifies
  inheritance, versioning, and provenance/security review. The strongest STANDALONE
  candidate; parked as a possible separate product rather than folded into Toprope.
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
- Phase 4 design document + task tracker (to be created next)
- Product_Vision_v2 (product vision reference)

---

## 8. Change Log

- v1.0 (May 2026) — initial consolidation. Phases 1–3 recorded as done; Phases
  4–6 defined; old numbering reconciled; superseded documents listed.
- v1.1 (May 2026) — Phases 4 and 5 marked DONE with full feature inventories.
  Improvement layer (knowledge sharing + showcase) inserted as the new Phase 6;
  production hardening renumbered to Phase 7. Internal artifact repository added to
  backlog as a standalone candidate. Note: the Phase 5 showcase is extended by the
  Phase 6 improvement layer (joint curation, annotations, best-practices linkage).

---

*End of Document — Toprope Product Roadmap & Source of Truth*
