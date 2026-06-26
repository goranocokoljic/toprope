# Introduction

## What GovProxy is

GovProxy is an **AI adoption intelligence platform for engineering
organizations**. It gives engineering leadership a unified, cross-tool view of
how their teams adopt AI-assisted development tools — regardless of which tools
are used, how they're billed, or who manages the accounts.

It aggregates data from tool APIs, git repositories, expense systems, and
developer self-reports; normalizes everything into a single model; and surfaces
the insights no individual vendor dashboard can:

- Which tools are actually being used, and by whom?
- Are we getting value from our AI investment, or paying for idle seats?
- How is adoption trending over time, and where is it stalling?
- Which teams are thriving with AI, and which need help?
- What does the quarterly AI-adoption report for executives look like?

GovProxy is **not** a proxy or gateway (an early concept since abandoned), not a
DLP/secret-scanning tool, and not a request router. It is an intelligence and
reporting layer that sits beside your existing tools and reads from them.

## Who it's for

**Primary buyer:** Engineering Manager / Head of Engineering / VP Engineering at
companies with 20–500 engineers using AI dev tools.

**Secondary:** Finance/procurement teams optimizing software licenses, and
IT/Security teams responsible for AI-tool governance.

The recurring pain it answers:

> "We're spending real money on AI tools. What are we getting for it?"

Today that answer is usually "I don't know," because the data is fragmented
across vendor dashboards, personal accounts, expense reports, and gut feelings.
GovProxy is the single pane of glass that answers it.

## Why vendor dashboards aren't enough

Every major AI tool now ships usage analytics — GitHub Copilot, Cursor, Claude
Code, Windsurf. They're useful individually, but each one only shows its own
tool. No vendor will tell you "this developer has seats on three tools and barely
uses any of them," or compare a team on Copilot against a team on Cursor. The
cross-tool unified view is the gap GovProxy fills.

## What GovProxy does, end to end

GovProxy has been built across five completed phases. Everything below is shipped
and working:

| Capability | What you get |
|---|---|
| **Multi-source collection** | Connectors for Copilot, Claude Code, Windsurf, and Cursor; multi-provider git analysis (GitHub, GitLab, Bitbucket); expense CSV import; developer self-reporting |
| **Unified dashboard** | Organization overview, team detail, private developer views, and a waste-detection screen — all served as a React SPA |
| **Waste detection** | Unused seats, underutilized seats, duplicate tool coverage, cost outliers, and plan-change ROI review, with a resolution workflow |
| **Longitudinal tracking** | Weekly / monthly / quarterly / yearly aggregates, period-over-period deltas, and a tier-aware AI maturity score |
| **AI-generated reports** | Automated narrative summaries at four levels, from a configurable (local-by-default) model that only ever sees aggregate numbers |
| **Anomaly detection** | Tier-aware statistical and percentage-change anomaly detection with dashboard and Slack surfacing |
| **Data-prompted surveys** | Triggered questions ("usage dropped 40% — did you switch tools?") delivered via Slack with email fallback |
| **Developer coaching** | A private mirror for developers: churn reflection, PR/review-outcome coaching, opt-in encrypted prompt capture, and a curated showcase of exemplary conversations |

See [Core concepts](./concepts.md) for the architecture and the data model, or
jump to [Getting started](./getting-started.md) to deploy.

## Core principles

These principles hold through every feature and are worth internalizing before
you deploy:

- **Multi-source with graceful degradation.** GovProxy works with whatever data
  is available and is always honest about confidence.
- **Privacy first.** Individual data is visible only to that developer; managers
  see team aggregates only. Coaching, never surveillance.
- **Tier-aware honesty.** Nothing implies data GovProxy doesn't have. Insights
  strengthen automatically as more sources connect.
- **Self-hosted.** Data stays in your infrastructure. The default AI-summary
  model is local (Ollama), so nothing leaves the network unless you choose it.
- **Append-only.** Daily snapshots are immutable; history is never rewritten.

## A note on the name

"GovProxy" is a working name (a relic of the abandoned proxy concept) and will be
finalized before any public launch. Throughout this manual it simply refers to
the platform described here.
