# CLI reference

Every Toprope command. Run the CLI as `npx toprope <command>` (after
`npm run build`) or from source with `npx tsx src/cli.ts <command>`.

**Global flag:** every command accepts `-c, --config <path>` to select a config
file (default `toprope.config.yaml`). Most commands run pending migrations
automatically before executing.

```
toprope <command> [subcommand] [options]
```

---

## Server

| Command | Description |
|---|---|
| `toprope start [-c <config>]` | Start the server. **Note:** currently mounts only `/health`; use `node dist/server.js` or `npm run dev` for the full API + dashboard + scheduler. |

## Diagnostics

| Command | Description |
|---|---|
| `toprope status` | Unified summary: developers (registered/active), teams, connector last-sync times, subscriptions and monthly cost, waste alerts, and data-quality distribution. |
| `toprope doctor` | Validate the whole setup: config file, database migrations, and live reachability of every enabled connector's credentials. Prints a `Fix:` hint per failure; non-zero exit on any failure. |

## Database

| Command | Description |
|---|---|
| `toprope db migrate` | Apply pending migrations (idempotent). |
| `toprope db status` | Show each migration and whether/when it was applied. |

## Teams

| Command | Description |
|---|---|
| `toprope team add --name <name> [--department <dept>] [--manager <mgr>]` | Create a team (warns if it already exists). |
| `toprope team list` | List all teams with department and manager. |

## Developers

| Command | Description |
|---|---|
| `toprope dev add --name <name> --team <team> [--email <e>] [--github <u>] [--bitbucket <u>] [--gitlab <u>] [--git-email <e>]...` | Add a developer, and immediately attribute any **already-synced** git history their identities resolve (the count of attributed dates is printed). `--git-email` is repeatable. An identity or email already owned by another developer is rejected with a non-zero exit. |
| `toprope dev list [--team <name>]` | List developers, optionally filtered by team, showing linked identities. |
| `toprope dev link --id <dev-id> [--copilot <u>] [--claude <e>] [--windsurf <e>] [--cursor <e>] [--github <u>] [--bitbucket <u>] [--gitlab <u>] [--slack <id>] [--git-email <e>]...` | Link a developer to tool, git-provider, and Slack identities. At least one identity is required; conflicts with another developer are rejected. |
| `toprope dev discover --org <org> [--token <t>] [--team <team>]` | Discover developers from **GitHub org members**. Reads `--token` or `GITHUB_TOKEN`. Defaults discovered devs to team `discovered`. GitHub-only, and includes members who never committed. |
| `toprope dev discover-repo` | List the review queue: git authors in the **already-synced** history that map to no developer, busiest first, with commit counts and a `[likely-bot]` flag. Provider-agnostic. An empty queue is not an error. |
| `toprope dev discover-repo --promote <raw-author-key> --team <team> [--name <n>] [--email <e>] [--github <u>] [--bitbucket <u>] [--gitlab <u>]` | Promote one unmatched author to a developer and attribute their retained history. |
| `toprope dev discover-repo --promote-all --team <team> [--include-bots]` | Promote every unmatched author. Likely bots are skipped unless `--include-bots`. |

See [Getting developers into Toprope](./developer-onboarding.md) for when to use
which of these, and for the opt-in auto-create-during-sync config.

## Users (dashboard accounts)

| Command | Description |
|---|---|
| `toprope user create-admin --email <email> [--password <pw>]` | Bootstrap an admin account for dashboard login. If `--password` is omitted, a temporary one is generated, printed, and must be changed on first login. |

## Sync

| Command | Description |
|---|---|
| `toprope sync all` | Full pipeline: Copilot → Claude Code → Windsurf → Cursor → Git, then plan-ROI evaluation. |
| `toprope sync copilot` | GitHub Copilot Metrics API only. |
| `toprope sync claude-code` | Anthropic Enterprise Analytics API only. |
| `toprope sync windsurf` | Windsurf Analytics API only. |
| `toprope sync cursor` | Cursor Analytics API only. |
| `toprope sync git [--provider <github\|bitbucket\|gitlab>]` | Git commit/PR analysis. `--provider` limits a multi-provider setup to one provider. |

Each prints `N written, M skipped`; non-zero exit if any connector reported errors.

## Git history maintenance

| Command | Description |
|---|---|
| `toprope git set-history-floor --provider <github\|bitbucket\|gitlab> --container <name> --at <iso> [--force]` | Declare how far back a **legacy** git provider has already synced. |

Only needed for providers first synced before Toprope recorded a history floor. Those
providers have no record of how far back their first sync reached, and it cannot be
recovered from stored data — so **"Sync older history" refuses them** (HTTP 409) rather
than guess. Guessing is not a safe fallback in either direction: too recent and the
backfill re-imports activity you already have (permanently inflating commit counts, since
the merge is additive); too old and the span in between becomes un-importable forever.

`--at` is the earliest instant that provider has already imported — normally
`(the time of its first sync) − (the history window that sync used)`. It must be a
canonical UTC ISO instant in the past, e.g. `2025-01-01T00:00:00.000Z`.

```bash
toprope git set-history-floor --provider github --container acme --at 2025-01-01T00:00:00.000Z
```

**Get this value right.** It is an assertion, not a guess: declare a floor *newer* than
the truth and the next backfill double-counts the overlap; declare one *older* and the
span in between is stranded. The command echoes what it armed — read it back.

`--force` replaces a floor that is already recorded. Use it to correct a mis-typed `--at`
**before** running a backfill. It does *not* apply to a provider that has never synced
(that refusal means the `--provider`/`--container` spelling doesn't match a connected
provider — fix the spelling, don't force it), and forcing over a floor that a real sync
earned will corrupt the backfill's disjointness.

## Expenses

| Command | Description |
|---|---|
| `toprope expenses import <file> [--profile <name>]` | Import subscriptions from a CSV. `--profile` selects an import profile (`standard` \| `expensify` \| `concur` \| a configured one). Reports imported / matched / unmatched / duplicates / recurring / one-time. |
| `toprope expenses unmatched` | List expense charges queued for manual resolution (rows whose developer couldn't be matched). |
| `toprope expenses resolve <charge-id> --dev <developer-id>` | Attribute a queued charge to a developer (accepts the 8-char short id). |
| `toprope expenses reconcile [--period <YYYY-MM>] [--tolerance <amount>]` | Reconcile imported expenses against the subscription registry for a period; surfaces `expense_no_subscription` / `subscription_no_expense` / `cost_discrepancy` results. |
| `toprope expenses show [--team <name>]` | Show active subscriptions with costs, per-team totals, and duplicate-tool alerts. |

See [Expenses & waste](./expenses-and-waste.md).

## Waste

| Command | Description |
|---|---|
| `toprope waste show` | Run detection and list active alerts grouped by type (unused, underutilized, duplicate, cost outlier, plan-ROI), with total monthly waste. |
| `toprope waste summary` | Waste aggregated by team. |
| `toprope waste resolve <alert-id> --reason <text>` | Dismiss an alert with a reason (accepts the 8-char short id). |

## Aggregation

| Command | Description |
|---|---|
| `toprope aggregate --period <weekly\|monthly\|quarterly\|yearly> [--date <YYYY-MM-DD>]` | Compute one aggregate level now. With `--date`, targets the period containing that day; otherwise the just-completed period. |
| `toprope aggregate backfill [--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>]` | Compute historical aggregates (all levels) from existing daily snapshots. Defaults to the last 12 months. Backfill oldest-first without gaps so boundary deltas compare correctly. |

See [Aggregation & AI summaries](./aggregation-and-summaries.md).

## Summaries

| Command | Description |
|---|---|
| `toprope summary generate --level <weekly\|monthly\|quarterly\|yearly> --period <key> --scope <org\|team:name> [--focus <text>]` | Generate (or regenerate) an AI narrative summary. `--focus` passes a regeneration hint into the prompt. Period keys: `YYYY-Wnn`, `YYYY-MM`, `YYYY-Qn`, `YYYY`. |
| `toprope summary show --level <level> --period <key> --scope <org\|team:name>` | Show a stored summary, its model, generation time, regeneration count, and a STALE flag if the underlying data changed. |

## Self-reporting

| Command | Description |
|---|---|
| `toprope log --tool <tool> [--minutes <n>] [--task <text>] [--date <YYYY-MM-DD>]` | Log your own AI usage for a day. `<tool>` is one of `copilot`, `cursor`, `claude_code`, `windsurf`, `chatgpt`, `other`. Identity comes from `TOPROPE_DEVELOPER_ID` or `TOPROPE_DEVELOPER_EMAIL` — you can only log for yourself. `--task` is a private descriptor never shared with managers or models. |
| `toprope log list [--tool <t>] [--from <d>] [--to <d>] [--limit <n>]` | Show your own self-reports, including private task descriptors. |

See [Self-reporting](./self-reporting.md).

## Surveys

| Command | Description |
|---|---|
| `toprope survey run` | Detect survey triggers and dispatch them (auto-send or queue per settings); retries stranded auto-surveys. |
| `toprope survey queue` | List surveys awaiting a manager to send. |
| `toprope survey send <survey-id>` | Send a queued survey (Slack preferred, email fallback). |
| `toprope survey create --developer <id> --question <text>` | Create a manual survey, queued for you to send. |
| `toprope survey dismiss <survey-id>` | Dismiss a queued survey without sending. |
| `toprope survey responses` | Show answered surveys with their responses. |

## Anomalies

| Command | Description |
|---|---|
| `toprope anomaly scan [--period <YYYY-MM-DD>]` | Scan a weekly period for anomalies across developers and teams. Defaults to the just-completed ISO week; idempotent. |
| `toprope anomaly list [--scope <developer\|team>] [--status <open\|acknowledged\|resolved>] [--period <YYYY-MM-DD>]` | List detected anomalies, newest first, with severity, metric, deviation, and basis. |

See [Anomalies, surveys & Slack](./anomalies-surveys-slack.md).

---

## Identity and environment notes

- **Self-report identity:** `toprope log` resolves *you* from
  `TOPROPE_DEVELOPER_ID` or `TOPROPE_DEVELOPER_EMAIL`. There is no way to log
  for another developer.
- **`dev discover`** is the one connector-adjacent command that reads
  `GITHUB_TOKEN` (or `--token`) directly.
- Most state-changing commands exit non-zero on error so they compose in scripts.
