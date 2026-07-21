# Toprope — Dogfood Setup Guide

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
- **Git access** to your repos and an **API token / access token** for the
  provider that hosts them (Bitbucket, GitHub, or GitLab). For Bitbucket Cloud use
  an **Atlassian API token** (app passwords are deprecated) — authenticate with
  your Atlassian account email as the username.
- API tokens for whichever AI tools you pay for (Copilot, Claude Code, Windsurf,
  Cursor). You can dogfood with a subset — connectors you leave `enabled: false`
  are simply skipped.

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

- `toprope.bitbucket.config.yaml` — Bitbucket-only (matches WMG).
- `toprope.github-only.config.yaml` — GitHub-only.

Copy one to `toprope.config.yaml` (the default the CLI and server look for):

```powershell
Copy-Item toprope.bitbucket.config.yaml toprope.config.yaml
```

Set the `server`, `storage`, and `connectors` blocks. Enable only the connectors
you have credentials for; multiple git providers can be configured at once. Then
export the referenced secrets:

```powershell
$env:BITBUCKET_USERNAME     = "your-atlassian-account-email"   # e.g. you@company.com
$env:BITBUCKET_APP_PASSWORD = "the-atlassian-api-token-you-create"
$env:GITHUB_API_TOKEN       = "ghp_..."        # if GitHub is enabled
$env:COPILOT_API_TOKEN      = "..."            # if Copilot is enabled
$env:CLAUDE_CODE_API_TOKEN  = "..."            # if Claude Code is enabled
$env:WINDSURF_API_TOKEN     = "..."            # if Windsurf is enabled
$env:CURSOR_SERVICE_KEY     = "..."            # if Cursor is enabled (Phase 4)
$env:SLACK_BOT_TOKEN        = "xoxb-..."       # if the Slack bot is enabled (Phase 4)
$env:SLACK_SIGNING_SECRET   = "..."            # if the Slack bot is enabled (Phase 4)
$env:DASHBOARD_PASSWORD     = "..."            # only if your config references it
```

---

## 3. Initialize the database & validate setup (5 min)

```powershell
npx toprope db migrate     # create the SQLite schema
npx toprope doctor         # validate every configured token + git provider
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
npx toprope dev add --name "Jane Dev" --team engineering `
    --email jane@company.com `
    --bitbucket jane-bb --git-email jane@personal.com

# 2. link AI-tool identities to that id (note: --claude, not --claude-code)
npx toprope dev link --id <dev-id> --copilot jane-gh --claude jane@company.com
```

Bootstrap the roster from the repositories you already synced — any provider,
including contractors who are not org members:

```powershell
npx toprope dev discover-repo                                # who is committing?
npx toprope dev discover-repo --promote-all --team engineering
```

(For GitHub orgs, `npx toprope dev discover --org <org>` bootstraps from org
*membership* instead — GitHub-only, and it includes members who never committed.)

Unmatched authors are also listed in the dashboard at **Admin → Developer
identities → Unmatched authors**. You do **not** need to re-sync after adding
someone: their already-synced history is attributed on the spot. See
`documentation/developer-onboarding.md`.

(Optional) import subscription costs so waste detection and Plan ROI have spend
data: `npx toprope expenses import subscriptions.csv`.

---

## 5. First data pull (10–20 min)

```powershell
npx toprope sync all       # pulls every enabled connector + git provider
npx toprope status         # unified cross-tool summary — confirms data landed
npx toprope waste show     # cross-tool waste alerts
```

`sync all` is incremental and idempotent; it writes one append-only snapshot per
developer per day per tool. Re-running it never rewrites history.

---

## 6. Create your login & start the dashboard (10 min)

```powershell
npx toprope user create-admin --email you@company.com
```

A temporary password is printed; you will be forced to change it on first login.

**Start the full dashboard server:**

```powershell
node dist/server.js
# or, for live-reload development: npm run dev
```

The server reads `toprope.config.yaml` (override with `$env:TOPROPE_CONFIG`).
Open **http://localhost:8080/dashboard** and log in.

> ⚠️ Use `node dist/server.js` (or `npm run dev`) to serve the dashboard. The
> `toprope start` CLI command currently brings up only the `/health` probe, not
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

## 8. Trends & AI summaries (Phase 3) (10 min)

Phase 3 adds pre-computed **aggregates** (weekly / monthly / quarterly / yearly),
an **AI maturity score** per team, and locally-generated **narrative summaries**.
At launch every developer is git-only (MEDIUM tier), so all of this is derived
from git activity + expense data and is labelled a **git-based estimate** — no
direct tool-usage numbers are invented. The end-to-end behaviour is covered by
`tests/integration/phase3-pipeline.test.ts`.

### 8a. Backfill historical trends

Once `sync all` has pulled your git history, compute all historical aggregates in
one pass so the dashboard has trend depth immediately instead of accumulating it
forward over weeks:

```powershell
npx toprope aggregate backfill          # trailing 12 months (default)
# npx toprope aggregate backfill --from 2024-01-01 --to 2025-12-31
```

Backfill is idempotent — re-running overwrites, never duplicates. After it runs,
the maturity trend and long-range views load from pre-computed rows (sub-200ms
reads), not by re-folding daily snapshots.

> **Maturity score** is a **git-based estimate** everywhere it appears. See
> `docs/MATURITY_CALIBRATION.md` for how to read it (it is adoption-dominated at
> launch) and when to re-calibrate.

### 8b. Configure local summaries

Summaries default to a **local Ollama model** so nothing — no code, no commit
contents, only aggregate numbers — ever leaves your network. Add a `summaries`
block to `toprope.config.yaml`:

```yaml
summaries:
  enabled: true
  model:
    type: ollama                      # ollama (default, local) | anthropic | openai
    endpoint: http://localhost:11434  # local Ollama server
    model_name: llama3.1:70b          # a larger local model for executive-facing prose
  weekly:   { model_name: llama3.1:8b }   # optional: keep weekly on a small/fast model
  monthly:  {}                            # inherits the base model
  quarterly: {}
  yearly:   {}
```

Pull the model first (`ollama pull llama3.1:70b`) and confirm it runs on your
dogfood box. If the endpoint is unreachable, generation is skipped and logged —
it never crashes the scheduler — and the summary is simply retried next run. See
`docs/summaries-model.md` for provider details and sizing notes.

### 8c. Generate & view summaries

Weekly and monthly summaries **auto-generate on schedule** (after the matching
aggregation job) when the server is running, so a manager opens Monday morning to
a summary already waiting. Quarterly and yearly are **on-demand** — generate them
when you need them:

```powershell
# on-demand (quarterly / yearly are never auto-generated)
npx toprope summary generate --level quarterly --period 2026-Q2 --scope team:backend
npx toprope summary generate --level yearly    --period 2026    --scope org

# read a stored summary
npx toprope summary show --level monthly --period 2026-05 --scope org
```

In the dashboard, the **maturity trend chart** (Organization Overview + Team
Detail) and the **Summaries panel** surface all of this, with a regenerate button
(optional focus) and a "git-based estimate" / MEDIUM-confidence label. A summary
whose underlying aggregate later changes (late-arriving data) is flagged
**stale** with a regenerate affordance.

### 8d. Schedules (UTC), for reference

| Job | When | Produces |
|-----|------|----------|
| Weekly aggregation | Mon 04:00 | prior ISO week |
| Weekly summary | Mon 04:15 | prior week, all scopes |
| Monthly aggregation | 1st 04:30 | prior month |
| Monthly summary | 1st 04:45 | prior month, all scopes |
| Quarterly aggregation | quarter start 05:00 | prior quarter |
| Yearly aggregation | Jan 1 05:00 | prior year |

Quarterly/yearly **summaries** are intentionally not scheduled — generate them on
demand. All jobs are idempotent and isolated (one failing job never blocks the
others).

---

## 9. Complete the data picture (Phase 4) (15 min)

Phase 4 closes the launch blind spots — personal/reimbursed accounts, tools
without admin access, non-committing AI use — and adds proactive analytics. Every
feature stays **tier-aware**: it labels its data basis and never invents
direct-usage numbers. The end-to-end behaviour is covered by
`tests/integration/phase4-pipeline.test.ts`.

### 9a. Cursor connector

Cursor is a first-class connector (api/HIGH tier, full parity with
Copilot/Claude Code/Windsurf). Enable it in `connectors`:

```yaml
connectors:
  cursor:
    enabled: true
    service_key: "${CURSOR_SERVICE_KEY}"   # Cursor Analytics API service key
```

Link each developer's Cursor identity (`npx toprope dev link --id <dev-id>
--cursor jane@company.com`), then `npx toprope sync all` pulls it like any other
connector. `doctor` validates the key.

### 9b. Self-reporting (CLI + Slack)

Developers on tools you can't reach by API (personal Cursor, ChatGPT, a reimbursed
seat) can self-report usage in seconds. It lands as a `self_report`/**MEDIUM**
snapshot — honestly marked, never fabricating measured counts — and the
**API-wins rule** guarantees a self-report never overrides (or is overridden into)
measured API data: if a connector later syncs the same day, the measured row wins.

```powershell
# CLI: log usage for yourself
npx toprope log --tool cursor --minutes 90 --task "refactored auth"
```

For the **Slack bot** (slash command + interactive form), add a top-level `slack`
block (distinct from `alerts.slack`, which is the waste-alert webhook):

```yaml
slack:
  enabled: true
  bot_token: "${SLACK_BOT_TOKEN}"          # xoxb-… bot user OAuth token
  signing_secret: "${SLACK_SIGNING_SECRET}" # verifies every inbound request
```

The bot routes register only when `slack.enabled` is true.

### 9c. Richer expense import + reconciliation

The importer recognizes multiple expense-export profiles (e.g. `standard`,
`expensify`, `concur`), normalizes annual charges to monthly, dedups, and infers
the billing model. Reconciliation then compares charges against the subscription
registry for a period and flags mismatches so total spend is trustworthy:

```powershell
npx toprope expenses import expenses.csv --profile expensify
npx toprope expenses reconcile --period 2026-06
```

Three mismatch types surface (`expense_no_subscription`, `subscription_no_expense`,
`cost_discrepancy`); each has a **resolve / ignore** workflow in the Admin UI.
Re-running reconciliation is idempotent (it never duplicates open results).

### 9d. Anomaly detection

Anomalies fire when a metric deviates from its own baseline — both **statistical**
(z-score) and **percentage-change** methods, configurable per metric in Settings.
A **minimum-baseline guard** suppresses early-weeks false positives until enough
prior periods exist, so a freshly-onboarded team doesn't generate noise. Anomalies
carry an honest basis (`git_estimate` at launch); developer-scope anomalies stay
private, team-scope surface to managers in the dashboard panel, optional Slack
alerts (notable/high only), and the AI summaries.

To route anomaly Slack alerts, add `anomaly_alerts` under the `slack` block:

```yaml
slack:
  enabled: true
  bot_token: "${SLACK_BOT_TOKEN}"
  anomaly_alerts:
    channels: ["C0123ABCD"]                # Slack channel IDs
    dashboard_url: "http://localhost:8080" # base URL for the "view in dashboard" deep link
```

### 9e. Data-prompted surveys

When a trigger fires (usage drop, unused new seat, plan change, anomaly), Toprope
can ask the developer a short question ("your usage dropped 40% — did you switch
tools?"). Each trigger is **manual by default** (queued for manager approval) or
**auto-send** per a Settings toggle (global default + per-team override under the
manager-permission model); delivery prefers Slack with an email fallback. The
developer's response is captured and shown to the manager as context next to the
triggering data. Enable with a top-level `surveys` block and review the queue
under the manager's Surveys panel.

### 9f. Team comparison & adoption journey

- **Team comparison:** pick 2–4 teams for a rich side-by-side (every metric, tool
  mix, overlaid trend, per-team tier with the weakest-link rule), or open the
  sortable all-teams table for a quarter.
- **Adoption journey:** each developer sees their own timeline from first AI
  activity to now — trajectory, tool/plan transitions, and annotated moments
  (first active week, sustained ramp, plateau). Managers can open the aggregate
  journey for any developer; a developer is confined to their own.

---

## 10. Developer coaching (Phase 5) (15 min)

Phase 5 turns the platform from a *measurement* tool into a *capability-building*
one: a private mirror that helps developers improve, while the manager sees only
team-level patterns. The first two pillars work on data you already have — a
git-only WMG developer gets genuinely useful coaching with **no opt-in required**.
The cross-cutting privacy rule holds everywhere: **individual coaching signals are
private to the developer; managers see floored team aggregates only**, and a
coaching signal becoming manager-visible is treated as a bug, not a feature.

Org-level coaching policy lives in **Settings** (admin). Pillars 1–2 default ON;
prompt capture, cloud analysis, and the showcase default OFF until an admin
permits them. Each is team-overridable when `coaching_managers_can_override` is on.

### 10a. Pillar 2 — PR/review outcome coaching (the highest-value, no-opt-in signal)

This is the one to dogfood first on real WMG git-only data. From the PR/MR +
review data the Phase 1 git connectors already pull (GitHub, Bitbucket, GitLab),
it reads the *verdict* on AI-assisted work — rework/review-rejection rate, review
rounds, comment density, time-to-merge, and the powerful **churn + review**
combination (high churn + high rejection = struggling with AI output; high churn +
clean reviews = healthy iteration; low churn + clean reviews = effective adopter).

- A developer opens **`GET /api/me/pr-coaching`** and sees their own trajectory,
  with the **all-PR (factual)** and **AI-assisted (inferred)** views kept rigorously
  separate and labelled — the inferred view is never presented as fact.
- A manager opens **`GET /api/coaching/pr-review/team/<team>`** (or `/org`) and sees
  a pooled team trajectory only. Every period below the cohort floor (3
  contributors) is suppressed; no individual's numbers and no developer id ever
  appear. There is deliberately no route that returns one developer's coaching to a
  manager.
- Sanity-check the signals against developers whose work you know: a developer you
  know was wrestling with AI output should read as elevated churn + rework, not a
  clean trajectory.

### 10b. Pillar 1 — available-data coaching

Churn self-reflection, acceptance-rate trends (only where tool data exists —
honestly absent for git-only), adoption-journey interpretation, and tier-aware
personal insights, all on the developer's **own** data via **`GET /api/me/coaching`**.
Inferred (git-estimate) signals are separated from measured ones. The manager
aggregate (`/api/coaching/available/...`) carries contributor counts and category
tallies only — never the observation sentence.

### 10c. Pillar 3 — opt-in prompt capture (double opt-in, private by default)

Off until an admin permits it (`coaching_capture_permitted`). Then it is the
**developer's** choice, in two separate steps:

- **Opt-in #1 — capture at all.** The developer turns capture on and picks a
  mechanism (local agent **or** editor extension — both feed the same store).
  Prompts are encrypted **client-side**; the server is a blind store that holds
  only ciphertext + public crypto metadata and **rejects any body carrying
  plaintext or key material**. Loop detection and prompt-quality nudges run
  **locally** at the capture layer and sync only metadata (counts, types,
  timestamps) — never prompt text.
- **Key recovery — the developer's informed choice.** At opt-in they pick
  *no-recovery* (maximum privacy; a lost key is unrecoverable by design) or a
  *recovery path* (the key is wrapped client-side; the server stores only the
  opaque blob). **Every recovery action is logged in a feed the developer can
  read** (`GET /api/me/capture-key/recovery-log`) — recovery can never be used
  silently, and there is no admin backdoor.
- **Opt-in #2 — cloud retrospective.** The session retrospective defaults to a
  **local model** (raw prompts never leave org infrastructure). Cloud analysis runs
  only when the org permits cloud analysis **and** the developer separately opts in.

### 10d. Showcase — deliberately-shared exemplary conversations

Off until `showcase_enabled`. The bridge from private self-coaching to
organizational learning, and the conflict ("your prompts are private" vs "share
your best prompt") dissolves because **sharing is always a deliberate owner act**:

- From their **own** retrospective the developer **promotes** a conversation
  (transiently decrypted for them to edit), **redacts** it (a mandatory step the
  flow refuses to skip), and **publishes** the redacted content at team or org
  scope (within the org's `showcase_scope_permitted`).
- Published examples live in a **separate shared store**; the private capture is
  never read or modified by publishing, and nothing is auto-harvested. Others
  **browse** within their access scope.
- The owner can **unpublish** anytime; a team lead can **remove** an example from
  their team's showcase (and the author is notified) — but a lead can **never**
  publish or edit on a developer's behalf.

### 10e. Manager coaching panel

`GET /api/coaching/manager/team/<team>` (or `/org`) composes the three pillar
aggregates plus synthesized team opportunities into one admin-only payload. Every
section is floored, the loop/nudge section counts only opted-in developers, and no
code path here accepts a developer id — the whole surface is structurally
aggregate-only.

---

## Health check

`GET http://localhost:8080/health` must always return `{"status":"ok"}`. Use it
as your liveness probe.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `doctor` fails on a provider | Re-check the env var name matches the `${VAR}` in your config; confirm the token scope can read repos. |
| Developers show LOW data quality | Their git-email/tool identity isn't mapped — add it (step 4) and re-sync. |
| No developers at all after `sync git` | Expected on an empty registry: sync attributes only to existing developers. Run `npx toprope dev discover-repo`, or use **Admin → Developer identities → Unmatched authors**. No re-sync needed. |
| Empty charts | Pick a wider time range (the selector defaults to the smallest range that fits available history); confirm `sync all` ran. |
| Dashboard 404 at `/dashboard` | You started `toprope start` instead of `node dist/server.js`. |
| Login locked out | The login limiter throttles repeated failures per IP; wait and retry. |
