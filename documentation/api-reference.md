# REST API reference

Toprope exposes a JSON REST API that powers the dashboard and supports
automation/export. This is a reference to the available endpoints, grouped by
area. Start the server with `npm run dev` (development) or `node dist/server.js`
(production); the API listens on port 8080.

## Authentication & access model

- The dashboard authenticates with **per-user login sessions** (cookie-based).
  Obtain a session via the auth routes below.
- An `onRequest` gate guards every `/api/*` route except login. **Developers are
  confined to `/api/me/*` and `/api/auth/*`**; all other routes require an
  **admin** session. This is the API-level enforcement of the privacy model.
- `GET /health` is always open and unauthenticated.
- Set `dashboard.auth.cookie_secure: true` behind HTTPS.

> A legacy `DASHBOARD_PASSWORD` basic-auth mode exists for Phase-1 compatibility
> but is superseded by user accounts.

## System

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness — always returns `{"status":"ok"}` |

## Auth

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/login` | Log in; establishes a session |
| POST | `/api/auth/logout` | Log out |
| GET | `/api/auth/me` | Current session user |

## Organization & teams (admin)

| Method | Path | Description |
|---|---|---|
| GET | `/api/overview` | Org-wide summary metrics |
| GET | `/api/overview/trend` | Org adoption trend over a time range |
| GET | `/api/teams` | All teams with summary metrics (paginated) |
| GET | `/api/teams/:team` | Team detail with per-developer aggregate cards |
| GET | `/api/teams/:team/providers` | Git providers for a team |
| GET | `/api/teams/compare-table` | Sortable all-teams table for a quarter |
| GET | `/api/compare?teams=a,b,c` | Rich side-by-side comparison of 2–4 teams |
| GET | `/api/coverage` | Multi-source coverage / data-quality indicator |
| GET | `/api/tools/distribution` | Tool distribution across the org |

## Developers (admin; aggregate-safe)

| Method | Path | Description |
|---|---|---|
| GET | `/api/developers/:id` | Developer detail |
| GET | `/api/developers/:id/timeline` | Daily activity timeline |
| GET | `/api/developers/:id/journey` | Adoption-journey (manager-aggregate view) |

## Waste (admin)

| Method | Path | Description |
|---|---|---|
| GET | `/api/waste` | Active waste alerts (paginated, `?team=`) |
| GET | `/api/waste/summary` | Waste grouped by team |
| GET | `/api/waste/resolved` | Resolved-alert audit trail |

## Aggregates, maturity & summaries (admin)

| Method | Path | Description |
|---|---|---|
| GET | `/api/aggregates/:scope/:level` | Pre-computed aggregates for a scope and level |
| GET | `/api/maturity/:team/trend` | AI maturity score trend (git-estimate labeled) |
| GET | `/api/summaries` | List AI-generated summaries |
| GET | `/api/summaries/:id` | A specific summary's text + metadata |

(Summary generation/regeneration is also driven from the CLI and the dashboard
summaries panel — see [Aggregation & AI summaries](./aggregation-and-summaries.md).)

## Anomalies (admin)

| Method | Path | Description |
|---|---|---|
| GET | `/api/anomalies?status=` | List anomalies (team-scope) |
| POST | `/api/anomalies/:id/acknowledge` | Acknowledge an anomaly |
| POST | `/api/anomalies/:id/resolve` | Resolve an anomaly |

## Surveys

| Method | Path | Description |
|---|---|---|
| GET | `/api/surveys/:id` | Survey detail (admin) |
| POST | `/api/surveys/:id/send` | Send a queued survey (admin) |
| POST | `/api/surveys/:id/dismiss` | Dismiss a queued survey (admin) |
| POST | `/api/surveys/run` | Run the trigger sweep (admin) |
| GET | `/api/me/surveys` | The developer's own surveys |
| POST | `/api/me/surveys/:id/decline` | Decline one's own survey |

## Snapshots & export (admin)

| Method | Path | Description |
|---|---|---|
| GET | `/api/snapshots` | Raw daily snapshots (filter by date/team) |
| GET | `/api/export` | CSV/JSON export (`?format=csv&from=&to=`) |

## Coaching — manager aggregates (admin, floored)

Every route here is structurally aggregate-only and minimum-group-size floored; no
route accepts a developer id, so no individual coaching is reachable.

| Method | Path | Description |
|---|---|---|
| GET | `/api/coaching/manager/org` | Unified team-level coaching panel (org) |
| GET | `/api/coaching/manager/team/:team` | Unified team-level coaching (team) |
| GET | `/api/coaching/pr-review/org` | Team aggregate PR/review coaching (org) |
| GET | `/api/coaching/pr-review/team/:team` | Team aggregate PR/review coaching (team) |
| GET | `/api/coaching/available/org` | Team aggregate available-data coaching (org) |
| GET | `/api/coaching/available/team/:team` | Team aggregate available-data coaching (team) |

## Developer-private surface (`/api/me`)

These require a session and only ever return the **signed-in developer's own**
data.

**Profile & activity**

| Method | Path | Description |
|---|---|---|
| GET | `/api/me/profile` | Own profile |
| GET | `/api/me/overview` | Own overview |
| GET | `/api/me/tools` | Own per-tool usage |
| GET | `/api/me/timeline` | Own activity timeline |
| GET | `/api/me/activity` | Own git activity + churn |
| GET | `/api/me/journey` | Own adoption journey |
| GET/PATCH | `/api/me/preferences` | UI preferences |

**Coaching (private)**

| Method | Path | Description |
|---|---|---|
| GET | `/api/me/coaching` | Available-data coaching (Pillar 1) |
| GET | `/api/me/pr-coaching` | PR/review trajectory (Pillar 2) |
| GET/PATCH | `/api/me/coaching-preferences` | Coaching opt-ins & preferences |
| GET | `/api/me/coaching/realtime-settings` | Real-time coaching settings |
| POST/GET | `/api/me/coaching/loop-events` | Record/read loop-event metadata |
| POST/GET | `/api/me/coaching/nudge-events` | Record/read nudge-event metadata |
| POST | `/api/me/coaching/nudge-events/:id/dismiss` | Dismiss a nudge |

**Prompt capture (encrypted, blind store)**

| Method | Path | Description |
|---|---|---|
| POST/GET | `/api/me/captures` | Ingest / list own encrypted captures |
| GET/DELETE | `/api/me/captures/:id` | Read / delete one capture |
| POST/GET | `/api/me/capture-key` | Set / read own key metadata + recovery posture |
| POST | `/api/me/capture-key/recovery/initiate` | Begin a recovery |
| POST | `/api/me/capture-key/recovery/complete` | Complete a recovery |
| GET | `/api/me/capture-key/recovery-log` | Developer-visible recovery audit |

**Retrospectives (private)**

| Method | Path | Description |
|---|---|---|
| POST/GET | `/api/me/retrospectives` | Generate / list own retrospectives |
| GET/DELETE | `/api/me/retrospectives/:id` | Read / delete one |
| POST | `/api/me/retrospectives/:id/followup` | Conversational follow-up |

**Showcase (owner-driven)**

| Method | Path | Description |
|---|---|---|
| POST | `/api/me/showcase/draft` | Promote one's own session into an editable draft |
| POST | `/api/me/showcase` | Publish a redacted example to the shared store |
| GET | `/api/me/showcase` | Browse within access scope |
| GET | `/api/me/showcase/:id` | Own published example |
| GET | `/api/me/showcase/browse/:id` | Browse a shared example |
| POST | `/api/me/showcase/:id/unpublish` | Unpublish one's own example |
| GET | `/api/me/showcase/removals` | Author removal-notice feed |
| POST | `/api/me/showcase/removals/:id/acknowledge` | Acknowledge a removal notice |

## Admin & settings

| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/admin/users` | List / create accounts |
| GET/POST | `/api/admin/teams` | List / create teams |
| GET/POST | `/api/admin/subscriptions` | List / create subscriptions |
| GET/POST | `/api/admin/developers` | List developers / create one. The create replays the new developer's retained git history and returns `replay.dates_attributed`. |
| GET | `/api/admin/developers/candidates` | Review queue: retained git authors that map to no developer, busiest first |
| GET | `/api/admin/data-sources` | Connector / provider status |
| POST | `/api/admin/reconciliation/run` | Run expense reconciliation |
| GET/POST | `/api/admin/showcase`, `.../:id/remove` | Team-lead showcase moderation (remove only) |
| GET/PATCH | `/api/settings/global` | Global settings |
| GET | `/api/settings/team/:team` | Team settings |
| GET/PATCH | `/api/settings/anomaly`, `.../team/:team` | Anomaly thresholds |
| GET | `/api/leaderboard/availability`, `/api/leaderboard/:team` | Optional leaderboard (off by default) |

## Notes

- List endpoints support pagination (`?page=&limit=`) and, where relevant, date
  (`?from=&to=`) and `?team=` filtering.
- Empty states return empty arrays, not errors.
- This table reflects the registered routes; consult the dashboard network tab or
  the route modules under `src/dashboard/api/` for exact request/response shapes.
