# Toprope — V1 Build Specification

**AI Adoption Intelligence Platform for Engineering Teams**

> Understand how your teams adopt AI tools, detect waste, track improvement over time, and coach developers toward effective AI-assisted development.

Version 1.0 — May 2026 | Build-Ready Specification

---

## 1. What V1 Is (And Is Not)

### V1 IS:

An AI adoption intelligence platform that an engineering manager can deploy, connect to their GitHub org, Copilot admin, Claude Code admin, and Windsurf admin, and within an hour see a unified view of AI tool adoption across their teams — who's using what, what it costs, whether it's working, and where money is being wasted.

### V1 IS NOT:

- A proxy/gateway (no traffic interception in v1)
- A DLP/secret scanning tool (removed from scope)
- A full developer coaching platform (coaching is v2)
- A replacement for vendor dashboards (it aggregates them)

### V1 Scope — Eight Capabilities:

1. **GitHub Copilot connector** — pull per-user usage metrics via admin API
2. **Claude Code connector** — pull per-user sessions, commits, PRs, cost via Enterprise Analytics API
3. **Windsurf connector** — pull per-user usage metrics via Enterprise API with service keys
4. **Git repository analysis** — detect AI adoption signals from commit history
5. **Expense/subscription tracking** — import cost data for all tools including reimbursed personal accounts
6. **Unified dashboard** — cross-source view with team breakdowns, waste detection, and adoption trends
7. **Time-series storage with aggregation** — daily snapshots, weekly/monthly pre-computed aggregates
8. **AI-generated summaries** — automated weekly and monthly narrative reports from aggregate data

Everything else — Cursor connector, developer coaching, session retrospectives, proxy module, self-reporting — is v1.5/v2.

---

## 2. Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Node.js + TypeScript | Existing expertise, fast iteration |
| Web Framework | Fastify | Lightweight API server for dashboard backend |
| Storage | SQLite (better-sqlite3) | Zero-config, handles <1M rows/year. PostgreSQL in v1.5 |
| Dashboard | React + Tailwind | SPA served by Fastify at /dashboard |
| CLI | Commander.js | Setup, connector config, manual data import, diagnostics |
| Scheduling | node-cron | Aggregation jobs, daily data pulls, summary generation |
| Git Analysis | simple-git + GitHub REST API | Clone-free commit analysis via API |
| AI Summaries | Configurable LLM endpoint | Ollama (local), Haiku (cheap), Sonnet (quality) |
| Config | YAML + JSON Schema | Declarative, git-friendly, validated |
| Packaging | Docker + npm global | Docker for deployment, npm for dev use |
| Testing | Vitest | Fast, TypeScript-native |

---

## 3. Project Structure

```
toprope/
├── CLAUDE.md                         # Claude Code instructions
├── package.json
├── tsconfig.json
├── Dockerfile
├── docker-compose.yml
├── bin/
│   └── index.js                      # CLI entry point
├── src/
│   ├── server.ts                     # Fastify server + route registration
│   ├── connectors/
│   │   ├── types.ts                  # Unified connector interface
│   │   ├── copilot/
│   │   │   ├── client.ts             # GitHub Copilot Metrics API client
│   │   │   ├── transformer.ts        # Transform Copilot data → unified schema
│   │   │   └── sync.ts               # Scheduled sync job
│   │   ├── claude-code/
│   │   │   ├── client.ts             # Anthropic Enterprise Analytics API client
│   │   │   ├── transformer.ts        # Transform Claude Code data → unified schema
│   │   │   └── sync.ts               # Scheduled sync job
│   │   ├── windsurf/
│   │   │   ├── client.ts             # Windsurf Analytics API client (service key auth)
│   │   │   ├── transformer.ts        # Transform Windsurf data → unified schema
│   │   │   └── sync.ts               # Scheduled sync job
│   │   └── git/
│   │       ├── client.ts             # GitHub/GitLab/Bitbucket API client
│   │       ├── analyzer.ts           # Commit pattern analysis
│   │       ├── churn.ts              # Code churn calculation
│   │       ├── ai-signature.ts       # AI-generated code detection heuristics
│   │       └── sync.ts               # Scheduled sync job
│   ├── expenses/
│   │   ├── importer.ts               # CSV/JSON expense data import
│   │   ├── subscription-tracker.ts   # Seat assignment and cost tracking
│   │   └── waste-detector.ts         # Unused/underutilized seat detection
│   ├── aggregation/
│   │   ├── daily.ts                  # Daily snapshot assembly from all sources
│   │   ├── weekly.ts                 # Weekly aggregate computation
│   │   ├── monthly.ts                # Monthly aggregate computation
│   │   └── scheduler.ts             # Cron job orchestration
│   ├── summaries/
│   │   ├── generator.ts              # AI summary generation orchestrator
│   │   ├── prompts.ts                # Summary prompt templates per report type
│   │   └── model-client.ts           # Configurable LLM endpoint client
│   ├── dashboard/
│   │   ├── api/
│   │   │   ├── overview.ts           # Org-wide summary endpoints
│   │   │   ├── teams.ts              # Team-level endpoints
│   │   │   ├── developers.ts         # Developer-level endpoints (privacy-bounded)
│   │   │   ├── waste.ts              # Waste detection endpoints
│   │   │   ├── trends.ts             # Time-series trend endpoints
│   │   │   ├── summaries.ts          # AI-generated summary endpoints
│   │   │   └── export.ts             # CSV/JSON export endpoints
│   │   └── frontend/                 # React SPA build
│   ├── storage/
│   │   ├── db.ts                     # SQLite adapter
│   │   ├── migrations/               # Schema migrations
│   │   └── queries.ts                # Common query patterns
│   ├── alerts/
│   │   └── slack.ts                  # Slack webhook for waste/threshold alerts
│   └── config/
│       ├── loader.ts                 # YAML config loading + validation
│       ├── schema.ts                 # JSON Schema for config validation
│       └── defaults.ts               # Default values
├── tests/
│   ├── connectors/
│   ├── aggregation/
│   ├── expenses/
│   └── fixtures/                     # Sample API responses, CSV files
└── docs/
    ├── setup.md
    ├── connectors.md
    └── expense-import.md
```

---

## 4. Database Schema

```sql
-- ============================================
-- CORE: Developer & Team Registry
-- ============================================

CREATE TABLE developers (
  id TEXT PRIMARY KEY,                -- internal ID
  external_ids TEXT,                  -- JSON: {"github": "user123", "cursor": "user456"}
  name TEXT NOT NULL,
  email TEXT,
  team TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE teams (
  name TEXT PRIMARY KEY,
  department TEXT,
  manager TEXT,
  created_at TEXT NOT NULL
);

-- ============================================
-- SUBSCRIPTIONS & COST
-- ============================================

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  tool TEXT NOT NULL,                  -- copilot|cursor|claude_code|windsurf|other
  plan TEXT,                           -- pro|business|enterprise|max|etc
  billing_model TEXT NOT NULL,         -- company_managed|reimbursed|personal|unknown
  monthly_cost REAL,
  seat_assigned_at TEXT,
  seat_revoked_at TEXT,
  data_source TEXT NOT NULL            -- api|expense_import|manual
);

-- ============================================
-- DAILY SNAPSHOTS (atomic unit)
-- ============================================

-- Tool usage snapshots (from API connectors)
CREATE TABLE tool_snapshots (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  date TEXT NOT NULL,                  -- YYYY-MM-DD
  tool TEXT NOT NULL,                  -- copilot|cursor|claude_code|windsurf
  data_source TEXT NOT NULL,           -- api|self_report
  data_quality TEXT NOT NULL,          -- high|medium|low

  -- Activity
  is_active INTEGER NOT NULL DEFAULT 0,
  interaction_count INTEGER DEFAULT 0, -- suggestions shown, chats, etc.
  acceptance_count INTEGER DEFAULT 0,  -- suggestions accepted
  acceptance_rate REAL,

  -- Feature breakdown (JSON for flexibility across tools)
  features_used TEXT,                  -- JSON: {"autocomplete": 45, "chat": 12, "agent": 3}
  models_used TEXT,                    -- JSON: {"gpt-4o": 30, "claude-sonnet": 15}

  -- Cost (if calculable)
  estimated_cost REAL,
  tokens_consumed INTEGER,

  -- Raw API response stored for debugging (optional, can be disabled)
  raw_data TEXT,

  UNIQUE(developer_id, date, tool)
);

-- Git snapshots (from repository analysis)
CREATE TABLE git_snapshots (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  date TEXT NOT NULL,                  -- YYYY-MM-DD

  commits INTEGER DEFAULT 0,
  lines_added INTEGER DEFAULT 0,
  lines_removed INTEGER DEFAULT 0,
  files_changed INTEGER DEFAULT 0,
  prs_opened INTEGER DEFAULT 0,
  prs_merged INTEGER DEFAULT 0,
  review_comments_given INTEGER DEFAULT 0,
  avg_time_to_merge_hours REAL,

  -- AI adoption signals
  code_churn_rate REAL,                -- % of lines rewritten within 48h
  ai_signature_score REAL,             -- 0-100 likelihood of AI assistance
  avg_commit_size REAL,                -- lines per commit (large = possible AI)
  commit_burst_count INTEGER DEFAULT 0,-- rapid successive commits

  UNIQUE(developer_id, date)
);

-- ============================================
-- AGGREGATES
-- ============================================

CREATE TABLE weekly_aggregates (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  week_start TEXT NOT NULL,            -- YYYY-MM-DD (Monday)
  team TEXT NOT NULL,

  -- Tool usage (summed across all tools)
  active_days INTEGER DEFAULT 0,
  total_interactions INTEGER DEFAULT 0,
  total_acceptances INTEGER DEFAULT 0,
  avg_acceptance_rate REAL,
  tools_used TEXT,                     -- JSON array
  estimated_total_cost REAL,

  -- Git metrics
  total_commits INTEGER DEFAULT 0,
  total_lines_added INTEGER DEFAULT 0,
  total_prs_merged INTEGER DEFAULT 0,
  avg_code_churn REAL,
  avg_ai_signature_score REAL,

  -- Subscription
  subscription_cost REAL,              -- total weekly cost of all seats

  -- Computed
  cost_per_pr REAL,                    -- subscription_cost / prs_merged
  is_active INTEGER DEFAULT 0,        -- had any AI activity this week
  data_quality TEXT,                   -- highest quality level available

  computed_at TEXT NOT NULL,
  UNIQUE(developer_id, week_start)
);

CREATE TABLE monthly_aggregates (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  month TEXT NOT NULL,                 -- YYYY-MM
  team TEXT NOT NULL,

  active_days INTEGER DEFAULT 0,
  active_weeks INTEGER DEFAULT 0,
  total_interactions INTEGER DEFAULT 0,
  avg_acceptance_rate REAL,
  tools_used TEXT,
  estimated_total_cost REAL,

  total_commits INTEGER DEFAULT 0,
  total_lines_added INTEGER DEFAULT 0,
  total_prs_merged INTEGER DEFAULT 0,
  avg_code_churn REAL,
  avg_ai_signature_score REAL,

  subscription_cost REAL,
  cost_per_pr REAL,
  is_active INTEGER DEFAULT 0,
  data_quality TEXT,

  -- Deltas from previous period
  interaction_delta_pct REAL,          -- % change from previous month
  acceptance_rate_delta REAL,
  commit_velocity_delta_pct REAL,
  churn_rate_delta REAL,

  computed_at TEXT NOT NULL,
  UNIQUE(developer_id, month)
);

CREATE TABLE quarterly_aggregates (
  id TEXT PRIMARY KEY,
  team TEXT NOT NULL,                  -- team-level only, not individual
  quarter TEXT NOT NULL,               -- YYYY-Q1, YYYY-Q2, etc.

  developer_count INTEGER DEFAULT 0,
  active_developer_count INTEGER DEFAULT 0,
  utilization_rate REAL,               -- active / total
  total_subscription_cost REAL,
  total_estimated_api_cost REAL,
  unused_seat_count INTEGER DEFAULT 0,
  wasted_spend REAL,                   -- cost of unused seats

  avg_acceptance_rate REAL,
  avg_code_churn REAL,
  total_prs_merged INTEGER DEFAULT 0,
  cost_per_pr REAL,

  -- Maturity score
  ai_maturity_score REAL,              -- 0-100 composite

  -- Deltas
  utilization_rate_delta REAL,
  maturity_score_delta REAL,

  computed_at TEXT NOT NULL,
  UNIQUE(team, quarter)
);

-- ============================================
-- AI-GENERATED SUMMARIES
-- ============================================

CREATE TABLE summaries (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,                 -- team|department|organization
  scope_name TEXT NOT NULL,            -- team name, dept name, or "org"
  period_type TEXT NOT NULL,           -- weekly|monthly|quarterly|yearly
  period_value TEXT NOT NULL,          -- 2026-W21, 2026-05, 2026-Q2, 2026
  summary_text TEXT NOT NULL,          -- AI-generated narrative
  model_used TEXT NOT NULL,
  data_hash TEXT NOT NULL,             -- hash of input data (for regeneration detection)
  generated_at TEXT NOT NULL,
  regenerated_count INTEGER DEFAULT 0
);

-- ============================================
-- WASTE DETECTION
-- ============================================

CREATE TABLE waste_alerts (
  id TEXT PRIMARY KEY,
  developer_id TEXT REFERENCES developers(id),
  team TEXT NOT NULL,
  alert_type TEXT NOT NULL,            -- unused_seat|underutilized|duplicate_tool|cost_outlier
  tool TEXT,
  details TEXT NOT NULL,               -- JSON with specifics
  monthly_waste REAL,                  -- estimated monthly waste amount
  detected_at TEXT NOT NULL,
  resolved_at TEXT,                    -- null if still active
  resolution TEXT                      -- reallocated|upgraded|justified|dismissed
);

-- ============================================
-- INDEXES
-- ============================================

CREATE INDEX idx_tool_snapshots_date ON tool_snapshots(date);
CREATE INDEX idx_tool_snapshots_dev_date ON tool_snapshots(developer_id, date);
CREATE INDEX idx_git_snapshots_date ON git_snapshots(date);
CREATE INDEX idx_git_snapshots_dev_date ON git_snapshots(developer_id, date);
CREATE INDEX idx_weekly_agg_week ON weekly_aggregates(week_start);
CREATE INDEX idx_monthly_agg_month ON monthly_aggregates(month);
CREATE INDEX idx_subscriptions_dev ON subscriptions(developer_id);
CREATE INDEX idx_waste_alerts_team ON waste_alerts(team);
```

---

## 5. Configuration

```yaml
# toprope.config.yaml

server:
  port: 8080
  host: "0.0.0.0"

storage:
  type: "sqlite"
  sqlite_path: "./data/toprope.db"

connectors:
  copilot:
    enabled: true
    github_org: "your-org"
    api_token: "${GITHUB_API_TOKEN}"    # needs copilot metrics scope
    sync_interval: "daily"              # daily|hourly
    sync_time: "02:00"                  # when to pull (UTC)

  claude_code:
    enabled: true
    org_id: "your-anthropic-org-id"
    api_key: "${ANTHROPIC_ADMIN_API_KEY}"  # Enterprise Admin API key
    sync_interval: "daily"
    sync_time: "02:30"

  windsurf:
    enabled: true
    service_key: "${WINDSURF_SERVICE_KEY}"  # from Team Settings → Service Keys
    sync_interval: "daily"
    sync_time: "03:00"

  git:
    enabled: true
    provider: "github"                  # github|gitlab|bitbucket
    org: "your-org"
    api_token: "${GIT_API_TOKEN}"       # needs repo read scope
    repos: []                           # empty = all org repos
    sync_interval: "daily"
    sync_time: "03:00"
    analysis:
      churn_window_hours: 48            # time window for churn detection
      ai_signature_enabled: true        # enable AI-pattern detection

expenses:
  import_path: "./data/expenses/"       # directory for CSV imports
  subscription_defaults:                # default costs when not in expense data
    copilot_business: 19
    copilot_enterprise: 39
    cursor_pro: 20
    cursor_business: 40
    claude_code_pro: 20
    claude_code_max: 200
    windsurf_pro: 20
    windsurf_teams: 40

aggregation:
  weekly:
    day: "monday"
    time: "04:00"
  monthly:
    day: 1
    time: "04:30"
  quarterly:
    time: "05:00"
  daily_retention_days: 90              # raw daily data kept for drill-down

summaries:
  enabled: true
  model:
    type: "anthropic"                   # anthropic|openai|ollama
    model_name: "claude-haiku-4-5-20251001"
    api_key: "${SUMMARY_MODEL_API_KEY}"
  weekly:
    enabled: true
    auto_generate: true
  monthly:
    enabled: true
    auto_generate: true
    model_name: "claude-sonnet-4-20250514"  # upgrade model for monthly
  quarterly:
    enabled: true
    auto_generate: true
    model_name: "claude-sonnet-4-20250514"

alerts:
  slack:
    enabled: false
    webhook_url: "${SLACK_WEBHOOK_URL}"
  waste_threshold: 14                   # days of inactivity before waste alert

dashboard:
  enabled: true
  auth:
    type: "basic"
    admin_password: "${DASHBOARD_PASSWORD}"

teams:
  - name: "frontend"
    department: "engineering"
    manager: "goran"
  - name: "backend"
    department: "engineering"
    manager: "goran"
```

---

## 6. Development Phases Overview

### Phase 1: Git Analysis + Tool Connectors (Copilot, Claude Code, Windsurf) + Foundation (Weeks 1–4)

Detailed in Section 8 below.

### Phase 2: Dashboard + Waste Detection (Weeks 5–6)

- React SPA with four views: Organization Overview, Team Detail, Developer Detail, Waste Detection
- Dashboard REST API serving all views
- Waste detection engine: unused seats (14+ days inactive), underutilized seats (below team average), duplicate tool coverage
- Projected annual savings calculation
- CSV/JSON export for all views
- Basic auth for dashboard access

**Milestone:** Manager opens dashboard, sees cross-source adoption data, identifies 2 wasted seats worth $480/year.

### Phase 3: Aggregation Engine + AI Summaries (Weeks 7–8)

- Weekly and monthly aggregate computation jobs (node-cron)
- Delta calculations: period-over-period changes for all key metrics
- AI maturity score computation (composite of utilization, acceptance rate, churn, velocity)
- AI-generated weekly summaries (configurable model)
- AI-generated monthly summaries (upgraded model)
- Summary storage with regeneration support
- Summary API endpoints for dashboard display

**Milestone:** Manager receives an automated weekly summary: "3 active developers this week, 1 unused seat detected, team acceptance rate improved 8% over last week."

### Phase 4: Expense Import + Subscription Tracking (Week 9)

- CSV importer for expense data (configurable column mapping)
- Subscription registry: which developer has which tool at what cost
- Billing model classification: company_managed, reimbursed, personal
- Cost-per-outcome metrics: subscription cost / PRs merged, cost / active day
- Dashboard integration: cost overlay on all views
- Duplicate subscription detection

**Milestone:** Manager imports expense CSV, sees that Developer X has both Copilot ($19/mo) and Cursor ($40/mo) but only uses Cursor — $228/year waste identified.

### Phase 5: Trends + Advanced Analytics (Weeks 10–11)

- Longitudinal trend charts: adoption rate over time, cost efficiency over time, team comparison over time
- Developer adoption journey visualization: timeline from first AI activity to current maturity
- Team comparison views: side-by-side metrics for teams on different tools
- Quarterly aggregate computation
- Quarterly AI-generated reports
- Anomaly detection: alert when developer/team metrics deviate significantly from baseline

**Milestone:** Manager shows VP a chart: "AI adoption grew from 45% to 82% over 4 months. Cost per PR dropped from $15 to $6. Here's the automated quarterly report."

### Phase 6: Dogfood at WMG (Weeks 12–16)

- Week 12: Deploy for yourself only. Connect WMG GitHub org + Copilot + Claude Code + Windsurf admin. Import expense data.
- Week 13: Invite 2 team leads. Get feedback on dashboard usefulness.
- Week 14–16: Expand to all 6 teams. Track metrics:

| Metric | Target |
|---|---|
| Dashboard loads | <2 seconds |
| Data accuracy | Copilot numbers match vendor dashboard within 5% |
| Waste detection | Identifies at least 2 genuinely wasted seats |
| Manager engagement | At least 1 manager checks dashboard >2x/week |
| AI summary quality | Summaries are accurate and actionable (subjective) |
| Setup time | New team onboarded in <1 hour |

---

## 7. What Comes After V1

### V1.5 (after successful dogfood):

- Cursor connector (Analytics API)
- Additional git providers: GitLab and Bitbucket connectors
- Self-reporting module (CLI + Slack bot)
- PostgreSQL support
- Loop detection and basic prompt coaching (optional proxy module for API-billed teams)

### V2 (after public launch):

- Session retrospective (AI-powered coding coach)
- Organizational learning analytics
- Cross-company benchmarks (anonymized)
- Quarterly/yearly AI-generated executive reports
- SSO/SAML, RBAC
- Hosted SaaS option

---

## 8. Phase 1: Detailed Task Breakdown

### Phase 1 Goal

Connect to a GitHub org (repos + Copilot Metrics API), Anthropic Enterprise (Claude Code Analytics), and Windsurf Enterprise (Analytics API), pull daily data, store it in time-series snapshots, and expose it via CLI and basic API. No dashboard yet — that's Phase 2. Phase 1 validates the data pipeline across all three tools.

Duration: Weeks 1–4

---

### Task 1.1: Project Scaffold (Day 1)

**What:** Initialize the project with all tooling configured.

**Deliverables:**
- TypeScript project with Fastify, better-sqlite3, Commander.js, vitest
- CLAUDE.md in project root
- Working `npm run dev`, `npm run build`, `npm test`, `npm run lint`
- Docker and docker-compose files (basic, for future use)
- toprope.config.yaml with defaults
- Config loader with JSON Schema validation

**Acceptance:**
- `npm run dev` starts Fastify server on port 8080
- `GET /health` returns `{"status": "ok"}`
- Config loads from YAML and validates against schema
- `npm test` runs and passes (even if only a placeholder test)

---

### Task 1.2: Database Setup + Migrations (Day 1–2)

**What:** Create the SQLite database with the full schema from Section 4.

**Deliverables:**
- SQLite adapter with connection management
- Migration system: numbered SQL files applied in order
- Migration 001: developers, teams, subscriptions tables
- Migration 002: tool_snapshots, git_snapshots tables
- Migration 003: weekly_aggregates, monthly_aggregates, quarterly_aggregates tables
- Migration 004: summaries, waste_alerts tables
- Migration 005: all indexes
- CLI command: `toprope db migrate` — applies pending migrations
- CLI command: `toprope db status` — shows migration state

**Acceptance:**
- `toprope db migrate` creates all tables and indexes
- Running it again is idempotent (no errors)
- `toprope db status` shows all migrations applied
- Unit tests verify table creation and basic CRUD for each table

---

### Task 1.3: Developer & Team Registry (Day 2–3)

**What:** Manage the mapping of developers to teams and external tool identities.

**Deliverables:**
- CLI: `toprope team add --name frontend --department engineering --manager goran`
- CLI: `toprope team list`
- CLI: `toprope dev add --name "John Doe" --email john@wmg.rs --team frontend --github johndoe`
- CLI: `toprope dev list [--team frontend]`
- CLI: `toprope dev link --id <dev-id> --copilot <copilot-username> --cursor <cursor-email>`
- Auto-discovery: option to pull developer list from GitHub org members API
- Config-based team definitions (from toprope.config.yaml teams section)

**Acceptance:**
- Teams and developers can be created via CLI and appear in database
- Developer external_ids JSON correctly stores mappings for multiple tools
- `toprope dev list --team frontend` filters correctly
- Auto-discovery from GitHub org pulls member list and creates developer records
- Duplicate detection: adding same GitHub username twice shows warning

---

### Task 1.4: GitHub Copilot Connector (Day 3–6)

**What:** Pull per-user usage metrics from the GitHub Copilot Metrics API and store as daily tool_snapshots.

**Deliverables:**
- Copilot API client: authenticate with GitHub token, call GET /orgs/{org}/copilot/metrics endpoint
- Support for the new per-user breakdown: suggestions, acceptances, active days, by IDE, by language, by model
- Team attribution via GET /orgs/{org}/copilot/metrics/teams endpoint
- Seat management: GET /orgs/{org}/copilot/billing/seats — detect assigned, active, inactive seats
- Data transformer: convert Copilot API response → tool_snapshots records
- Map Copilot usernames to developer_id via external_ids
- Store daily snapshots with data_quality: "high", data_source: "api"
- Sync command: `toprope sync copilot` — pulls latest data
- Scheduled sync: configurable cron (default: daily at 2am UTC)
- Handle API pagination, rate limits, and errors gracefully
- Store raw API response in raw_data field (optional, configurable)

**Acceptance:**
- `toprope sync copilot` successfully pulls data from the API (or test fixtures)
- tool_snapshots table populated with one row per developer per day
- Interaction count, acceptance count, and acceptance rate calculated correctly
- Features_used JSON populated with breakdown by feature (completions, chat, etc.)
- Seat status detection: correctly identifies assigned-but-inactive seats
- API errors handled gracefully: logged, not crashing, partial data saved
- Unit tests with fixture data covering: normal response, empty response, pagination, rate limit

---

### Task 1.5: Claude Code Connector (Day 6–8)

**What:** Pull per-user usage metrics from the Anthropic Enterprise Analytics API and store as daily tool_snapshots.

**Deliverables:**
- Anthropic Enterprise Analytics API client: authenticate with Admin API key
- Per-user metrics: conversation count, messages sent, sessions, Claude Code commits, PRs, lines added/removed
- Tool acceptance/rejection rates
- Cost estimates per user
- Data transformer: convert Anthropic API response → tool_snapshots records
- Map Anthropic user identifiers to developer_id via external_ids
- Store daily snapshots with data_quality: "high", data_source: "api"
- Sync command: `toprope sync claude-code` — pulls latest data
- Scheduled sync: configurable cron (default: daily at 2:30am UTC)
- Handle API pagination, rate limits, and errors gracefully

**Acceptance:**
- `toprope sync claude-code` successfully pulls data from the API (or test fixtures)
- tool_snapshots populated with correct per-developer daily records
- Session count, commit count, PR count, and cost correctly extracted
- Features_used JSON populated (e.g., {"chat": 12, "code_generation": 30, "agent_sessions": 5})
- API errors handled gracefully: logged, not crashing
- Unit tests with fixture data covering: normal response, empty response, rate limit

---

### Task 1.6: Windsurf Connector (Day 8–10)

**What:** Pull per-user usage metrics from the Windsurf Enterprise Analytics API and store as daily tool_snapshots.

**Deliverables:**
- Windsurf Analytics API client: authenticate with service key in request body
- Base URL: https://server.codeium.com/api/v1/
- Per-user metrics: AI-generated code percentage, completions, Cascade sessions, feature usage
- Team-level analytics breakdowns
- Data transformer: convert Windsurf API response → tool_snapshots records
- Map Windsurf user identifiers to developer_id via external_ids
- Store daily snapshots with data_quality: "high", data_source: "api"
- Sync command: `toprope sync windsurf` — pulls latest data
- Scheduled sync: configurable cron (default: daily at 3am UTC)
- Handle API errors and permission issues (different endpoints require different permissions)

**Acceptance:**
- `toprope sync windsurf` successfully pulls data from the API (or test fixtures)
- tool_snapshots populated with correct per-developer daily records
- AI-generated code percentage correctly captured
- Features_used JSON populated (e.g., {"autocomplete": 50, "cascade": 8, "chat": 15})
- Service key authentication works correctly
- API errors handled gracefully
- Unit tests with fixture data

---

### Task 1.7: Git Repository Analysis (Day 10–14)

**What:** Analyze commit history from GitHub repos to detect AI adoption signals and store as daily git_snapshots.

**Deliverables:**
- GitHub REST API client for commits, PRs, and reviews (no cloning — pure API)
- Per-developer daily commit metrics: commit count, lines added/removed, files changed
- PR metrics: opened, merged, review comments given, time-to-merge
- Code churn calculator:
  - For each file changed in a commit, check if the same file was changed again within configurable window (default: 48 hours)
  - Churn rate = lines re-changed / total lines changed
  - High churn suggests accepting AI suggestions without understanding them
- AI signature scorer (heuristic-based, not ML):
  - Large commits with consistent formatting → higher score
  - Comprehensive error handling added in bulk → higher score
  - Multiple new files with boilerplate structure → higher score
  - Score is 0-100, explicitly labeled as "estimated" in all outputs
  - Start conservative: only flag very obvious patterns
- Commit burst detection: 3+ commits within 30 minutes
- Sync command: `toprope sync git` — analyzes commits since last sync
- Configurable repo inclusion/exclusion list
- Store as git_snapshots: one row per developer per day

**Acceptance:**
- `toprope sync git` pulls commit and PR data for configured repos
- git_snapshots populated with correct daily aggregates per developer
- Churn rate calculated correctly: test with fixture where developer modifies same file twice in 24h
- AI signature score produces non-zero values for obviously AI-patterned commits in test fixtures
- AI signature score stays at 0 for normal human-looking commits
- PRs correctly attributed to developer, time-to-merge calculated
- Handles repos with no activity gracefully (no errors, zero-value snapshots)
- Rate limiting: respects GitHub API limits, backs off appropriately

---

### Task 1.8: Expense & Subscription Import (Day 14–16)

**What:** Import subscription cost data from CSV files and track seat assignments.

**Deliverables:**
- CSV importer with configurable column mapping:
  ```
  # Example CSV format (flexible, column names configurable)
  developer_email,tool,plan,monthly_cost,billing_model
  john@wmg.rs,copilot,business,19,company_managed
  jane@wmg.rs,cursor,pro,20,reimbursed
  jane@wmg.rs,claude_code,max,200,reimbursed
  ```
- CLI: `toprope expenses import ./data/expenses/q2-2026.csv`
- CLI: `toprope expenses show [--team frontend]` — current subscriptions with costs
- Column mapping configuration in YAML config
- Subscription registry: creates/updates subscriptions table records
- Match imported data to developers via email
- Default cost values from config (used when CSV doesn't include cost)
- Duplicate subscription detection: flag developers with overlapping tools
- Total cost calculation per developer, per team, per org

**Acceptance:**
- CSV import creates subscription records linked to developers
- Flexible column mapping: works with different CSV formats
- Duplicate detection: "Jane has both Cursor Pro ($20/mo) and Copilot Business ($19/mo)"
- `toprope expenses show` displays a clean summary table
- Handles missing developers gracefully (warns, doesn't crash)
- Handles malformed CSV rows (skips with warning)
- Unit tests with various CSV formats and edge cases

---

### Task 1.9: Basic API Endpoints (Day 16–18)

**What:** REST API that exposes the collected data for the dashboard (built in Phase 2).

**Deliverables:**
- `GET /api/overview` — org-wide summary: total developers, active developers, total subscriptions, total monthly cost, active tools, data quality distribution
- `GET /api/teams` — list all teams with summary metrics
- `GET /api/teams/:team` — team detail: developer list with per-developer activity summary, team totals, waste indicators
- `GET /api/developers/:id` — developer detail: all tool snapshots, git snapshots, subscriptions, activity timeline
- `GET /api/developers/:id/timeline` — daily activity for last 90 days (for trend charts)
- `GET /api/waste` — all active waste alerts: unused seats, underutilized seats, duplicate tools
- `GET /api/snapshots?date=YYYY-MM-DD` — raw daily data for a specific date
- `GET /api/export?format=csv&from=&to=` — export raw data as CSV
- All endpoints: JSON response, consistent pagination, filtering by date range and team
- Basic auth middleware (from config)

**Acceptance:**
- All endpoints return correct data from the database
- Pagination works: `?page=1&limit=20`
- Date filtering works: `?from=2026-05-01&to=2026-05-31`
- Team filtering works: `?team=frontend`
- Empty states handled gracefully (no errors, empty arrays)
- Auth: unauthenticated requests return 401
- Response times: all endpoints under 200ms with 10K rows in database
- Unit tests for each endpoint with fixture data

---

### Task 1.10: Waste Detection Engine (Day 18–20)

**What:** Analyze subscription and usage data to identify wasted spend.

**Deliverables:**
- Unused seat detector: developer has active subscription but zero tool_snapshots activity for N days (configurable, default: 14)
- Underutilized seat detector: developer's usage is below 20% of team average (configurable threshold)
- Duplicate tool detector: developer has subscriptions for 2+ tools in the same category (IDE-based AI: Copilot + Cursor, or terminal-based: Claude Code + Codex)
- Cost outlier detector: developer's cost-per-PR is >3x team average
- Waste alert creation: stores in waste_alerts table with type, details, estimated monthly waste
- Waste resolution: CLI `toprope waste resolve <alert-id> --reason justified` to dismiss with explanation
- CLI: `toprope waste show` — list active waste alerts with total monthly waste
- CLI: `toprope waste summary` — aggregate waste by team

**Acceptance:**
- Correctly identifies a developer with an active Copilot subscription and zero activity in 14 days
- Correctly identifies a developer with both Copilot and Cursor subscriptions
- Correctly identifies a developer whose usage is significantly below team average
- Monthly waste calculation is correct: unused $19/mo seat → $19/mo waste
- Waste alerts are not duplicated: same waste condition doesn't create multiple alerts
- Resolved alerts don't reappear
- CLI output is clean and actionable
- Unit tests with fixture scenarios for each waste type

---

### Task 1.11: CLI Summary + Doctor Command (Day 20–21)

**What:** CLI tools for quick status checking and setup validation.

**Deliverables:**
- `toprope status` — quick summary:
  ```
  Toprope Status
  ──────────────────────────
  Developers:     22 registered (18 active)
  Teams:          6
  Connectors:     Copilot (last sync: 2h ago), Git (last sync: 3h ago)
  Subscriptions:  28 active ($4,820/mo)
  Waste detected: 3 alerts ($177/mo potential savings)
  Data coverage:  HIGH: 15 devs | MEDIUM: 4 devs | LOW: 3 devs
  ```
- `toprope doctor` — validate setup:
  - Check: config file exists and is valid
  - Check: database exists and migrations are current
  - Check: GitHub API token is valid and has correct scopes
  - Check: Copilot API access works for configured org
  - Check: configured repos are accessible
  - Check: summary model endpoint is reachable (if configured)
  - Report issues with suggested fixes

**Acceptance:**
- `toprope status` shows accurate, up-to-date summary
- `toprope doctor` catches: missing config, invalid token, wrong API scopes, unreachable model endpoint
- Doctor output includes actionable fix suggestions for each issue
- Both commands work when database is empty (first run)

---

### Task 1.12: Scheduled Sync + Data Pipeline (Day 21–22)

**What:** Automate the data collection pipeline to run on schedule.

**Deliverables:**
- Sync scheduler using node-cron
- Configurable sync times per connector (from config)
- Sync pipeline order: Copilot API → Claude Code API → Windsurf API → Git Analysis → (future connectors)
- Sync logging: each run logged with start time, end time, records processed, errors
- CLI: `toprope sync all` — manual trigger for full sync
- CLI: `toprope sync copilot` — manual trigger for single connector
- CLI: `toprope sync claude-code` — manual trigger for Claude Code connector
- CLI: `toprope sync windsurf` — manual trigger for Windsurf connector
- CLI: `toprope sync git` — manual trigger for git analysis
- Graceful error handling: one connector failing doesn't block others
- Sync state tracking: each connector remembers last successful sync to avoid re-processing

**Acceptance:**
- Scheduled sync runs at configured time without manual intervention
- Sync processes only new data since last run (no duplicates)
- If Copilot sync fails, Git sync still runs
- Sync log shows clear status for each connector
- Manual trigger via CLI works identically to scheduled sync
- Unit tests verify sync state tracking and duplicate prevention

---

### Phase 1 Milestone

After 4 weeks, you have:

- A working data pipeline that pulls from GitHub Copilot, Claude Code, and Windsurf APIs daily
- Git repository analysis detecting AI adoption signals from commit history
- Subscription data imported from CSV with cost tracking
- All data stored in time-series daily snapshots in a unified schema
- Waste detection identifying unused, underutilized, and duplicate seats across all three tools
- A REST API exposing all data (ready for dashboard in Phase 2)
- CLI tools for management, diagnostics, and manual operations

**Test:** Run `toprope doctor` to verify setup (checks all three API tokens + git access). Run `toprope sync all` to pull data from all sources. Run `toprope status` to see the unified summary across Copilot, Claude Code, and Windsurf. Run `toprope waste show` to see cross-tool waste alerts. Open `http://localhost:8080/api/overview` to see the unified API response.

This validates the entire multi-tool data pipeline before investing in the dashboard UI.

---

## 9. API Endpoints Summary (V1)

```
# Data API (authenticated)
GET  /api/overview                     → Org-wide summary
GET  /api/teams                        → All teams with metrics
GET  /api/teams/:team                  → Team detail with developers
GET  /api/developers/:id              → Developer detail
GET  /api/developers/:id/timeline     → 90-day daily activity
GET  /api/waste                        → Active waste alerts
GET  /api/waste/summary               → Waste by team
GET  /api/snapshots                    → Raw daily snapshots (filterable)
GET  /api/trends/:team                → Team trend data over time
GET  /api/summaries                    → AI-generated summaries list
GET  /api/summaries/:id               → Specific summary text
GET  /api/export                       → CSV/JSON export

# System
GET  /health                           → Health check
GET  /health/detailed                  → Connector status, last sync times
```

---

## 10. CLI Commands (V1)

```bash
# Server
toprope start                                     # Start server
toprope start --config ./toprope.config.yaml     # Custom config
toprope doctor                                    # Validate setup
toprope status                                    # Quick summary

# Database
toprope db migrate                                # Apply migrations
toprope db status                                 # Show migration state

# Teams & Developers
toprope team add --name <name> --manager <manager>
toprope team list
toprope dev add --name "Name" --email e@mail --team <team> --github <username>
toprope dev list [--team <name>]
toprope dev link --id <id> --copilot <username>

# Sync
toprope sync all                                  # Full sync (all connectors)
toprope sync copilot                              # Copilot only
toprope sync claude-code                          # Claude Code only
toprope sync windsurf                             # Windsurf only
toprope sync git                                  # Git analysis only

# Expenses
toprope expenses import ./path/to/file.csv
toprope expenses show [--team <name>]

# Waste
toprope waste show                                # Active waste alerts
toprope waste summary                             # Waste by team
toprope waste resolve <alert-id> --reason <text>

# Export
toprope export --format csv --from 2026-05-01 --to 2026-05-31
```

---

## 11. CLAUDE.md (Drop Into Project Root)

```markdown
# Toprope

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
Run: toprope doctor (validates setup — checks all 3 API tokens + git access)
Run: toprope sync all (pulls data from Copilot, Claude Code, Windsurf, and git)
Run: toprope status (shows unified summary across all tools)
Run: toprope waste show (shows cross-tool waste alerts)
Test API: curl http://localhost:8080/api/overview
```

---

## 12. Go / No-Go After Dogfood

After 4 weeks of dogfooding at WMG:

**Ship publicly if:**
- Data pipeline ran stable for 4 weeks across all three connectors without manual intervention
- Copilot metrics match vendor dashboard within 5% accuracy
- Claude Code metrics match Anthropic admin dashboard within 5% accuracy
- Windsurf metrics match vendor analytics within 5% accuracy
- Git analysis produces plausible AI adoption signals (manually verified)
- Waste detection identified at least 2 genuinely wasted seats across any tool
- Cross-tool view reveals insights no single vendor dashboard showed
- At least 1 manager checked the dashboard without being asked
- AI-generated summaries were accurate and actionable
- Setup took less than 1 hour for a new team

**Do not ship if:**
- Any connector requires frequent manual fixes or re-authentication
- Metrics diverge significantly from vendor dashboards for any tool
- Git AI signature scoring produces mostly false positives
- Waste alerts are mostly wrong (false positives >20%)
- Dashboard ignored after initial demo
- AI summaries contain inaccurate or misleading information
- Cross-tool unified view doesn't provide more insight than checking vendor dashboards separately

---

*End of Document — Toprope V1 Build Specification*
