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
- Append-only: never modify historical snapshots. `tool_snapshots` and every other non-git
  snapshot table are strictly append-only, with no exceptions.
  **The git pipeline is not append-only — it is a source of record plus projections
  (IG1, epic #316; design: `dev-docs/Idempotent_Git_Ingestion_Design.md`).** Four tables,
  four different rules:
  - **`raw_commits` — the immutable SOURCE OF RECORD.** One row per commit, keyed
    `(provider, container, repo, sha)`. A commit is named by the hash of its own content, so a
    re-observed sha is the same fact: the write is insert-or-improve (`ON CONFLICT DO UPDATE`
    only when a strictly more informative observation arrives, e.g. a diffstat that was degraded
    on first sight), never `+=`. Overlapping windows, a replayed run and a re-fetched backfill
    are all no-ops. Rows leave only via the provider delete cascade, which retracts exactly one
    `(provider, container)`. **No other runtime path may delete them.**
  - **`raw_author_daily` — a recomputed PROJECTION** at the
    `(provider, container, raw_author_key, date)` grain. Every cell an ingest touches is
    recomputed by aggregate over `raw_commits` inside the run's transaction (`INSERT OR REPLACE`,
    never `+=`), so re-running an ingest writes the same numbers twice. Two groups of columns are
    NOT projected and must be combined idempotently rather than replaced: the four PR counters
    (derived from `pr_records`, combined with `max()`) and `code_churn_rate` /
    `ai_signature_score`, which `raw_commits` cannot recompute (no commit message, no file paths)
    and which are therefore carried across writes by a commit-weighted mean. Adding a new column
    means deciding which group it is in.
  - **`git_snapshots` — a PROJECTION of `(raw_author_daily, identity map)`** at the
    `(developer_id, date)` grain (#253/#264). It folds every provider and identity for the day,
    so a scoped single-provider run cannot drop another provider's same-day contribution.
    Bounded by `is_projected`: rows the projection did not produce are never written or
    deleted by it.
  - **`commit_diffstats` — a MEMO** of an idempotent remote read (#273), same immutability
    argument as `raw_commits`, written per commit DURING the fetch and outside the run's write
    transaction so a failed run keeps its expensive fetches. Deleting it costs only re-fetching.
  **Sync cursors are FETCH HINTS, not correctness proofs.** A stale, lost or overlapping
  cursor costs API calls, never accuracy — the old disjoint-window invariant it used to carry
  is gone with the additive merge.
  **Migrations 042 (#264), 043 (#266) and 046 (#317) are one-time PRE-PRODUCTION resets** that
  cleared this data outright, 042 and 046 including `is_projected = 0` legacy cells. 046 is
  the reset that precedes IG1 and leaves the `git_data_reset_pending` marker `toprope doctor`
  fails on until the rebuild is acknowledged. **No runtime path may do any of this.**
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

## Review convergence policy
The review pipeline has damping rules so it cannot loop (see the Convergence guard
in `.claude/skills/dev-cycle-phases/SKILL.md`): reviewers rank only in-diff defects
(out-of-diff observations are unranked and parked in `dev-docs/parking-lot.md`);
a review finding becomes a new GitHub issue only within the spawn policy (max one
per completed issue, chain depth ≤ 2 without human approval); small follow-up fixes
get a focused `--lenses SEC,TST` review, not all five lenses. The harness runs
`scripts/dev-cycle/loop-check.mjs` after every completed item and stops the queue
when fix-of-fix loop signatures trip.
