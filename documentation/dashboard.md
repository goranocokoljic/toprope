# Dashboard

The dashboard is a React single-page app served by Fastify at **`/dashboard`**.
It's the single pane of glass — manager views for the org and teams, strictly
private views for each developer, plus admin and settings screens. Everything it
shows comes from the same REST API documented in the
[API reference](./api-reference.md).

Start the server (`npm run dev` for development, or `node dist/server.js` in
production) and open **http://localhost:8080/dashboard**.

## Accounts and authentication

- Authentication is **per-user accounts** with email + password (argon2 hashing),
  managed via login sessions. The legacy Phase-1 `admin_password` is retained for
  config compatibility but no longer enforced.
- **Bootstrap an admin** from the CLI:
  `toprope user create-admin --email you@acme.com`. A generated temporary
  password forces a change on first login.
- Admins provision further accounts (admin or developer) from **Admin →
  Management** or `POST /api/admin/users`.
- **Roles:** `admin` (manager) and `developer`. The API gateway confines
  developers to `/api/me/*` and `/api/auth/*` — a developer can never reach
  another person's data or any team aggregate that would reveal an individual.
- Set `dashboard.auth.cookie_secure: true` whenever the dashboard is reached over
  HTTPS (including behind a TLS-terminating proxy). Configure session lifetime
  with `session_ttl_hours`.

## Manager views

### Organization Overview
Top-line metric cards, tool distribution, a hero adoption-trend chart, and a
multi-source **coverage indicator** that combines data-quality tiers, connected
tool connectors, and git providers (with repo counts). The coverage badge is how a
manager sees, at a glance, how much of the picture is measured vs estimated.

### Teams List
A sortable list of all teams with utilization, cost, and waste indicators.

### Team Detail
Team-scoped metrics, an adoption trend, and **per-developer aggregate cards** that
show utilization *health* — deliberately **not** a ranking. Includes the team's
tool breakdown, its git-provider label, and inline waste for the team. (A team is
shown with the weakest-link data tier of its members, never overstated.)

### Waste Detection
Categorized waste alerts with totals, **projected annual savings**, the resolution
workflow + audit trail, and plan-ROI review items. See
[Expenses & waste](./expenses-and-waste.md).

### Team comparison
Rich side-by-side comparison of 2–4 teams — every metric, the tool mix, an
overlaid trend, each team's data-quality tier, and maturity with its
`git_estimate` basis labeled. A sortable all-teams table for a selected quarter is
also available.

## Developer views (private)

Visible only to the signed-in developer; never to a manager.

- **My Dashboard** — personal stats, adoption journey, and activity trend (no peer
  ranking).
- **My Tools** — per-tool usage detail.
- **My Activity** — git correlation and code churn, with a plain-language
  explanation of what churn means rather than a bare number.
- **Adoption journey** — a timeline from first to latest AI activity, with
  tool/plan transitions and annotated milestones (first active week, sustained
  ramp, plateau), tier-labeled.
- **My Coaching** / **My Tools coaching** / retrospectives / showcase — the
  Phase-5 surfaces, covered in [Coaching](./coaching.md).

## Data-quality UX

The tier model from [Core concepts](./concepts.md#data-quality-tiers) is visible
throughout: HIGH/MEDIUM/LOW/NONE markers on cards and charts, tier-aware waste
framing, and explicit cold-start / genuine-empty / partial-coverage empty states
so a new or sparsely-covered deployment never looks broken or fabricated.

## Optional leaderboard

A ranked team view exists because buyers ask for it, but ships **OFF by default**
on principle. It's gated by a global setting plus a per-team override, surfaced
through `/api/leaderboard/*`. Enable it only deliberately.

## Admin & settings

- **Admin → Management** — users, teams, identity mapping, and subscriptions (a UI
  over the Phase-1 CLI capabilities).
- **Admin → Developer identities** — add developers (**＋ Add developer**), link their
  tool and git identities, move them between teams, and work the **Unmatched authors**
  review queue: git authors in the synced history that map to nobody, each promotable
  to a developer in one click. Adding or promoting someone attributes their retained
  history on the spot. See
  [Getting developers into Toprope](./developer-onboarding.md).
- **Admin → Reconciliation** — review expense/subscription mismatches.
- **Admin → Git Providers** — connect, test, edit, remove, and sync git providers
  (GitHub, GitLab, Bitbucket incl. self-hosted) and choose which repositories are
  analyzed, entirely from the UI — the primary path, replacing config-file edits.
  Adding a token provider requires `TOPROPE_SECRET_KEY` (see
  [Connectors](./connectors.md#adding-a-provider-from-the-dashboard)). Config-file
  providers show here as read-only.
- **Settings** — global defaults plus per-team overrides under a permission model,
  covering anomaly thresholds, survey-trigger auto-send, plan-ROI thresholds,
  coaching-pillar enablement, leaderboard visibility, and alert channels.
- **Preferences** — per-user UI preferences (default time range, dark mode).

## Shared UI

- **Time-range selector** — 30d / 90d / year / lifetime / custom, with smart
  defaults based on available history ("lifetime" runs from your first data) and
  remembered per user.
- Coverage/confidence badges, stat cards, chart wrappers, sortable tables, loading
  skeletons, dark mode, and role-aware navigation.
