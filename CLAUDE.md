# GovProxy — Claude Code Instructions

# GovProxy

## Overview
AI adoption intelligence platform for engineering teams.
Aggregates data from AI tool APIs, git repos, and expense data
to show unified adoption metrics, waste detection, and trends.
V1: Copilot + Claude Code + Windsurf connectors + git analysis + expense import + REST API.

## Tech Stack
Node.js + TypeScript + Fastify + better-sqlite3 + Commander.js
Dashboard (Phase 2): React + Tailwind

## Architecture
Data flows in one direction:
Connectors (Copilot API, Claude Code API, Windsurf API, Git API) → Daily Snapshots → Aggregates → API → Dashboard
Expense CSV → Subscriptions → Waste Detection → API → Dashboard

No proxy, no traffic interception. Pure API-pull + git analysis.

## Key Constraints
- Daily snapshots are the atomic unit — one row per developer per day per tool
- Append-only: never modify historical snapshots
- Waste detection: subscription with zero activity for 14+ days = unused
- Data quality tracked per data point: high (API), medium (git), low (expense only)
- Privacy: individual data visible only to developer. Managers see team aggregates.
- All timestamps in UTC ISO format

## Commands
npm run dev        — Start dev server (tsx)
npm run build      — Compile TypeScript
npm test           — Vitest
npm run lint       — ESLint

## Project Structure
src/server.ts              — Fastify entry point
src/connectors/copilot/    — GitHub Copilot Metrics API client + transformer
src/connectors/claude-code/ — Anthropic Enterprise Analytics API client + transformer
src/connectors/windsurf/   — Windsurf Analytics API client + transformer
src/connectors/git/        — Git repo analysis (commits, PRs, churn, AI signatures)
src/expenses/              — CSV import, subscription tracking, waste detection
src/aggregation/           — Weekly/monthly aggregate computation + scheduling
src/summaries/             — AI-generated narrative reports
src/dashboard/api/         — REST API endpoints
src/storage/               — SQLite adapter + migrations
src/config/                — YAML config loader + validation

## Current Phase
Phase 1: Git Analysis + Tool Connectors (Copilot, Claude Code, Windsurf) + Foundation

## Phase 1 Tasks
1.1  Project scaffold (Fastify, SQLite, Commander, config loader)
1.2  Database setup + migration system
1.3  Developer & team registry (CLI + auto-discovery from GitHub)
1.4  GitHub Copilot connector (Metrics API → tool_snapshots)
1.5  Claude Code connector (Enterprise Analytics API → tool_snapshots)
1.6  Windsurf connector (Analytics API → tool_snapshots)
1.7  Git repository analysis (commits, PRs, churn, AI signatures → git_snapshots)
1.8  Expense & subscription import (CSV → subscriptions)
1.9  Basic API endpoints (overview, teams, developers, waste, export)
1.10 Waste detection engine (unused seats, duplicates, underutilized)
1.11 CLI summary + doctor command
1.12 Scheduled sync + data pipeline automation

## Testing
Run: govproxy doctor (validates setup — checks all 3 API tokens + git access)
Run: govproxy sync all (pulls data from Copilot, Claude Code, Windsurf, and git)
Run: govproxy status (shows unified summary across all tools)
Run: govproxy waste show (shows cross-tool waste alerts)
Test API: curl http://localhost:8080/api/overview

## Project
AI Adoption Intelligence Platform. Aggregates per-user usage from GitHub Copilot, Claude Code, and Windsurf APIs; stores daily snapshots in SQLite; serves a React dashboard via Fastify; generates AI-written narrative reports.

V1 Build Specification: `V1_Build_Specification_v2.md`
Product Vision: `/dev-docs/product-vision/Product_Vision_v2.md`

## Commands

| Action     | Command              |
|------------|----------------------|
| Dev server | `npm run dev`        |
| Build      | `npm run build`      |
| Test       | `npm test`           |
| Lint       | `npm run lint`       |
| Typecheck  | `npm run typecheck`  |
| CLI        | `npx govproxy <cmd>` |

Server starts on port 8080. `GET /health` must always return `{"status":"ok"}`.

## Branch naming
`feature/issue-{number}-{short-slug}` — e.g. `feature/issue-1-project-scaffold`

## Commit format
`{type}(#{issue}): {description}` — e.g. `feat(#1): add Fastify server with health endpoint`

Types: `feat` `fix` `chore` `test` `docs` `refactor`

## Merge strategy
Squash merge into main. Always delete the branch after merge.

## TypeScript rules
- No `any` unless genuinely unavoidable — use `unknown` + narrowing instead
- Strict mode enabled — no implicit any, no implicit returns
- All exported functions must have explicit return types

## Dev Cycle
When working on a GitHub issue, always follow the `/dev-cycle` skill. Never open a PR on a failing build or failing tests. Never merge without completing the review cycle or exhausting all 3 iterations.
