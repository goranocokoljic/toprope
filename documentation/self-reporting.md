# Self-reporting

Self-reporting is the **Tier 4** gap-filler: when there's no admin API and no
expense data for a tool, a developer can log their own AI usage in seconds. It's
voluntary, privacy-respecting, and explicitly lower-confidence (MEDIUM tier) than
measured API data — used to fill gaps, never as a primary source.

## How it fits the data model

A self-report creates a `self_report`/MEDIUM `tool_snapshot` marking the developer
active for that tool/day. It records the tool, optional rough minutes, and an
optional **private task descriptor**.

Two guarantees:

- **The private task descriptor never enters the aggregated snapshot** and is
  never shared with managers or models. Only the developer can see it (via
  `toprope log list`).
- **API-wins rule:** a self-report never overrides a measured API snapshot for the
  same developer/day/tool. If an API sync later produces real data, it replaces
  the self-report placeholder — but the raw self-report is always kept on record.

## You can only log for yourself

Identity is resolved from the environment, not a flag — there is no way to log on
another developer's behalf:

```powershell
$env:TOPROPE_DEVELOPER_ID = "<your-dev-id>"
# or
$env:TOPROPE_DEVELOPER_EMAIL = "you@acme.com"
```

## CLI

Valid `--tool` values are `copilot`, `cursor`, `claude_code`, `windsurf`,
`chatgpt`, and `other` (the latter two cover tools with no API connector).

```powershell
# Log usage for today (or a specific --date)
npx toprope log --tool claude_code --minutes 90 --task "refactored the billing module"
npx toprope log --tool copilot --date 2026-06-12

# Review your own self-reports (includes the private task descriptors)
npx toprope log list
npx toprope log list --tool claude_code --from 2026-06-01 --to 2026-06-13 --limit 20
```

The command confirms whether you were newly marked active, were already active, or
whether API data already exists for that tool/date (in which case your report is
kept on record but doesn't change the snapshot).

## Slack bot

For developers who'd rather not touch a terminal, the Slack self-reporting bot
exposes the same capability through a slash command and an interactive form:

1. Configure and enable the `slack` bot — see
   [Anomalies, surveys & Slack → Slack](./anomalies-surveys-slack.md#1-the-self-reporting-bot-slack).
2. Link each developer's Slack id:
   `toprope dev link --id <dev-id> --slack <U…>`.
3. The developer runs the `/toprope-log` slash command, fills the modal (tool,
   minutes, optional task), and submits. Every inbound request is verified by
   Slack signing secret.

An optional **end-of-day prompt** (`slack.daily_prompt`) posts a gentle,
dismissible nudge to configured channels reminding people to log — opt-in and
never nagging.

## Privacy summary

- Self-reports are your own data; managers see only the aggregate activity they
  roll into, at MEDIUM confidence.
- The private task descriptor is yours alone.
- Logging is always voluntary.

## Related

- [Core concepts → data tiers & API-wins](./concepts.md)
- [Anomalies, surveys & Slack](./anomalies-surveys-slack.md)
- [CLI reference → self-reporting](./cli-reference.md#self-reporting)
