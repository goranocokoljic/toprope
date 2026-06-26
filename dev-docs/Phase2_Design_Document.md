# GovProxy — Phase 2 Design Document

**Phase 2: The Dashboard — Manager & Developer Views**

Status: DRAFT FOR DISCUSSION | Version 0.1 — May 2026

> This document describes Phase 2 in detail so we can discuss, refine, and then turn it into GitHub issues with acceptance criteria. Nothing here is final until we agree on it.

---

## 1. Phase 2 Goal

Phase 1 built the data pipeline: connectors pull from Copilot, Claude Code, Windsurf, and git providers; data lands in time-series snapshots; the REST API exposes it. But right now the only way to see any of it is via CLI or raw JSON.

Phase 2 builds the dashboard — a React SPA served by Fastify — that turns the collected data into something a manager and a developer actually want to look at. By the end of Phase 2, opening the browser shows a living picture of AI adoption across the organization.

**Scope boundary:** Dashboard and waste-detection UI only. AI-generated narrative summaries stay in Phase 3. Aggregation engine (weekly/monthly pre-computed tables) also stays in Phase 3 — Phase 2 queries the daily snapshots and computes views on the fly, which is fine at this data scale.

**Duration estimate:** 2–3 weeks (will refine once we lock scope)

---

## 2. Two Audiences, Two Experiences

The dashboard serves two distinct users with different needs and different permission levels. This separation is fundamental to the product's "coaching not surveillance" principle.

### 2.1 The Manager View

The manager (team lead, eng manager, VP) sees aggregate organizational intelligence. They never see individual prompt content or granular per-developer behavior that would feel like surveillance. They see:

- Organization-wide adoption and cost overview
- Team-level breakdowns and comparisons
- Waste detection (unused seats, duplicates, underutilization)
- Adoption trends over time
- Per-developer *aggregate* metrics (activity level, tool usage, cost) — but framed as utilization and health, not judgment

### 2.2 The Developer View

The developer sees their own data — and only their own. This is their private space to understand and improve their AI usage. They see:

- Their personal adoption journey and stats
- Their tool usage across Copilot, Claude Code, Windsurf
- Their git activity correlated with AI usage
- Personal trends: is their usage growing, their acceptance rate improving?
- Self-improvement framing: insights, not scores ranked against peers

### 2.3 The Permission Model

| Data | Manager sees | Developer sees (own) | Developer sees (others) |
|---|---|---|---|
| Org/team aggregate metrics | Yes | Yes (team-level) | Team-level only |
| Individual activity level | Yes (their reports) | Yes | No |
| Individual tool usage detail | Aggregate only | Full | No |
| Individual cost | Yes (their reports) | Yes | No |
| Waste alerts | Yes (their teams) | Own seat only | No |
| Git activity detail | Aggregate only | Full (own) | No |

Authentication in V1 is email + password with proper hashing (argon2/bcrypt), admin-provisioned accounts, and role-based access (admin vs. developer). Full RBAC granularity and SSO/SAML are Enterprise tier / v2. See Section 5.1a for the full authentication design. For Phase 2 dogfooding, the admin (you) provisions accounts for team leads and developers through the Admin UI (Section 5.1b).

---

## 3. Manager View — Screens

### 3.1 Organization Overview (landing screen for managers)

The first thing a manager sees. Answers "how are we doing overall?" at a glance.

**Top-line metric cards (the numbers that matter):**
- Total active developers / total registered (e.g., "18 / 22 active this week")
- Total monthly AI spend across all tools
- Overall utilization rate (active seats / paid seats)
- Total potential savings from waste (e.g., "$177/mo in unused seats")

**Tool distribution:**
- Which tools are in use, how many developers on each, cost per tool
- Visual: horizontal bar or donut showing seat distribution across Copilot, Claude Code, Windsurf

**Adoption trend (the hero chart):**
- Line chart: active developers over time (daily points, last 90 days)
- Shows whether adoption is growing, flat, or declining
- This is the chart the VP wants to see

**Data quality / coverage indicator:**
- Honest display of per-developer coverage: "HIGH: 15 devs | MEDIUM: 4 | LOW: 3"
- Tool connector status: which of Copilot / Claude Code / Windsurf are connected and syncing
- Git provider coverage: which of GitHub / Bitbucket / GitLab are connected, with repo counts (e.g., "Bitbucket: 23 repos, GitHub: 5 repos")
- Builds trust by being transparent about what the platform does and doesn't know across all data sources

**Quick links:**
- Jump to teams, waste detection, or a specific team that needs attention

### 3.2 Teams List

A sortable overview of all teams.

**Per-team row:**
- Team name, developer count, active count
- Utilization rate (with visual indicator: green/amber/red)
- Total monthly cost
- Tool mix (small icons or labels)
- Waste flag if the team has active waste alerts

**Sortable by:** utilization, cost, waste, team size

**The insight this delivers:** at a glance, which teams are thriving with AI and which are struggling or wasting money.

### 3.3 Team Detail

Drill into a single team.

**Team summary:**
- Same top-line cards as org overview, scoped to this team
- Team adoption trend over time

**Developer list (aggregate metrics only):**
- Each developer: activity level (active/low/inactive), tools used, weekly activity, monthly cost
- Activity shown as a sparkline or simple indicator, NOT a ranked leaderboard
- Framing: "utilization health" not "performance ranking"
- Click a developer → see their aggregate detail (still no prompt content)

**Team tool breakdown:**
- Which tools this team uses, adoption per tool, cost per tool

**Team git provider label:**
- Informational display of which git provider(s) host this team's repos (GitHub / Bitbucket / GitLab)
- Small label, no action — purely contextual so the manager knows where the git data comes from
- Useful as the product grows to companies with repos split across providers

**Waste alerts for this team:**
- Inline display of any unused/duplicate/underutilized seats

### 3.4 Waste Detection

The screen that pays for the product.

**Summary:**
- Total monthly waste detected
- Projected annual savings if resolved
- Breakdown by waste type

**Waste alert list:**
- Each alert: developer (or seat), tool, waste type, monthly cost, details
- Types: unused seat (14+ days inactive), underutilized (below team threshold), duplicate tool coverage, cost outlier, **plan-change ROI** (upgrade not justified by usage rise)
- Action per alert: mark resolved with reason (reallocated / upgraded / justified / downgrade recommended / monitor longer / dismissed)
- Resolved alerts move to a separate "resolved" view for audit trail

**Plan ROI alerts (highlighted):**
- Dedicated treatment for change-driven waste: "Developer upgraded to a more expensive plan but usage didn't rise proportionally"
- Shows: old plan → new plan, cost delta, usage delta, time since change
- Example: "Jane: Claude Code Pro → Max 6 weeks ago (+$180/mo), usage +8%. Review recommended."
- Framed as a review prompt, never as developer wrongdoing

**The framing matters:** waste alerts are about optimizing spend, not punishing developers. "This seat is unused" not "this developer is lazy." A developer with an unused seat might be on leave, might prefer a different tool, or might need onboarding — the manager decides.

---

## 4. Developer View — Screens

### 4.1 My Dashboard (landing screen for developers)

The developer's private view of their own AI usage. Designed to be genuinely useful to them, not a report card.

**Personal stat cards:**
- My active days this week / this month
- My primary tool(s)
- My acceptance rate trend (am I getting better at using AI?)
- My estimated AI cost (transparency, no judgment)

**My adoption journey:**
- Timeline: when I started using each tool, how my usage evolved
- Framing: growth story, not surveillance

**My activity trend:**
- Personal line chart: my AI interactions over time
- My git activity (commits, PRs) overlaid — am I shipping more?

**Insights (gentle, optional):**
- "Your acceptance rate improved 12% this month"
- "You've been consistently active across all your tools"
- NOT: "You rank 5th on your team" — no competitive ranking

### 4.2 My Tools

Detail on the developer's own tool usage.

**Per tool (Copilot, Claude Code, Windsurf — whichever they use):**
- Activity over time
- Feature usage breakdown (autocomplete vs chat vs agent)
- Acceptance rate
- Cost (if applicable)

**The value:** a developer can see "I'm paying for Windsurf Max but only using autocomplete — maybe I should try Cascade, or downgrade."

### 4.3 My Activity (Git Correlation)

Where AI usage meets actual output.

- My commits, PRs, lines changed over time
- My code churn rate (am I committing AI code I then have to rewrite?)
- Correlation view: AI usage vs. output (without overclaiming causation)

**The value:** self-awareness. "My churn rate is high — maybe I'm accepting suggestions too quickly without reviewing them."

---

## 5. Technical Design

### 5.1 Frontend Stack

- React + TypeScript SPA
- Tailwind for styling
- Recharts for charts (line, bar, donut) — lightweight, React-native
- Build output served as static files by Fastify at `/dashboard`
- Client-side routing (React Router)
- State: React Query for server state (caching, refetch), minimal local state

### 5.1a Authentication & User Accounts

Phase 1 had only a single admin password in config. Phase 2 needs real per-user authentication because developers now log in to see their own private views.

**Account model:**
- Each user (manager or developer) has an account with email + hashed password
- Passwords hashed with argon2 (or bcrypt) — never stored plaintext
- Role field: `admin` (manager/leadership) or `developer`
- A user account links to a developer record (for developers) so their `/api/me/*` data resolves correctly

**Account creation & password flow:**
- Admin creates user accounts via the Admin UI (see 5.1b) or CLI
- System generates a temporary password (or a one-time setup link/token)
- User must change password on first login
- Admin can trigger a password reset (generates a new temporary password / setup link)
- No public self-registration — accounts are always admin-provisioned (this is a controlled internal tool)

**Session management:**
- Signed session cookie or JWT after successful login
- Configurable session expiry
- Logout invalidates the session
- Developer endpoints (`/api/me/*`) resolve the developer strictly from the authenticated session — a developer cannot pass another developer's ID and see their data

**Scope for Phase 2:** email + password with proper hashing, admin-provisioned accounts, first-login password change, role-based access. Full SSO/SAML/OAuth remains Enterprise tier / v2.

### 5.1b Admin Management UI

Phase 1 exposed user/team/subscription management only via CLI. That's fine for the technical founder but unrealistic for other team leads during dogfood, and it undermines the "deploy in an afternoon" promise. Phase 2 adds a web-based Admin area (admin role only) that wraps the existing CLI capabilities.

**Admin UI covers:**
- **Users:** create, edit, deactivate user accounts; assign role (admin/developer); trigger password reset; link to a developer record
- **Teams:** create, edit, archive teams; assign manager; move developers between teams
- **Developer identity mapping:** link a developer's tool identities (Copilot username, Claude Code email, Windsurf email) and git author emails — the same `external_ids` and git-email mapping built in Phase 1, now editable in the UI
- **Subscriptions & plans:** assign a tool subscription to a developer, set plan and monthly cost, change or end a subscription (drives the lifecycle handling in 5.1c)
- **Data sources:** view connector and git provider status (read-only in Phase 2; configuration stays in config file)

**Terminology note:** "plans" here means the *AI tool subscription plans* the platform tracks for cost analysis (Copilot Business, Claude Code Max, Windsurf Teams, etc.) — NOT GovProxy's own pricing tiers. The Admin UI manages the former.

### 5.1c Subscription Lifecycle Handling

Developers change tools and plans over time. The platform must record these transitions accurately rather than overwriting history, both for correct cost-over-time accounting and to enable change-driven insights (see 5.1d).

**Model:**
- A subscription change (plan upgrade/downgrade, or tool switch) is recorded as: set `seat_revoked_at` on the old subscription row, create a new subscription row with the new plan/cost and a fresh `seat_assigned_at`
- This preserves full history: "Jane had Claude Code Pro Jan–Mar, then Max from Mar onward"
- Cost-over-time calculations use the active subscription for each date, so historical monthly costs remain accurate across changes
- Append-only `tool_snapshots` already preserve activity history correctly regardless of plan

**Transition-aware logic:**
- The expense importer (Phase 1 Task 1.8) detects when an imported record represents a *change* to an existing subscription vs. a genuinely new one, and applies the revoke-old + create-new pattern rather than creating duplicates
- The waste detector ignores recently-transitioned seats for the inactivity window (a seat assigned yesterday isn't "unused for 14 days")
- The developer "adoption journey" view displays transitions as part of the narrative

### 5.1d Plan-Change ROI Detection (Manager Feature)

A distinct category of waste detection focused on *change-driven* waste rather than static waste. When a developer moves to a more expensive plan, the platform watches whether usage rises enough to justify the cost increase.

**How it works:**
- On a plan upgrade (cost increase), record the baseline: average usage in the N days before the change (configurable, default 30)
- After a settling period (configurable, default 30 days post-change), compare post-change average usage to the baseline
- Compute the cost increase ratio vs. the usage increase ratio
- Flag when cost rose significantly more than usage — e.g., cost +900% (Pro→Max), usage +8%

**Example alert:**
> "Jane upgraded Claude Code Pro → Max 6 weeks ago (+$180/mo). Usage increased only 8% since the upgrade. The higher plan may not be justified — consider reviewing."

**Important framing (consistent with the product's principles):**
- This is a prompt to *review*, not an automatic judgment. Jane may have legitimate reasons (working on a project that needs higher limits intermittently, ramping up, etc.)
- Surfaced to the manager in the Waste Detection screen as a dedicated "Plan ROI" alert type
- Resolution options: justified / downgrade recommended / monitor longer / dismissed
- Never framed as the developer doing something wrong — framed as a spend-optimization question

**Why this matters:** vendor dashboards will never surface this because they benefit from upsell. It's exactly the kind of cross-cutting, incentive-aligned insight that justifies the platform to a budget-conscious manager.

### 5.2 Backend (extends Phase 1 API)

Phase 1 built the core API endpoints. Phase 2 adds the endpoints the dashboard needs that don't exist yet, and adds the developer-scoped endpoints:

**New manager endpoints:**
- `GET /api/overview/trend?range=90d` — adoption trend time-series (range: 30d|90d|year|lifetime|custom)
- `GET /api/teams/:team/trend?range=90d` — team adoption trend
- `GET /api/tools/distribution` — tool/seat/cost distribution
- `GET /api/coverage` — data source coverage: tool connectors + git providers with repo counts
- `GET /api/teams/:team/providers` — git provider(s) hosting this team's repos
- `GET /api/waste/resolved` — resolved waste alerts (audit trail)
- `POST /api/waste/:id/resolve` — mark alert resolved with reason
- `GET /api/waste/plan-roi` — plan-change ROI alerts (upgrades not justified by usage)
- `GET /api/leaderboard/:team` — ranked team view (returns 403 if leaderboard disabled by settings)

**New auth endpoints:**
- `POST /api/auth/login` — email + password → session
- `POST /api/auth/logout` — invalidate session
- `POST /api/auth/change-password` — change own password (required on first login)
- `GET /api/auth/me` — current session info (role, linked developer)

**New admin endpoints (admin role only):**
- `GET/POST/PATCH /api/admin/users` — list, create, edit, deactivate user accounts
- `POST /api/admin/users/:id/reset-password` — trigger password reset
- `GET/POST/PATCH /api/admin/teams` — manage teams
- `PATCH /api/admin/developers/:id/identities` — link tool + git identities
- `GET/POST/PATCH /api/admin/subscriptions` — assign/change/end subscriptions (drives lifecycle handling)
- `GET /api/admin/data-sources` — connector + git provider status (read-only)

**New developer endpoints (auth: developer's own token):**
- `GET /api/me/overview` — personal stat summary
- `GET /api/me/tools` — personal per-tool breakdown
- `GET /api/me/timeline?range=90d` — personal activity time-series (range: 30d|90d|year|lifetime|custom with from/to)
- `GET /api/me/activity` — personal git activity + churn

Note: developer insights endpoint deferred to Phase 3 (decision 6). All time-series endpoints accept the same `range` parameter supporting 30d / 90d / year / lifetime / custom (from + to dates).

**New settings endpoints (admin role; some readable by managers):**
- `GET/PATCH /api/settings/global` — site-wide settings (leaderboard availability, ROI threshold default, whether managers may override per team)
- `GET/PATCH /api/settings/team/:team` — per-team overrides (only if globally permitted)
- `GET/PATCH /api/me/preferences` — per-user UI preferences (default time range, dark mode)

**Auth middleware extension:**
- Distinguish admin (manager) vs. developer role
- Developer endpoints (`/api/me/*`) scope all queries to the authenticated developer
- Manager endpoints require admin role
- A developer cannot access another developer's detail

### 5.3 On-the-Fly Aggregation

Phase 2 does NOT build the pre-computed aggregate tables (that's Phase 3). Instead, dashboard endpoints query the daily snapshots and aggregate in-query. At Phase 2 data scale (weeks of data for ~22 developers), this is fast enough. Phase 3 adds pre-computation when history grows and quarterly reports need it.

### 5.4 Multi-Provider Git Data (Inherited from Phase 1)

All three git providers (GitHub, Bitbucket, GitLab) were implemented in Phase 1 behind the provider abstraction layer. This means every git-related dashboard view consumes normalized `git_snapshots` and works identically regardless of provider. No provider-specific dashboard code is required.

Practical implications for Phase 2:
- The developer "My Activity" screen and team git aggregates are multi-provider from day one
- A developer committing to Bitbucket repos and one committing to GitHub repos appear identically
- A single developer with commits across multiple providers has unified git metrics
- The coverage indicator and team provider label expose which providers are active, but no view branches on provider type

This is a meaningful dogfood advantage: WMG uses Bitbucket as primary, so the git correlation views will be validated against real Bitbucket data rather than a GitHub stand-in.

### 5.6 Database Schema Additions (Phase 2)

Phase 2 introduces a few schema changes on top of the Phase 1 tables:

```sql
-- User accounts (new — Phase 1 had only a config-file admin password)
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- argon2/bcrypt
  role TEXT NOT NULL,                   -- admin|developer
  developer_id TEXT REFERENCES developers(id),  -- null for pure admins
  must_change_password INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  deactivated_at TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Plan ROI baselines (new — supports plan-change ROI detection)
CREATE TABLE plan_change_events (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  tool TEXT NOT NULL,
  old_plan TEXT,
  new_plan TEXT NOT NULL,
  old_monthly_cost REAL,
  new_monthly_cost REAL NOT NULL,
  changed_at TEXT NOT NULL,
  baseline_usage REAL,                  -- avg daily usage in N days before change
  baseline_window_days INTEGER,
  post_change_usage REAL,               -- avg daily usage after settling period
  evaluated_at TEXT,                    -- when post-change comparison ran (null until settled)
  roi_flagged INTEGER DEFAULT 0
);

-- Settings (new — global + per-team configuration)
CREATE TABLE settings (
  scope TEXT NOT NULL,                  -- global|team
  scope_name TEXT NOT NULL,             -- "global" or team name
  key TEXT NOT NULL,                    -- leaderboard_enabled|roi_threshold|roi_settling_days|managers_can_override
  value TEXT NOT NULL,                  -- JSON-encoded value
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_name, key)
);

-- Per-user UI preferences (new)
CREATE TABLE user_preferences (
  user_id TEXT NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,                    -- default_time_range|dark_mode
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
```

The existing `subscriptions` table already supports lifecycle handling via `seat_assigned_at` / `seat_revoked_at` — no change needed there, just the revoke-old + create-new logic in the importer and admin UI. The `waste_alerts` table (Phase 1) gains a new `alert_type` value: `plan_roi`.

### 5.7 Design Aesthetic

The dashboard should feel like a precision instrument, not a generic admin panel. Direction to settle during discussion, but my recommendation:

- Clean, data-focused, calm. This is a tool people check regularly — it should reduce anxiety, not add to it.
- Restrained color palette with meaningful accent use (green/amber/red only for genuine status signals, not decoration)
- Distinctive but readable typography (a characterful display font for headings, clean body font)
- Charts that are immediately legible — no chartjunk
- Dark mode option (developers love it, and managers checking on phones at night appreciate it)

---

## 6. Resolved Design Decisions

All open questions have been resolved. Recorded here for reference.

**1. Authentication.** Email + password, argon2/bcrypt hashing, admin-provisioned accounts, first-login password change, role-based (admin/developer), session cookies/JWT. Admin Management UI for account creation. SSO/SAML deferred to Enterprise/v2. (Sections 5.1a, 5.1b.)

**2. Manager visibility vs. leaderboards.** Default is the privacy-respecting utilization view — non-adopters surface only in the waste/utilization context, never as a ranked list. However, a ranked leaderboard is also built as a capability that ships **turned off by default**. A site-level setting controls whether it's available at all; a second setting controls whether individual team managers can enable it for their team (same global + per-team permission pattern as ROI thresholds). Rationale: buyers will ask for leaderboards even though they conflict with the coaching principle; having it ready-but-off lets us say yes without compromising the default experience.

**3. Charting.** Invest in a strong charting/dashboard library for polish (first impressions matter during evaluation). Candidates: Recharts or Tremor (Tremor is purpose-built for analytics dashboards and looks excellent out of the box). Final library chosen at frontend-scaffold time. Interactive charts (hover detail, the time-range selector below) are in Phase 2 scope.

**4. Mobile.** Desktop-optimized for Phase 2. A dedicated mobile interface is a separate future phase. No responsive work in Phase 2 beyond not actively breaking on smaller screens.

**5. Empty / low-data states.** Resolved via a **time-range selector** (30 days / 90 days / year / lifetime / custom range) present on every time-series view:
- **Smart default:** the selector defaults to the smallest preset that comfortably contains available history. Early on (few days of data) it defaults to a short range so charts don't look broken; as history accumulates the default grows toward 90 days. The user's explicit choice is remembered as a per-user UI preference.
- **"Lifetime"** means "from the first day we have data for this scope" — for a developer tracked 3 weeks, lifetime is 3 weeks; for the org, since first sync. The axis only spans real data, avoiding empty-axis artifacts.
- **Custom range:** arbitrary start/end date picker, included in Phase 2.
- This lets each manager choose their own framing (honest-and-sparse via lifetime, or fill-up-over-time via 90 days) without the product picking a side.
- Paired with the **confidence/coverage badge:** whatever range is selected, each chart states how many days of actual data back it.
- Distinct data states still need explicit handling: **cold-start** (connected, no data yet → "collecting your data" panel with setup checklist), **genuine-empty** (a real signal, e.g. unused seat → distinct from cold-start, never conflated), and **partial-coverage** (some developers HIGH quality, others LOW → honest per-scope confidence display).
- Implemented as reusable data-state components in the shared-components task, applied consistently across all screens.

**6. Developer insights.** Skipped in Phase 2. The developer view shows their own data and trends; narrative insights (rule-based or AI-generated) wait for Phase 3 where they'll be done properly.

**7. Plan-change ROI thresholds.** Configurable through the UI. The site admin sets a global default; a setting controls whether team managers may override it per team (same pattern as the leaderboard toggle). Starting default: flag when the cost-increase ratio is 3x or more the usage-increase ratio, evaluated after a 30-day settling period.

---

## 7. Proposed Task Breakdown (Draft)

Once we agree on scope, these become GitHub issues. Rough cut:

- **2.1** Frontend scaffold (React + Tailwind + charting library + React Query, served by Fastify)
- **2.2** Authentication system (accounts, password hashing, first-login change, sessions, role model)
- **2.3** New manager API endpoints (trends, distribution, coverage, team providers, waste resolve)
- **2.4** New developer API endpoints (`/api/me/*`, scoped to authenticated developer)
- **2.5** Manager: Organization Overview screen (incl. multi-source coverage indicator)
- **2.6** Manager: Teams List + Team Detail screens (incl. git provider label)
- **2.7** Manager: Waste Detection screen (incl. Plan ROI alerts)
- **2.8** Developer: My Dashboard screen
- **2.9** Developer: My Tools + My Activity screens (multi-provider git correlation)
- **2.10** Shared components (charts, stat cards, layout, navigation, dark mode, time-range selector, data-state components, coverage/confidence badge)
- **2.11** Empty/loading/error states across all screens (cold-start, genuine-empty, partial-coverage)
- **2.12** Phase 2 integration testing + dogfood prep
- **2.13** Admin Management UI (users, teams, identity mapping, subscriptions)
- **2.14** Subscription lifecycle handling (plan/tool changes, transition-aware logic)
- **2.15** Plan-change ROI detection (baseline capture, post-change comparison, alerts)
- **2.16** Settings & configuration (global + per-team toggles for leaderboard and ROI thresholds, per-user UI preferences for time-range default)
- **2.17** Optional leaderboard view (ships off by default, gated by settings from 2.16)

---

## 8. Phase 2 Milestone (Proposed)

By the end of Phase 2:

- A manager logs in and sees org overview, drills into teams, identifies waste, and views adoption trends — all from real WMG data collected in Phase 1
- A developer logs in and sees their own private dashboard with their tool usage, activity, and personal trends
- The cross-tool unified view is visible and useful — something no vendor dashboard provides
- The dashboard is the thing you actually open every morning instead of running CLI commands

---

*End of Document — GovProxy Phase 2 Design (DRAFT FOR DISCUSSION)*
