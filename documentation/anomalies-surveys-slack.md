# Anomalies, surveys & Slack

Three connected features that turn passive metrics into proactive prompts:
**anomaly detection** flags when something changes, **data-prompted surveys** ask
the developer about it, and **Slack** is the delivery channel for both.

## Anomaly detection

GovProxy watches for metrics that deviate meaningfully from their own baseline —
usage drops, runaway spend, churn spikes — and raises anomalies for review.

### How it works

- **Two methods, configurable per metric:** statistical (z-score) and
  percentage-change. Each metric can use a global default or a per-team override.
- **Minimum-baseline guard:** anomalies are suppressed until enough prior periods
  exist, so a new deployment's early weeks don't produce false positives.
- **Idempotent re-scan:** re-running a period never duplicates anomalies and
  preserves acknowledged/resolved status.
- **Honest basis:** every anomaly carries its basis (e.g. `git_estimate` at a
  git-only launch), so the confidence is explicit.
- **Privacy:** developer-scope anomalies stay private to the developer; only
  team-scope anomalies surface to managers.

### Running scans

Scans run automatically after the weekly aggregation. To run manually:

```powershell
npx govproxy anomaly scan                      # just-completed ISO week
npx govproxy anomaly scan --period 2026-05-18  # any date in the target week
npx govproxy anomaly list --scope team --status open
```

### Surfacing

- **Dashboard panel** with acknowledge/resolve (`/api/anomalies`).
- **Slack alerts** for notable/high-severity anomalies (settings-gated; see
  below).
- **Folded into AI summaries** in plain, honest language.

Configure thresholds in **Settings → Anomaly** (global default + per-team
override), or via `/api/settings/anomaly`.

## Data-prompted surveys

When the data raises a question, GovProxy can ask the developer directly — turning
a metric into context. ("We see your Copilot usage dropped 40% — did you switch
tools?")

### Triggers

Detected from aggregates: a usage drop, an unused new seat, a plan change, or an
anomaly. Each trigger has a templated question with optional answer choices.

### Auto-send vs manager approval

Per trigger, you choose auto-send or manager-approval (a global default with a
per-team override, under the manager-permission toggle). Stranded auto-surveys are
retried on the next sweep. Delivery prefers the Slack bot and falls back to email.

### Running the sweep

Enable the daily sweep in config to run detection + dispatch automatically:

```yaml
surveys:
  enabled: true
  sweep_time: "09:00"   # HH:MM UTC
```

Or drive it manually and manage the queue from the CLI:

```powershell
npx govproxy survey run                       # detect triggers + dispatch
npx govproxy survey queue                      # list surveys awaiting send
npx govproxy survey send <survey-id>           # send a queued survey
npx govproxy survey create --developer <id> --question "..."   # manual survey
npx govproxy survey dismiss <survey-id>
npx govproxy survey responses                  # answered surveys + responses
```

### Privacy

A developer answers only their own surveys (strict scoping). Responses are
surfaced to the manager as **context next to the triggering data** — not as a
standalone individual metric. Developers respond in Slack or via
`/api/me/surveys`.

## Slack

GovProxy uses Slack two distinct ways. Don't confuse them:

### 1. The self-reporting bot (`slack`)

A full Slack app with the `/govproxy-log` slash command and interactive forms,
used for [self-reporting](./self-reporting.md), survey delivery, anomaly alerts,
and the optional end-of-day prompt. Authenticated by a **bot token + signing
secret** (every inbound request is HMAC-verified).

```yaml
slack:
  enabled: true
  bot_token: "${SLACK_BOT_TOKEN}"            # xoxb-…
  signing_secret: "${SLACK_SIGNING_SECRET}"
  daily_prompt:
    enabled: false
    time: "16:00"           # HH:MM UTC — gentle, dismissible nudge to self-report
    channels: ["C0123ABCD"]
  anomaly_alerts:
    channels: ["C0123ABCD"]                  # where notable/high anomalies post
    dashboard_url: "https://govproxy.example.com"   # builds the "view in dashboard" link
```

Setup: create a Slack app, add the slash command pointing at your server, install
it to the workspace for the `xoxb-` token, and copy the signing secret. Link each
developer's Slack id with `govproxy dev link --id <dev-id> --slack <U…>` before
they can log. The bot's routes are only mounted when `slack.enabled` is true.

### 2. The waste webhook (`alerts.slack`)

A simpler one-way **incoming webhook** that posts waste/threshold alerts to a
channel. No bot, no interactivity.

```yaml
alerts:
  slack:
    enabled: true
    webhook_url: "${SLACK_WEBHOOK_URL}"
```

### Delivery gating

Anomaly Slack alerts require: the bot enabled with a token, at least one channel
configured, **and** the per-team `anomaly_alerts_enabled` setting. If any is
missing, alerting cleanly no-ops rather than erroring.

## Related

- [Self-reporting](./self-reporting.md)
- [Aggregation & AI summaries](./aggregation-and-summaries.md)
- [Dashboard → Settings](./dashboard.md)
