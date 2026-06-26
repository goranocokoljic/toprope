# GovProxy Documentation

**The complete user manual for GovProxy — the AI adoption intelligence platform for engineering teams.**

This manual covers everything from installing GovProxy to connecting your tools,
reading the dashboard, optimizing spend, and giving your developers a private
coaching companion. If you are looking for a high-level overview or a five-minute
quick start, see the [project README](../README.md) in the repository root.

---

## How this manual is organized

Read top to bottom the first time you deploy GovProxy; afterwards use it as a
reference. Each chapter is self-contained.

### Getting started
1. [Introduction](./introduction.md) — what GovProxy is, who it's for, and the problem it solves
2. [Core concepts](./concepts.md) — architecture, the data model, data-quality tiers, and the privacy model
3. [Installation](./installation.md) — prerequisites, install, build, and Docker
4. [Configuration](./configuration.md) — the complete `govproxy.config.yaml` reference
5. [Getting started — your first hour](./getting-started.md) — a guided first-run walkthrough

### Connecting your data
6. [Connectors](./connectors.md) — Copilot, Claude Code, Windsurf, Cursor, and multi-provider git
7. [Expenses & waste detection](./expenses-and-waste.md) — importing cost data, reconciliation, and finding wasted spend
8. [Self-reporting](./self-reporting.md) — the CLI `log` command and the Slack bot

### Insights & reporting
9. [Dashboard](./dashboard.md) — manager and developer views, accounts, and settings
10. [Aggregation & AI summaries](./aggregation-and-summaries.md) — trends, the maturity score, and narrative reports
11. [Anomalies, surveys & Slack](./anomalies-surveys-slack.md) — anomaly detection, data-prompted surveys, and alerting

### Developer coaching (Phase 5)
12. [Coaching](./coaching.md) — the three coaching pillars, prompt capture, and the exemplary-conversation showcase

### Reference
13. [CLI reference](./cli-reference.md) — every `govproxy` command
14. [REST API reference](./api-reference.md) — every endpoint
15. [Operations & troubleshooting](./operations-and-troubleshooting.md) — running in production, the scheduler, `doctor`, and common gotchas

---

## A 60-second mental model

GovProxy collects data from four kinds of source, normalizes it into a unified
daily snapshot model, rolls those snapshots up into trends, and serves the result
through a REST API, a dashboard, and a CLI.

```
 Copilot / Claude Code / Windsurf / Cursor APIs ┐
 Git providers (GitHub / GitLab / Bitbucket)    ├─► Daily snapshots ─► Aggregates ─► API ─► Dashboard
 Expense CSVs                                    │        │                            └─► AI summaries
 Developer self-reports (CLI / Slack)            ┘        └─► Waste detection · Anomalies · Coaching
```

Every insight is **tier-aware**: GovProxy is always honest about how much it
actually knows (HIGH / MEDIUM / LOW / NONE), and it never invents usage it can't
measure. Individual data is private to the developer; managers only ever see team
aggregates.

---

## Conventions used in this manual

- Commands are shown for **PowerShell on Windows** (the primary development
  environment), but work the same on macOS/Linux shells unless noted.
- `npx govproxy <cmd>` runs the compiled CLI (requires `npm run build` first).
  You can also run from source without building via `npx tsx src/cli.ts <cmd>`.
- Anything in `${UPPER_SNAKE_CASE}` inside config is substituted from an
  environment variable at load time.
- Placeholders like `<dev-id>` should be replaced with a real value.
