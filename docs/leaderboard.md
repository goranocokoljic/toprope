# Leaderboard (optional, OFF by default)

The ranked team leaderboard is an **optional** capability. It ships **disabled by
default and is disabled by design.**

## Why it is off by default

A ranked leaderboard of developers conflicts with GovProxy's core
coaching-not-surveillance principle. The default manager experience is the
privacy-respecting utilization view — non-adopters surface only in the
waste/utilization context, never as a ranked list.

Buyers nonetheless ask for leaderboards. The resolution is to build it as a
capability that is **ready but off**: a site-level setting controls whether it is
available at all, and a second setting controls whether individual team managers
may enable it for their team. This lets us say "yes, it's supported" without
compromising the default product.

When the leaderboard is off, it leaves **no trace** in the UI: the nav entry is
absent (not merely a disabled/blocked link), the route renders an ordinary
not-found page, and the API returns `403` for the data endpoint.

## Settings that gate it

Both live in the global settings (`GET/PATCH /api/settings/global`) and per-team
settings (`GET/PATCH /api/settings/team/:team`). See `src/settings/registry.ts`.

| Key | Scope | Default | Meaning |
|-----|-------|---------|---------|
| `leaderboard_enabled` | global (team-overridable) | `false` | Master switch. When false, nobody sees the leaderboard. |
| `leaderboard_managers_can_enable` | global | `false` | Whether a team manager may opt their team in/out via a per-team override of `leaderboard_enabled`. |

A per-team override of `leaderboard_enabled` is only honored when
`leaderboard_managers_can_enable` is true (the standard global + per-team override
pattern, shared with the ROI threshold settings).

## Access rules

The gate is a pure function — `canAccessLeaderboard` in
`src/dashboard/api/leaderboard-gate.ts` — evaluated per request:

1. The global master switch `leaderboard_enabled` must be `true`. When it is
   false, **everyone** is denied.
2. Then, by role:
   - **admin** → may view any team's leaderboard.
   - **manager** → may view only when `leaderboard_managers_can_enable` is true
     **and** the team has it enabled (the resolved per-team value).
   - **developer** (or any other role) → never.

In the current codebase the manager-facing role is `admin` (a dedicated manager
role is a future addition); the `manager` branch above is the seam it will plug
into, and is fully covered by the gating unit tests.

## API

- `GET /api/leaderboard/availability` — cheap capability probe used by the
  dashboard nav. Returns `{ available, leaderboard_enabled, managers_can_enable }`.
- `GET /api/leaderboard/:team?metric=activity|acceptance|output` — the ranked
  view. Returns `403` (`code: leaderboard_disabled`) whenever the gate denies
  access, including the default disabled state. `404` if the team does not exist.

Ranking metrics: `activity` (total tool interactions), `acceptance` (accepted
suggestions ÷ interactions), or `output` (git commits). All three values are
returned for every developer; the chosen metric drives the sort. Ties share a
rank (standard competition ranking: 1, 2, 2, 4). A supported time window
(`range` / `from` + `to`) may be supplied; it defaults to the last 30 days.
