# `tr-harness.ps1` — User Manual

Runs `/dev-cycle-phases` over a list of GitHub issues **sequentially**, one fresh
`claude` process per issue, with a live status panel pinned to the bottom of the
terminal and per-run analytics written to disk.

It drives the issue-to-merge workflow autonomously: read issue → branch →
implement → build+test → open PR → code-review loop → merge → close. A failed
item is **quarantined** — marked failed and skipped over while the rest of the
queue keeps running (see [Failure quarantine](#failure-quarantine)); `-StopOnFail`
restores the legacy stop-at-first-failure behaviour.

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
./tr-harness.ps1 6

# Several, in order — stops at the first failure
./tr-harness.ps1 6 7 8
```

The script processes issues left to right. If issue 6 fails, it is quarantined
(`✗` in the queue) and 7 and 8 still run; the script exits `1` at the end if
anything failed. Pass `-StopOnFail` to stop at the first failure instead.

---

## Parameters

| Parameter        | Type / values        | Default  | What it does |
|------------------|----------------------|----------|--------------|
| `-Issues`        | `int[]` (positional) | —        | Issue numbers to run, in order. Can be given positionally (`6 7 8`) or named (`-Issues 6,7,8`). **Required.** |
| `-MaxResumes`    | `int`                | `2`      | How many times to **resume** a single issue after an *incomplete* (crashed / no-sentinel) run before giving up. Total attempts = `MaxResumes + 1`. Does not retry hard failures. |
| `-ReviewCycles`  | `int` `1`–`10`       | `3`      | Cap on Phase-6 code-review cycles per issue. Each cycle = one multi-lens review + fix + gate + push. Lower for cheaper/faster runs; raise for tougher issues. |
| `-Model`         | `sonnet` \| `opus` \| `fable` | `opus` | Model passed to `claude -p --model`. Always passed explicitly so the headless CLI never falls back to its configured default. Also used for the graduation review's recommendation call. |
| `-Fresh`         | switch               | off      | Re-run every item even if it already looks complete (disables the resume-skip that silently skips already-merged children / already-closed issues). |
| `-Panel`         | switch               | off      | Force the pinned panel on even when Windows Terminal isn't detected (e.g. the JetBrains/WebStorm terminal). |
| `-NoPanel`       | switch               | off      | Force plain streaming, no pinned panel. Always wins over `-Panel`. |
| `-NoWaitForReset`| switch               | off      | **Opt out** of auto-resume across usage limits. By default a run that stops because the account hit its Claude usage/session limit is paused (not failed): the harness sleeps until the limit resets, then re-dispatches the same attempt. This switch disables that — see [Riding out usage limits](#riding-out-usage-limits). |
| `-MaxWaits`      | `int`                | `12`     | Safety cap on consecutive limit-waits per issue attempt. Past it, a limit stops being waited out and falls through to the normal incomplete/resume path. Guards against a mis-detected or perpetual limit looping forever. |
| `-StopOnFail`    | switch               | off      | Legacy behaviour: stop the whole run at the first failed item instead of quarantining it — see [Failure quarantine](#failure-quarantine). |
| `-MaxConsecutiveFails` | `int` `1`–`100` | `3`     | Quarantine circuit breaker: this many **consecutive** item failures aborts the run (a systemic problem would otherwise burn a paid run per remaining item). Successes reset the counter. |
| `-NoGraduate`    | switch               | off      | Skip the [KB graduation review](#the-kb-graduation-review) that runs after the whole queue completes successfully. |
| `-GraduateOnly`  | switch               | off      | Run **only** the KB graduation review — no dev-cycle runs, no panel. The issue list may be omitted. |

### Examples

```powershell
./tr-harness.ps1 6 7 8 -Model opus          # run on Opus
./tr-harness.ps1 6 7 8 -ReviewCycles 2      # cap review at 2 cycles
./tr-harness.ps1 -Issues 6,7,8 -MaxResumes 1
./tr-harness.ps1 6 7 8 -Panel               # force panel in WebStorm terminal
./tr-harness.ps1 6 7 8 -NoPanel             # plain streaming
./tr-harness.ps1 6 7 8 -NoWaitForReset      # fail fast on a usage limit instead of waiting
./tr-harness.ps1 6 7 8 -NoGraduate          # skip the post-run KB graduation review
./tr-harness.ps1 -GraduateOnly              # just review/graduate KB lessons, no runs
```

---

## The panel

When the panel is active, logs scroll in the upper region while a fixed HUD shows,
at a glance:

```
─────────────────────────────────────────────────────────────────────────────
 tr-harness  started 14:02:11   elapsed 00:18:42   $24.13 billed   model sonnet
 queue: ✓ 6  ▶ 7  · 8   (done 1/3)
─────────────────────────────────────────────────────────────────────────────
 ▶ #7  4m 12s in   attempt 1/3   $5.20 billed   ctx ~142K
   phase  read ─ branch ─ implement ─ build+test ─ pr ─ ▶review ─ merge
   now    review (cycle 2/3: C0 H1 M2 (blockers 1))   -> Edit: src/...
─────────────────────────────────────────────────────────────────────────────
```

- **Line 1** — run start, total elapsed, total billed `$`, and the model that's
  *actually* running. If the running model differs from what you asked for, it's
  flagged in red. While paused on a usage limit it also shows `⏸ LIMIT — resuming
  after reset` (see [Riding out usage limits](#riding-out-usage-limits)).
- **Queue** — `✓` done, `▶` current, `·` pending, `✗` failed (quarantined), `⊘`
  blocked (an epic sibling failed, so this step was skipped — see
  [Failure quarantine](#failure-quarantine)). A `✗N quarantined` tally appears
  after the done count when anything has failed.
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
| `DEVCYCLE_FAIL: …` | **Hard failure** — not retried. Quarantined; queue continues (stops with `-StopOnFail`). |
| Stopped on a usage/session limit | **Paused, not failed** (unless `-NoWaitForReset`): waits for the reset, then re-dispatches the same attempt for free — see [Riding out usage limits](#riding-out-usage-limits). |
| Crash / no sentinel (incomplete) | **Resumed** up to `MaxResumes` times, then quarantined. |
| `DEVCYCLE_OK` but issue not `CLOSED`, or `gh` can't confirm | Treated as failure — quarantined. |

**Resuming** is safe: a resumed attempt checks out the existing branch/PR, figures
out what's already done, and continues from the first incomplete phase rather than
restarting.

---

## Failure quarantine

By default a failed item does **not** kill the run — it's marked `✗` and skipped
over, and the queue keeps earning through the night instead of dying at 2am on
item 3 of 9.

**Rules:**

- **Plain issue fails** → quarantined; every later item still runs.
- **Epic child fails** → the whole epic is quarantined: its remaining children and
  its finalize step are marked `⊘` blocked and skipped **without a paid run**.
  Children stack sequentially on a shared branch and finalize lands the whole stack
  and closes every child issue — proceeding would land an incomplete epic and close
  unfixed issues. Items *outside* the epic continue normally. `develop` is never
  touched by a quarantined epic; its branch is left for inspection.
- **Circuit breaker** — `-MaxConsecutiveFails` (default `3`) consecutive failures
  aborts the run anyway. A systemic problem (broken `gh` auth, `npm`, network) fails
  every item *after* its paid claude run; the breaker stops the queue before it
  burns the remaining budget discovering that. Successes reset the counter, and
  `⊘` skips don't count.
- **Exit code** — `1` if anything failed (even when the queue ran to the end), so
  callers/CI still see the run as red. `0` only on a fully clean queue.
- **Recovery** — re-run the same issue list: done items resume-skip for free, and
  only the failed/blocked ones dispatch again.
- The [KB graduation review](#the-kb-graduation-review) still runs after a queue
  that finished with quarantined failures (it's skipped only when the run aborts —
  `-StopOnFail` or the circuit breaker).

`-StopOnFail` restores the legacy behaviour: first failure stops everything.

---

## Riding out usage limits

A long queue can outrun your Claude **usage/session limit** mid-run. When that
happens the headless process stops *without* a `DEVCYCLE_OK` sentinel — which on
its own looks just like a crash and would burn a resume attempt, then (past
`-MaxResumes`) stop the whole queue.

**By default the harness handles this for you.** When it detects a usage/session/API
limit it treats the run as *paused, not failed*:

1. It parses the reset time from the limit message (e.g. *"…resets 7:20pm"*), adds a
   2-minute buffer, and **sleeps until then** (logging a countdown every ~5 min). If no
   time can be parsed it falls back to polling every 30 min — a retry that re-hits the
   limit is ~free and returns immediately, so polling eventually gets through.
2. It then **re-dispatches the same attempt** — this does *not* count against
   `-MaxResumes`. The re-dispatch carries the resume note, so the model continues from
   the existing branch/PR rather than restarting.
3. `-MaxWaits` (default 12) caps consecutive waits per attempt, so a mis-detected or
   perpetual limit can't loop forever; past the cap the limit falls through to the normal
   incomplete/resume path.

While paused, the panel's header shows `⏸ LIMIT — resuming after reset` and the queue
holds its place. Leave the run going overnight and it picks itself back up.

**How a limit is detected:** either a raw *"you've hit your session limit · resets …"*
line in the stream (the process exits with no clean result), or a surfaced
`api_error_status` (429/529/5xx) / limit wording in the final result — the CLI only
surfaces those after its own internal retries gave up.

**To opt out:** pass `-NoWaitForReset`. A limit is then just an incomplete run — retried
up to `-MaxResumes` times and, if still stuck, it stops the queue. Use this when you'd
rather fail fast than have the run sit idle waiting for a reset.

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
| `review` | `cycles_run`, `total_review_sec`, `total_fix_sec`, `findings_total` by priority, `dispositions_total` (see below; `null` if no cycle reported) |
| `review_cycles[]` | nested per-cycle records (same shape as below) |

**`review-cycles.jsonl`** — one flat record per review cycle:

| Field | Meaning |
|-------|---------|
| `issue`, `attempt`, `review_cycle`, `max_cycles` | which cycle |
| `findings` | `critical`/`high`/`medium`/`low`/`style`, plus derived `blocker` (=crit+high) and `total` |
| `dispositions` | The fate of every deduped finding, **as adjudicated by the fixer** (who holds the implementation intent): `fixed`, `rejected_intentional` (deliberate code backed by a named, verifiable constraint), `rejected_wrong` (reviewer factually incorrect), `deferred` (real but non-blocking, filed as follow-up). Sums to `findings.total`. `null` on cycles that never reported (pre-tracking records). This measures reviewer **false positives** — the raw signal for whether context-blind reviewers need an intent memo. |
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

# Reviewer false-positive rate (rejected findings / all adjudicated findings)
$d = Get-Content dev-cycle-analytics/review-cycles.jsonl |
  ForEach-Object { ($_ | ConvertFrom-Json).dispositions } | Where-Object { $_ }
$rej = ($d | ForEach-Object { $_.rejected_intentional + $_.rejected_wrong } | Measure-Object -Sum).Sum
$tot = ($d | ForEach-Object { $_.fixed + $_.rejected_intentional + $_.rejected_wrong + $_.deferred } | Measure-Object -Sum).Sum
"rejected $rej of $tot adjudicated findings ($([math]::Round($rej/$tot*100))% false-positive rate)"
```

With `jq`:

```bash
jq -c 'select(.outcome=="ok") | {issue, total_sec, billed_cost_usd}' dev-cycle-analytics/tasks.jsonl

# Reviewer false-positive rate (rejected findings / all adjudicated findings) —
# the signal for whether context-blind reviewers need more author context:
jq -s '[.[] | .dispositions | select(.)] |
  { rejected: (map(.rejected_intentional + .rejected_wrong) | add),
    total:    (map(.fixed + .rejected_intentional + .rejected_wrong + .deferred) | add) } |
  . + { rate: (if .total > 0 then (.rejected / .total * 100 | round) else null end) }' \
  dev-cycle-analytics/review-cycles.jsonl
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

## The KB graduation review

After the queue runs to its end (including with quarantined failures — only an
aborted run skips it), the harness runs a graduation review of the review knowledge
base (`dev-cycle-analytics/review-lessons.jsonl`). Skip it with `-NoGraduate`; run
it on its own with `-GraduateOnly`.

**Why:** *active* lessons (recurred in ≥2 issues) are injected only into the
implementer for matching files (the hot path). *Graduating* one compiles it into
`dev-docs/review-rules.md`, which `CLAUDE.md` `@`-imports — always-on context for
**every** agent. That's high-leverage but expensive shared space, which is why the
step is human-gated: the harness recommends, you decide.

**Flow:**

1. One short headless `claude` call (same `-Model` as the run) ranks all active
   lessons as an *honest curator*: it weighs breadth (codebase-wide vs. an area the
   hot path's file-glob targeting already covers), recurrence pressure (distinct
   issues, recent `last_seen` — is the hot path failing to prevent it?), leverage,
   and overlap with already-graduated rules. It's explicitly told that recommending
   **against** graduation is often correct.
2. An interactive picker opens (alternate screen buffer — your scrollback is
   preserved), ordered by the agent's priority, recommended items pre-selected.
   Every item shows the verdict with confidence, the case **for** (`+`), and the
   honest case **against** (`−`).

   | Key | Action |
   |-----|--------|
   | `↑`/`↓` (or `k`/`j`) | move |
   | `space` | toggle selection |
   | `r` | reset selection to the agent's recommendation |
   | `a` | select all / none |
   | `enter` | graduate the selected lessons |
   | `q` / `esc` | skip — KB unchanged |

3. Confirmed picks run through `node scripts/kb/graduate.mjs --id …`, which updates
   the lesson store and regenerates `dev-docs/review-rules.md`. **Nothing is
   committed** — commit `review-lessons.jsonl` + `review-rules.md` when ready.

**Degradation:** if the recommendation call fails or returns unparseable JSON, the
picker still opens with the candidates ordered by severity/recurrence, marked
`agent: no advice`. On a non-VT terminal the picker becomes a printed list plus a
numbered `Read-Host` prompt (Enter = accept recommended). With no interactive
console at all (redirected stdin), it prints the ranking and instructions to
graduate manually, and changes nothing.

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Panel renders garbled | Terminal lacks scroll-region support. Use `-NoPanel`. |
| No panel appears | Not Windows Terminal and `-Panel` not set, or window too short. Add `-Panel` or enlarge the window. |
| `model … (asked sonnet!)` in red | The CLI ran a different model than requested — check your `claude` config / default model. |
| Run sits at `⏸ LIMIT — resuming after reset` | Working as intended — the account hit its usage/session limit and the run is sleeping until it resets (countdown logged every ~5 min). Pass `-NoWaitForReset` if you'd rather fail fast. See [Riding out usage limits](#riding-out-usage-limits). |
| Item quarantined with `UNVERIFIED` | `gh issue view` failed — check `gh auth status`. If `gh` is broken globally, the circuit breaker will stop the run after `-MaxConsecutiveFails` items. |
| Item quarantined with `MISMATCH` | The model reported success but the issue isn't closed (or the child isn't on the epic branch) — inspect the PR/issue manually, then re-run the list to retry it. |
| Issue keeps resuming then gets quarantined | The cycle can't complete (e.g. persistent build break). Read the latest `dev-cycle-logs/issue-<n>-*.log`. |
| Run aborts on `N consecutive item failures` | The circuit breaker tripped — the failures look systemic (gh auth, npm, network), not per-issue. Fix the environment, then re-run the same list; done items skip for free. |

---

## Phase reference

The phases shown on the track, in order:

`read` → `branch` → `implement` → `build+test` → `pr` → `review` (×N cycles) → `merge`

Phase state comes from `DEVCYCLE_PHASE:` markers emitted by `/dev-cycle-phases`
(**not** plain `/dev-cycle`). Findings counts and the review/fix-time split come
from `DEVCYCLE_METRIC:` markers from the same skill.
