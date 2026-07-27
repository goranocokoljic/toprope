# Toprope — Claude Code Instructions

# Toprope

## Review knowledge base (graduated rules)
Recurring code-review findings that graduated into always-on project rules. Honor them
when writing code. Auto-generated — do not hand-edit (see `dev-cycle-analytics/REVIEW_KB.md`).
@dev-docs/review-rules.md

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
- Append-only: never modify historical snapshots.
  **Documented exception — `git_snapshots` (#253 / #264).** Since #253 `git_snapshots` is not
  a source of record but a deterministic PROJECTION of `(raw_author_daily, identity map)`
  at the `(developer_id, date)` grain. Rebuilding or removing a projected cell is therefore
  *recomputation*, not history rewriting: the facts live in `raw_author_daily`, keyed by the
  immutable raw git identity and by `(provider, container)`. Two paths rely on it — replaying
  a developer whose identities changed (#253), and the provider delete cascade, which
  retracts one container's contribution and re-projects the affected days (#264). The
  exception is bounded by `is_projected`: rows the projection did not produce are never
  written or deleted by it.
  **A third, one-time path is migration 042 (#264)**, which clears `git_snapshots` outright —
  including `is_projected = 0` legacy cells, i.e. deliberately outside that bound. It is
  licensed only as a pre-production reset, and it is what makes the cascade *complete*: a
  legacy cell can never be retracted by the projection, so leaving any behind would make every
  later provider delete silently partial. No runtime path may do this.
  **Migration 043 (#266)** also drops projected cells — unconditionally, like 042, but strictly
  WITHIN the `is_projected` bound (legacy cells are left untouched, unlike 042). It is
  unconditional deliberately: "needs normalizing" is not decidable in SQL the way the code
  decides it, so a conditional probe would miss exactly the rows that matter and leave their
  cursors behind. The raw rows it clears cannot be honestly re-attributed to one spelling, so
  the days they fed are re-projected by a resync — and 043 leaves a `git_data_reset_pending`
  marker that `toprope doctor` fails on until the rebuild is acknowledged.
  `tool_snapshots` and every other snapshot table remain strictly append-only.
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
Run: toprope doctor (validates setup — checks all 3 API tokens + git access)
Run: toprope sync all (pulls data from Copilot, Claude Code, Windsurf, and git)
Run: toprope status (shows unified summary across all tools)
Run: toprope waste show (shows cross-tool waste alerts)
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
| CLI        | `npx toprope <cmd>` |

Server starts on port 8080. `GET /health` must always return `{"status":"ok"}`.

## Branch naming
`feature/issue-{number}-{short-slug}` — e.g. `feature/issue-1-project-scaffold`

## Commit format
`{type}(#{issue}): {description}` — e.g. `feat(#1): add Fastify server with health endpoint`

Types: `feat` `fix` `chore` `test` `docs` `refactor`

## Merge strategy
Feature branches are cut from `develop` and squash-merged back into `develop` (always delete the branch after merge). `main` stays frozen — the user merges `develop` into `main` manually at the end of a phase.

## TypeScript rules
- No `any` unless genuinely unavoidable — use `unknown` + narrowing instead
- Strict mode enabled — no implicit any, no implicit returns
- All exported functions must have explicit return types

## Dev Cycle
When working on a GitHub issue, always follow the `/dev-cycle` skill. Never open a PR on a failing build or failing tests. Never merge without completing the review cycle or exhausting all 3 iterations.
