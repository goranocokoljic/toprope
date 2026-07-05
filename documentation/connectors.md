# Connectors

Connectors pull data from external sources into Toprope's unified snapshot model.
There are four **tool API connectors** (Copilot, Claude Code, Windsurf, Cursor)
and a **multi-provider git analyzer** (GitHub, GitLab, Bitbucket). All write
`tool_snapshots` (tools) or `git_snapshots` (git) as one row per developer per
day, at data-quality tier **HIGH** for APIs and **MEDIUM** for git analysis.

Before a connector's data can attribute to a person, that person must be linked to
the matching identity with `toprope dev link` (see
[Getting started](./getting-started.md#3-initialize-the-database-and-register-people)).

## Common behavior

Every connector:

- Authenticates, paginates, retries on rate limits (HTTP 429), and isolates
  errors so one failure doesn't block the pipeline.
- Writes **idempotent** daily snapshots — re-running updates rather than
  duplicates.
- Obeys the **API-wins rule**: a measured snapshot overrides any prior
  self-report for the same developer/day/tool.
- Can be triggered manually (`toprope sync <name>`) or on the configured cron.

Validate any connector's credentials with `npx toprope doctor`.

## GitHub Copilot

Pulls per-user daily metrics from the GitHub Copilot Metrics API: suggestions,
acceptances, active days, and breakdowns by IDE, language, and model. Also reads
seat assignments to detect assigned-but-inactive seats, and team attribution.

```yaml
connectors:
  copilot:
    enabled: true
    github_org: "your-org"
    api_token: "${GITHUB_API_TOKEN}"
    sync_interval: "daily"
    sync_time: "02:00"
```

- **Token scope:** a GitHub PAT with repo read, plus `manage_billing:copilot` and
  org-admin rights for the Copilot metrics/billing endpoints.
- **Identity:** link with `--copilot <github-username>`.
- **Sync:** `npx toprope sync copilot`

## Claude Code

Pulls per-user metrics from the Anthropic Enterprise Analytics API: sessions,
messages, Claude Code commits, PRs, lines added/removed, tool acceptance rates,
and cost.

```yaml
connectors:
  claude_code:
    enabled: true
    org_id: "your-anthropic-org-id"
    api_key: "${ANTHROPIC_ADMIN_API_KEY}"
    sync_interval: "daily"
    sync_time: "02:30"
```

- **Credential:** an Anthropic Enterprise **Admin API key** with Usage Analytics
  permission.
- **Identity:** link with `--claude <email>`.
- **Sync:** `npx toprope sync claude-code`

## Windsurf

Pulls per-user metrics from the Windsurf Enterprise Analytics API: AI-generated
code percentage, completions, Cascade sessions, and feature usage, with team
breakdowns. Authenticates with a service key.

```yaml
connectors:
  windsurf:
    enabled: true
    service_key: "${WINDSURF_SERVICE_KEY}"
    sync_interval: "daily"
    sync_time: "03:00"
```

- **Credential:** a Windsurf service key (Team Settings → Service Keys) with
  analytics permission.
- **Identity:** link with `--windsurf <email>`.
- **Sync:** `npx toprope sync windsurf`

## Cursor

Full parity with the other connectors: pulls per-user analytics into
`tool_snapshots` at HIGH quality, mapping by Cursor identifier with an email
fallback.

```yaml
connectors:
  cursor:
    enabled: true
    service_key: "${CURSOR_SERVICE_KEY}"
    sync_interval: "daily"
    sync_time: "03:15"
```

- **Credential:** a Cursor Enterprise service key.
- **Identity:** link with `--cursor <email-or-id>`.
- **Sync:** `npx toprope sync cursor`

## Git repository analysis

The universal, tool-agnostic source. It works for **every** developer regardless
of which AI tool they use — which is why a git-only deployment still gets useful
adoption signals and PR/review coaching from day one. Analysis is **clone-free**:
it reads commits, PRs/MRs, and reviews over the provider's REST API.

What it computes per developer per day (`git_snapshots`):

- Commit count, lines added/removed, files changed
- PRs opened/merged, review comments given, average time-to-merge
- **Code churn rate** — lines rewritten within the churn window (48h default)
- **AI signature score** — a conservative 0–100 heuristic estimate of AI
  assistance, always labeled "estimated"
- Commit-burst detection (rapid successive commits)

```yaml
connectors:
  git:
    enabled: true
    provider: "github"          # github | gitlab | bitbucket
    org: "your-org"
    api_token: "${GIT_API_TOKEN}"
    repos: []                   # bare repo names; [] = all org repos
    sync_interval: "daily"
    sync_time: "03:00"
    analysis:
      churn_window_hours: 48
      ai_signature_enabled: true
```

- **Repo list:** entries are **bare repo names** (matched within the org). `[]`
  means all org repos. Use an `exclude:<name>` entry to omit one.
- **Identity:** git activity attributes by matching the commit author to a
  developer's linked `--github` / `--bitbucket` / `--gitlab` username or one of
  their `--git-email` addresses.
- **Sync:** `npx toprope sync git` (add `--provider <type>` to sync just one
  provider in a multi-provider setup).

### Multi-provider git

Toprope normalizes GitHub, GitLab, and Bitbucket into one git data model, so all
git-derived views and coaching work identically across providers. Two ways to
configure:

1. **Single provider** — set `provider`, `org`, `api_token` as above.
2. **Multiple providers** — supply a `providers:` list, each entry a full provider
   config. This is how a WMG-style deployment runs Bitbucket as primary while also
   analyzing a GitHub org.

Provider notes:

- **GitHub** — REST API; cloud and Enterprise.
- **Bitbucket** — REST API 2.0; app-password / token / OAuth; cloud and Server.
  Raw-author parsing handles Bitbucket's commit author format. See the shipped
  `toprope.bitbucket.config.yaml`.
- **GitLab** — REST API v4; PAT / OAuth / job-token; cloud and self-managed;
  understands projects/MRs/notes terminology and subgroups.

> `doctor` flags an empty `repos: []` as a failure even though `sync git` treats
> empty as "all org repos." List at least one repo to get a green check.

## The sync pipeline

`toprope sync all` runs every connector in order — **Copilot → Claude Code →
Windsurf → Cursor → Git** — then evaluates plan-change ROI. When the server runs,
the same pipeline runs on the per-connector cron schedule, with per-connector sync
state so only new data is processed. See
[Operations & troubleshooting](./operations-and-troubleshooting.md).
