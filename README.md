<div align="center">

# Toprope

### Finally answer the question your VP keeps asking: *is our AI investment actually working?*

**The AI adoption intelligence platform for engineering teams.**
Connect your tools, connect your repos, and get one honest, unified view of how
your organization adopts AI — across every tool, every billing model, every team.

[Quick start](#-quick-start) · [Why Toprope](#-why-toprope) · [Features](#-what-you-get) · [Documentation](./documentation/README.md)

</div>

---

## The problem

Every engineering org is now spending real money on AI dev tools. Almost none can
say what they're getting for it. The data is scattered across Copilot's dashboard,
Cursor's analytics, Claude Code's console, Windsurf's reports, a pile of expense
receipts for reimbursed personal accounts, and a lot of gut feeling.

So when the VP asks *"we're spending $15K/month on AI — what's the return?"*, the
honest answer is usually **"I don't know."**

Vendor dashboards don't fix this. Each one only shows its own tool. None of them
will tell you that one developer holds seats on three tools and barely uses any of
them, or that a team on Cursor is pulling ahead of a team on Copilot.

## 💡 Why Toprope

Toprope is the single pane of glass that sits beside your tools and reads from
all of them. It pulls from **tool APIs, git repositories, expense data, and
developer self-reports**, normalizes everything into one model, and surfaces the
insights no single vendor can:

- ✅ **Which tools are actually used — and by whom.** Cross-tool, not per-vendor.
- 💸 **Where the money leaks.** Unused seats, duplicate tools, cost outliers,
  unjustified upgrades — with a projected-savings number attached.
- 📈 **Whether adoption is improving.** Weekly → yearly trends, deltas, and a
  tier-aware maturity score.
- 🧭 **Which teams thrive and which need help.** Side-by-side team comparison.
- 📝 **The executive report, written for you.** Automated weekly/monthly/quarterly
  narratives from a local-by-default AI model.
- 🌱 **Developers who get *better*.** A private coaching mirror — not a scorecard.

> *It pays for itself by reclaiming one or two idle seats a month.*

### Built on three promises

- **Honest about what it knows.** Every insight is tagged HIGH / MEDIUM / LOW /
  NONE confidence. Toprope never invents usage it can't measure — a git-only team
  still gets real value, clearly labeled as estimated.
- **Private by design.** Individual data is visible only to that developer.
  Managers see team aggregates, never individual scorecards. Coaching, never
  surveillance.
- **Yours to host.** Self-hosted, your data never leaves your infrastructure, and
  the AI report model defaults to local (Ollama) so nothing has to leave the
  network.

## 🎯 Who it's for

Engineering Managers, Heads of Engineering, and VPs at companies with 20–500
engineers using AI dev tools — plus the finance and IT/security teams who care
about license optimization and tool governance.

## 📦 What you get

| | |
|---|---|
| **Multi-tool connectors** | GitHub Copilot · Claude Code · Windsurf · Cursor — automated daily metrics |
| **Multi-provider git analysis** | GitHub · GitLab · Bitbucket — adoption signals from commit & PR history, no cloning |
| **Waste detection** | Unused / underutilized seats, duplicate tools, cost outliers, plan-ROI review, with a resolution workflow |
| **Expense intelligence** | CSV import (Expensify/Concur/custom profiles), reconciliation, duplicate detection |
| **Unified dashboard** | Org overview, team detail, private developer views, waste screen — a React SPA |
| **Trends & reports** | Weekly/monthly/quarterly/yearly aggregates, maturity score, AI-written narrative summaries |
| **Proactive signals** | Tier-aware anomaly detection + data-prompted surveys, delivered via Slack |
| **Developer coaching** | Churn reflection, PR/review-outcome coaching, opt-in encrypted prompt capture, and a curated showcase of exemplary AI conversations |

See the [full feature guide](./documentation/introduction.md) for the complete
picture.

## 🚀 Quick start

> Prerequisites: **Node.js 22+** and a C/C++ build toolchain (for `better-sqlite3`
> and `argon2`). Full details in the [installation guide](./documentation/installation.md).

```bash
# 1. Install & build
npm install
npm run build

# 2. Initialize the database
npx toprope db migrate

# 3. Register a team, a developer, and your dashboard login
npx toprope team add --name frontend --department engineering --manager you
npx toprope dev add  --name "Ada Lovelace" --team frontend --email ada@acme.com --github adalovelace
npx toprope user create-admin --email you@acme.com     # prints a temp password

# 4. Add credentials (see the configuration guide), then validate
npx toprope doctor

# 5. Pull data from everything that's connected
npx toprope sync all

# 6. See it
npx toprope status        # unified CLI summary
npm run dev                # then open http://localhost:8080/dashboard
```

Want trends immediately, without waiting weeks?

```bash
npx toprope aggregate backfill     # builds 12 months of trends from your snapshots
```

The [first-hour walkthrough](./documentation/getting-started.md) covers every step
in detail, including connecting tools and importing expenses.

### Configuration in 30 seconds

Toprope reads one file, `toprope.config.yaml`. Put non-secret IDs (your org
names) in the YAML and secrets in environment variables via `${VAR}` placeholders:

```yaml
connectors:
  copilot:
    enabled: true
    github_org: "your-org"
    api_token: "${GITHUB_API_TOKEN}"
  git:
    enabled: true
    provider: "github"        # github | gitlab | bitbucket
    org: "your-org"
    api_token: "${GIT_API_TOKEN}"
```

Two ready-made variants ship for common setups:
`toprope.github-only.config.yaml` and `toprope.bitbucket.config.yaml`. The
[configuration reference](./documentation/configuration.md) documents every
option.

## 📚 Documentation

The complete user manual lives in [**`documentation/`**](./documentation/README.md):

| Getting started | Connecting data | Insights | Coaching & reference |
|---|---|---|---|
| [Introduction](./documentation/introduction.md) | [Connectors](./documentation/connectors.md) | [Dashboard](./documentation/dashboard.md) | [Coaching](./documentation/coaching.md) |
| [Core concepts](./documentation/concepts.md) | [Expenses & waste](./documentation/expenses-and-waste.md) | [Aggregation & AI summaries](./documentation/aggregation-and-summaries.md) | [CLI reference](./documentation/cli-reference.md) |
| [Installation](./documentation/installation.md) | [Self-reporting](./documentation/self-reporting.md) | [Anomalies, surveys & Slack](./documentation/anomalies-surveys-slack.md) | [REST API reference](./documentation/api-reference.md) |
| [Configuration](./documentation/configuration.md) | | | [Operations & troubleshooting](./documentation/operations-and-troubleshooting.md) |
| [Getting started](./documentation/getting-started.md) | | | |

## 🛠 How it works

```
 Copilot / Claude Code / Windsurf / Cursor APIs ┐
 Git providers (GitHub / GitLab / Bitbucket)    ├─► Daily snapshots ─► Aggregates ─► API ─► Dashboard
 Expense CSVs                                    │        │                            └─► AI summaries
 Developer self-reports (CLI / Slack)            ┘        └─► Waste · Anomalies · Coaching
```

One-directional by design: sources in, insights out. No proxy, no traffic
interception. Daily snapshots are the immutable atomic unit; everything else is
computed from them. Read the [architecture overview](./documentation/concepts.md).

**Stack:** Node.js · TypeScript · Fastify · better-sqlite3 · Commander.js ·
node-cron · React · Tailwind.

## 🧰 Common commands

```bash
npx toprope doctor            # validate config, DB, and connector credentials
npx toprope status            # unified summary across all sources
npx toprope sync all          # pull from every connected source
npx toprope waste show        # find wasted spend, grouped by type
npx toprope expenses import <file.csv>   # import subscription costs
npx toprope summary generate --level monthly --period 2026-05 --scope org
```

Full list in the [CLI reference](./documentation/cli-reference.md).

## 🗺 Status

Toprope is built and verified through five phases — data pipeline, dashboard,
aggregation + AI summaries, complete data picture + analytics, and developer
coaching. Next up is **production hardening & scale** (PostgreSQL, SSO/SAML, full
RBAC). The [roadmap](./dev-docs/GovProxy_Roadmap_Source_of_Truth.md) is the source
of truth for what's built and what's next.

---

<div align="center">

**Measure your AI adoption. Cut the waste. Coach your developers.**

[Read the docs →](./documentation/README.md)

</div>
