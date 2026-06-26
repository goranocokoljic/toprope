# GovProxy — Revised Product Vision

**AI Adoption Intelligence Platform for Engineering Organizations**

> Understand how your teams adopt AI tools, detect waste, track improvement over time, and coach developers toward effective AI-assisted development — across every tool, billing model, and workflow.

Version 2.0 — May 2026 | Confidential

---

## 1. Executive Summary

GovProxy is an AI adoption intelligence platform that gives engineering leadership a unified, cross-tool view of how their organization uses AI-assisted development tools — regardless of which tools are in use, how they're billed, or who manages the accounts.

Unlike vendor-specific dashboards (Copilot Metrics, Cursor Analytics, Claude Code Analytics) that show usage for their own tool only, GovProxy aggregates data from every source available — tool APIs, git repositories, expense data, and developer self-reports — normalizes it into a unified model, and surfaces the insights that no single vendor provides:

- Which tools are actually being used, and by whom?
- Are we getting value from our AI tool investment, or wasting money on idle seats?
- How is adoption improving over time? Where is it stalling?
- Which teams are thriving with AI? Which need help?
- What does the quarterly AI adoption report look like for executive leadership?

**Core thesis:** Every engineering organization is now spending significant money on AI tools. Nobody can answer the question "is it working?" because the data is fragmented across vendor dashboards, personal accounts, expense reports, and gut feelings. GovProxy is the single pane of glass that answers that question.

---

## 2. Why This Product Exists

### 2.1 The Real-World Mess

The clean enterprise scenario — one tool, centrally managed, admin API connected — is the minority. The reality at most companies in 2026:

- Team A has 5 Copilot Business seats managed through the GitHub org
- Team B uses Cursor — some on company-managed Enterprise, some on personal Pro subscriptions that get reimbursed
- Three senior developers use Claude Code Max on personal accounts, expensed monthly
- One team lead bought 4 Windsurf seats on a team credit card without IT involvement
- Two contractors use their own tools and bill hours with no AI visibility
- Half the developers also use ChatGPT or Claude.ai web for coding questions, with no telemetry at all

The engineering manager is asked by the VP: "We're spending $15K/month on AI tools. What are we getting for it?"

The honest answer today: "I don't know."

### 2.2 Why Vendor Dashboards Don't Solve This

Every major AI tool vendor now has usage analytics:

- **GitHub Copilot** — per-user daily metrics, acceptance rates, team attribution (GA since Feb 2026)
- **Cursor** — admin dashboard with model/feature/team breakdowns, Analytics API on Enterprise
- **Claude Code** — Enterprise Analytics API with per-user metrics, sessions, commits, PRs, cost
- **Windsurf** — Enterprise API with service key auth, analytics endpoints, usage dashboards

These are useful individually. But they each show only their own tool. No vendor will tell you "your developer would be more productive on a competitor's tool" or "this developer has seats on three tools and barely uses any of them." The cross-tool unified view is the gap GovProxy fills.

### 2.3 Target Buyer

**Primary:** Engineering Manager / Head of Engineering / VP Engineering at companies with 20–500 engineers using AI-assisted development tools.

**Secondary:** Finance/procurement teams responsible for software license optimization. IT/Security teams responsible for AI tool governance.

**The buyer's pain:**
- "How do I prove to the board that our AI investment is paying off?"
- "I have 40 Copilot seats and I think 10 are unused but I can't prove it."
- "Different teams use different tools and I have no way to compare."
- "Developers say AI helps but I have no data to support the claim."
- "We need a quarterly AI adoption report and it takes me a week to compile it manually."

---

## 3. Product Pillars

### Pillar 1: Multi-Source Data Collection

GovProxy doesn't depend on a single data collection method. It works with whatever data sources are available and clearly communicates the confidence level of its insights.

**Tier 1: Tool API Connectors (highest data quality)**

Direct integration with vendor admin APIs. Automated, daily data pull. Full usage metrics.

| Tool | Data Available | Requirements |
|---|---|---|
| GitHub Copilot | Per-user daily: suggestions, acceptances, active days, chat usage, code review, by language/IDE/model. Seat assignments, unused seats. Team attribution. | GitHub org admin + API token with copilot metrics scope |
| Cursor | Per-user: completions, chat, agent edits, model usage, acceptance rates. Team breakdowns. | Cursor Enterprise + service key |
| Claude Code | Per-user: sessions, commits, PRs, lines added/removed, tool acceptance rates, cost. | Anthropic Enterprise + Admin API key |
| Windsurf | Per-user: AI-generated code percentage, feature usage, team analytics. | Windsurf Enterprise + service key |

**Tier 2: Git Repository Analysis (universal, tool-agnostic)**

Works for every developer regardless of which AI tool they use or how it's managed. Analyzes git commit history to detect AI adoption signals:

- Commit velocity changes over time (before/after AI tool introduction)
- Code pattern signatures associated with AI-generated code (formatting consistency, verbose naming, comprehensive error handling)
- Commit cadence patterns (bursts of large commits followed by refinement)
- PR quality indicators (test coverage, lint compliance, documentation)
- Code churn rate (code written then rewritten within a short window — indicates ineffective AI usage or hallucination acceptance)
- Cross-referencing commit timestamps with known AI tool activity windows

Git analysis doesn't tell you which tool was used, but it answers the adoption question: "Is this developer's output pattern consistent with effective AI-assisted development?"

Requirements: Read access to GitHub/GitLab/Bitbucket org repos via API.

**Tier 3: Expense & Subscription Tracking (cost visibility)**

For tools where no admin API exists (personal accounts, reimbursed subscriptions):

- Import subscription cost data from expense management systems (Expensify, SAP Concur, etc.) or manual CSV upload
- Track which developers have which subscriptions and what they cost
- Detect duplicate subscriptions (developer has both Copilot and Cursor)
- When combined with Tier 1 or Tier 2 data: compute cost-per-outcome metrics

**Tier 4: Developer Self-Reporting (gap filler)**

For scenarios with no admin API and no expense data:

- Lightweight CLI command or Slack bot: developer logs AI tool usage in 10 seconds
- Periodic data-prompted surveys: "We see your Copilot usage dropped 40% — did you switch tools?"
- Optional, voluntary, privacy-respecting
- Used to fill gaps, not as a primary data source

**Graceful Degradation:**

The platform works with whatever is available. Each data source adds confidence. The dashboard clearly indicates data quality per team/developer:

- **HIGH** — Tool API connector active, full automated metrics
- **MEDIUM** — Git analysis + expense data, or self-reported usage
- **LOW** — Expense data only, no usage metrics
- **NO DATA** — Developer known to use AI tools but no data source connected

This transparency is critical. The manager sees exactly where the gaps are and can prioritize which connectors to set up.

### Pillar 2: Unified Intelligence Dashboard

The single pane of glass that no vendor provides.

**Organization Overview**
- Total AI tool spend across all tools and billing models
- Active seats vs. assigned seats vs. unused seats (cross-tool)
- Organization-wide AI maturity score trending over time
- Tool distribution: which tools are used, by how many developers, at what cost

**Team View**
- Per-team adoption metrics: utilization rate, active users, tool mix
- Team comparison: which teams are thriving, which are struggling
- Spend per team with cost-per-outcome metrics (cost per PR, cost per commit)
- Adoption trend lines per team over weeks/months

**Developer View (privacy-bounded)**
- Individual adoption journey: when they started, how usage evolved
- Tool utilization: are they using what they're paying for?
- Growth indicators: improving acceptance rates, decreasing churn, increasing velocity
- Visible to the developer themselves + aggregate-only for managers

**Waste Detection**
- Unused seats: assigned but zero activity for 14+ days
- Underutilized seats: activity far below team average
- Duplicate coverage: developer has overlapping tools
- Cost-per-outcome outliers: developers with high cost but low output correlation
- Projected annual savings from seat reallocation

**Tool Effectiveness Comparison**
- Side-by-side comparison: teams on different tools with similar workloads
- Model usage analysis: are developers using premium models that justify the cost?
- Feature adoption: autocomplete only vs. agent mode vs. chat — are teams using the full capability?

### Pillar 3: Longitudinal Tracking & AI-Generated Reports

The platform's core differentiator: not just "where are we today" but "where were we, and where are we heading."

**Time-Series Data Architecture**
- Daily snapshots as the atomic unit: one row per developer per day per tool
- Pre-computed aggregates: weekly (computed Mondays), monthly (1st of month), quarterly, yearly
- Raw daily data retained for 90-day drill-down; aggregates retained indefinitely
- Append-only design: historical records never modified
- GDPR-friendly: daily individual data can be aged out while anonymous aggregates persist

**AI-Generated Summaries**

Automated narrative reports generated from aggregate data — no prompt content, no code, no sensitive information sent to the model.

- **Weekly summary** (for team managers): Who was active, who wasn't. Usage changes. Waste alerts. Coaching opportunities. ~2 paragraphs.
- **Monthly summary** (for department heads): Team comparisons. Adoption trends. Cost efficiency. Training impact. Seat optimization recommendations. ~1 page.
- **Quarterly report** (for VP/C-level): Executive summary. Investment vs. return analysis. Maturity score progression. Strategic recommendations. Cross-team benchmarks. ~2-3 pages.
- **Yearly report** (for board/annual review): Full year narrative. AI adoption journey. ROI analysis. Future investment recommendations.

Model choice configurable per deployment: local model (Ollama) for privacy, Haiku/Flash for cost-efficient summaries, Sonnet for executive-quality reports.

Reports are generated automatically on schedule, stored, and available for manager review. Managers can regenerate with adjusted focus or additional context.

### Pillar 4: Developer Coaching (Phase 2)

Building on the adoption intelligence foundation, the coaching layer helps developers improve their AI tool usage.

**From Tool API Data:**
- Suggestion acceptance rate trends (are they learning to evaluate AI output?)
- Feature adoption progression (moving from autocomplete to agent mode)
- Model usage patterns (using the right model for the right task)

**From Git Analysis:**
- Code churn rate (accepting AI suggestions without understanding them)
- PR review feedback patterns (AI-generated code getting more or fewer review comments)
- Test coverage correlation with AI-assisted commits

**From Proxy (Optional Module):**
- For teams with API-billed usage: transparent HTTP proxy captures prompt/response data
- Loop detection: repeated similar prompts indicating developer is stuck
- Prompt structure nudges: gentle hints about missing context
- This is the original proxy concept — now an optional add-on, not the core product

**Session Retrospective (Future):**
- AI-powered coding coach that reviews a developer's session
- Private to the developer — full prompt/response context, encrypted, never visible to managers
- Personalized improvement suggestions based on individual patterns

**Privacy Boundaries (Non-Negotiable):**
- Prompt content never visible to managers — only structural quality scores and aggregate metrics
- Individual coaching data visible only to the developer themselves
- Managers see team-level aggregates: adoption rates, improvement trends, common patterns
- Frame as "coaching" not "monitoring" — the developer must feel the tool is on their side

---

## 4. Data Architecture

### 4.1 Unified Schema

Regardless of source, all data normalizes into a common model:

```
Daily Developer Snapshot:
  - developer_id
  - date
  - team
  - data_source (copilot_api | cursor_api | claude_api | windsurf_api | git | self_report | expense)
  - data_quality (high | medium | low)
  - tool_name
  - billing_model (subscription | api | reimbursed | unknown)
  - subscription_cost_monthly (if known)
  - is_active (boolean — any AI activity this day)
  - interaction_count (suggestions, completions, chats, etc.)
  - acceptance_rate (if available)
  - features_used (autocomplete, chat, agent, code_review, etc.)
  - model_used (if available)
  - tokens_consumed (if API-billed)
  - estimated_cost (if calculable)
  
Daily Git Snapshot (separate, tool-agnostic):
  - developer_id
  - date
  - commits
  - lines_added
  - lines_removed
  - prs_opened
  - prs_merged
  - review_comments_given
  - time_to_merge_avg
  - code_churn_rate
  - ai_signature_score (0-100, likelihood of AI assistance based on patterns)
```

### 4.2 Aggregation Hierarchy

```
daily_snapshots (raw, per developer, per day, per tool)
  → weekly_aggregates (computed Monday 2am)
    → monthly_aggregates (computed 1st of month)
      → quarterly_aggregates (computed at quarter boundary)
        → yearly_aggregates (computed January 1st)

weekly_summaries (AI-generated narrative)
monthly_summaries (AI-generated narrative)
quarterly_reports (AI-generated narrative)
yearly_reports (AI-generated narrative)
```

Each aggregate stores: averages, totals, min/max, percentiles, and deltas from previous period. Aggregates are immutable once computed. Raw daily data retained for 90-day drill-down; aggregates retained indefinitely.

### 4.3 Storage

- **Development / Small teams:** SQLite — zero config, embedded, handles <1M rows per year easily
- **Production / Enterprise:** PostgreSQL — concurrent access, partitioning by date range, production audit requirements
- **Future consideration:** Time-series optimized storage (TimescaleDB extension for PostgreSQL) if data volume demands it

---

## 5. Competitive Landscape

### 5.1 What Exists

| Category | Players | What They Do | What They Miss |
|---|---|---|---|
| Vendor Dashboards | Copilot Metrics, Cursor Analytics, Claude Analytics, Windsurf Analytics | Usage metrics for their own tool | Cross-tool view, waste detection, coaching, trend reporting |
| Developer Analytics | DX, Jellyfish, LinearB, Pluralsight Flow | Engineering productivity metrics, some AI tool connectors | AI-adoption-specific intelligence, coaching, multi-tool waste detection |
| Cost Management | CloudZero, Finout | Cloud + AI cost tracking | Not focused on adoption intelligence, no coaching, no git analysis |
| Open Source | copilot-metrics-viewer, cursor-usage-tracker | Visualize single-vendor metrics | Single tool only, no unified view |

### 5.2 The Gap

No existing tool answers the question: "Across all our AI tools, billing models, and teams — are we getting value from our AI investment, and how do we improve?"

DX and Jellyfish are the closest competitors. They offer connectors for some AI tools and correlate with engineering metrics. But they're broad engineering productivity platforms, not AI-adoption-focused. Their AI tool coverage is a feature, not the product. GovProxy makes AI adoption intelligence the entire product, going deeper on waste detection, multi-source data collection, longitudinal tracking, AI-generated reports, and developer coaching.

### 5.3 Positioning

> "GovProxy is the AI adoption intelligence platform for engineering teams. Connect your tools, connect your repos, and finally answer the question your VP keeps asking: is our AI investment working?"

---

## 6. Platform Agnostic by Design

GovProxy works with every major AI development tool and every billing model:

**Tool Coverage (via API connectors):**
- GitHub Copilot (Business, Enterprise)
- Cursor (Teams, Enterprise)
- Claude Code (Teams, Enterprise API)
- Windsurf (Teams, Enterprise)
- Extensible connector architecture for future tools (Codex, Augment, Kiro, etc.)

**Billing Model Coverage:**
- Centrally managed subscriptions (admin API access) — full automated metrics
- Reimbursed personal subscriptions (expense data) — cost tracking + git correlation
- API-billed usage (optional proxy module) — detailed token/cost tracking
- Mixed environments — graceful degradation with clear data quality indicators

**Git Provider Coverage:**
- GitHub (Cloud and Enterprise)
- GitLab (Cloud and Self-Managed)
- Bitbucket (Cloud and Server)

**Deployment:**
- Self-hosted (Docker) — data never leaves your infrastructure
- Future: hosted SaaS option

---

## 7. Business Model

### 7.1 Open Core Strategy

| Tier | Price | Includes |
|---|---|---|
| Community (OSS) | Free | 1 tool connector + git analysis, up to 25 developers, SQLite, basic dashboard, weekly aggregates, CLI |
| Team | $399/mo | All connectors, unlimited developers, PostgreSQL, full dashboard with trends, waste detection, AI-generated weekly/monthly summaries, expense import, self-reporting, Slack alerts |
| Enterprise | Custom | All Team + quarterly/yearly AI reports, SSO/SAML, RBAC, coaching module, custom connectors, cross-org benchmarks, dedicated support, SLA |

### 7.2 Revenue Projections

- Year 1: 20 Team-tier customers = ~$96K ARR
- Year 2: 50 Team + 5 Enterprise = ~$350K+ ARR
- The product pays for itself by identifying 1-2 unused seats per month — at $20-40/seat, that's $240-480/year per seat reclaimed

---

## 8. Development Phases (High Level)

| Phase | Focus | Outcome |
|---|---|---|
| Phase 1 | Git analysis + 1 tool connector (Copilot) + basic dashboard | Manager sees cross-source adoption data for the first time |
| Phase 2 | Additional connectors (Cursor, Claude Code) + waste detection + expense import | Full multi-tool unified view with cost optimization |
| Phase 3 | Longitudinal tracking + AI-generated summaries + aggregation engine | Automated weekly/monthly/quarterly reports |
| Phase 4 | Windsurf connector + self-reporting + advanced analytics | Complete data source coverage |
| Phase 5 | Developer coaching module (optional proxy, loop detection, nudges) | Developers get private feedback on AI usage effectiveness |
| Phase 6 | Dogfood at WMG | Validate everything with real teams |

---

## 9. Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Vendor APIs change or get restricted | High | Connector architecture isolates changes. Community maintains connectors. Multiple data sources reduce dependency on any single API. |
| DX/Jellyfish adds deeper AI adoption features | High | Move fast. GovProxy goes deeper on AI-specific intelligence than broad engineering platforms can. |
| Companies resist tracking individual developer metrics | Medium | Strict privacy boundaries. Individual data visible only to the developer. Managers see aggregates only. Frame as organizational intelligence, not surveillance. |
| Git-based AI detection has false positives | Medium | Use as correlation signal, not definitive classification. Combine with tool API data when available. Be transparent about confidence levels. |
| Tool API access requires Enterprise plans that cost more | Medium | Git analysis works without any tool API. Platform provides value even with zero connectors. Enterprise plans are the target buyer's reality anyway. |
| Naming — GovProxy is a working name | Low | Finalize before public launch. No brand investment in the working name. |

---

## 10. PureContext Synergy

GovProxy and PureContext serve different but complementary roles:

- **GovProxy** measures and improves how organizations adopt AI tools
- **PureContext** optimizes the context that goes into AI prompts

Data from GovProxy (which teams have high code churn, which developers loop frequently) could inform PureContext's optimization strategies. PureContext's token savings could appear as a measurable improvement in GovProxy's cost-per-outcome metrics.

Together: measure your AI adoption, coach your developers, and optimize every token.

---

## 11. Why This Will Work

The strongest signal is that this product solves a problem you personally have. You manage 18-22 engineers across 6 teams at WMG. You use multiple AI tools. You get asked by management to prove AI adoption value. You currently do it through interviews, which you know are unreliable.

You are the buyer. You are building for yourself first.

If it works for you — if you can open a dashboard on Monday morning and know exactly how your teams are adopting AI, where money is being wasted, and who needs coaching — then it works for every engineering manager in the same position. And in 2026, that's nearly all of them.

---

*End of Document — GovProxy Product Vision v2.0*
