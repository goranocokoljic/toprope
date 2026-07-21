# Toprope — Agent Instructions

## Review knowledge base
Recurring code-review findings that graduated into always-on project rules. Honor them when writing code. Auto-generated — do not hand-edit the generated rules file.

- `dev-docs/review-rules.md`

## Overview
Toprope is an AI adoption intelligence platform for engineering teams.

It aggregates data from AI tool APIs, git providers, expense data, and developer self-reports to show unified adoption metrics, waste detection, coaching signals, and trends.

Primary product scope:

- Multi-tool connectors: Copilot, Claude Code, Windsurf, Cursor
- Multi-provider git analysis: GitHub, GitLab, Bitbucket
- Expense and subscription tracking
- Aggregates, anomaly detection, and AI-written summaries
- Fastify API + React dashboard

## Tech stack
- Node.js
- TypeScript
- Fastify
- better-sqlite3
- Commander.js
- React
- Tailwind

## Architecture
Data flows one direction:

Tool APIs / Git providers / Expense CSVs / Self-reports
→ Daily snapshots
→ Aggregates and derived analytics
→ API
→ Dashboard / CLI / AI summaries

Key rule: no proxying or traffic interception. Toprope is API-pull and analysis only.

## Non-negotiable constraints
- Daily snapshots are the atomic unit.
- Historical snapshots are append-only. Do not rewrite history.
- Waste detection treats 14+ days of zero activity as unused.
- Data quality must remain explicit per data point.
- Individual data is private to the developer; managers see team aggregates.
- Store timestamps in UTC ISO format.

## Commands
- `npm run dev` — start the dev server
- `npm run build` — compile TypeScript
- `npm test` — run tests
- `npm run lint` — run ESLint
- `npm run typecheck` — run TypeScript checks
- `npx toprope <cmd>` — run CLI commands

## Project structure
- `src/server.ts` — Fastify entry point
- `src/connectors/` — tool and git connectors
- `src/expenses/` — CSV import, subscriptions, waste detection
- `src/aggregation/` — rollups and scheduled computation
- `src/summaries/` — AI-generated narrative reports
- `src/dashboard/api/` — REST API endpoints
- `src/storage/` — SQLite adapter and migrations
- `src/config/` — YAML config loading and validation
- `documentation/` — user and operator docs
- `dev-docs/` — internal specs, review rules, roadmap inputs

## Current expectations for agents
- Keep `GET /health` returning `{"status":"ok"}`.
- Prefer focused changes that preserve the snapshot-first architecture.
- Do not introduce `any` unless genuinely unavoidable; prefer `unknown` and narrowing.
- Give exported functions explicit return types.
- Keep build, tests, and lint green before considering work complete.
- Do not merge or propose completion on a failing build.

## Operational workflow
- Validate setup with `npx toprope doctor`.
- Sync data with `npx toprope sync all`.
- Inspect status with `npx toprope status`.
- Review waste signals with `npx toprope waste show`.
- Use `npx toprope aggregate backfill` when historical trend generation is needed.

## Source documents
- `README.md` — product overview and quick start
- `documentation/README.md` — documentation hub
- `V1_Build_Specification_v2.md` — build specification
- `dev-docs/product-vision/Product_Vision_v2.md` — product vision

## Git conventions
- Branch naming: `feature/issue-{number}-{short-slug}`
- Commit format: `{type}(#{issue}): {description}`
- Types: `feat`, `fix`, `chore`, `test`, `docs`, `refactor`
- Work from `develop`; squash-merge back into `develop`
- `main` is promoted manually at phase boundaries

## Delivery standard
Before handing off code:

- Build passes
- Tests pass
- Lint passes
- Changes align with privacy and append-only data rules
- Any docs or config surface affected by the change is updated
