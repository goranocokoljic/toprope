# CLI reference

Every GovProxy command. Run the CLI as `npx govproxy <command>` (after
`npm run build`) or from source with `npx tsx src/cli.ts <command>`.

**Global flag:** every command accepts `-c, --config <path>` to select a config
file (default `govproxy.config.yaml`). Most commands run pending migrations
automatically before executing.

```
govproxy <command> [subcommand] [options]
```

---

## Server

| Command | Description |
|---|---|
| `govproxy start [-c <config>]` | Start the server. **Note:** currently mounts only `/health`; use `node dist/server.js` or `npm run dev` for the full API + dashboard + scheduler. |

## Diagnostics

| Command | Description |
|---|---|
| `govproxy status` | Unified summary: developers (registered/active), teams, connector last-sync times, subscriptions and monthly cost, waste alerts, and data-quality distribution. |
| `govproxy doctor` | Validate the whole setup: config file, database migrations, and live reachability of every enabled connector's credentials. Prints a `Fix:` hint per failure; non-zero exit on any failure. |

## Database

| Command | Description |
|---|---|
| `govproxy db migrate` | Apply pending migrations (idempotent). |
| `govproxy db status` | Show each migration and whether/when it was applied. |

## Teams

| Command | Description |
|---|---|
| `govproxy team add --name <name> [--department <dept>] [--manager <mgr>]` | Create a team (warns if it already exists). |
| `govproxy team list` | List all teams with department and manager. |

## Developers

| Command | Description |
|---|---|
| `govproxy dev add --name <name> --team <team> [--email <e>] [--github <u>] [--bitbucket <u>] [--gitlab <u>] [--git-email <e>]...` | Add a developer. `--git-email` is repeatable. Duplicate identities/emails are detected and warned. |
| `govproxy dev list [--team <name>]` | List developers, optionally filtered by team, showing linked identities. |
| `govproxy dev link --id <dev-id> [--copilot <u>] [--claude <e>] [--windsurf <e>] [--cursor <e>] [--github <u>] [--bitbucket <u>] [--gitlab <u>] [--slack <id>] [--git-email <e>]...` | Link a developer to tool, git-provider, and Slack identities. At least one identity is required; conflicts with another developer are rejected. |
| `govproxy dev discover --org <org> [--token <t>] [--team <team>]` | Auto-discover developers from GitHub org members. Reads `--token` or `GITHUB_TOKEN`. Defaults discovered devs to team `discovered`. |

## Users (dashboard accounts)

| Command | Description |
|---|---|
| `govproxy user create-admin --email <email> [--password <pw>]` | Bootstrap an admin account for dashboard login. If `--password` is omitted, a temporary one is generated, printed, and must be changed on first login. |

## Sync

| Command | Description |
|---|---|
| `govproxy sync all` | Full pipeline: Copilot → Claude Code → Windsurf → Cursor → Git, then plan-ROI evaluation. |
| `govproxy sync copilot` | GitHub Copilot Metrics API only. |
| `govproxy sync claude-code` | Anthropic Enterprise Analytics API only. |
| `govproxy sync windsurf` | Windsurf Analytics API only. |
| `govproxy sync cursor` | Cursor Analytics API only. |
| `govproxy sync git [--provider <github\|bitbucket\|gitlab>]` | Git commit/PR analysis. `--provider` limits a multi-provider setup to one provider. |

Each prints `N written, M skipped`; non-zero exit if any connector reported errors.

## Expenses

| Command | Description |
|---|---|
| `govproxy expenses import <file> [--profile <name>]` | Import subscriptions from a CSV. `--profile` selects an import profile (`standard` \| `expensify` \| `concur` \| a configured one). Reports imported / matched / unmatched / duplicates / recurring / one-time. |
| `govproxy expenses unmatched` | List expense charges queued for manual resolution (rows whose developer couldn't be matched). |
| `govproxy expenses resolve <charge-id> --dev <developer-id>` | Attribute a queued charge to a developer (accepts the 8-char short id). |
| `govproxy expenses reconcile [--period <YYYY-MM>] [--tolerance <amount>]` | Reconcile imported expenses against the subscription registry for a period; surfaces `expense_no_subscription` / `subscription_no_expense` / `cost_discrepancy` results. |
| `govproxy expenses show [--team <name>]` | Show active subscriptions with costs, per-team totals, and duplicate-tool alerts. |

See [Expenses & waste](./expenses-and-waste.md).

## Waste

| Command | Description |
|---|---|
| `govproxy waste show` | Run detection and list active alerts grouped by type (unused, underutilized, duplicate, cost outlier, plan-ROI), with total monthly waste. |
| `govproxy waste summary` | Waste aggregated by team. |
| `govproxy waste resolve <alert-id> --reason <text>` | Dismiss an alert with a reason (accepts the 8-char short id). |

## Aggregation

| Command | Description |
|---|---|
| `govproxy aggregate --period <weekly\|monthly\|quarterly\|yearly> [--date <YYYY-MM-DD>]` | Compute one aggregate level now. With `--date`, targets the period containing that day; otherwise the just-completed period. |
| `govproxy aggregate backfill [--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>]` | Compute historical aggregates (all levels) from existing daily snapshots. Defaults to the last 12 months. Backfill oldest-first without gaps so boundary deltas compare correctly. |

See [Aggregation & AI summaries](./aggregation-and-summaries.md).

## Summaries

| Command | Description |
|---|---|
| `govproxy summary generate --level <weekly\|monthly\|quarterly\|yearly> --period <key> --scope <org\|team:name> [--focus <text>]` | Generate (or regenerate) an AI narrative summary. `--focus` passes a regeneration hint into the prompt. Period keys: `YYYY-Wnn`, `YYYY-MM`, `YYYY-Qn`, `YYYY`. |
| `govproxy summary show --level <level> --period <key> --scope <org\|team:name>` | Show a stored summary, its model, generation time, regeneration count, and a STALE flag if the underlying data changed. |

## Self-reporting

| Command | Description |
|---|---|
| `govproxy log --tool <tool> [--minutes <n>] [--task <text>] [--date <YYYY-MM-DD>]` | Log your own AI usage for a day. `<tool>` is one of `copilot`, `cursor`, `claude_code`, `windsurf`, `chatgpt`, `other`. Identity comes from `GOVPROXY_DEVELOPER_ID` or `GOVPROXY_DEVELOPER_EMAIL` — you can only log for yourself. `--task` is a private descriptor never shared with managers or models. |
| `govproxy log list [--tool <t>] [--from <d>] [--to <d>] [--limit <n>]` | Show your own self-reports, including private task descriptors. |

See [Self-reporting](./self-reporting.md).

## Surveys

| Command | Description |
|---|---|
| `govproxy survey run` | Detect survey triggers and dispatch them (auto-send or queue per settings); retries stranded auto-surveys. |
| `govproxy survey queue` | List surveys awaiting a manager to send. |
| `govproxy survey send <survey-id>` | Send a queued survey (Slack preferred, email fallback). |
| `govproxy survey create --developer <id> --question <text>` | Create a manual survey, queued for you to send. |
| `govproxy survey dismiss <survey-id>` | Dismiss a queued survey without sending. |
| `govproxy survey responses` | Show answered surveys with their responses. |

## Anomalies

| Command | Description |
|---|---|
| `govproxy anomaly scan [--period <YYYY-MM-DD>]` | Scan a weekly period for anomalies across developers and teams. Defaults to the just-completed ISO week; idempotent. |
| `govproxy anomaly list [--scope <developer\|team>] [--status <open\|acknowledged\|resolved>] [--period <YYYY-MM-DD>]` | List detected anomalies, newest first, with severity, metric, deviation, and basis. |

See [Anomalies, surveys & Slack](./anomalies-surveys-slack.md).

---

## Identity and environment notes

- **Self-report identity:** `govproxy log` resolves *you* from
  `GOVPROXY_DEVELOPER_ID` or `GOVPROXY_DEVELOPER_EMAIL`. There is no way to log
  for another developer.
- **`dev discover`** is the one connector-adjacent command that reads
  `GITHUB_TOKEN` (or `--token`) directly.
- Most state-changing commands exit non-zero on error so they compose in scripts.
