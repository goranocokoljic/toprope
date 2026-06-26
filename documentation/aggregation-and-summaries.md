# Aggregation & AI summaries

This chapter covers GovProxy's longitudinal layer: how daily snapshots become
trends, the AI maturity score, and the automated narrative reports.

## Aggregation engine

Immutable daily snapshots are rolled up into pre-computed aggregates at four
levels:

```
daily snapshots
  → weekly   (per developer, Mondays)
    → monthly  (per developer, 1st of month)
      → quarterly (per team, quarter boundary)
        → yearly  (per team)
```

Properties:

- **Idempotent** — re-computing a period overwrites cleanly; it never duplicates.
- **Delta-aware** — each aggregate carries period-over-period changes for key
  metrics. The first period of a series has **null** deltas; GovProxy never shows
  a fake 0%.
- **Tier-aware** — aggregates fold whatever snapshots exist (git-only and
  expense-only deployments included), carrying the honest data basis forward.

### Scheduled vs manual

When the server runs, aggregation jobs fire on their period boundaries (04:00+
UTC, after the day's connector syncs). You can also trigger one level manually —
the same code path the scheduler uses:

```powershell
# Just-completed period:
npx govproxy aggregate --period weekly

# A specific period (the one containing this date):
npx govproxy aggregate --period monthly --date 2026-05-15
```

### Backfill — instant trend depth

Don't wait weeks for charts. Backfill aggregates from the daily snapshots you
already have:

```powershell
npx govproxy aggregate backfill                          # last 12 months
npx govproxy aggregate backfill --from 2025-01-01 --to 2026-06-01
```

Backfill the **oldest range first and without gaps** — deltas aren't cascaded, so
running a later range before an earlier adjacent one leaves the boundary delta
uncompared.

## AI maturity score

A tier-aware composite **0–100** score per team per period, summarizing AI
adoption health. At a git-only launch it's composed from adoption breadth,
consistency, output health, churn quality, and cost efficiency (benchmarked
against the org average). It's labeled a **"git-based estimate"** everywhere it
appears and is designed to strengthen toward "measured" as tool data arrives —
without changing scale or meaning. The maturity trend is charted in the dashboard
and served at `GET /api/maturity/:team/trend`.

## AI-generated summaries

Automated narrative reports written by a configurable model. The crucial privacy
property: **the model only ever receives aggregate numbers** — never code, commit
content, or prompt content.

### The four levels

| Level | Audience | Cadence |
|---|---|---|
| **Weekly** | Team managers | Auto-generated on schedule |
| **Monthly** | Department heads | Auto-generated on schedule |
| **Quarterly** | VP / C-level | On-demand |
| **Yearly** | Board / annual review | On-demand |

### Model configuration

The default is a **local** model (Ollama) so nothing leaves your network. You can
point at Anthropic or OpenAI-compatible endpoints, and override the model per
level (small/fast for weekly, larger for monthly+):

```yaml
summaries:
  enabled: true
  model:
    type: "ollama"
    endpoint: "http://localhost:11434"
    model_name: "llama3.1:70b"
  weekly:  { enabled: true, auto_generate: true, model_name: "llama3.1:8b" }
  monthly: { enabled: true, auto_generate: true }
  quarterly: { enabled: true, auto_generate: false }
  yearly:    { enabled: true, auto_generate: false }
```

### Tier-aware prompting

Summary prompts describe the data's basis honestly. For git-only data they
describe git signals as estimates and never invent direct-usage language. This is
adversarially tested: an integration suite checks generated summaries against a
catalogue of forbidden direct-usage terms so a git-estimate summary can't claim
measured tool usage.

### Generating and reading summaries

```powershell
npx govproxy summary generate --level monthly --period 2026-05 --scope org
npx govproxy summary generate --level weekly  --period 2026-W21 --scope team:frontend
npx govproxy summary show     --level monthly --period 2026-05 --scope org
```

- **Period keys:** `YYYY-Wnn` (weekly), `YYYY-MM` (monthly), `YYYY-Qn`
  (quarterly), `YYYY` (yearly).
- **Scope:** `org` or `team:<name>`.
- **`--focus <text>`** passes a regeneration hint into the prompt (e.g. `"cost"`).
- Summaries are stored with a **regeneration count** and a **staleness flag** —
  if the underlying aggregates change after generation, the summary is marked
  STALE so you know to regenerate.

In the dashboard, the summaries panel offers regeneration, on-demand generation
for quarterly/yearly, and stale flagging. API endpoints live under
`/api/summaries`.

## Related

- [Configuration → aggregation & summaries](./configuration.md#aggregation)
- [Operations & troubleshooting](./operations-and-troubleshooting.md) — the scheduler
- [API reference](./api-reference.md)
