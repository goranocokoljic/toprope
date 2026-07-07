# Configuration

Toprope is configured through a single declarative YAML file,
`toprope.config.yaml`, validated against a JSON Schema at load time. This chapter
is the complete reference for every section.

## How configuration loads

- The server and CLI look for `toprope.config.yaml` in the current working
  directory by default. Override with the `-c, --config <path>` flag (CLI) or the
  `TOPROPE_CONFIG` environment variable (server).
- Any `${VAR}` placeholder is substituted from an environment variable **at load
  time**. Use this for every secret — never commit tokens to the YAML.
- The file is validated against a schema; an invalid or malformed config fails
  fast with a descriptive error.

> **Gotcha:** because a placeholder like `api_token: "${GITHUB_API_TOKEN}"`
> expands to an *empty string* when the variable is unset (not `undefined`), code
> fallbacks such as `?? process.env.GITHUB_TOKEN` will not trigger. Always export
> the exact variable the YAML references.

## Secrets and environment variables

The shipped config references these variables. Export the ones you need:

| Variable | Used by |
|---|---|
| `GITHUB_API_TOKEN` | Copilot connector |
| `GIT_API_TOKEN` | Git connector, YAML path (the same GitHub PAT is fine) |
| `TOPROPE_SECRET_KEY` | Encrypts git-provider tokens added from the dashboard (base64, 32 bytes) — **required** to add a token provider in the UI; fail-closed if unset |
| `ANTHROPIC_ADMIN_API_KEY` | Claude Code connector |
| `WINDSURF_SERVICE_KEY` | Windsurf connector |
| `CURSOR_SERVICE_KEY` | Cursor connector |
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` | Slack self-reporting bot |
| `SLACK_WEBHOOK_URL` | Slack waste-alert webhook |
| `SUMMARY_MODEL_API_KEY` | AI summaries (only for cloud models) |
| `DASHBOARD_PASSWORD` | Legacy Phase-1 basic auth (superseded by user accounts) |

```powershell
$env:GITHUB_API_TOKEN = "ghp_..."
$env:GIT_API_TOKEN    = "ghp_..."
# Required to add git-provider tokens from the dashboard (base64, 32 bytes):
$env:TOPROPE_SECRET_KEY = "$(openssl rand -base64 32)"   # or a pre-generated key
# ...etc. Env vars are per-session on Windows; re-export in each new terminal.
```

## Full annotated example

The repository ships a complete `toprope.config.yaml`. Two ready-made variants
also ship for common cases:

- `toprope.github-only.config.yaml` — Copilot + Git only (others disabled)
- `toprope.bitbucket.config.yaml` — Bitbucket-primary git setup

Below is the reference, section by section.

### `server`

```yaml
server:
  port: 8080
  host: "0.0.0.0"      # bind address; use 127.0.0.1 for loopback-only
```

If you bind a non-loopback host without `dashboard.auth.cookie_secure: true`, the
server logs a warning that session cookies would travel over plaintext HTTP.

### `storage`

```yaml
storage:
  type: "sqlite"
  sqlite_path: "./data/toprope.db"
```

SQLite is the only V1 storage backend (PostgreSQL is a Phase-6 item). The path is
resolved relative to the working directory.

### `connectors`

Each connector has `enabled`, an optional `sync_interval` (`daily` | `hourly`),
and an optional `sync_time` (`HH:MM` UTC). Disable connectors you aren't using so
`doctor` doesn't flag them. See [Connectors](./connectors.md) for credential
details.

```yaml
connectors:
  copilot:
    enabled: true
    github_org: "your-org"                 # plain string, NOT env-substituted
    api_token: "${GITHUB_API_TOKEN}"       # needs copilot metrics scope
    sync_interval: "daily"
    sync_time: "02:00"

  claude_code:
    enabled: true
    org_id: "your-anthropic-org-id"        # plain string
    api_key: "${ANTHROPIC_ADMIN_API_KEY}"  # Enterprise Admin API key
    sync_interval: "daily"
    sync_time: "02:30"

  windsurf:
    enabled: true
    service_key: "${WINDSURF_SERVICE_KEY}"
    sync_interval: "daily"
    sync_time: "03:00"

  cursor:
    enabled: true
    service_key: "${CURSOR_SERVICE_KEY}"
    sync_interval: "daily"
    sync_time: "03:15"

  git:
    enabled: true
    provider: "github"                     # github | gitlab | bitbucket
    org: "your-org"
    api_token: "${GIT_API_TOKEN}"          # repo read scope
    repos: []                              # bare repo names; [] = all org repos
    sync_interval: "daily"
    sync_time: "03:00"
    analysis:
      churn_window_hours: 48               # window for churn detection
      ai_signature_enabled: true
    # Multi-provider: supply a `providers:` list to analyze GitHub + GitLab +
    # Bitbucket together. See documentation/connectors.md.
```

> **The dashboard is the primary way to connect git providers now** — this
> `connectors.git` block is still fully supported but optional. Providers added in
> **Admin → Git Providers** are stored in the database (tokens encrypted with
> `TOPROPE_SECRET_KEY`) and are editable in the UI; providers defined here in YAML
> appear in the same UI as **read-only `Config`** entries. When both name the same
> `(provider, org)`, the **database entry wins** and the YAML one is shadowed. See
> [Connectors → Connecting providers](./connectors.md#connecting-providers-dashboard-or-yaml).

### `expenses`

```yaml
expenses:
  import_path: "./data/expenses/"
  subscription_defaults:        # used when a CSV row has a blank monthly_cost
    copilot_business: 19
    copilot_enterprise: 39
    cursor_pro: 20
    cursor_business: 40
    claude_code_pro: 20
    claude_code_max: 200
    windsurf_pro: 20
    windsurf_teams: 40
  # column_mapping:             # legacy single mapping = the 'standard' profile
  # import_profiles:            # named profiles (expensify, concur, custom...)
  #   expensify:
  #     column_mapping: { developer_email: "Email", amount: "Amount", ... }
  #     default_billing_model: "reimbursed"
  #     default_frequency: "monthly"
  # reconciliation:
  #   cost_tolerance: 1         # $ difference treated as rounding noise
```

Defaults are keyed `<tool>_<plan>`. Profiles, billing-model inference, and
reconciliation tuning are covered in [Expenses & waste](./expenses-and-waste.md).

### `aggregation`

```yaml
aggregation:
  weekly:   { day: "monday", time: "04:00" }
  monthly:  { day: 1, time: "04:30" }
  quarterly: { time: "05:00" }
  daily_retention_days: 90      # raw daily data kept for drill-down
```

Aggregation jobs run after connector syncs (04:00+ UTC) so each rollup folds a
table the day's sync has already populated. They run whenever the database
persists, even with no connectors (git-only / expense-only deployments included).

### `summaries`

AI-generated narrative reports. The model only ever receives **aggregate
numbers** — never code, commit content, or prompt content. Defaults to a **local**
Ollama model so nothing leaves your network.

```yaml
summaries:
  enabled: false
  model:
    type: "ollama"                    # ollama (default, local) | anthropic | openai
    endpoint: "http://localhost:11434"
    model_name: "llama3.1:70b"        # larger local model for monthly+
    # api_key: "${SUMMARY_MODEL_API_KEY}"   # only for anthropic/openai
  weekly:    { enabled: true, auto_generate: true, model_name: "llama3.1:8b" }
  monthly:   { enabled: true, auto_generate: true }
  quarterly: { enabled: true, auto_generate: false }
  yearly:    { enabled: true, auto_generate: false }
```

Per-level `model_name` lets weekly stay on a small/fast model while monthly+ use a
larger one. Weekly and monthly auto-generate on schedule; quarterly and yearly are
on-demand. See [Aggregation & AI summaries](./aggregation-and-summaries.md).

### `alerts`

```yaml
alerts:
  slack:
    enabled: false
    webhook_url: "${SLACK_WEBHOOK_URL}"   # one-way incoming webhook for waste alerts
  waste_threshold: 14                     # days of inactivity before a seat is "unused"
```

This `alerts.slack` block is a one-way webhook, distinct from the full `slack`
bot below.

### `slack` (self-reporting bot)

A full Slack app with the `/toprope-log` slash command and interactive forms,
plus optional anomaly alerts and an end-of-day prompt. Authenticated by a bot
token and signing secret. See [Self-reporting](./self-reporting.md) and
[Anomalies, surveys & Slack](./anomalies-surveys-slack.md).

```yaml
slack:
  enabled: false
  bot_token: "${SLACK_BOT_TOKEN}"          # xoxb-… bot user OAuth token
  signing_secret: "${SLACK_SIGNING_SECRET}" # verifies every inbound request (HMAC)
  daily_prompt:
    enabled: false        # opt-in, dismissible end-of-day nudge to self-report
    time: "16:00"         # HH:MM UTC
    channels: []          # Slack channel IDs, e.g. ["C0123ABCD"]
  # anomaly_alerts:
  #   channels: ["C0123ABCD"]
  #   dashboard_url: "https://toprope.example.com"
```

### `surveys`

```yaml
# surveys:
#   enabled: false        # daily trigger sweep; operator-driven until switched on
#   sweep_time: "09:00"   # HH:MM UTC
```

When enabled, the server runs survey trigger detection + dispatch on a daily cron.
See [Anomalies, surveys & Slack](./anomalies-surveys-slack.md).

### `dashboard`

```yaml
dashboard:
  enabled: true
  auth:
    type: "basic"
    admin_password: "${DASHBOARD_PASSWORD}"  # legacy; superseded by user accounts
    # session_ttl_hours: 24
    # cookie_secure: true                    # set true behind HTTPS / TLS proxy
```

The Phase-1 single `admin_password` is retained so old configs still load but is
no longer enforced — authentication is now per-user accounts created with
`toprope user create-admin`. See [Dashboard](./dashboard.md).

### `teams`

Declaratively seed teams at startup. The CLI can also manage teams (see
[CLI reference](./cli-reference.md)).

```yaml
teams:
  - name: "frontend"
    department: "engineering"
    manager: "goran"
  - name: "backend"
    department: "engineering"
    manager: "goran"
```

## Per-team and per-developer settings

Beyond this file, Toprope stores runtime settings in the database with a
consistent model: a **global default**, an optional **per-team override**, and a
**permission toggle** that controls whether managers may change team-level
behavior. These cover leaderboard visibility, anomaly thresholds, survey-trigger
auto-send, coaching-pillar enablement, and more. They are managed through the
dashboard Settings screens and the `/api/settings/*` endpoints rather than YAML —
see [Dashboard](./dashboard.md) and the [API reference](./api-reference.md).
