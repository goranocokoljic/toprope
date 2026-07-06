# Toprope — Phase 1 Task Tracker

**Phase 1: Git Analysis + Tool Connectors (Copilot, Claude Code, Windsurf) + Foundation**

Duration: Weeks 1–4 | 12 Tasks

---

## Workflow Per Task

```
1. Create GitHub Issue (copy description below)
2. Create branch: task/1.X-short-name
3. Implement in Claude Code (reference acceptance criteria)
4. Write tests alongside implementation
5. Run full test suite: npm test
6. Push + open PR (reference issue: "Closes #N")
7. AI-assisted code review (paste diff into Claude)
8. Address feedback + re-test
9. Merge to main
10. Tag: v0.1.X
11. Verify: toprope doctor (smoke test after merge)
```

---

## Task 1.1: Project Scaffold

**Branch:** `task/1.1-project-scaffold`
**Estimate:** Day 1
**Depends on:** Nothing

### GitHub Issue Description

```
## Task 1.1: Project Scaffold

Initialize the project with all core tooling configured and working.

### Deliverables

- [ ] TypeScript project with Fastify, better-sqlite3, Commander.js, vitest
- [ ] CLAUDE.md in project root (copy from V1 Build Spec Section 11)
- [ ] Working npm scripts: `dev`, `build`, `test`, `lint`
- [ ] Docker and docker-compose files (basic, for future use)
- [ ] toprope.config.yaml with sensible defaults
- [ ] Config loader that reads YAML and validates against JSON Schema
- [ ] `GET /health` endpoint returning `{"status": "ok"}`
- [ ] ESLint + Prettier configured

### Acceptance Criteria

- [ ] `npm run dev` starts Fastify server on port 8080
- [ ] `GET /health` returns `{"status": "ok"}`
- [ ] Config loads from YAML, validates, and throws clear error on invalid config
- [ ] `npm test` runs and passes
- [ ] `npm run build` compiles to dist/ without errors
- [ ] `npm run lint` passes
```

---

## Task 1.2: Database Setup + Migrations

**Branch:** `task/1.2-database-migrations`
**Estimate:** Day 1–2
**Depends on:** 1.1

### GitHub Issue Description

```
## Task 1.2: Database Setup + Migrations

Create SQLite database with the full schema and a versioned migration system.

### Deliverables

- [ ] SQLite adapter (src/storage/db.ts) with connection management
- [ ] Migration runner: reads numbered SQL files, applies in order, tracks state
- [ ] Migration 001: developers, teams tables
- [ ] Migration 002: subscriptions table
- [ ] Migration 003: tool_snapshots, git_snapshots tables
- [ ] Migration 004: weekly_aggregates, monthly_aggregates, quarterly_aggregates tables
- [ ] Migration 005: summaries, waste_alerts tables
- [ ] Migration 006: all indexes
- [ ] CLI command: `toprope db migrate`
- [ ] CLI command: `toprope db status`

### Acceptance Criteria

- [ ] `toprope db migrate` creates all tables and indexes
- [ ] Running migrate again is idempotent (no errors, no duplicate tables)
- [ ] `toprope db status` shows all 6 migrations as applied
- [ ] Unit tests verify table creation
- [ ] Unit tests verify basic CRUD (insert + select) for each core table
- [ ] Migration files are plain SQL, easy to read and modify
```

---

## Task 1.3: Developer & Team Registry

**Branch:** `task/1.3-developer-registry`
**Estimate:** Day 2–3
**Depends on:** 1.2

### GitHub Issue Description

```
## Task 1.3: Developer & Team Registry

Manage developers, teams, and cross-tool identity mapping.

### Deliverables

- [ ] CLI: `toprope team add --name <name> --department <dept> --manager <manager>`
- [ ] CLI: `toprope team list`
- [ ] CLI: `toprope dev add --name "Name" --email email --team <team> --github <username>`
- [ ] CLI: `toprope dev list [--team <name>]`
- [ ] CLI: `toprope dev link --id <dev-id> --copilot <username> --claude <email> --windsurf <email>`
- [ ] Auto-discovery: pull developer list from GitHub org members API
- [ ] Config-based team definitions loaded from toprope.config.yaml teams section
- [ ] Developer external_ids JSON stores identity mappings for Copilot, Claude Code, Windsurf

### Acceptance Criteria

- [ ] Teams created via CLI appear in database and in `team list` output
- [ ] Developers created via CLI with correct team association
- [ ] `dev list --team frontend` filters correctly
- [ ] `dev link` correctly updates external_ids JSON with multiple tool mappings
- [ ] Auto-discovery from GitHub org creates developer records for all org members
- [ ] Duplicate detection: adding same GitHub username twice shows warning, doesn't create duplicate
- [ ] Config-based teams are created on first startup
- [ ] Unit tests for all CRUD operations and edge cases
```

---

## Task 1.4: GitHub Copilot Connector

**Branch:** `task/1.4-copilot-connector`
**Estimate:** Day 3–6
**Depends on:** 1.3

### GitHub Issue Description

```
## Task 1.4: GitHub Copilot Connector

Pull per-user daily usage metrics from the GitHub Copilot Metrics API
and store as tool_snapshots in the unified schema.

### Deliverables

- [ ] Copilot API client (src/connectors/copilot/client.ts)
  - Authenticate with GitHub token
  - GET /orgs/{org}/copilot/metrics — per-user daily breakdown
  - GET /orgs/{org}/copilot/metrics/teams — team attribution
  - GET /orgs/{org}/copilot/billing/seats — seat assignments, active/inactive
- [ ] Data transformer (src/connectors/copilot/transformer.ts)
  - Convert Copilot API response → tool_snapshots records
  - Map Copilot usernames to developer_id via external_ids
  - Populate: interaction_count, acceptance_count, acceptance_rate
  - Populate features_used JSON: {"completions": N, "chat": N, "code_review": N}
  - Populate models_used JSON: {"gpt-4o": N, "claude-sonnet": N}
- [ ] Sync job (src/connectors/copilot/sync.ts)
  - CLI: `toprope sync copilot`
  - Pulls data since last successful sync
  - Stores snapshots with data_quality: "high", data_source: "api"
  - Handles pagination, rate limits (GitHub 5000 req/hr), retries
  - Detects assigned-but-inactive seats
  - Stores raw API response in raw_data field (configurable)
- [ ] Connector interface (src/connectors/types.ts)
  - Define unified ConnectorInterface that all connectors implement
  - Methods: sync(), getLastSyncTime(), getName()

### Acceptance Criteria

- [ ] `toprope sync copilot` pulls data and creates tool_snapshots records
- [ ] One row per developer per day in tool_snapshots
- [ ] Interaction count, acceptance count, acceptance rate calculated correctly
- [ ] Features_used and models_used JSON populated correctly
- [ ] Inactive seats detected and flagged
- [ ] API errors handled: logged with detail, process doesn't crash, partial data saved
- [ ] Rate limit handling: backs off and retries on 429 responses
- [ ] Pagination: handles multi-page responses correctly
- [ ] Sync state: running sync twice for same day doesn't create duplicates (UPSERT)
- [ ] Unit tests with fixture data: normal response, empty org, pagination, rate limit, malformed response
- [ ] ConnectorInterface is generic enough for Claude Code and Windsurf to implement
```

---

## Task 1.5: Claude Code Connector

**Branch:** `task/1.5-claude-code-connector`
**Estimate:** Day 6–8
**Depends on:** 1.4 (uses ConnectorInterface)

### GitHub Issue Description

```
## Task 1.5: Claude Code Connector

Pull per-user daily usage metrics from the Anthropic Enterprise Analytics API
and Claude Code Analytics Admin API, store as tool_snapshots.

### Deliverables

- [ ] Anthropic API client (src/connectors/claude-code/client.ts)
  - Authenticate with Anthropic Admin API key
  - Enterprise Analytics API: per-user engagement metrics
    - Conversation counts, messages sent
    - Claude Code commits, PRs
    - Lines of code added/removed
    - Session counts
  - Claude Code Analytics Admin API: per-user daily aggregated usage
    - Sessions, tool acceptance/rejection rates
    - Cost estimates
- [ ] Data transformer (src/connectors/claude-code/transformer.ts)
  - Convert Anthropic API response → tool_snapshots records
  - Map Anthropic user identifiers to developer_id via external_ids
  - Populate: interaction_count (sessions), acceptance_count, acceptance_rate
  - Populate features_used JSON: {"chat": N, "code_generation": N, "agent_sessions": N}
  - Populate estimated_cost from API response
- [ ] Sync job (src/connectors/claude-code/sync.ts)
  - CLI: `toprope sync claude-code`
  - Implements ConnectorInterface
  - Pulls data since last successful sync
  - Handles pagination, rate limits, errors

### Acceptance Criteria

- [ ] `toprope sync claude-code` pulls data and creates tool_snapshots records
- [ ] One row per developer per day in tool_snapshots
- [ ] Session count, commit count, PR count, lines changed correctly extracted
- [ ] Estimated cost populated from API data
- [ ] Features_used JSON correctly populated
- [ ] Implements same ConnectorInterface as Copilot connector
- [ ] API errors handled gracefully
- [ ] Sync state: no duplicates on re-run
- [ ] Unit tests with fixture data: normal response, empty response, rate limit
```

---

## Task 1.6: Windsurf Connector

**Branch:** `task/1.6-windsurf-connector`
**Estimate:** Day 8–10
**Depends on:** 1.4 (uses ConnectorInterface)

### GitHub Issue Description

```
## Task 1.6: Windsurf Connector

Pull per-user daily usage metrics from the Windsurf Enterprise Analytics API
and store as tool_snapshots.

### Deliverables

- [ ] Windsurf API client (src/connectors/windsurf/client.ts)
  - Base URL: https://server.codeium.com/api/v1/
  - Authenticate with service key in request body: {"service_key": "..."}
  - Per-user metrics: AI-generated code percentage, completions, Cascade sessions
  - Team-level analytics
  - Feature usage breakdowns
- [ ] Data transformer (src/connectors/windsurf/transformer.ts)
  - Convert Windsurf API response → tool_snapshots records
  - Map Windsurf user identifiers to developer_id via external_ids
  - Populate: interaction_count, acceptance_count, acceptance_rate
  - Populate features_used JSON: {"autocomplete": N, "cascade": N, "chat": N, "flows": N}
- [ ] Sync job (src/connectors/windsurf/sync.ts)
  - CLI: `toprope sync windsurf`
  - Implements ConnectorInterface
  - Handles different permission requirements per endpoint
  - Handles API errors and auth issues

### Acceptance Criteria

- [ ] `toprope sync windsurf` pulls data and creates tool_snapshots records
- [ ] One row per developer per day in tool_snapshots
- [ ] AI-generated code percentage correctly captured
- [ ] Features_used JSON correctly populated with Windsurf-specific features
- [ ] Service key authentication works (key in body, not header)
- [ ] Permission errors logged clearly with which permission is missing
- [ ] Implements same ConnectorInterface as other connectors
- [ ] Sync state: no duplicates on re-run
- [ ] Unit tests with fixture data
```

---

## Task 1.7: Git Repository Analysis

**Branch:** `task/1.7-git-analysis`
**Estimate:** Day 10–14
**Depends on:** 1.3

### GitHub Issue Description

```
## Task 1.7: Git Repository Analysis

Analyze commit history from GitHub repos to detect AI adoption signals.
Store as daily git_snapshots. Uses GitHub REST API only — no repo cloning.

### Deliverables

- [ ] GitHub REST API client (src/connectors/git/client.ts)
  - List repos for org
  - Get commits per repo with author, date, files changed, additions/deletions
  - Get PRs: opened, merged, reviews, time-to-merge
  - Get review comments per PR
- [ ] Commit analyzer (src/connectors/git/analyzer.ts)
  - Aggregate per-developer per-day: commits, lines added/removed, files changed
  - PR metrics: opened, merged, review comments given, avg time-to-merge
- [ ] Code churn calculator (src/connectors/git/churn.ts)
  - For each file changed, check if same file changed again within 48h window
  - Churn rate = lines re-changed / total lines changed
  - Configurable window (default: 48 hours)
- [ ] AI signature scorer (src/connectors/git/ai-signature.ts)
  - Heuristic scoring (0-100), NOT ML-based
  - Signals: large commits with consistent formatting, bulk error handling additions,
    multiple new boilerplate files, comprehensive test generation in single commit
  - Start very conservative — only flag obvious patterns
  - Score explicitly labeled as "estimated" everywhere it appears
- [ ] Commit burst detection: flag 3+ commits within 30 minutes
- [ ] Sync job: `toprope sync git`
  - Configurable repo inclusion/exclusion list
  - Processes commits since last sync
  - Stores as git_snapshots: one row per developer per day

### Acceptance Criteria

- [ ] `toprope sync git` pulls commit and PR data for configured repos
- [ ] git_snapshots populated with correct daily aggregates per developer
- [ ] Churn rate calculated correctly (test: developer modifies same file twice in 24h)
- [ ] AI signature score > 0 for obviously AI-patterned test fixtures
- [ ] AI signature score = 0 for normal human-looking commit fixtures
- [ ] Commit bursts correctly detected
- [ ] PRs correctly attributed to developer, time-to-merge calculated
- [ ] Empty repos handled gracefully (no errors, zero-value snapshots)
- [ ] Respects GitHub API rate limits (5000 req/hr authenticated)
- [ ] Configurable repo list works (include/exclude)
- [ ] Sync state: processes only new commits since last run
- [ ] Unit tests with comprehensive fixture data for each analysis type
```

---

## Task 1.8: Expense & Subscription Import

**Branch:** `task/1.8-expense-import`
**Estimate:** Day 14–16
**Depends on:** 1.3

### GitHub Issue Description

```
## Task 1.8: Expense & Subscription Import

Import subscription cost data from CSV files. Track which developer
has which tool at what cost, regardless of billing model.

### Deliverables

- [ ] CSV importer (src/expenses/importer.ts)
  - Configurable column mapping (in config YAML)
  - Supports: developer_email, tool, plan, monthly_cost, billing_model
  - Match imported records to developers via email
  - Handle missing fields gracefully (use defaults from config)
- [ ] Subscription tracker (src/expenses/subscription-tracker.ts)
  - Creates/updates subscriptions table records
  - Billing model classification: company_managed, reimbursed, personal, unknown
  - Default cost values from config when CSV doesn't include cost
  - Total cost calculation per developer, per team, per org
- [ ] CLI: `toprope expenses import ./path/to/file.csv`
- [ ] CLI: `toprope expenses show [--team <name>]`
- [ ] Duplicate subscription detection: flag developers with overlapping tools

### Acceptance Criteria

- [ ] CSV import creates subscription records linked to correct developers
- [ ] Flexible column mapping: works with at least 3 different CSV formats (test fixtures)
- [ ] Duplicate detection: flags "Jane has both Cursor Pro and Copilot Business"
- [ ] `toprope expenses show` displays clean summary table with costs
- [ ] Missing developers warned (not crashed)
- [ ] Malformed CSV rows skipped with warning + line number
- [ ] Default costs applied when CSV omits cost column
- [ ] Total cost aggregation correct at developer, team, and org level
- [ ] Unit tests with various CSV formats and edge cases
```

---

## Task 1.9: Basic API Endpoints

**Branch:** `task/1.9-api-endpoints`
**Estimate:** Day 16–18
**Depends on:** 1.4, 1.5, 1.6, 1.7, 1.8

### GitHub Issue Description

```
## Task 1.9: Basic API Endpoints

REST API exposing all collected data. This is the backend for the
Phase 2 dashboard — no UI yet, just JSON endpoints.

### Deliverables

- [ ] `GET /api/overview` — org-wide summary
  - Total developers (registered, active), total subscriptions, total monthly cost
  - Active tools list, data quality distribution (high/medium/low/none)
  - Active waste alert count, total monthly waste
- [ ] `GET /api/teams` — all teams with summary metrics
  - Per team: developer count, active count, tool mix, total cost, utilization rate
- [ ] `GET /api/teams/:team` — team detail
  - Developer list with per-developer: tools, activity summary, subscription cost
  - Team totals, waste indicators
- [ ] `GET /api/developers/:id` — developer detail
  - All tool_snapshots, git_snapshots, subscriptions
  - Activity summary across all tools
- [ ] `GET /api/developers/:id/timeline` — 90-day daily activity
  - Daily data points for trend charts (tool activity + git activity)
- [ ] `GET /api/waste` — active waste alerts with details
- [ ] `GET /api/waste/summary` — waste aggregated by team
- [ ] `GET /api/snapshots?date=YYYY-MM-DD` — raw daily data for specific date
- [ ] `GET /api/export?format=csv&from=&to=` — export as CSV or JSON
- [ ] Basic auth middleware (password from config)
- [ ] Consistent response format: `{ data: [...], pagination: { page, limit, total } }`

### Acceptance Criteria

- [ ] All endpoints return correct data from database
- [ ] Pagination works: `?page=1&limit=20` with correct total count
- [ ] Date range filtering: `?from=2026-05-01&to=2026-05-31`
- [ ] Team filtering: `?team=frontend`
- [ ] Empty states: no errors, empty arrays with zero totals
- [ ] Auth: unauthenticated requests return 401 with clear message
- [ ] All endpoints respond under 200ms with 10K rows in database
- [ ] Cross-tool data correctly unified in overview and team endpoints
- [ ] CSV export produces valid, downloadable file
- [ ] Unit tests for each endpoint with fixture data
```

---

## Task 1.10: Waste Detection Engine

**Branch:** `task/1.10-waste-detection`
**Estimate:** Day 18–20
**Depends on:** 1.4, 1.5, 1.6, 1.8

### GitHub Issue Description

```
## Task 1.10: Waste Detection Engine

Analyze subscription and usage data across all three tools to identify
wasted spend: unused seats, underutilized developers, duplicate coverage.

### Deliverables

- [ ] Unused seat detector
  - Developer has active subscription but zero tool_snapshots activity for N days
  - Configurable threshold (default: 14 days)
  - Checks across Copilot, Claude Code, and Windsurf independently
- [ ] Underutilized seat detector
  - Developer's usage below 20% of team average for that tool
  - Configurable threshold
- [ ] Duplicate tool detector
  - Developer has subscriptions for 2+ tools in same category
  - IDE-based: Copilot + Cursor + Windsurf (overlapping)
  - Terminal-based: Claude Code + Codex (overlapping)
  - Flag as "review needed" not "definitely wasted" — developer may have reasons
- [ ] Cost outlier detector
  - Developer's cost-per-PR is >3x team average
- [ ] Waste alert management
  - Store in waste_alerts table: type, details JSON, estimated monthly waste
  - No duplicate alerts for same condition
  - CLI: `toprope waste resolve <id> --reason <text>` to dismiss with explanation
  - Resolved alerts don't reappear for same condition
- [ ] CLI: `toprope waste show` — list active alerts with total waste
- [ ] CLI: `toprope waste summary` — waste by team with totals

### Acceptance Criteria

- [ ] Identifies developer with Copilot subscription + zero activity for 14 days
- [ ] Identifies developer with Claude Code subscription + zero activity for 14 days
- [ ] Identifies developer with Windsurf subscription + zero activity for 14 days
- [ ] Identifies developer with both Copilot and Windsurf (duplicate IDE-based)
- [ ] Identifies developer with usage <20% of team average
- [ ] Monthly waste calculation correct: unused $40/mo Cursor seat = $40/mo waste
- [ ] No duplicate alerts: same condition doesn't create multiple alerts on re-run
- [ ] Resolved alerts stay resolved (don't reappear)
- [ ] `toprope waste show` output is clean, actionable, grouped by type
- [ ] `toprope waste summary` shows per-team breakdown with total
- [ ] Unit tests with fixture scenarios for each waste type
```

---

## Task 1.11: CLI Summary + Doctor Command

**Branch:** `task/1.11-cli-doctor`
**Estimate:** Day 20–21
**Depends on:** 1.4, 1.5, 1.6, 1.7, 1.8, 1.10

### GitHub Issue Description

```
## Task 1.11: CLI Summary + Doctor Command

CLI tools for quick status overview and setup validation.

### Deliverables

- [ ] `toprope status` — quick unified summary
  ```
  Toprope Status
  ──────────────────────────────────
  Developers:     22 registered (18 active)
  Teams:          6
  Connectors:
    Copilot:      ✓ connected (last sync: 2h ago, 15 devs tracked)
    Claude Code:  ✓ connected (last sync: 3h ago, 8 devs tracked)
    Windsurf:     ✓ connected (last sync: 3h ago, 5 devs tracked)
    Git:          ✓ connected (last sync: 4h ago, 12 repos)
  Subscriptions:  28 active ($4,820/mo)
  Waste detected: 3 alerts ($177/mo potential savings)
  Data coverage:  HIGH: 15 devs | MEDIUM: 4 devs | LOW: 3 devs
  ```
- [ ] `toprope doctor` — validate entire setup
  - Check: config file exists and is valid YAML
  - Check: database exists and all migrations applied
  - Check: GitHub API token valid and has correct scopes (repo, copilot)
  - Check: Copilot API access works for configured org
  - Check: Anthropic Admin API key valid and has analytics access
  - Check: Windsurf service key valid and has analytics permissions
  - Check: configured git repos are accessible
  - Check: summary model endpoint is reachable (if configured)
  - Each check: ✓ pass or ✗ fail with specific fix suggestion

### Acceptance Criteria

- [ ] `toprope status` shows accurate real-time summary
- [ ] Status shows per-connector sync state with last sync time
- [ ] Status shows data coverage breakdown
- [ ] `toprope doctor` catches: missing config, invalid tokens for each service
- [ ] Doctor catches: wrong API scopes, unreachable model endpoint
- [ ] Doctor gives actionable fix suggestion for every failure
- [ ] Both commands work when database is empty (first run)
- [ ] Both commands work when some connectors are disabled
```

---

## Task 1.12: Scheduled Sync + Data Pipeline

**Branch:** `task/1.12-sync-pipeline`
**Estimate:** Day 21–22
**Depends on:** 1.4, 1.5, 1.6, 1.7

### GitHub Issue Description

```
## Task 1.12: Scheduled Sync + Data Pipeline

Automate the multi-connector data collection pipeline to run on schedule.

### Deliverables

- [ ] Sync scheduler using node-cron
  - Configurable sync times per connector from config
  - Default: Copilot 2:00, Claude Code 2:30, Windsurf 3:00, Git 3:30 (UTC)
- [ ] Sync pipeline orchestration
  - Order: Copilot → Claude Code → Windsurf → Git
  - Each connector runs independently
  - One connector failing does NOT block others
- [ ] Sync logging
  - Each run logged: connector name, start time, end time, records processed, errors
  - Log stored in database for dashboard visibility
- [ ] Sync state tracking
  - Each connector tracks last successful sync timestamp
  - Only processes data since last sync (no duplicates)
- [ ] CLI manual triggers
  - `toprope sync all` — runs full pipeline
  - `toprope sync copilot` — single connector
  - `toprope sync claude-code` — single connector
  - `toprope sync windsurf` — single connector
  - `toprope sync git` — git analysis only
- [ ] Error recovery
  - Failed sync retried once after 5 minute delay
  - Persistent failure logged as alert, doesn't block next scheduled run

### Acceptance Criteria

- [ ] Scheduled sync runs at configured times without manual intervention
- [ ] Each connector syncs only new data since last run (no duplicates)
- [ ] If Copilot sync fails, Claude Code + Windsurf + Git still run
- [ ] If Windsurf sync fails, others still run
- [ ] Sync log shows clear status per connector per run
- [ ] Manual trigger via CLI works identically to scheduled sync
- [ ] Re-running sync for same time period is safe (upsert, no duplicates)
- [ ] Failed sync is retried once, then logged as alert
- [ ] Unit tests verify: sync state tracking, duplicate prevention, error isolation
```

---

## Phase 1 Completion Checklist

After all 12 tasks are merged to main:

```
[ ] toprope doctor — all checks pass (3 APIs + git + database)
[ ] toprope sync all — pulls data from all 4 sources without errors
[ ] toprope status — shows unified summary with all connectors
[ ] toprope waste show — shows cross-tool waste alerts
[ ] curl /api/overview — returns unified org summary with data from all tools
[ ] curl /api/teams — returns team list with cross-tool metrics
[ ] curl /api/developers/:id/timeline — returns 90-day daily activity
[ ] npm test — all tests pass
[ ] toprope expenses import test.csv — imports correctly
[ ] Scheduled sync runs overnight without intervention
```

**Phase 1 is complete when all checks above pass with real WMG data
(or realistic test fixtures if API access isn't ready yet).**

Next: Phase 2 — Dashboard + Waste Detection UI (Weeks 5–6)

---

*End of Document — Toprope Phase 1 Task Tracker*
