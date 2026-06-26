# Core concepts

This chapter explains how GovProxy is put together: the data flow, the unit of
storage, the data-quality tiers, and the privacy model. Understanding these makes
every other chapter easier.

## Architecture at a glance

Data flows in one direction — sources in, insights out. There is no traffic
interception anywhere.

```
Connectors (Copilot API, Claude Code API, Windsurf API, Cursor API, Git API) ┐
Expense CSVs                                                                  ├─► Daily snapshots
Developer self-reports (CLI / Slack)                                          ┘        │
                                                                                       ▼
                                                  Aggregates (weekly → monthly → quarterly → yearly)
                                                                                       │
                       ┌───────────────────────────────────────────────────────────────┤
                       ▼                         ▼                      ▼                ▼
                  Waste detection         AI summaries         Anomaly detection    Coaching signals
                       │                         │                      │                │
                       └─────────────────────► REST API ◄───────────────┘────────────────┘
                                                 │
                                    ┌────────────┴────────────┐
                                    ▼                         ▼
                            React dashboard               CLI / exports
```

**Tech stack:** Node.js + TypeScript, Fastify (web server), better-sqlite3
(storage), Commander.js (CLI), node-cron (scheduling), React + Tailwind
(dashboard). See [Installation](./installation.md) for versions.

## The daily snapshot — the atomic unit

Everything in GovProxy is built on the **daily snapshot**: one row per developer,
per day, per tool. There are two snapshot families:

- **`tool_snapshots`** — activity from a tool API or a self-report (interactions,
  acceptances, features used, models used, estimated cost). One row per
  developer/day/tool.
- **`git_snapshots`** — repository activity from git analysis (commits, lines
  added/removed, PRs opened/merged, review comments, code churn, AI-signature
  score). One row per developer/day.

Two rules govern snapshots:

1. **Append-only.** Historical snapshots are never modified. Re-running a sync is
   idempotent — it updates the current day's row, it does not duplicate history.
2. **API wins.** A measured API snapshot always takes precedence over a
   self-report for the same developer/day/tool. A later API sync replaces an
   earlier self-report placeholder, but the raw self-report is always kept on
   record. See [Self-reporting](./self-reporting.md).

## Aggregation hierarchy

Daily snapshots are rolled up into immutable, pre-computed aggregates:

```
daily snapshots
  → weekly_aggregates   (per developer, computed Mondays)
    → monthly_aggregates (per developer, computed 1st of month)
      → quarterly_aggregates (per team, at quarter boundary)
        → yearly_aggregates (per team)
```

Each aggregate carries totals, averages, and **period-over-period deltas** (the
first period of any series has null deltas — GovProxy never fabricates a fake
0%). Raw daily data is retained for drill-down (90 days by default); aggregates
are kept indefinitely. See [Aggregation & AI summaries](./aggregation-and-summaries.md).

## Data-quality tiers

The single most important concept in GovProxy. Because data comes from sources of
very different reliability, **every insight is labeled with a confidence tier**,
and the UI never implies more certainty than the data supports.

| Tier | Source | Meaning |
|---|---|---|
| **HIGH** | Tool API connector | Full automated metrics, measured directly |
| **MEDIUM** | Git analysis, or developer self-report | Strong signal, but inferred or voluntary |
| **LOW** | Expense data only | We know the cost, not the usage |
| **NONE** | No data source connected | Developer known to use AI, but nothing to measure |

The tiers drive real behavior, not just a badge:

- A **git-only** developer shows output and *estimated* AI signals, never
  fabricated interaction counts.
- **Waste claims** are framed as assertions for HIGH-tier data and as
  review-questions for MEDIUM-tier data.
- The **AI maturity score** and **anomaly detection** carry an explicit basis
  (e.g. `git_estimate`) and are labeled as estimates everywhere they appear.
- As you connect more sources, the same insights strengthen from "estimated" to
  "measured" without changing scale or meaning.

This honesty is deliberate: a manager can see exactly where the gaps are and
decide which connectors are worth setting up.

## The privacy model

Privacy is non-negotiable and consistent across the whole product:

- **Individual data is private to the developer.** A developer can only ever see
  their own data — their snapshots, their coaching, their captures.
- **Managers see team aggregates only.** Never an individual's churn rate,
  review-rejection rate, or coaching score. The moment an individual coaching
  signal becomes manager-visible it becomes a performance metric and gets gamed
  into meaninglessness.
- **k-anonymity floor.** Manager-facing coaching aggregates are floored to a
  minimum group size (≥3 contributors) so no individual is reconstructable.
- **Trajectory, not snapshot.** Individual signals are framed
  within-developer-over-time ("your rework rate rose from 15% to 30%"), never as
  a cross-developer ranking or a one-shot verdict.
- **Local by default.** Deeper analysis (AI summaries, session retrospectives)
  defaults to local models. Anything that sends data externally is a separate,
  conscious opt-in.
- **Encrypted prompt capture.** Opt-in prompt capture (Phase 5) is client-side
  encrypted with a developer-controlled key. The server is a blind store: it
  holds no plaintext and no key material.

The role model is simple: **admin** (manager) versus **developer**. Developers
are confined by the API gateway to `/api/me/*` and `/api/auth/*`; everything else
requires an admin session. See [Dashboard](./dashboard.md) for accounts and auth.

## Glossary

| Term | Meaning |
|---|---|
| **Connector** | A client that pulls data from a tool API (Copilot, Claude Code, Windsurf, Cursor) into snapshots |
| **Provider** | A git host GovProxy can analyze: GitHub, GitLab, or Bitbucket |
| **Snapshot** | One immutable daily record of activity for a developer |
| **Aggregate** | A pre-computed weekly/monthly/quarterly/yearly rollup of snapshots |
| **AI signature score** | A 0–100 heuristic estimate of AI assistance in commits; conservative and always labeled "estimated" |
| **Code churn** | Share of lines rewritten within a short window (48h default); high churn can indicate accepting AI output without review |
| **Maturity score** | A tier-aware 0–100 composite of a team's AI adoption health |
| **Waste alert** | A detected instance of wasted spend (unused/underutilized seat, duplicate tool, cost outlier, plan-ROI) |
| **Self-report** | A developer's voluntary log of AI usage (MEDIUM tier), used to fill gaps |
| **Coaching pillar** | One of the three Phase-5 coaching layers (available-data, PR/review, opt-in prompt capture) |
| **Showcase** | A curated, deliberately-shared collection of exemplary AI conversations |
