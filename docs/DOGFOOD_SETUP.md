# GovProxy — Dogfood Setup Guide

**Goal:** a manager goes from a fresh clone to a working dashboard — real data,
both roles, in **under one hour**. This is the deployment path validated for the
WMG dogfood at the close of Phase 2 (Task 2.12).

Everything below uses PowerShell (Windows). Environment variables set with
`$env:NAME = "..."` last only for the current terminal session — set them in the
same window you run the commands from.

> **Time budget:** install/build ≈ 10 min · config + credentials ≈ 15 min ·
> first sync ≈ 10–20 min (depends on repo count) · accounts + smoke test ≈ 10 min.

---

## 0. Prerequisites (5 min)

- **Node.js 20+** and **npm** (`node -v`).
- **Git access** to your repos and an **app password / access token** for the
  provider that hosts them (Bitbucket, GitHub, or GitLab).
- API tokens for whichever AI tools you pay for (Copilot, Claude Code, Windsurf).
  You can dogfood with a subset — connectors you leave `enabled: false` are
  simply skipped.

---

## 1. Install & build (10 min)

```powershell
npm install
npm run build      # compiles server + dashboard into dist/
```

> If `npm install` fails TLS verification behind a **trusted corporate proxy**,
> install the failing package once with `npm install <pkg> --strict-ssl=false`.
> Scope it to the single failing package — never disable TLS globally, and don't
> use this on an untrusted network.

---

## 2. Create your config (10 min)

Start from one of the checked-in samples and edit in place:

- `govproxy.bitbucket.config.yaml` — Bitbucket-only (matches WMG).
- `govproxy.github-only.config.yaml` — GitHub-only.

Copy one to `govproxy.config.yaml` (the default the CLI and server look for):

```powershell
Copy-Item govproxy.bitbucket.config.yaml govproxy.config.yaml
```

Set the `server`, `storage`, and `connectors` blocks. Enable only the connectors
you have credentials for; multiple git providers can be configured at once. Then
export the referenced secrets:

```powershell
$env:BITBUCKET_USERNAME     = "your-bitbucket-username"
$env:BITBUCKET_APP_PASSWORD = "the-app-password-you-create"
$env:GITHUB_API_TOKEN       = "ghp_..."        # if GitHub is enabled
$env:COPILOT_API_TOKEN      = "..."            # if Copilot is enabled
$env:CLAUDE_CODE_API_TOKEN  = "..."            # if Claude Code is enabled
$env:WINDSURF_API_TOKEN     = "..."            # if Windsurf is enabled
$env:DASHBOARD_PASSWORD     = "..."            # only if your config references it
```

---

## 3. Initialize the database & validate setup (5 min)

```powershell
npx govproxy db migrate     # create the SQLite schema
npx govproxy doctor         # validate every configured token + git provider
```

`doctor` is the single best pre-flight check — it confirms each connector token
works and lists the repos it can read for every configured git provider. Do not
proceed until it is green.

---

## 4. Register developers (10 min)

Snapshots are attributed to developers by their tool identities and git commit
emails. Register each person, then link their AI-tool identities. `dev add`
takes the name/team/email and git identities; the AI-tool identities (Copilot,
Claude Code, Windsurf) are attached with `dev link`:

```powershell
# 1. create the developer record (prints the generated developer id)
npx govproxy dev add --name "Jane Dev" --team engineering `
    --email jane@company.com `
    --bitbucket jane-bb --git-email jane@personal.com

# 2. link AI-tool identities to that id (note: --claude, not --claude-code)
npx govproxy dev link --id <dev-id> --copilot jane-gh --claude jane@company.com
```

For GitHub orgs you can bootstrap the roster with `npx govproxy dev discover`.
Any unmatched commit authors are printed at the end of `sync git` — add them and
re-sync to raise their data quality from LOW to MEDIUM/HIGH.

(Optional) import subscription costs so waste detection and Plan ROI have spend
data: `npx govproxy expenses import subscriptions.csv`.

---

## 5. First data pull (10–20 min)

```powershell
npx govproxy sync all       # pulls every enabled connector + git provider
npx govproxy status         # unified cross-tool summary — confirms data landed
npx govproxy waste show     # cross-tool waste alerts
```

`sync all` is incremental and idempotent; it writes one append-only snapshot per
developer per day per tool. Re-running it never rewrites history.

---

## 6. Create your login & start the dashboard (10 min)

```powershell
npx govproxy user create-admin --email you@company.com
```

A temporary password is printed; you will be forced to change it on first login.

**Start the full dashboard server:**

```powershell
node dist/server.js
# or, for live-reload development: npm run dev
```

The server reads `govproxy.config.yaml` (override with `$env:GOVPROXY_CONFIG`).
Open **http://localhost:8080/dashboard** and log in.

> ⚠️ Use `node dist/server.js` (or `npm run dev`) to serve the dashboard. The
> `govproxy start` CLI command currently brings up only the `/health` probe, not
> the dashboard — see `docs/KNOWN_ISSUES.md`.

---

## 7. Smoke test both roles (5 min)

1. **Manager (admin account):** Overview → Teams → a Team detail → Waste. Confirm
   real numbers, the multi-source coverage badge, and at least one waste alert.
2. **Developer:** create a developer-role login linked to a developer record
   (Admin → Users, or `user create-admin` is admin-only — use the Admin UI to add
   developers), then log in and walk My Dashboard → My Tools → My Activity.
3. Confirm the developer **cannot** see manager screens (the nav won't show them;
   direct URLs return 403).

If all three pass, you have a working dogfood deployment. The automated
equivalent of this smoke test lives in `tests/integration/` and runs in CI.

---

## Health check

`GET http://localhost:8080/health` must always return `{"status":"ok"}`. Use it
as your liveness probe.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `doctor` fails on a provider | Re-check the env var name matches the `${VAR}` in your config; confirm the token scope can read repos. |
| Developers show LOW data quality | Their git-email/tool identity isn't mapped — add it (step 4) and re-sync. |
| Empty charts | Pick a wider time range (the selector defaults to the smallest range that fits available history); confirm `sync all` ran. |
| Dashboard 404 at `/dashboard` | You started `govproxy start` instead of `node dist/server.js`. |
| Login locked out | The login limiter throttles repeated failures per IP; wait and retry. |
