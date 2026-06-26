# Getting started — your first hour

This is a guided first run: install, configure credentials, register your people,
pull data, and read the results. The goal mirrors the product promise — within
about an hour you should see a unified view of AI adoption across your teams.

> Commands are shown for PowerShell on Windows. Environment variables set with
> `$env:NAME = "..."` last only for the current terminal session.

## 1. Install and build

```powershell
npm install
npm run build      # required for `npx govproxy`
```

See [Installation](./installation.md) for prerequisites and Docker.

## 2. Configure credentials

GovProxy reads `govproxy.config.yaml` and substitutes `${VAR}` placeholders from
the environment. Two things to do: edit the YAML for non-secret IDs, and export
env vars for the secrets.

**Edit the YAML** (these are plain strings, not env placeholders):

| Field | Set to |
|---|---|
| `connectors.copilot.github_org` | your GitHub org login |
| `connectors.claude_code.org_id` | your Anthropic organization ID |
| `connectors.git.org` | your GitHub org login |
| `connectors.git.repos` | list of bare repo names (or `[]` for all) |

Set `enabled: false` on connectors you aren't testing yet — `doctor` checks every
enabled connector, so disabling avoids noise. For a fast first run, use the
shipped `govproxy.github-only.config.yaml` (Copilot + Git enabled) and pass it
with `-c`.

**Export secrets:**

```powershell
$env:GITHUB_API_TOKEN        = "ghp_..."           # Copilot connector
$env:GIT_API_TOKEN           = "ghp_..."           # Git connector (same PAT is fine)
$env:ANTHROPIC_ADMIN_API_KEY = "sk-ant-admin-..."  # Claude Code
$env:WINDSURF_SERVICE_KEY    = "..."               # Windsurf
$env:CURSOR_SERVICE_KEY      = "..."               # Cursor
```

Token scopes are detailed in [Connectors](./connectors.md).

## 3. Initialize the database and register people

```powershell
npx govproxy db migrate          # creates ./data/govproxy.db and applies migrations

# Teams
npx govproxy team add --name frontend --department engineering --manager goran
npx govproxy team list

# Developers — email enables expense matching; --github enables git/Copilot mapping
npx govproxy dev add --name "Ada Lovelace" --team frontend --email ada@acme.com --github adalovelace
npx govproxy dev list

# Link the developer's identities across tools and git providers
npx govproxy dev link --id <dev-id> --copilot adalovelace --claude ada@acme.com --windsurf ada@acme.com
```

A developer can map to **multiple** tool identities and **multiple** git author
emails — that cross-tool identity mapping is what lets GovProxy unify a person's
activity. Use `--bitbucket` / `--gitlab` / `--git-email` (repeatable) as needed.

**Optional — auto-discover** developers from a GitHub org (reads `GITHUB_TOKEN` or
`--token`):

```powershell
$env:GITHUB_TOKEN = "ghp_..."
npx govproxy dev discover --org my-org --team frontend
```

## 4. Create your dashboard login

The dashboard uses per-user accounts. Bootstrap an admin:

```powershell
npx govproxy user create-admin --email you@acme.com
# prints a temporary password; you'll be forced to change it on first login
```

## 5. Validate the setup

```powershell
npx govproxy doctor
```

`doctor` checks the config file, database migrations, and the **live
reachability** of every enabled connector's credentials. Each failure prints a
`Fix:` hint. Get it green before syncing.

## 6. Pull data

```powershell
npx govproxy sync all            # Copilot → Claude Code → Windsurf → Cursor → Git
# or one at a time:
npx govproxy sync copilot
npx govproxy sync git
```

Each connector prints `N written, M skipped`. Syncs are idempotent — re-running
updates the day's rows rather than duplicating them. One connector failing does
not block the others.

## 7. Import expenses (optional)

A sample CSV ships at `data/expenses/sample-subs.csv`:

```powershell
npx govproxy expenses import .\data\expenses\sample-subs.csv
```

Developers must already exist with matching emails. A blank `monthly_cost` falls
back to `expenses.subscription_defaults`. See
[Expenses & waste](./expenses-and-waste.md).

## 8. See the results

**Via CLI:**

```powershell
npx govproxy status              # unified summary: devs, connectors, cost, waste, data quality
npx govproxy waste show          # runs detection + lists alerts by type
npx govproxy expenses show       # subscriptions and monthly cost
```

**Via the dashboard / REST API** — start the server with `npm run dev`, then open
**http://localhost:8080/dashboard** and log in, or hit the API:

```powershell
curl http://localhost:8080/health            # -> {"status":"ok"}
curl http://localhost:8080/api/overview
curl http://localhost:8080/api/teams
curl http://localhost:8080/api/waste
```

## 9. Build trend depth immediately

You don't have to wait weeks for trends. Backfill aggregates from the daily
snapshots you just pulled:

```powershell
npx govproxy aggregate backfill          # default: last 12 months
```

Then, if you've enabled summaries with a local model, generate a narrative:

```powershell
npx govproxy summary generate --level monthly --period 2026-05 --scope org
npx govproxy summary show     --level monthly --period 2026-05 --scope org
```

## Where to go next

- [Connectors](./connectors.md) — connect more tools and multiple git providers
- [Dashboard](./dashboard.md) — what every screen shows
- [Aggregation & AI summaries](./aggregation-and-summaries.md) — trends and reports
- [Coaching](./coaching.md) — give developers their private mirror
- [Operations & troubleshooting](./operations-and-troubleshooting.md) — scheduling and gotchas
