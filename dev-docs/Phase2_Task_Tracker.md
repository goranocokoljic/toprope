# GovProxy — Phase 2 Task Tracker

**Phase 2: The Dashboard — Manager & Developer Views**

17 Tasks | Estimated 3–4 weeks | React SPA served by Fastify

> Each task below is a complete GitHub issue description with context, deliverables, and acceptance criteria. Written to serve as living documentation — anyone reading an issue should understand not just *what* to build but *why* it exists and how it fits the product.

---

## Workflow Per Task (same as Phase 1)

```
1. Create GitHub Issue (copy description below)
2. Create branch: feature/2.X-short-name
3. Implement in Claude Code (reference acceptance criteria)
4. Write tests alongside implementation
5. Run full test suite: npm test
6. Push + open PR (reference issue: "Closes #N")
7. AI-assisted code review (paste diff into Claude)
8. Address feedback + re-test
9. Merge to main
10. Tag: v0.2.X
11. Verify against acceptance criteria
```

## Recommended Build Order

The tasks have dependencies. Suggested order:

```
Foundation:   2.1 → 2.2 → 2.16 (scaffold, auth, settings)
Backend APIs: 2.3 → 2.4 → 2.14 → 2.15 (manager + dev endpoints, lifecycle, ROI)
Shared UI:    2.10 → 2.11 (components, data states)
Manager UI:   2.5 → 2.6 → 2.7 → 2.13 → 2.17 (overview, teams, waste, admin, leaderboard)
Developer UI: 2.8 → 2.9 (dashboard, tools/activity)
Close-out:    2.12 (integration + dogfood prep)
```

Note: 2.14 (lifecycle) and 2.15 (ROI) are backend and can be built in parallel with UI work once the data model is in place.

---

# TASK 2.1: Frontend Scaffold

**Branch:** `task/2.1-frontend-scaffold`
**Depends on:** Phase 1 complete
**Estimate:** 1–2 days

### GitHub Issue Description

```
## Task 2.1: Frontend Scaffold

### Context
Phase 1 delivered the data pipeline and a REST API, but the only way to view
data is via CLI or raw JSON. Phase 2 builds the dashboard. This task sets up
the frontend foundation that all subsequent UI tasks build on. It is a
React SPA served as static files by the existing Fastify server at /dashboard.

### Goal
A running React application served by Fastify, with routing, data-fetching,
styling, and charting libraries configured. No real screens yet — just the
skeleton that proves the full stack works end to end.

### Deliverables
- [ ] React + TypeScript app under src/dashboard/frontend/
- [ ] Vite build configured; output served by Fastify at /dashboard
- [ ] Tailwind CSS configured with the project design tokens (colors, spacing, typography)
- [ ] Charting library installed and verified with one sample chart
      (Decision needed during this task: Recharts vs Tremor — Tremor is
      purpose-built for analytics dashboards and looks polished out of the box.
      Document the choice in the PR.)
- [ ] React Router configured with placeholder routes for manager and developer areas
- [ ] React Query (TanStack Query) configured for server-state management
- [ ] A typed API client wrapper (fetch-based) that talks to the Phase 1 API
- [ ] A distinctive but readable font pairing (display + body) — NOT generic
      system fonts; this is a product people evaluate, first impressions matter
- [ ] Dark mode infrastructure (theme toggle wiring, even if the toggle UI
      comes later in 2.10)
- [ ] Basic app shell: header, navigation placeholder, content area
- [ ] One end-to-end smoke test: app loads, calls /api/overview, renders the result

### Acceptance Criteria
- [ ] `npm run dev` runs the frontend with hot reload during development
- [ ] `npm run build` produces static output that Fastify serves at /dashboard
- [ ] Navigating to http://localhost:8080/dashboard loads the React app
- [ ] The sample chart renders with data fetched from the live API
- [ ] React Query caches the API call (verify no duplicate requests on re-render)
- [ ] Routing works: at least two placeholder routes navigable without full reload
- [ ] Tailwind classes apply correctly; design tokens are centralized (not hardcoded)
- [ ] Dark mode can be toggled programmatically (full UI toggle comes in 2.10)
- [ ] Chosen charting library documented in PR with rationale
- [ ] Build artifacts are git-ignored; only source committed
```

---

# TASK 2.2: Authentication System

**Branch:** `task/2.2-authentication`
**Depends on:** 2.1
**Estimate:** 2–3 days

### GitHub Issue Description

```
## Task 2.2: Authentication System

### Context
Phase 1 had only a single admin password in config — adequate for one manager
running CLI commands, but Phase 2 introduces developer logins (each developer
sees their own private data) and multiple managers. We need real per-user
authentication. This is security-sensitive: a developer must NEVER be able to
see another developer's data, and prompt-level privacy is a core product
principle.

### Goal
A complete email + password authentication system with admin-provisioned
accounts, role-based access (admin vs developer), first-login password change,
and secure session management.

### Deliverables
- [ ] Database migration: `users` table (id, email, password_hash, role,
      developer_id, must_change_password, created_at, deactivated_at)
- [ ] Database migration: `sessions` table (id, user_id, created_at, expires_at)
- [ ] Password hashing with argon2 (preferred) or bcrypt — never plaintext
- [ ] Auth endpoints:
      - POST /api/auth/login (email + password → session cookie/JWT)
      - POST /api/auth/logout (invalidate session)
      - POST /api/auth/change-password (change own password)
      - GET /api/auth/me (current session: role, linked developer_id)
- [ ] Session management via signed cookie or JWT, configurable expiry
- [ ] Auth middleware:
      - Distinguishes admin vs developer role
      - Protects all /api/* endpoints (except login)
      - Developer endpoints (/api/me/*) resolve developer_id STRICTLY from the
        session — never from a request parameter
      - Admin-only endpoints reject developer-role sessions with 403
- [ ] First-login flow: must_change_password forces password change before
      any other action
- [ ] Frontend: login screen, password-change screen, logout, auth-guarded routes
- [ ] CLI: `govproxy user create-admin` to bootstrap the first admin account

### Acceptance Criteria
- [ ] Passwords stored only as argon2/bcrypt hashes; verified by inspecting DB
- [ ] Login with correct credentials returns a valid session; wrong credentials
      return 401 with a generic message (no user enumeration)
- [ ] A logged-in developer calling GET /api/me/* sees ONLY their own data
- [ ] A developer attempting to access an admin endpoint receives 403
- [ ] A developer attempting to pass another developer's ID as a parameter
      cannot retrieve that developer's data (data scoped from session, not param)
- [ ] First login forces password change before dashboard access
- [ ] Logout invalidates the session; subsequent requests with the old session fail
- [ ] Sessions expire per configured expiry
- [ ] `govproxy user create-admin` bootstraps the first admin
- [ ] Unit tests: hashing, login success/failure, role enforcement, session
      lifecycle, cross-developer access prevention (this last one is critical)
```

---

# TASK 2.3: Manager API Endpoints

**Branch:** `task/2.3-manager-api`
**Depends on:** 2.2
**Estimate:** 2 days

### GitHub Issue Description

```
## Task 2.3: Manager API Endpoints

### Context
The manager-facing dashboard screens need data the Phase 1 API doesn't yet
expose: time-series trends, tool distribution, multi-source coverage, git
provider info per team, and waste resolution. This task adds those endpoints.
All require admin role.

### Goal
All manager-facing API endpoints implemented, returning correct data with
consistent time-range support.

### Deliverables
- [ ] GET /api/overview/trend?range=<range> — org adoption trend time-series
- [ ] GET /api/teams/:team/trend?range=<range> — team adoption trend
- [ ] GET /api/tools/distribution — seats and cost per tool across the org
- [ ] GET /api/coverage — data source coverage:
      - Per-developer data quality counts (HIGH/MEDIUM/LOW/none)
      - Tool connector status (Copilot/Claude Code/Windsurf connected + last sync)
      - Git provider coverage (GitHub/Bitbucket/GitLab + repo counts)
- [ ] GET /api/teams/:team/providers — git provider(s) hosting the team's repos
- [ ] GET /api/waste/resolved — resolved waste alerts (audit trail)
- [ ] POST /api/waste/:id/resolve — mark alert resolved with reason
      (reallocated | upgraded | justified | downgrade_recommended |
       monitor_longer | dismissed)
- [ ] Shared time-range parser: accepts 30d | 90d | year | lifetime | custom
      (with from & to dates). "lifetime" = from earliest data for that scope.
- [ ] All endpoints admin-role gated

### Acceptance Criteria
- [ ] Each endpoint returns correctly shaped, accurate data verified against
      known fixture data
- [ ] Time-range parser correctly handles all five range types
- [ ] "lifetime" returns data from the earliest available record for the scope
- [ ] Custom range validates from <= to and rejects invalid dates
- [ ] /api/coverage accurately reflects connector and git provider state
- [ ] /api/waste/:id/resolve records the reason and moves the alert to resolved
- [ ] Resolved alerts appear in /api/waste/resolved, not in active /api/waste
- [ ] All endpoints return 403 for developer-role sessions
- [ ] Response times under 200ms with 10K+ snapshot rows
- [ ] Unit tests per endpoint including range variations and empty data
```

---

# TASK 2.4: Developer API Endpoints

**Branch:** `task/2.4-developer-api`
**Depends on:** 2.2
**Estimate:** 1–2 days

### GitHub Issue Description

```
## Task 2.4: Developer API Endpoints

### Context
The developer view is the privacy-respecting half of the product. A developer
sees only their own data, framed for self-improvement. These endpoints must
scope every query to the authenticated developer — security-critical.

### Goal
All /api/me/* endpoints implemented, each strictly scoped to the authenticated
developer via session (never via request parameter).

### Deliverables
- [ ] GET /api/me/overview — personal stat summary (active days, primary tools,
      acceptance rate trend direction, estimated personal cost)
- [ ] GET /api/me/tools — personal per-tool breakdown (activity, features used,
      acceptance rate, cost per tool)
- [ ] GET /api/me/timeline?range=<range> — personal activity time-series
      (tool interactions + git activity), same range support as manager endpoints
- [ ] GET /api/me/activity — personal git activity (commits, PRs, lines, churn)
      across all configured git providers
- [ ] GET /api/me/preferences + PATCH — per-user UI preferences (default time
      range, dark mode)
- [ ] developer_id resolved exclusively from session
- [ ] Note: insights endpoint intentionally deferred to Phase 3

### Acceptance Criteria
- [ ] Each endpoint returns only the authenticated developer's data
- [ ] Passing a different developer_id in any way does not change the result
      (data always scoped from session)
- [ ] Git activity correctly aggregates across multiple providers for the
      same developer (e.g., Bitbucket + GitHub commits unified)
- [ ] Time-range parameter behaves identically to manager endpoints
- [ ] Preferences persist and are returned on subsequent requests
- [ ] An unauthenticated request returns 401
- [ ] Unit tests including the cross-developer isolation check
```

---

# TASK 2.5: Manager — Organization Overview Screen

**Branch:** `task/2.5-org-overview`
**Depends on:** 2.3, 2.10
**Estimate:** 2 days

### GitHub Issue Description

```
## Task 2.5: Manager — Organization Overview Screen

### Context
This is the manager's landing screen — the first impression of the product and
the screen answering "how are we doing overall?" at a glance. It must feel
like a precision instrument, not a generic admin panel.

### Goal
A polished organization overview showing top-line metrics, tool distribution,
the hero adoption-trend chart, and honest data-coverage display.

### Deliverables
- [ ] Top-line metric cards:
      - Active developers / total registered (e.g., "18 / 22 active this week")
      - Total monthly AI spend across all tools
      - Overall utilization rate (active seats / paid seats)
      - Total potential savings from waste
- [ ] Tool distribution visual (donut or horizontal bar): developers and cost
      per tool across Copilot / Claude Code / Windsurf
- [ ] Hero adoption-trend chart: active developers over time, with the shared
      time-range selector (30d/90d/year/lifetime/custom)
- [ ] Data coverage indicator:
      - Per-developer quality breakdown (HIGH/MEDIUM/LOW)
      - Tool connector status
      - Git provider coverage with repo counts
- [ ] Quick links to teams, waste detection, and any team needing attention
- [ ] Uses shared components from 2.10 (cards, charts, time-range selector,
      coverage badge, data-state handling)

### Acceptance Criteria
- [ ] All metric cards show accurate values from the live API
- [ ] Tool distribution reflects real seat and cost data
- [ ] Adoption trend chart renders and responds to time-range changes
- [ ] Coverage indicator honestly reflects all data sources
- [ ] Screen handles cold-start (no data yet) and low-data states gracefully
      via shared data-state components
- [ ] Screen loads in under 2 seconds with realistic data
- [ ] Desktop-optimized layout; does not break on smaller windows
- [ ] Matches the established design aesthetic (calm, data-focused, polished)
```

---

# TASK 2.6: Manager — Teams List + Team Detail Screens

**Branch:** `task/2.6-teams-screens`
**Depends on:** 2.3, 2.10
**Estimate:** 3 days

### GitHub Issue Description

```
## Task 2.6: Manager — Teams List + Team Detail Screens

### Context
Managers need to compare teams (who's thriving, who's struggling or wasting
money) and drill into a single team. The Team Detail screen shows per-developer
aggregate metrics — but deliberately as utilization health, NOT a ranked
leaderboard (see product principle; ranked leaderboard is a separate, off-by-
default feature in 2.17).

### Goal
A sortable teams list and a detailed per-team view that surfaces utilization,
cost, tool mix, git provider, and waste — without surveillance framing.

### Deliverables
TEAMS LIST:
- [ ] Sortable table: team name, developer count, active count, utilization
      rate (with green/amber/red indicator), total monthly cost, tool mix,
      waste flag
- [ ] Sortable by utilization, cost, waste, team size
- [ ] Click a team → Team Detail

TEAM DETAIL:
- [ ] Team summary cards (scoped versions of org overview metrics)
- [ ] Team adoption trend chart with time-range selector
- [ ] Developer list with AGGREGATE metrics only:
      - Activity level (active/low/inactive) shown as sparkline or indicator,
        NOT a ranked leaderboard
      - Tools used, weekly activity, monthly cost
      - Framing: "utilization health," not "performance ranking"
- [ ] Team tool breakdown (adoption + cost per tool)
- [ ] Git provider label (informational: which provider(s) host this team's repos)
- [ ] Inline waste alerts for the team
- [ ] Click a developer → that developer's aggregate detail (still no prompt content)

### Acceptance Criteria
- [ ] Teams list sorts correctly by every sortable column
- [ ] Utilization indicators use consistent thresholds (document them)
- [ ] Team Detail shows accurate scoped metrics
- [ ] Developer list shows aggregate activity WITHOUT ranking developers against
      each other (no "1st, 2nd, 3rd" framing)
- [ ] Git provider label correctly reflects the team's repo hosting
- [ ] Waste alerts for the team display inline and link to the waste screen
- [ ] Cold-start and low-data states handled
- [ ] Both screens desktop-optimized and match design aesthetic
- [ ] Loads under 2 seconds with realistic data
```

---

# TASK 2.7: Manager — Waste Detection Screen

**Branch:** `task/2.7-waste-screen`
**Depends on:** 2.3, 2.10, 2.15 (for Plan ROI alerts)
**Estimate:** 2 days

### GitHub Issue Description

```
## Task 2.7: Manager — Waste Detection Screen

### Context
This is the screen that pays for the product. It surfaces wasted AI spend:
unused seats, underutilized seats, duplicate tools, cost outliers, and — the
high-value addition — plan-change ROI alerts (developer upgraded to a pricier
plan but usage didn't rise to match). Framing throughout is spend-optimization,
never developer blame.

### Goal
A clear, actionable waste-detection screen with total savings, categorized
alerts, the Plan ROI feature, and a resolution workflow with audit trail.

### Deliverables
- [ ] Summary: total monthly waste, projected annual savings, breakdown by type
- [ ] Waste alert list, each showing: developer/seat, tool, type, monthly cost,
      details. Types: unused (14+ days inactive), underutilized (below team
      threshold), duplicate tool, cost outlier, plan_roi
- [ ] Plan ROI alerts highlighted with dedicated treatment:
      - old plan → new plan, cost delta, usage delta, time since change
      - Example: "Jane: Claude Code Pro → Max 6 weeks ago (+$180/mo),
        usage +8%. Review recommended."
- [ ] Resolution workflow: mark resolved with reason (reallocated / upgraded /
      justified / downgrade_recommended / monitor_longer / dismissed)
- [ ] Resolved alerts move to a separate "resolved" view (audit trail)
- [ ] All framing is review-oriented, never accusatory

### Acceptance Criteria
- [ ] All waste types display with correct monthly cost and details
- [ ] Plan ROI alerts show before/after plan, cost delta, and usage delta
- [ ] Total waste and projected annual savings calculated correctly
- [ ] Resolving an alert records the reason and removes it from the active list
- [ ] Resolved alerts appear in the resolved/audit view
- [ ] No alert uses accusatory language; all are framed as review prompts
- [ ] Empty state (no waste detected) shows a positive confirmation, not a blank
- [ ] Desktop-optimized, matches aesthetic, loads under 2 seconds
```

---

# TASK 2.8: Developer — My Dashboard Screen

**Branch:** `task/2.8-my-dashboard`
**Depends on:** 2.4, 2.10
**Estimate:** 2 days

### GitHub Issue Description

```
## Task 2.8: Developer — My Dashboard Screen

### Context
The developer's private landing screen. This is what makes the product
something developers WANT rather than something imposed on them. It shows their
own AI usage framed as personal growth, never as a report card and never
compared competitively to peers.

### Goal
A personal dashboard showing the developer's own stats, adoption journey, and
activity trend — useful and encouraging, not judgmental.

### Deliverables
- [ ] Personal stat cards: active days (week/month), primary tool(s),
      acceptance rate trend direction, estimated personal AI cost
- [ ] Adoption journey: timeline of when they started each tool and how usage
      evolved (including tool/plan switches from lifecycle data)
- [ ] Personal activity trend chart with time-range selector: AI interactions
      over time, with git activity (commits, PRs) overlaid
- [ ] Encouraging, non-competitive framing throughout
- [ ] NO insights text in Phase 2 (deferred to Phase 3) — just the data and trends
- [ ] NO comparison/ranking against other developers

### Acceptance Criteria
- [ ] All personal stats accurate and scoped to the authenticated developer
- [ ] Adoption journey correctly reflects tool start dates and any transitions
- [ ] Activity trend chart works with the time-range selector
- [ ] Git activity overlay reflects data across all the developer's git providers
- [ ] No competitive ranking or peer comparison appears anywhere
- [ ] Cold-start and low-data states handled (e.g., a developer tracked only a
      few days sees an appropriate "building your history" treatment)
- [ ] Desktop-optimized, matches aesthetic, loads under 2 seconds
```

---

# TASK 2.9: Developer — My Tools + My Activity Screens

**Branch:** `task/2.9-my-tools-activity`
**Depends on:** 2.4, 2.10
**Estimate:** 2 days

### GitHub Issue Description

```
## Task 2.9: Developer — My Tools + My Activity Screens

### Context
Deeper detail for the developer: per-tool usage (so they can see, e.g., "I pay
for Windsurf Max but only use autocomplete") and git correlation (so they can
self-reflect, e.g., "my churn rate is high — maybe I'm accepting AI suggestions
too quickly"). Self-awareness tools, fully private.

### Goal
Two developer screens: per-tool usage detail and git-activity correlation,
both private and self-reflection oriented.

### Deliverables
MY TOOLS:
- [ ] Per tool (only tools the developer uses): activity over time, feature
      usage breakdown (autocomplete vs chat vs agent), acceptance rate, cost
- [ ] Surfaces utilization insight implicitly (e.g., paying for a premium plan
      but only using basic features becomes visually obvious)

MY ACTIVITY:
- [ ] Git activity over time: commits, PRs, lines changed
- [ ] Code churn rate displayed with brief plain-language explanation of what
      it means (high churn = code rewritten quickly)
- [ ] Correlation view: AI usage vs output, WITHOUT overclaiming causation
- [ ] Multi-provider: aggregates the developer's activity across all git providers

### Acceptance Criteria
- [ ] My Tools shows accurate per-tool data scoped to the developer
- [ ] Feature breakdown makes under-utilization of premium plans visually apparent
- [ ] My Activity shows correct git metrics across all providers
- [ ] Churn rate displayed with a clear, non-technical explanation
- [ ] Correlation view avoids causation claims (careful copy)
- [ ] Both screens fully private (only the developer's own data)
- [ ] Cold-start and low-data states handled
- [ ] Desktop-optimized, matches aesthetic, loads under 2 seconds
```

---

# TASK 2.10: Shared Components

**Branch:** `task/2.10-shared-components`
**Depends on:** 2.1
**Estimate:** 3 days

### GitHub Issue Description

```
## Task 2.10: Shared Components

### Context
Almost every screen reuses the same building blocks. Building them once,
consistently, is what makes the dashboard feel cohesive and polished rather
than like separate pages stitched together. This task is foundational for all
UI tasks — prioritize it early.

### Goal
A library of reusable, well-designed components used across all dashboard screens.

### Deliverables
- [ ] Stat card (metric, label, optional trend indicator, optional sparkline)
- [ ] Chart wrappers built on the chosen library:
      - Line/area chart (for trends)
      - Bar chart (for comparisons)
      - Donut/distribution chart (for tool mix)
      All themeable for light/dark
- [ ] Time-range selector component (30d / 90d / year / lifetime / custom with
      date picker):
      - Smart default: smallest preset that comfortably contains available history
      - "lifetime" = from first available data for the scope
      - Remembers the user's explicit choice via /api/me/preferences
      - Used consistently on every time-series chart
- [ ] Coverage/confidence badge: shows how many real days of data back a view
- [ ] App layout shell: header, sidebar/nav, content area
- [ ] Navigation with role-aware items (manager sees manager nav, developer
      sees developer nav)
- [ ] Dark mode toggle (wired to preferences)
- [ ] Loading skeletons
- [ ] Consistent table component (sortable, used by teams list, waste, etc.)

### Acceptance Criteria
- [ ] Every component renders correctly in both light and dark mode
- [ ] Time-range selector applies smart default based on available history
- [ ] Time-range choice persists across sessions (via preferences API)
- [ ] "lifetime" correctly spans only real data (no empty axis)
- [ ] Custom range date picker validates from <= to
- [ ] Coverage badge accurately reflects data-day count for its scope
- [ ] Navigation shows correct items per role
- [ ] Components are documented (props, usage) for reuse by other tasks
- [ ] Charts are legible, polished, and free of chartjunk
```

---

# TASK 2.11: Data States (Empty / Loading / Error)

**Branch:** `task/2.11-data-states`
**Depends on:** 2.10
**Estimate:** 2 days

### GitHub Issue Description

```
## Task 2.11: Data States (Empty / Loading / Error)

### Context
During early dogfood (and any new customer's first weeks) there isn't much
data. Empty charts make a strong product feel hollow exactly when first
impressions form. Critically, we must distinguish "no data because we haven't
collected it yet" from "no data because this person genuinely isn't using the
tool" — those look similar but mean opposite things.

### Goal
A consistent set of data-state treatments applied across all screens that are
honest about data confidence and never misleading.

### Deliverables
- [ ] Cold-start state: connected but no/minimal data yet → "collecting your
      data" panel showing active connectors, when meaningful data will appear,
      and a setup-completeness checklist
- [ ] Genuine-empty state: a real signal (e.g., unused seat) → clearly
      distinguished from cold-start, never conflated
- [ ] Partial-coverage state: some developers HIGH quality, others LOW/none →
      honest per-scope confidence display
- [ ] Loading states using skeletons from 2.10
- [ ] Error states: connector failure, API error → clear, non-alarming messaging
- [ ] Low-data trend handling works WITH the time-range selector (lifetime shows
      sparse real data honestly; longer ranges show "building history")

### Acceptance Criteria
- [ ] Cold-start panel appears when a scope has no/minimal data and clearly
      communicates that collection is in progress
- [ ] Genuine-empty (e.g., truly unused seat) is visually and semantically
      distinct from cold-start
- [ ] Partial-coverage honestly shows which developers have full vs thin data
- [ ] No screen ever shows a broken-looking empty chart
- [ ] No screen ever presents thin data as if it were complete
- [ ] Error states are clear and non-alarming, with a suggested action
- [ ] All states render correctly in light and dark mode
- [ ] States are reusable components, applied consistently across all screens
```

---

# TASK 2.12: Phase 2 Integration Testing + Dogfood Prep

**Branch:** `task/2.12-integration-dogfood`
**Depends on:** all prior Phase 2 tasks
**Estimate:** 2 days

### GitHub Issue Description

```
## Task 2.12: Phase 2 Integration Testing + Dogfood Prep

### Context
Before dogfooding at WMG, verify the whole dashboard works end-to-end with real
data from all connectors and git providers, across both manager and developer
roles. This is the final gate before real users see it.

### Goal
A verified, dogfood-ready dashboard with documented setup and known-issue list.

### Deliverables
- [ ] End-to-end test: login → manager flow (overview → teams → team detail →
      waste) → logout
- [ ] End-to-end test: login → developer flow (my dashboard → my tools →
      my activity) → logout
- [ ] Cross-role isolation test: developer cannot reach manager screens or
      other developers' data
- [ ] Verify all screens with real WMG data (Copilot + Claude Code + Windsurf +
      Bitbucket + GitHub + GitLab as configured)
- [ ] Verify time-range selector across all charts with real history
- [ ] Verify waste detection (incl. Plan ROI) against real subscription data
- [ ] Performance check: all screens under 2 seconds with real data volume
- [ ] Setup/onboarding doc: how a manager deploys and reaches a working dashboard
      in under 1 hour
- [ ] Known-issues list for the dogfood

### Acceptance Criteria
- [ ] Both end-to-end role flows pass
- [ ] Cross-role isolation verified (security-critical)
- [ ] All screens render correctly with real multi-source WMG data
- [ ] No screen exceeds the 2-second load target with real data
- [ ] Setup doc enables a sub-1-hour deployment (validated by following it fresh)
- [ ] Dogfood readiness checklist complete and signed off
```

---

# TASK 2.13: Admin Management UI

**Branch:** `task/2.13-admin-ui`
**Depends on:** 2.2, 2.10
**Estimate:** 3 days

### GitHub Issue Description

```
## Task 2.13: Admin Management UI

### Context
Phase 1 exposed user/team/subscription management only via CLI — fine for the
technical founder but unrealistic for other team leads, and it undermines the
"deploy in an afternoon" promise. This task adds a web admin area (admin role
only) wrapping the existing capabilities.

NOTE on terminology: "plans" here means the AI tool subscription plans tracked
for cost analysis (Copilot Business, Claude Code Max, etc.) — NOT GovProxy's
own pricing tiers.

### Goal
A web-based admin area for managing users, teams, identity mappings, and
subscriptions without touching the CLI.

### Deliverables
- [ ] Users management: create, edit, deactivate accounts; assign role
      (admin/developer); trigger password reset; link account to a developer record
- [ ] Teams management: create, edit, archive teams; assign manager; move
      developers between teams
- [ ] Developer identity mapping: link tool identities (Copilot username,
      Claude Code email, Windsurf email) and git author emails — editable UI
      over the Phase 1 external_ids + git-email mapping
- [ ] Subscriptions management: assign a tool subscription to a developer, set
      plan and monthly cost, change or end a subscription (drives lifecycle
      handling in 2.14)
- [ ] Data sources view: connector + git provider status (read-only in Phase 2;
      configuration stays in config file)
- [ ] Admin endpoints from the design doc (GET/POST/PATCH /api/admin/*)

### Acceptance Criteria
- [ ] All admin functions work via UI without needing the CLI
- [ ] Creating a user generates a temporary password / setup flow (ties to 2.2)
- [ ] Identity mapping correctly updates external_ids and git-email mappings
- [ ] Changing a subscription triggers the lifecycle pattern from 2.14
      (revoke-old + create-new), not a silent overwrite
- [ ] Deactivating a user prevents their login but preserves their historical data
- [ ] All admin endpoints reject developer-role sessions (403)
- [ ] Data sources view accurately reflects connector/provider status
- [ ] Desktop-optimized, matches aesthetic
- [ ] Unit + integration tests for each admin function
```

---

# TASK 2.14: Subscription Lifecycle Handling

**Branch:** `task/2.14-subscription-lifecycle`
**Depends on:** Phase 1 subscriptions, 2.13 (UI surface)
**Estimate:** 2 days

### GitHub Issue Description

```
## Task 2.14: Subscription Lifecycle Handling

### Context
Developers change tools and plans over time. We must record transitions
accurately rather than overwriting history — both for correct cost-over-time
accounting and to enable the Plan ROI feature (2.15). The data model already
supports this via seat_assigned_at / seat_revoked_at; this task implements the
LOGIC.

### Goal
Correct handling of plan upgrades/downgrades and tool switches, preserving full
history, with transition-aware logic across the system.

### Deliverables
- [ ] Subscription change logic: a plan change or tool switch sets
      seat_revoked_at on the old row and creates a new row with the new
      plan/cost and fresh seat_assigned_at (never an in-place overwrite)
- [ ] Cost-over-time calculations use the active subscription for each date so
      historical monthly costs remain accurate across changes
- [ ] Expense importer (Phase 1 Task 1.8) updated: detects when an imported
      record is a CHANGE to an existing subscription vs a genuinely new one,
      and applies revoke-old + create-new instead of creating duplicates
- [ ] Waste detector updated: ignores recently-transitioned seats for the
      inactivity window (a seat assigned yesterday isn't "unused for 14 days")
- [ ] Records plan_change_events rows (feeds 2.15 ROI detection)
- [ ] Adoption-journey data (developer view) reflects transitions

### Acceptance Criteria
- [ ] Changing a plan preserves the old subscription with a revoke date and
      creates a new active one
- [ ] Cost-over-time for a developer who upgraded mid-month is calculated
      correctly for each date range
- [ ] Expense import detects changes and does NOT create duplicate active subs
- [ ] A freshly-transitioned seat is not flagged as "unused" by the waste detector
- [ ] plan_change_events is populated on every plan/tool change with before/after
      plan and cost
- [ ] Historical tool_snapshots remain intact and correctly attributed across
      transitions
- [ ] Unit tests: upgrade, downgrade, tool switch, import-detected change,
      waste-detector transition exemption
```

---

# TASK 2.15: Plan-Change ROI Detection

**Branch:** `task/2.15-plan-roi`
**Depends on:** 2.14, 2.16 (for thresholds)
**Estimate:** 2 days

### GitHub Issue Description

```
## Task 2.15: Plan-Change ROI Detection

### Context
A high-value manager feature: when a developer moves to a more expensive plan,
watch whether usage rises enough to justify it. Vendor dashboards will never
surface this because they benefit from upsell — it's exactly the
incentive-aligned insight that justifies the platform to a budget-conscious
manager. Framing is always "review," never "developer did something wrong."

### Goal
Detect plan upgrades whose usage increase doesn't justify the cost increase,
and surface them as review-oriented alerts.

### Deliverables
- [ ] Baseline capture: on a plan upgrade (cost increase), record average usage
      in the N days before the change (configurable; default 30)
- [ ] Post-change evaluation: after a settling period (configurable; default 30
      days), compute average post-change usage
- [ ] ROI comparison: compare cost-increase ratio vs usage-increase ratio; flag
      when cost rose disproportionately (default: cost ratio >= 3x usage ratio)
- [ ] Threshold values read from settings (global default, optional per-team
      override) — see 2.16
- [ ] Create a waste_alert of type plan_roi when flagged, with before/after
      plan, cost delta, usage delta, time since change
- [ ] Scheduled evaluation job: checks plan_change_events whose settling period
      has elapsed but aren't yet evaluated
- [ ] Review-oriented framing in all output

### Acceptance Criteria
- [ ] Baseline usage captured correctly at time of upgrade
- [ ] Post-change evaluation runs only after the settling period elapses
- [ ] A large cost increase with negligible usage increase is flagged
- [ ] A cost increase MATCHED by a proportional usage increase is NOT flagged
- [ ] Thresholds are read from settings and respect per-team overrides when allowed
- [ ] Generated alert contains old→new plan, cost delta, usage delta, elapsed time
- [ ] Alert language is review-oriented, never accusatory
- [ ] Downgrades and lateral changes do not generate ROI alerts
- [ ] Unit tests: justified upgrade, unjustified upgrade, settling-period gating,
      threshold override behavior
```

---

# TASK 2.16: Settings & Configuration

**Branch:** `task/2.16-settings`
**Depends on:** 2.2
**Estimate:** 2 days

### GitHub Issue Description

```
## Task 2.16: Settings & Configuration

### Context
Several behaviors need to be configurable through the UI rather than hardcoded:
the optional leaderboard (off by default), Plan ROI thresholds, and per-user UI
preferences. The pattern is global default + optional per-team override, with
the site admin controlling whether managers may override.

### Goal
A settings system supporting global and per-team configuration with a clear
permission model, plus per-user UI preferences.

### Deliverables
- [ ] Database migration: settings table (scope, scope_name, key, value)
- [ ] Database migration: user_preferences table (user_id, key, value)
- [ ] Settings endpoints:
      - GET/PATCH /api/settings/global (admin only)
      - GET/PATCH /api/settings/team/:team (admin, or manager if globally permitted)
      - GET/PATCH /api/me/preferences (own preferences)
- [ ] Global settings supported in Phase 2:
      - leaderboard_enabled (bool, default false)
      - leaderboard_managers_can_enable (bool, default false)
      - roi_threshold (number, default 3.0)
      - roi_settling_days (number, default 30)
      - roi_managers_can_override (bool, default false)
- [ ] Per-team overrides honored only when the corresponding
      managers_can_* flag is true
- [ ] Per-user preferences: default_time_range, dark_mode
- [ ] Settings UI (admin area): global settings panel + per-team settings
- [ ] Resolution helper: given a setting key and team, returns effective value
      (team override if allowed and set, else global default)

### Acceptance Criteria
- [ ] Global settings persist and are returned correctly
- [ ] Per-team override applies ONLY when the global managers_can_* flag is true
- [ ] When override is disallowed, team-level PATCH is rejected or ignored with
      a clear message
- [ ] Effective-value resolution returns the correct value (override vs default)
- [ ] roi_threshold and roi_settling_days actually drive the 2.15 ROI logic
- [ ] leaderboard_enabled actually gates the 2.17 leaderboard
- [ ] Per-user preferences persist and drive UI (time-range default, dark mode)
- [ ] Non-admins cannot change global settings
- [ ] Unit tests: permission model, override resolution, default fallback
```

---

# TASK 2.17: Optional Leaderboard View

**Branch:** `task/2.17-leaderboard`
**Depends on:** 2.16, 2.6
**Estimate:** 1–2 days

### GitHub Issue Description

```
## Task 2.17: Optional Leaderboard View

### Context
A ranked leaderboard of developers conflicts with the product's coaching-not-
surveillance principle, and the founder's view is that it should NOT be the
default experience. However, buyers will ask for it. The resolution: build it
as a capability that ships OFF by default, gated by settings, so we can say yes
without compromising the default product.

### Goal
A ranked team leaderboard that is fully gated behind settings and disabled by
default.

### Deliverables
- [ ] GET /api/leaderboard/:team endpoint — returns 403 when leaderboard
      disabled by settings
- [ ] Leaderboard UI: ranked developer view within a team (by activity,
      acceptance, or output metric)
- [ ] Visible/accessible ONLY when:
      - leaderboard_enabled is true globally, AND
      - either accessed by admin, or by a manager when
        leaderboard_managers_can_enable is true and the team has enabled it
- [ ] When disabled, the leaderboard nav item / route is hidden, not just blocked
- [ ] Clear documentation that this is off by default by design

### Acceptance Criteria
- [ ] With leaderboard_enabled = false (default), the endpoint returns 403 and
      the UI entry point is not shown anywhere
- [ ] With leaderboard_enabled = true, admin can view team leaderboards
- [ ] Manager access respects leaderboard_managers_can_enable and per-team setting
- [ ] Ranking is accurate for the chosen metric
- [ ] The default product experience (with leaderboard off) shows no trace of it
- [ ] Unit tests: gating logic for every combination of global/team/role settings
```

---

## Phase 2 Completion Checklist

After all 17 tasks are merged:

```
[ ] Manager logs in → sees org overview with real multi-tool data
[ ] Manager drills into teams → team detail → identifies waste
[ ] Plan ROI alert correctly flags an unjustified upgrade (test with real data)
[ ] Manager resolves a waste alert → moves to audit trail
[ ] Developer logs in → sees ONLY their own private dashboard
[ ] Developer cannot access manager screens or other developers' data
[ ] Time-range selector works across all charts (30d/90d/year/lifetime/custom)
[ ] Cold-start and low-data states look intentional, not broken
[ ] Admin creates a user + team + subscription entirely via UI (no CLI)
[ ] Subscription change preserves history (revoke-old + create-new)
[ ] Leaderboard is invisible by default; appears only when enabled in settings
[ ] All git-related views work across Bitbucket + GitHub + GitLab
[ ] Every screen loads under 2 seconds with real WMG data
[ ] npm test — all tests pass
[ ] Setup doc enables sub-1-hour deployment
```

**Phase 2 is complete when a manager opens the dashboard every morning instead
of running CLI commands, and developers voluntarily check their own view.**

Next: Phase 3 — Aggregation Engine + AI-Generated Summaries

---

*End of Document — GovProxy Phase 2 Task Tracker*
