# `run-issues-panel.ps1` — User Manual

Runs `/dev-cycle-phases` over a list of GitHub issues **sequentially**, one fresh
`claude` process per issue, with a live status panel pinned to the bottom of the
terminal and per-run analytics written to disk.

It drives the issue-to-merge workflow autonomously: read issue → branch →
implement → build+test → open PR → code-review loop → merge → close. It stops on
the first hard failure so a bad run never cascades into the rest of the queue.

---

## Requirements

- **Windows Terminal** (or any VT-capable terminal) for the pinned panel. Falls
  back to plain streaming otherwise — see [The panel](#the-panel).
- `claude` CLI on `PATH`, authenticated.
- `gh` CLI authenticated (used to verify each merge closed its issue).
- `npm` available (the build/test gate runs inside the cycle).
- Run from the repo root (the script resolves paths from its own location).

---

## Quick start

```powershell
# One issue
./run-issues-panel.ps1 6

# Several, in order — stops at the first failure
./run-issues-panel.ps1 6 7 8
```

The script processes issues left to right. If issue 6 fails, 7 and 8 are **not**
attempted.

---

## Parameters

| Parameter        | Type / values        | Default  | What it does |
|------------------|----------------------|----------|--------------|
| `-Issues`        | `int[]` (positional) | —        | Issue numbers to run, in order. Can be given positionally (`6 7 8`) or named (`-Issues 6,7,8`). **Required.** |
| `-MaxResumes`    | `int`                | `2`      | How many times to **resume** a single issue after an *incomplete* (crashed / no-sentinel) run before giving up. Total attempts = `MaxResumes + 1`. Does not retry hard failures. |
| `-ReviewCycles`  | `int` `1`–`10`       | `3`      | Cap on Phase-6 code-review cycles per issue. Each cycle = one multi-lens review + fix + gate + push. Lower for cheaper/faster runs; raise for tougher issues. |
| `-Model`         | `sonnet` \| `opus`   | `sonnet` | Model passed to `claude -p --model`. Defaults to `sonnet` (the headless CLI's own default is `opus`). |
| `-Panel`         | switch               | off      | Force the pinned panel on even when Windows Terminal isn't detected (e.g. the JetBrains/WebStorm terminal). |
| `-NoPanel`       | switch               | off      | Force plain streaming, no pinned panel. Always wins over `-Panel`. |

### Examples

```powershell
./run-issues-panel.ps1 6 7 8 -Model opus          # run on Opus
./run-issues-panel.ps1 6 7 8 -ReviewCycles 2      # cap review at 2 cycles
./run-issues-panel.ps1 -Issues 6,7,8 -MaxResumes 1
./run-issues-panel.ps1 6 7 8 -Panel               # force panel in WebStorm terminal
./run-issues-panel.ps1 6 7 8 -NoPanel             # plain streaming
```

---

## The panel

When the panel is active, logs scroll in the upper region while a fixed HUD shows,
at a glance:

```
─────────────────────────────────────────────────────────────────────────────
 run-issues-panel  started 14:02:11   elapsed 00:18:42   $24.13 billed   model sonnet
 queue: ✓ 6  ▶ 7  · 8   (done 1/3)
─────────────────────────────────────────────────────────────────────────────
 ▶ #7  4m 12s in   attempt 1/3   $5.20 billed   ctx ~142K
   phase  read ─ branch ─ implement ─ build+test ─ pr ─ ▶review ─ merge
   now    review (cycle 2/3: C0 H1 M2 (blockers 1))   -> Edit: src/...
─────────────────────────────────────────────────────────────────────────────
```

- **Line 1** — run start, total elapsed, total billed `$`, and the model that's
  *actually* running. If the running model differs from what you asked for, it's
  flagged in red.
- **Queue** — `✓` done, `▶` current, `·` pending, `✗` failed.
- **Current issue** — time in, attempt number, billed `$` for this issue, and a
  live **context gauge** (`ctx ~NK`): the latest turn's prompt size. Amber past
  180K, red past 300K — a run whose context balloons is usually looping or
  self-correcting.
- **Phase track** — left-to-right progress through the dev-cycle phases.
- **now** — current phase (with review-cycle detail and latest findings) and the
  most recent tool activity.

If the terminal can't support the panel (no `WT_SESSION`, no `-Panel`, or the
window is too short), it degrades to plain streaming with identical log output.

> **Cost note:** the billed figure is the authoritative `total_cost_usd` summed
> across completed processes — never reconstructed from token counts.

---

## How a run is judged

Each issue's process must end by printing a sentinel on its **last line**:

- `DEVCYCLE_OK` — PR opened, build+tests passed, review loop done, merged to
  `develop`, issue closed.
- `DEVCYCLE_FAIL: <reason>` — something blocked completion.

The script then decides:

| Result | Action |
|--------|--------|
| `DEVCYCLE_OK` **and** `gh` confirms the issue is `CLOSED` | Marked **done**, moves to next issue. |
| `DEVCYCLE_FAIL: …` | **Hard failure** — not retried. Stops the whole run. |
| Crash / no sentinel (incomplete) | **Resumed** up to `MaxResumes` times, then fails. |
| `DEVCYCLE_OK` but issue not `CLOSED`, or `gh` can't confirm | Treated as failure — stops. |

**Resuming** is safe: a resumed attempt checks out the existing branch/PR, figures
out what's already done, and continues from the first incomplete phase rather than
restarting.

---

## Output files

### Stream logs — `dev-cycle-logs/`
Raw `claude` stream-json, one file per attempt: `issue-<n>-<timestamp>.log`. The
full record of everything the model did. Gitignored.

### Analytics — `dev-cycle-analytics/` (JSONL, gitignored)
Written once per attempt, separate from the stream logs, for analysis.

**`tasks.jsonl`** — one record per issue run:

| Field | Meaning |
|-------|---------|
| `issue`, `attempt`, `ts`, `outcome` | which run (`ok` / `incomplete` / `failed`) |
| `model_asked`, `model_ran` | requested vs. actual model |
| `total_sec` | wall-clock duration of the run |
| `billed_cost_usd` | **authoritative** real cost (`total_cost_usd`) |
| `phases[]` | per phase: `duration_sec`, `out_tokens`, `in_tokens`, `turns`, `tool_calls`, `peak_ctx_tokens`, `est_cost_usd` |
| `review` | `cycles_run`, `total_review_sec`, `total_fix_sec`, `findings_total` by priority |
| `review_cycles[]` | nested per-cycle records (same shape as below) |

**`review-cycles.jsonl`** — one flat record per review cycle:

| Field | Meaning |
|-------|---------|
| `issue`, `attempt`, `review_cycle`, `max_cycles` | which cycle |
| `findings` | `critical`/`high`/`medium`/`low`/`style`, plus derived `blocker` (=crit+high) and `total` |
| `review_sec` | time spent reviewing (running the review + bucketing findings) |
| `fix_sec` | time spent fixing (`null` if the cycle was clean and exited without fixing) |
| `cycle_sec` | total review→fix duration |
| `out_tokens`, `in_tokens`, `review_out_tokens`, `fix_out_tokens`, `turns`, `tool_calls` | work volume, split review vs. fix |
| `est_cost_usd` | estimated cost for the cycle |

#### What's real vs. estimated

| Real (measured) | Estimated (derived) |
|-----------------|---------------------|
| all durations (wall clock between markers) | `est_cost_usd` (per phase / per cycle) |
| findings counts by priority | |
| token volumes (`out`/`in` — safe to sum) | |
| `billed_cost_usd` (task total, authoritative) | |

The stream has **no per-phase dollar figure**, and cache tokens must never be
summed (they're re-reported cumulatively and would overstate cost 2–70×). So any
sub-task `$` is `est_cost_usd`: the one real billed total apportioned by each
phase's/cycle's share of output tokens. Treat it as a proportion, not a bill.

---

## Querying the analytics

```powershell
# Average billed cost and duration per successful issue
Get-Content dev-cycle-analytics/tasks.jsonl |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object outcome -eq 'ok' |
  Measure-Object billed_cost_usd, total_sec -Average

# Findings totals per review cycle
Get-Content dev-cycle-analytics/review-cycles.jsonl |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Select-Object issue, review_cycle, @{n='blockers';e={$_.findings.blocker}}, review_sec, fix_sec
```

With `jq`:

```bash
jq -c 'select(.outcome=="ok") | {issue, total_sec, billed_cost_usd}' dev-cycle-analytics/tasks.jsonl
```

---

## Tuning the review loop

The `-ReviewCycles` cap flows into `/dev-cycle-phases`, which runs the multi-lens
review in **isolated** subagents (independent eyes, diff-only) but applies fixes in
the **main dev-cycle context**, where the implementation intent lives. That split
is deliberate: detection wants independence, remediation wants context. Watch the
`fix_sec` / `fix_out_tokens` fields — if they balloon relative to findings count,
the context may have gone toxic (cross-check the `ctx` gauge / `peak_ctx_tokens`),
which is the one case where a fresh resume beats grinding on.

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Panel renders garbled | Terminal lacks scroll-region support. Use `-NoPanel`. |
| No panel appears | Not Windows Terminal and `-Panel` not set, or window too short. Add `-Panel` or enlarge the window. |
| `model … (asked sonnet!)` in red | The CLI ran a different model than requested — check your `claude` config / default model. |
| Run stops with `UNVERIFIED` | `gh issue view` failed — check `gh auth status`. |
| Run stops with `MISMATCH` | The model reported success but the issue isn't closed — inspect the PR/issue manually. |
| Issue keeps resuming then fails | The cycle can't complete (e.g. persistent build break). Read the latest `dev-cycle-logs/issue-<n>-*.log`. |

---

## Phase reference

The phases shown on the track, in order:

`read` → `branch` → `implement` → `build+test` → `pr` → `review` (×N cycles) → `merge`

Phase state comes from `DEVCYCLE_PHASE:` markers emitted by `/dev-cycle-phases`
(**not** plain `/dev-cycle`). Findings counts and the review/fix-time split come
from `DEVCYCLE_METRIC:` markers from the same skill.
