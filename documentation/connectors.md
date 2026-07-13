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

> **The dashboard is now the primary way to connect git providers.** Add, test,
> edit, remove, and sync providers — and pick which repositories are analyzed —
> from **Admin → Git Providers** (`/admin/git-providers`), no config-file edit or
> CLI required. YAML providers (below) remain fully supported and appear in that
> UI as **read-only**. See [Connecting providers: dashboard or
> YAML](#connecting-providers-dashboard-or-yaml).

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

### Connecting providers: dashboard or YAML

There are **two supported ways** to connect a git provider, and both feed the same
sync pipeline, `doctor`, and scheduler — analysis behaves identically whichever you
use:

1. **Dashboard (primary)** — **Admin → Git Providers**. Pick a provider type, fill
   the dynamic form (container + auth method + token, plus GitLab's optional
   self-hosted URL and subgroup toggle), click **Test connection** to verify the
   token before saving, then **Save**. You can later Test, Sync now, edit, remove,
   toggle enabled, and set repo scope — all without touching a file. Providers added
   here are stored in the database (tokens encrypted at rest; see
   [Adding a provider from the dashboard](#adding-a-provider-from-the-dashboard)).
2. **YAML (`connectors.git`)** — the config-file path shown above. Still fully
   supported for git-only and file-driven deployments. Config-file providers show up
   in the dashboard list flagged **Config** and are **read-only** there: you can Test
   them, but editing or removing one means editing the YAML (the app never rewrites a
   possibly read-only, mounted config file).

**Precedence — the database wins.** Providers from both sources are merged at one
seam and de-duplicated by `(type, container)` (e.g. the same GitHub `org`). If a
provider exists in both the database and YAML, the **database entry wins** and the
config one is shadowed (the shadowing is logged). So a UI edit always takes effect
even when an older YAML entry names the same org.

Toprope normalizes GitHub, GitLab, and Bitbucket into one git data model regardless
of which path you use, so all git-derived views and coaching work identically across
providers. A multi-provider setup — e.g. Bitbucket as primary while also analyzing a
GitHub org — is just two connected providers, whether you add them in the UI, list
them under `providers:` in YAML, or mix both.

> **Multi-provider caveat — prefer a full sync over per-provider "Sync now".** Git
> snapshots are keyed by `(developer, day)` with no provider dimension: a developer's
> same-day activity across providers is merged into one row *within a single sync
> run*. A **scoped** sync — the dashboard's per-provider **Sync now** button, or
> `sync git --provider <type>` — fetches only that one provider and rewrites the day's
> row from just its data, which can drop another provider's already-recorded
> contribution for that same day until the next full sync re-establishes it. In a
> multi-provider deployment, prefer a full `sync git` (or the scheduled sync) so
> every provider's same-day activity is merged in one pass. (Tracked for a
> merge-on-write fix in the shared sync pipeline.)

### Adding a provider from the dashboard

**Secret key is required first.** Provider tokens added from the UI are encrypted at
rest with a server-held key, so the server needs a master key before it will store
one. Set the `TOPROPE_SECRET_KEY` environment variable to a **base64-encoded,
32-byte** key. The key handling is **fail-closed**: if it is unset (or not a valid
32-byte base64 value), adding a **token** provider is refused with a clear setup
message (HTTP 503) rather than storing a token in the clear — there is no
plaintext-at-rest fallback. Generate one with either:

```bash
openssl rand -base64 32
# or, with Node (cross-platform):
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

then export it (see [Configuration → Secrets](./configuration.md#secrets-and-environment-variables)).

**Repo scope — monitor all vs. select.** Every connected provider defaults to
**Monitor all repositories** (all repos in the org/workspace/group). To narrow it,
open the provider's repo-scope editor and switch to **Select repositories**: Toprope
loads the provider's repos and you tick the ones to analyze (bulk **Select all** /
**Clear selection** controls help in large workspaces). Archived repos are shown but
excluded by default. Switch back to "Monitor all" at any time. Right after you
connect a provider, the scope editor opens automatically so you can pick the active
repositories **before the first sync** — in long-lived organizations most repos are
dormant, and narrowing the scope keeps syncs fast and the data relevant.

**Deselecting a repo keeps its history.** Changing the scope only affects future
syncs: a deselected repository stops being read, but everything already collected
from it (daily snapshots, PR records) is retained — snapshots are append-only and
are never rewritten. Re-selecting the repo later resumes collection from the
provider's incremental cursor.

**Tokens are write-only.** A token is accepted on create/update and **never**
returned by the API afterwards — the dashboard only ever shows a masked value and the
last four characters. Editing a provider without re-entering the token keeps the
stored one; entering a new token replaces it.

**Sync now shows live progress.** Triggering a per-provider sync from the dashboard
streams the run's progress under the provider row — the current stage (listing
repositories → fetching activity → matching developers → writing snapshots) with
live repo/commit/PR/developer counters — and the row reflects the terminal ok/error
outcome when the run settles, without a manual refresh. A second trigger while a
run is in flight is rejected with a visible "sync already in progress" message.

Provider notes:

- **GitHub** — REST API; cloud and Enterprise.
- **Bitbucket** — REST API 2.0; API token (Atlassian account email + token) /
  access token / OAuth; cloud and Server. The `app_password` auth method is the
  Atlassian API-token path (Bitbucket app passwords are deprecated; the same
  Basic-auth flow now uses the account email as the username). Raw-author parsing
  handles Bitbucket's commit author format. See the shipped
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
