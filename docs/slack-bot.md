# Slack Self-Reporting Bot (Task 4.2)

The Slack bot is the lowest-friction way for developers to self-report AI tool
usage. It sits on top of the 4.1 self-reporting core: a submission writes through
`createSelfReport` with `source_interface = "slack"`, so the same API-wins and
privacy rules apply (measured API data always takes precedence; the optional task
descriptor stays private to the developer and is never sent to managers or models).

## How it works

- `/govproxy-log` opens a modal: tool (required), rough time (optional buttons),
  and an optional private task note.
- Submitting logs the usage for the **submitting** Slack user only — there is no
  way to log on behalf of anyone else. The Slack user id is mapped to a
  `developer_id`; unlinked users get a clear "ask your admin to link your account"
  message instead of a silent failure.
- An optional, dismissible end-of-day prompt ("Used an AI tool today?") can be
  posted to configured channels.

## Security

Every inbound request is verified against the Slack signing secret (HMAC-SHA256
over `v0:{timestamp}:{body}`), with a 5-minute timestamp window to block replays.
Requests that fail verification are rejected with `401` before any handler runs.
The routes live outside `/api`, so the dashboard session gate doesn't apply — the
signature *is* the authentication.

## Slack app setup

1. Create a Slack app (https://api.slack.com/apps).
2. **Slash Commands** → create `/govproxy-log` with the request URL
   `https://<your-host>/slack/commands`.
3. **Interactivity & Shortcuts** → enable, request URL
   `https://<your-host>/slack/interactivity`.
4. **OAuth & Permissions** → add bot scopes `commands`, `chat:write`, then install
   the app and copy the **Bot User OAuth Token** (`xoxb-…`).
5. **Basic Information** → copy the **Signing Secret**.

## Configuration

```yaml
slack:
  enabled: true
  bot_token: "${SLACK_BOT_TOKEN}"
  signing_secret: "${SLACK_SIGNING_SECRET}"
  daily_prompt:
    enabled: false
    time: "16:00"        # HH:MM UTC
    channels: []         # e.g. ["C0123ABCD"]
```

## Linking developers

Map each developer to their Slack user id (find it in their Slack profile →
"Copy member ID"):

```
govproxy dev link --id <developer-id> --slack U0123ABCD
```

A Slack id can be linked to only one developer; attempting to reuse one is
rejected, exactly like the other provider identities.
