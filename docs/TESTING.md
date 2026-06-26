# GovProxy — Initial Testing Guide

A short, practical walkthrough for testing GovProxy after Phase 1 (tasks 1.1–1.12).
You'll configure credentials, register developers, pull data, and inspect results
via the CLI and REST API.

> Commands below use PowerShell (Windows). Environment variables set with
> `$env:NAME = "..."` last only for the current terminal session.

---

## 1. Install & build

```powershell
npm install
npm run build      # compiles to dist/ — required for the `npx govproxy` CLI
```

You can run the CLI two ways:

- **Built:** `npx govproxy <cmd>` (needs `npm run build` first)
- **From source (no build):** `npx tsx src/cli.ts <cmd>`

This guide uses `npx govproxy`.

---

## 2. Configure credentials

GovProxy reads `govproxy.config.yaml` and substitutes `${VAR}` placeholders from
environment variables at load time. Two things to set: **edit the YAML** for the
non-secret IDs, and **export env vars** for the secrets.

### 2a. Edit `govproxy.config.yaml`

Replace the placeholder org/IDs (these are NOT env-substituted):

| Field | Change to |
|-------|-----------|
| `connectors.copilot.github_org` | your GitHub org login |
| `connectors.claude_code.org_id` | your Anthropic organization ID |
| `connectors.git.org` | your GitHub org login |
| `connectors.git.repos` | list of repo names — see [Git setup](#3-git-connection) |

**Disable connectors you're not testing** by setting `enabled: false`. The
`doctor` command checks every enabled connector, so disabling avoids noise.

> **Shortcut for a GitHub-only run:** use the ready-made
> [`govproxy.github-only.config.yaml`](../govproxy.github-only.config.yaml)
> (Copilot + Git enabled, Anthropic/Windsurf disabled). Pass it to any CLI
> command with `-c`, e.g. `npx govproxy doctor -c govproxy.github-only.config.yaml`,
> or point the dev server at it:
> `$env:GOVPROXY_CONFIG = "govproxy.github-only.config.yaml"; npm run dev`.
> Edit the `your-org` / `your-repo` placeholders before running.

### 2b. Export secrets (env vars)

The YAML placeholders map to these exact variable names:

```powershell
$env:GITHUB_API_TOKEN      = "ghp_..."   # copilot connector  (${GITHUB_API_TOKEN})
$env:GIT_API_TOKEN         = "ghp_..."   # git connector       (${GIT_API_TOKEN})  — same PAT is fine
$env:ANTHROPIC_ADMIN_API_KEY = "sk-ant-admin-..."  # claude code (${ANTHROPIC_ADMIN_API_KEY})
$env:WINDSURF_SERVICE_KEY  = "..."       # windsurf            (${WINDSURF_SERVICE_KEY})
$env:DASHBOARD_PASSWORD    = "secret"    # optional API basic-auth password
```

**Token scopes:**
- **GitHub PAT** (Copilot + Git): repo read access; for Copilot also
  `manage_billing:copilot` and org-admin rights.
- **Anthropic Admin key**: must have Usage Analytics permission.
- **Windsurf service key**: must have analytics permission.

> If you set `DASHBOARD_PASSWORD`, the REST API requires HTTP Basic auth.
> Leave it unset for the easiest local testing (API is then open — the server
> logs a warning).

---

## 3. Git connection

The git connector pulls commits/PRs **via the GitHub API** (no local clone). It
lists all repos in `connectors.git.org`, then filters by `connectors.git.repos`:

```yaml
connectors:
  git:
    org: "my-org"
    repos:
      - "service-api"          # include this repo (bare name, not owner/repo)
      - "web-frontend"
      # - "exclude:legacy-app" # optional: exclude prefix
```

- Entries are **bare repo names** (matched against the repo name within the org).
- Leave `repos: []` to sync **all** org repos — but note `doctor` flags an empty
  list as a failure (see [Gotchas](#gotchas)).

Git activity is attributed to a developer by matching the commit author's GitHub
login to the developer's linked `--github` username (step 4).

---

## 4. Initialize DB & register developers

```powershell
npx govproxy db migrate          # creates ./data/govproxy.db and applies migrations

# Teams
npx govproxy team add --name frontend --department engineering --manager goran
npx govproxy team list

# Developers (email is needed for expense import; github for git/copilot mapping)
npx govproxy dev add --name "Ada Lovelace" --team frontend --email ada@acme.com --github adalovelace
npx govproxy dev list

# Link tool identities so synced data attributes to the right developer
npx govproxy dev link --id <dev-id> --copilot adalovelace --claude ada@acme.com --windsurf ada@acme.com
```

Optional: auto-discover org members from GitHub (needs `GITHUB_TOKEN` set, or `--token`):

```powershell
$env:GITHUB_TOKEN = "ghp_..."
npx govproxy dev discover --org my-org --team frontend
```

---

## 5. Validate setup

```powershell
npx govproxy doctor
```

Checks the config file, DB migrations, and **live reachability** of each enabled
connector's credentials (GitHub token + Copilot billing access, Anthropic key,
Windsurf key, git repos). Each failure prints a `Fix:` hint. Get this green
before syncing.

---

## 6. Pull data

```powershell
npx govproxy sync all            # runs Copilot → Claude Code → Windsurf → Git
# or individually:
npx govproxy sync copilot
npx govproxy sync claude-code
npx govproxy sync windsurf
npx govproxy sync git
```

Each prints `N written, M skipped`. Snapshots are one row per developer/day/tool
and are idempotent (re-running updates rather than duplicates).

---

## 7. See results

### Via CLI

```powershell
npx govproxy status              # unified summary: devs, connectors, cost, waste, data quality
npx govproxy waste show          # runs detection + lists active alerts by type
npx govproxy waste summary       # waste grouped by team
npx govproxy expenses show       # subscriptions + monthly cost (optional --team <name>)
```

### Via REST API

Start the server **with `npm run dev`** (see Gotchas — `govproxy start` only
serves `/health`):

```powershell
npm run dev                      # listens on http://localhost:8080
```

Then, in another terminal:

```powershell
curl http://localhost:8080/health                 # -> {"status":"ok"}
curl http://localhost:8080/api/overview
curl http://localhost:8080/api/teams
curl http://localhost:8080/api/teams/frontend
curl http://localhost:8080/api/developers/<dev-id>
curl http://localhost:8080/api/developers/<dev-id>/timeline
curl http://localhost:8080/api/waste
curl http://localhost:8080/api/waste/summary
curl "http://localhost:8080/api/snapshots?team=frontend&date=2026-05-26"
curl "http://localhost:8080/api/export?format=csv&from=2026-05-01&to=2026-05-26" -o export.csv
```

If you set `DASHBOARD_PASSWORD`, add basic auth (username is ignored):

```powershell
curl -u "admin:secret" http://localhost:8080/api/overview
```

---

## 8. Expenses & waste (optional)

A sample CSV ships at [`data/expenses/sample-subs.csv`](../data/expenses/sample-subs.csv):

```csv
developer_email,tool,plan,monthly_cost,billing_model
ada@acme.com,copilot,business,,company_managed
ada@acme.com,claude_code,max,,company_managed
grace@acme.com,copilot,business,19,company_managed
grace@acme.com,windsurf,pro,,reimbursed
alan@acme.com,cursor,pro,20,personal
```

Import it (developers must already exist with matching emails — register them in
step 4 first, or edit the emails to match yours):

```powershell
npx govproxy expenses import .\data\expenses\sample-subs.csv
```

CSV columns: `developer_email, tool, plan, monthly_cost, billing_model`. A blank
`monthly_cost` falls back to `expenses.subscription_defaults` keyed by
`<tool>_<plan>` (e.g. `copilot_business` → $19, `claude_code_max` → $200).
`billing_model` accepts `company_managed`, `reimbursed`, `personal`, `unknown`
(plus aliases like `company`, `expensed`). Then:

```powershell
npx govproxy waste show          # unused seats (14+ days inactive), duplicates, etc.
```

---

## Gotchas

- **Use `npm run dev` for the API, not `govproxy start`.** The CLI `start`
  command currently mounts only `/health` — the `/api/*` routes and the
  scheduler are wired up by `npm run dev` (`src/server.ts`).
- **`GITHUB_TOKEN` is not a reliable fallback for the connectors.** Because the
  YAML sets `api_token: "${GITHUB_API_TOKEN}"`, an unset var expands to an empty
  string (not undefined), so the code's `?? process.env.GITHUB_TOKEN` fallback
  won't trigger. Set `GITHUB_API_TOKEN` / `GIT_API_TOKEN` explicitly.
  (`dev discover` is the exception — it reads `GITHUB_TOKEN` or `--token`.)
- **`doctor` fails on an empty `git.repos` list**, even though `sync git` treats
  empty as "all org repos." List at least one repo to get a green doctor check.
- **Edit `claude_code.org_id` and `*.github_org`/`git.org` in the YAML** — these
  are plain strings, not env placeholders, and ship with dummy values.
- **Env vars are per-session.** Re-export them (or use a script) in each new
  terminal before running `doctor`/`sync`/`dev`.
