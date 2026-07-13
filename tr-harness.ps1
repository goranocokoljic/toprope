#!/usr/bin/env pwsh
# tr-harness.ps1 — run /dev-cycle-phases on a list of GitHub issues
# sequentially, with a pinned status panel at the bottom of the terminal.
#
# This is the panel variant of run-issues.ps1. Behaviour (fresh process per
# issue, resumable incomplete runs) is identical; the difference is the live HUD
# pinned to the bottom rows while logs scroll above.
#
# Failure quarantine (default): a failed item is marked ✗ and SKIPPED OVER — the
# rest of the queue keeps running. A failed epic child blocks that epic's remaining
# children and its finalize step (⊘) so an incomplete stack can never land, while
# items outside the epic continue. -MaxConsecutiveFails (default 3) is the circuit
# breaker: that many failures in a row looks systemic (broken gh/npm/network) and
# stops the run before it burns a paid claude run per remaining item. -StopOnFail
# restores the legacy stop-at-first-failure behaviour. Exit code is 1 if any item
# failed, even when the queue ran to the end.
#
# The HUD shows, at a glance:
#   - when the run started and total elapsed
#   - the issue queue with per-issue state (done / current / pending / failed)
#   - the current issue, when it started, and how long it has been running
#   - which dev-cycle phase it is in, drawn as a left-to-right track
#
# Phase state comes from `DEVCYCLE_PHASE:` markers emitted by the
# /dev-cycle-phases skill (NOT plain /dev-cycle). Run that skill, not the
# original, or the phase track will stay on "read".
#
# Requires a VT-capable terminal (Windows Terminal). If not detected, or with
# -NoPanel, it degrades to plain streaming (same output as run-issues.ps1).
#
# Usage:
#   ./tr-harness.ps1 6 7 8
#   ./tr-harness.ps1 -Issues 6,7,8 -MaxResumes 1
#   ./tr-harness.ps1 6 7 8 -Model fable     # default is opus
#   ./tr-harness.ps1 6 7 8 -ReviewCycles 2  # cap Phase-6 review cycles (default 3)
#   ./tr-harness.ps1 6 7 8 -Panel           # force panel (e.g. WebStorm terminal)
#   ./tr-harness.ps1 6 7 8 -NoPanel
#   ./tr-harness.ps1 150 151 152 -Fresh     # re-run every item, ignoring the resume-skip
#   ./tr-harness.ps1 6 7 8 -NoWaitForReset  # don't sleep through usage limits (see below)
#   ./tr-harness.ps1 6 7 8 -NoGraduate      # skip the post-run KB graduation review
#   ./tr-harness.ps1 -GraduateOnly          # just the KB graduation review, no runs
#   ./tr-harness.ps1 6 7 8 -StopOnFail      # legacy: stop the run at the first failure
#
# Usage limits: by DEFAULT, if a run stops because the account hit its Claude usage/
# session limit, the harness sleeps until the limit's reset time (parsed from the limit
# message, +2 min buffer) and re-dispatches the SAME attempt — so a long overnight queue
# rides out the reset on its own instead of burning resume attempts and stopping. Pass
# -NoWaitForReset to disable it; -MaxWaits N (default 12) caps consecutive waits per attempt.
#
# Epics: if an issue has GitHub sub-issues (or a "Subtasks" section listing #NN), its
# children are built on a shared epic branch and reviewed once at the end. Re-running
# the same list RESUMES: already-merged children and already-closed epics/issues are
# skipped deterministically (no claude run, no tokens) before dispatch — unless -Fresh.
#
# KB graduation: after the queue runs to its end (quarantined failures included; an
# aborted run skips it), the harness reviews the review-KB's *active* lessons
# (dev-cycle-analytics/review-lessons.jsonl): one headless claude call ranks them with
# an honest graduate/hold recommendation, you pick interactively, and the picks are
# applied via scripts/kb/graduate.mjs (which regenerates dev-docs/review-rules.md —
# the cold path loaded into EVERY agent's context). -NoGraduate skips the step;
# -GraduateOnly runs just this step with no dev-cycle runs.
#
# Per-run analytics (separate from the stream-json logs in dev-cycle-logs/) are
# appended to dev-cycle-analytics/ as JSONL:
#   tasks.jsonl          one record per issue run — outcome, total duration,
#                        per-phase duration/tokens/est-cost, billed total_cost_usd,
#                        and the nested review-cycle breakdown.
#   review-cycles.jsonl  one record per review cycle — findings by priority,
#                        review time vs fix time, tokens, est cost.
# See Write-Analytics. Cost note: per-phase/-cycle $ are ESTIMATES apportioned from
# the one authoritative total_cost_usd by output-token share (the stream has no
# per-phase cost, and cache tokens must never be summed — see the cost memo below).

[CmdletBinding()]
param(
    # Required unless -GraduateOnly (validated below — kept non-mandatory so the
    # graduation review can run standalone without an issue list).
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [int[]]$Issues,

    # How many times to resume a single issue after an incomplete (non-failure) run.
    [int]$MaxResumes = 2,

    # Maximum code-review cycles per issue (Phase 6 of the dev-cycle). Passed through
    # to the skill, which otherwise defaults to 3. Each cycle = one multi-lens review
    # + fix + gate + push. Lower it for cheaper/faster runs; raise it for tougher issues.
    [ValidateRange(1, 10)]
    [int]$ReviewCycles = 3,

    # Model passed to `claude -p --model`. Defaults to opus. Always passed
    # explicitly so the headless CLI never silently falls back to the
    # configured default. Fast mode is interactive-only, so it is not
    # offered here.
    [ValidateSet('sonnet', 'opus', 'fable')]
    [string]$Model = 'opus',

    # Force the pinned panel on even when Windows Terminal isn't detected (e.g.
    # the WebStorm/JetBrains terminal, which is VT-capable but doesn't set
    # WT_SESSION). If the panel renders garbled, your terminal lacks scroll-
    # region support — fall back to -NoPanel.
    [switch]$Panel,

    # Force plain streaming with no pinned panel.
    [switch]$NoPanel,

    # Re-run every item even if it already looks complete (disables the resume-skip:
    # already-merged children / already-closed issues are normally skipped without a run).
    [switch]$Fresh,

    # Opt OUT of auto-resume across usage/session limits. By DEFAULT, when the account
    # hits its Claude usage/session limit mid-run, the harness sleeps until the limit's
    # reset time (parsed from the limit message) and re-dispatches the SAME attempt —
    # so an overnight queue rides out the reset on its own instead of burning attempts
    # and stopping. Pass -NoWaitForReset to disable that: a limit then falls through to
    # the normal incomplete/resume path (and, past -MaxResumes, stops the run).
    [switch]$NoWaitForReset,

    # Safety cap on consecutive limit-waits per issue attempt, so a mis-detected or
    # perpetual limit can't loop forever. Once exceeded, a limit stops behaving as a
    # wait and falls through to the normal incomplete/resume path.
    [int]$MaxWaits = 12,

    # Stop the whole run at the FIRST failed item (legacy behaviour). Default is
    # failure quarantine: a failed item is skipped over and the queue continues;
    # a failed epic child additionally blocks that epic's remaining children and
    # its finalize step so an incomplete stack can never land.
    [switch]$StopOnFail,

    # Quarantine circuit breaker: this many CONSECUTIVE item failures stops the run
    # anyway. A systemic problem (broken gh auth, npm, network) fails every item
    # AFTER its paid claude run — without this cap, quarantine would burn the whole
    # queue's budget discovering that. Successes reset the counter.
    [ValidateRange(1, 100)]
    [int]$MaxConsecutiveFails = 3,

    # Skip the interactive KB graduation review that runs after the whole queue
    # completes successfully.
    [switch]$NoGraduate,

    # Run ONLY the KB graduation review — no dev-cycle runs, no panel. Reviews the
    # KB's active lessons with an agent recommendation and graduates the ones you pick.
    [switch]$GraduateOnly
)

$ErrorActionPreference = 'Stop'
# We manage native (git/gh) exit codes ourselves via $LASTEXITCODE, so a non-zero
# exit must NOT throw — except where we explicitly `throw` to fail loud (epic resolution).
$PSNativeCommandUseErrorActionPreference = $false

# -Issues is only optional for the standalone graduation review.
if (-not $GraduateOnly -and (-not $Issues -or $Issues.Count -eq 0)) {
    Write-Host 'Usage: ./tr-harness.ps1 <issue> [<issue> ...] [options]   (or -GraduateOnly)' -ForegroundColor Red
    exit 2
}

$OK   = 'DEVCYCLE_OK'
$FAIL = 'DEVCYCLE_FAIL'

$logDir = Join-Path $PSScriptRoot 'dev-cycle-logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$analyticsDir = Join-Path $PSScriptRoot 'dev-cycle-analytics'
New-Item -ItemType Directory -Force -Path $analyticsDir | Out-Null
$tasksJsonl   = Join-Path $analyticsDir 'tasks.jsonl'
$cyclesJsonl  = Join-Path $analyticsDir 'review-cycles.jsonl'
$epicsJsonl   = Join-Path $analyticsDir 'epics.jsonl'      # one record per finalized epic (roll-up over its children + finalize)

$maxAttempts = $MaxResumes + 1

# Auto-resume across usage/session limits is ON by default; -NoWaitForReset opts out.
$WaitForReset = -not $NoWaitForReset

# --------------------------------------------------------------------------
# Panel state (script scope — updated as the run progresses, read by Draw-Panel)
# --------------------------------------------------------------------------
$ESC       = [char]27
$PHASES    = @('read', 'branch', 'implement', 'build+test', 'pr', 'review', 'merge')
$PanelRows = 8

# Decide whether we can draw the panel. Windows Terminal sets WT_SESSION and
# supports the VT sequences we use (scroll region, cursor save/restore). Other
# VT-capable terminals (e.g. WebStorm) don't set WT_SESSION, so -Panel forces
# it on. -NoPanel always wins.
# The console probe throws when there is no attached console (redirected/headless
# runs, e.g. the RIP_NOEXEC smoke test) — treat that as "no panel".
$script:PanelMode = (-not $NoPanel) -and ($Panel -or [bool]$env:WT_SESSION) -and
    (& { try { [Console]::WindowHeight -gt ($PanelRows + 4) } catch { $false } })

$script:RunStart    = Get-Date
$script:IssueState  = [ordered]@{}      # work-item issue number -> 'pending'|'running'|'done'|'failed'
$script:WorkList    = @()               # expanded work items (epics -> children + finalize); built in main
$script:ItemByIssue = @{}               # issue number (string) -> work item, for panel/queue rendering
$script:CurItem     = $null             # the work item currently running (mode/epic context for the panel)
$script:CurrentIssue = $null
$script:IssueStart   = $null
$script:Attempt      = 0
$script:MaxAtt       = $maxAttempts
$script:Phase        = $null            # one of $PHASES
$script:PhaseDetail  = ''               # e.g. "cycle 2/3"
$script:NowDetail    = ''               # latest tool command / activity
$script:ModelArg     = $Model           # what we asked claude to use
$script:RunModel     = ''               # what the stream says is ACTUALLY running
$script:RunState     = 'running'        # 'running' | 'stopped'
$script:StopReason   = ''
$script:RunCost      = 0.0              # real USD billed so far (sum of completed runs' total_cost_usd)
$script:IssueCost    = 0.0             # real USD for the current issue (across its attempts)
$script:LastCost     = 0.0             # total_cost_usd captured from the current process's result line
$script:CurCtx       = 0.0             # latest turn's prompt size in tokens (live context gauge)
$script:LimitHit     = $false          # last run stopped on a usage/session/API limit
$script:LimitReason  = ''              # human-readable limit message (shown in the pause banner)
$script:QueueCompleted = $false        # queue ran to its end -> run the KB graduation review
$script:BlockedEpics = @{}             # epic issue (string) -> $true once quarantined (child/finalize failed)
$script:ConsecFails  = 0               # consecutive failed items (circuit breaker; reset on success)
$script:HadFailures  = $false          # any item failed -> exit 1 at the very end

# --- Per-run analytics accumulators (reset at the start of each Invoke-DevCycleRun) ---
# $script:RunPhases       ordered: phase name -> phase record (timing + token volume)
# $script:RunCycles       array of review-cycle records (findings, review/fix split)
# $script:CurPhase        the open phase record (tokens attributed here)
# $script:CurCycle        the open review-cycle record, or $null
# $script:CurSub          'review' | 'fix' | 'done' — sub-phase within a review cycle
$script:RunPhases    = [ordered]@{}
$script:RunCycles    = @()
$script:CurPhase     = $null
$script:CurCycle     = $null
$script:CurSub       = $null
$script:RunStartTs   = $null
$script:RunEndTs     = $null

# --- Per-epic roll-up accumulator (built from the worklist, accumulated across
# each epic's child + finalize runs; written to epics.jsonl when the epic finalizes) ---
$script:EpicAgg      = [ordered]@{}     # epic issue (string) -> roll-up record (billed, children, finalize stats)

# SGR color codes
$C = @{
    reset = '0'; bold = '1'; dim = '2'
    red = '31'; green = '32'; yellow = '33'; cyan = '36'; gray = '90'
    boldcyan = '1;36'; boldgreen = '1;32'; boldred = '1;31'
}

# --------------------------------------------------------------------------
# Cost & context. IMPORTANT: we do NOT reconstruct cost from per-turn usage.
# The stream re-reports 1h cache-creation tokens cumulatively, so naively
# summing cache_creation overstates cost by 2-70x vs what the CLI actually
# bills (verified against issue-38: reconstruction $978 vs real $13.81).
# Instead we read the authoritative total_cost_usd from each process's
# result line, and track only the live prompt size here as a context gauge.
# --------------------------------------------------------------------------
function Update-Ctx {
    param($Usage)
    if ($null -eq $Usage) { return }
    $cc = $Usage.cache_creation
    $w = if ($cc) { [double]$cc.ephemeral_5m_input_tokens + [double]$cc.ephemeral_1h_input_tokens }
         else { [double]$Usage.cache_creation_input_tokens }
    # Prompt size fed to the model this turn = uncached input + cache read + cache creation.
    $script:CurCtx = [double]$Usage.input_tokens + [double]$Usage.cache_read_input_tokens + $w
}

# --------------------------------------------------------------------------
# Usage / session-limit detection + wait-for-reset. When the account hits its
# Claude usage/session limit, a headless run stops WITHOUT a DEVCYCLE sentinel —
# which would otherwise look like a crash and burn a resume attempt. We detect the
# limit and (by default) sleep until it resets, then re-dispatch the same attempt.
# Ported from the ai-gen harness's shared tokens.ps1.
# --------------------------------------------------------------------------

# Did this run stop because of a usage / rate / API limit (vs a normal failure)? A
# surfaced api_error_status (429/529/5xx) means the CLI already retried and gave up;
# limit wording in the result text is the softer signal.
function Test-UsageLimit {
    param([string]$ResultText, $ApiErrorStatus)
    if ($null -ne $ApiErrorStatus -and "$ApiErrorStatus".Trim() -ne '' -and "$ApiErrorStatus" -ne 'null') { return $true }
    if ($ResultText -match '(?i)usage limit|rate[ _-]?limit|too many requests|overloaded|quota (?:exceeded|reached)|limit (?:reached|will reset)|reset[s]? at') { return $true }
    return $false
}

# A single RAW stream line that signals the CLI gave up on a session/usage limit. The
# limit prints as a plain line ("You've hit your session limit · resets 7:20pm ...") and
# the process exits WITHOUT a clean result object, so Test-UsageLimit alone misses it.
# Anchored on distinctive phrases so ordinary dev-cycle output can't trip it.
function Test-LimitLine {
    param([string]$Line)
    if ([string]::IsNullOrWhiteSpace($Line)) { return $false }
    return ($Line -match "(?i)hit your (?:session|usage|weekly|5-?hour|account) limit|(?:usage|session) limit reached|claude usage limit|approaching your (?:session|usage) limit|limit · reset")
}

# Parse the reset time out of a limit message ("...resets 7:20pm..." / "...resets at 19:20...")
# into the next future local DateTime, or $null if there's no time to parse. The message's
# wall-clock is assumed to be the machine's local time (the limit text names the operator's TZ).
function Get-ResetTime {
    param([string]$Reason)
    $m = [regex]::Match([string]$Reason, '(?i)reset[s]?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?')
    if (-not $m.Success) { return $null }
    $h = [int]$m.Groups[1].Value
    $min = if ($m.Groups[2].Success) { [int]$m.Groups[2].Value } else { 0 }
    $ap = $m.Groups[3].Value.ToLower()
    if ($ap -eq 'pm' -and $h -lt 12) { $h += 12 } elseif ($ap -eq 'am' -and $h -eq 12) { $h = 0 }
    if ($h -gt 23 -or $min -gt 59) { return $null }
    $t = (Get-Date -Hour $h -Minute $min -Second 0).AddMilliseconds(-(Get-Date).Millisecond)
    if ($t -le (Get-Date)) { $t = $t.AddDays(1) }   # already past today → it's tomorrow
    return $t
}

# Block until the limit resets, then return $true so the caller can retry. Sleeps in <=60s
# chunks (Ctrl-C stays responsive) and logs a countdown every ~5 min (each log repaints the
# panel). If no time can be parsed, falls back to a fixed poll interval — each retry is ~free
# (it re-hits the limit and returns immediately) so polling eventually gets through.
function Wait-UntilReset {
    param([string]$Reason, [int]$FallbackMinutes = 30, [int]$BufferSeconds = 120)
    $target = Get-ResetTime -Reason $Reason
    if ($null -eq $target) { $target = (Get-Date).AddMinutes($FallbackMinutes); $label = 'no reset time in message; auto-retrying at' }
    else { $target = $target.AddSeconds($BufferSeconds); $label = 'limit hit; auto-resuming at' }

    $canLog = [bool](Get-Command Write-Log -ErrorAction SilentlyContinue)
    $lastLog = (Get-Date).AddMinutes(-10)
    while ((Get-Date) -lt $target) {
        $left = $target - (Get-Date)
        if (((Get-Date) - $lastLog).TotalSeconds -ge 300 -or $left.TotalSeconds -le 65) {
            $msg = "    [wait] $label $($target.ToString('ddd HH:mm')) — {0}h{1:00}m left" -f [int]$left.TotalHours, $left.Minutes
            if ($canLog) { Write-Log $msg 'Yellow' } else { Write-Host $msg -ForegroundColor Yellow }
            $lastLog = Get-Date
        }
        Start-Sleep -Seconds ([Math]::Min(60, [Math]::Max(5, [int]$left.TotalSeconds)))
    }
    return $true
}

# --------------------------------------------------------------------------
# Analytics capture. We observe the same stream the panel does, but timestamp
# phase/metric markers and attribute per-turn token VOLUME (output + new input —
# the only safely-summable usage fields; cache tokens are re-reported cumulatively
# and must never be summed, see the cost memo above) to whichever phase is open.
#
# What is real vs. estimated:
#   - durations            real (wall clock between markers)
#   - findings by priority real (emitted by the skill, which just bucketed them)
#   - output/input tokens  real per-phase volume (safe to sum)
#   - billed_cost_usd      real, authoritative (total_cost_usd, task level only)
#   - est_cost_usd         ESTIMATE: billed total apportioned by output-token share
# --------------------------------------------------------------------------
function Reset-Analytics {
    $script:RunPhases  = [ordered]@{}
    $script:RunCycles  = @()
    $script:CurPhase   = $null
    $script:CurCycle   = $null
    $script:CurSub     = $null
    $script:RunStartTs = Get-Date
    $script:RunEndTs   = $null
}

function Open-Phase {
    param([string]$Name)
    if ($script:CurPhase -and -not $script:CurPhase.end) { $script:CurPhase.end = Get-Date }
    if (-not $script:RunPhases.Contains($Name)) {
        $script:RunPhases[$Name] = [ordered]@{
            phase = $Name; start = (Get-Date); end = $null
            out = 0.0; in = 0.0; turns = 0; tools = 0; peak = 0.0
        }
    }
    $script:CurPhase = $script:RunPhases[$Name]
}

function Start-ReviewCycle {
    param([int]$N, [int]$Max)
    # A previous cycle's record stays as-is; this opens the next one.
    $rec = [ordered]@{
        review_cycle = $N; max_cycles = $Max
        review_start = (Get-Date); review_end = $null; fix_start = $null; fix_end = $null
        critical = 0; high = 0; medium = 0; low = 0; style = 0
        # Finding dispositions as adjudicated by the fixer (context-blindness metric).
        # $null = never reported (old skill / crashed cycle), distinct from a real 0.
        fixed = $null; rejected_intentional = $null; rejected_wrong = $null; deferred = $null
        out = 0.0; in = 0.0; review_out = 0.0; fix_out = 0.0; turns = 0; tools = 0
    }
    $script:RunCycles += ,$rec
    $script:CurCycle = $rec
    $script:CurSub   = 'review'
}

# Attribute one assistant turn's token volume to the open phase (and review cycle).
function Add-TurnTokens {
    param($Usage, [bool]$IsMain)
    if ($null -eq $Usage) { return }
    $out = [double]$Usage.output_tokens
    $in  = [double]$Usage.input_tokens
    if ($script:CurPhase) {
        $script:CurPhase.out  += $out
        $script:CurPhase.in   += $in
        $script:CurPhase.turns++
        if ($IsMain -and $script:CurCtx -gt $script:CurPhase.peak) { $script:CurPhase.peak = $script:CurCtx }
    }
    if ($script:CurCycle -and $script:CurPhase -and $script:CurPhase.phase -eq 'review') {
        $script:CurCycle.out += $out
        $script:CurCycle.in  += $in
        $script:CurCycle.turns++
        if     ($script:CurSub -eq 'review') { $script:CurCycle.review_out += $out }
        elseif ($script:CurSub -eq 'fix')    { $script:CurCycle.fix_out    += $out }
    }
}

# Parse a DEVCYCLE_METRIC: line emitted by the skill. Returns $true if handled.
function Read-MetricMarker {
    param([string]$Raw)
    $m = [regex]::Match($Raw, '^\s*[`*_]*DEVCYCLE_METRIC:\s*(\w+)\s*(?:\|\s*(.*))?$')
    if (-not $m.Success) { return $false }
    $kind = $m.Groups[1].Value
    $kv = @{}
    foreach ($pair in [regex]::Matches($m.Groups[2].Value, '(\w+)\s*=\s*(\d+)')) {
        $kv[$pair.Groups[1].Value] = [int]$pair.Groups[2].Value
    }
    switch ($kind) {
        'review_done' {
            if ($script:CurCycle) {
                foreach ($k in 'critical','high','medium','low','style') {
                    if ($kv.ContainsKey($k)) { $script:CurCycle[$k] = $kv[$k] }
                }
                $script:CurCycle.review_end = Get-Date
                $script:CurSub = 'between'
                $b = $script:CurCycle.critical + $script:CurCycle.high
                $script:PhaseDetail = "cycle $($script:CurCycle.review_cycle): C$($script:CurCycle.critical) H$($script:CurCycle.high) M$($script:CurCycle.medium) (blockers $b)"
            }
        }
        'fix_start' { if ($script:CurCycle) { $script:CurCycle.fix_start = Get-Date; $script:CurSub = 'fix' } }
        'fix_done'  {
            if ($script:CurCycle) {
                $script:CurCycle.fix_end = Get-Date; $script:CurSub = 'done'
                # Robustness: absorb disposition counts if the skill folded them in here.
                foreach ($k in 'fixed','rejected_intentional','rejected_wrong','deferred') {
                    if ($kv.ContainsKey($k)) { $script:CurCycle[$k] = $kv[$k] }
                }
            }
        }
        'dispositions' {
            # Per-finding fate as adjudicated by the fixer: fixed / rejected_intentional /
            # rejected_wrong / deferred. A key absent from an emitted marker counts as 0
            # (reported-zero), unlike a cycle that never reported (stays $null).
            if ($script:CurCycle) {
                foreach ($k in 'fixed','rejected_intentional','rejected_wrong','deferred') {
                    $script:CurCycle[$k] = if ($kv.ContainsKey($k)) { $kv[$k] } else { 0 }
                }
            }
        }
    }
    return $true
}

function Get-Sec { param($A, $B) if ($A -and $B) { [math]::Round((($B) - ($A)).TotalSeconds, 1) } else { $null } }

# Finalize accumulators into JSONL records and append them. Called once per run.
# $Mode is 'default' | 'subtask' | 'finalize'; $EpicIssue is the parent epic (0 if none).
function Write-Analytics {
    param([int]$Issue, [int]$Attempt, [string]$Outcome, [double]$BilledUsd,
          [string]$Mode = 'default', [int]$EpicIssue = 0)

    if ($script:CurPhase -and -not $script:CurPhase.end) { $script:CurPhase.end = Get-Date }
    $script:RunEndTs = Get-Date
    $ts = (Get-Date).ToString('o')

    $totalOut = 0.0
    foreach ($p in $script:RunPhases.Values) { $totalOut += $p.out }
    $apportion = { param($o) if ($BilledUsd -gt 0 -and $totalOut -gt 0) { [math]::Round($BilledUsd * $o / $totalOut, 4) } else { 0.0 } }

    $phaseRecs = foreach ($p in $script:RunPhases.Values) {
        [ordered]@{
            phase            = $p.phase
            duration_sec     = Get-Sec $p.start $p.end
            out_tokens       = [long]$p.out
            in_tokens        = [long]$p.in
            turns            = $p.turns
            tool_calls       = $p.tools
            peak_ctx_tokens  = [long]$p.peak
            est_cost_usd     = & $apportion $p.out
        }
    }

    $cycleRecs = foreach ($c in $script:RunCycles) {
        $reviewSec = Get-Sec $c.review_start $c.review_end
        $fixSec    = Get-Sec $c.fix_start $c.fix_end
        $cycleEnd  = if ($c.fix_end) { $c.fix_end } else { $c.review_end }
        # null when the cycle never reported dispositions (old skill version / crash).
        $disp = if ($null -ne $c.fixed -or $null -ne $c.rejected_intentional -or
                    $null -ne $c.rejected_wrong -or $null -ne $c.deferred) {
            [ordered]@{
                fixed                = [int]($c.fixed ?? 0)
                rejected_intentional = [int]($c.rejected_intentional ?? 0)
                rejected_wrong       = [int]($c.rejected_wrong ?? 0)
                deferred             = [int]($c.deferred ?? 0)
            }
        } else { $null }
        [ordered]@{
            issue          = $Issue
            attempt        = $Attempt
            ts             = $ts
            review_cycle   = $c.review_cycle
            max_cycles     = $c.max_cycles
            findings       = [ordered]@{
                critical = $c.critical; high = $c.high; medium = $c.medium
                low = $c.low; style = $c.style
                blocker = ($c.critical + $c.high)
                total = ($c.critical + $c.high + $c.medium + $c.low + $c.style)
            }
            dispositions   = $disp
            review_sec       = $reviewSec
            fix_sec          = $fixSec
            cycle_sec        = Get-Sec $c.review_start $cycleEnd
            out_tokens       = [long]$c.out
            in_tokens        = [long]$c.in
            review_out_tokens = [long]$c.review_out
            fix_out_tokens    = [long]$c.fix_out
            turns            = $c.turns
            tool_calls       = $c.tools
            est_cost_usd     = & $apportion $c.out
        }
    }
    $cycleRecs = @($cycleRecs)

    # Per-cycle rows (flat, one JSON object per line) for easy slicing.
    foreach ($r in $cycleRecs) {
        Add-Content -Path $cyclesJsonl -Value ($r | ConvertTo-Json -Depth 6 -Compress)
    }

    $sumFind = [ordered]@{ critical = 0; high = 0; medium = 0; low = 0; style = 0 }
    $sumDisp = [ordered]@{ fixed = 0; rejected_intentional = 0; rejected_wrong = 0; deferred = 0 }
    $dispReported = $false
    $totReview = 0.0; $totFix = 0.0
    foreach ($c in $script:RunCycles) {
        foreach ($k in 'critical','high','medium','low','style') { $sumFind[$k] += $c[$k] }
        if ($null -ne $c.fixed -or $null -ne $c.rejected_intentional -or
            $null -ne $c.rejected_wrong -or $null -ne $c.deferred) {
            $dispReported = $true
            foreach ($k in 'fixed','rejected_intentional','rejected_wrong','deferred') { $sumDisp[$k] += [int]($c[$k] ?? 0) }
        }
        $rs = Get-Sec $c.review_start $c.review_end; if ($rs) { $totReview += $rs }
        $fs = Get-Sec $c.fix_start $c.fix_end;       if ($fs) { $totFix += $fs }
    }

    $task = [ordered]@{
        issue           = $Issue
        attempt         = $Attempt
        ts              = $ts
        outcome         = $Outcome
        mode            = $Mode
        epic_issue      = $EpicIssue
        model_asked     = $script:ModelArg
        model_ran       = $script:RunModel
        total_sec       = Get-Sec $script:RunStartTs $script:RunEndTs
        billed_cost_usd = [math]::Round($BilledUsd, 4)
        phases          = @($phaseRecs)
        review          = [ordered]@{
            cycles_run         = $cycleRecs.Count
            max_cycles         = $ReviewCycles
            total_review_sec   = [math]::Round($totReview, 1)
            total_fix_sec      = [math]::Round($totFix, 1)
            findings_total     = $sumFind
            dispositions_total = $(if ($dispReported) { $sumDisp } else { $null })
        }
        review_cycles   = $cycleRecs
    }
    Add-Content -Path $tasksJsonl -Value ($task | ConvertTo-Json -Depth 8 -Compress)
}

# Write one roll-up record for a finalized epic. Billed cost is the authoritative
# sum across the epic's children + finalize runs (accumulated in the main loop);
# the finalize review stats come from the just-completed finalize run's cycles
# (still held in $script:RunCycles at call time).
function Write-EpicRollup {
    param($Agg, [string]$FinalizeOutcome)

    $cycles = @($script:RunCycles)
    $find = [ordered]@{ critical = 0; high = 0; medium = 0; low = 0; style = 0 }
    foreach ($c in $cycles) { foreach ($k in 'critical','high','medium','low','style') { $find[$k] += $c[$k] } }

    $rec = [ordered]@{
        record          = 'epic'
        ts              = (Get-Date).ToString('o')
        epic            = $Agg.epic
        branch          = $Agg.branch
        children        = @($Agg.children)
        child_total     = $Agg.child_total
        child_ok        = $Agg.child_ok
        outcome         = $FinalizeOutcome
        wall_sec        = Get-Sec $Agg.start (Get-Date)
        billed_cost_usd = [math]::Round($Agg.billed_usd, 4)
        billed_partial  = [bool]$Agg.resumed   # true => some children ran in a prior invocation; billed/wall cover only this run
        finalize_review = [ordered]@{
            cycles_run     = $cycles.Count
            blockers_fixed = ($find.critical + $find.high)
            findings_total = $find
        }
    }
    Add-Content -Path $epicsJsonl -Value ($rec | ConvertTo-Json -Depth 6 -Compress)
}

# --------------------------------------------------------------------------
# Low-level terminal helpers
# --------------------------------------------------------------------------
function Set-ScrollRegion { param([int]$Top, [int]$Bottom) [Console]::Write("$ESC[$Top;${Bottom}r") }
function Reset-ScrollRegion { [Console]::Write("$ESC[r") }

# Build a colored line from segments, clipped to $Width visible chars so the
# panel never wraps. Each segment is @{ t = '<text>'; c = '<sgr or empty>' }.
function Format-Line {
    param([object[]]$Segs, [int]$Width)
    $sb  = ''
    $vis = 0
    foreach ($s in $Segs) {
        if ($vis -ge $Width) { break }
        $t = [string]$s.t
        if ($vis + $t.Length -gt $Width) { $t = $t.Substring(0, [Math]::Max(0, $Width - $vis)) }
        if ($t.Length -gt 0) {
            if ($s.c) { $sb += "$ESC[$($s.c)m$t$ESC[0m" } else { $sb += $t }
            $vis += $t.Length
        }
    }
    return $sb
}

function Seg { param([string]$t, [string]$c = '') return @{ t = $t; c = $c } }

# --------------------------------------------------------------------------
# Panel rendering
# --------------------------------------------------------------------------
function Get-PanelLines {
    param([int]$Width)

    $rule = @(Seg ('─' * $Width) $C.gray)

    # Line 1 — run-level
    $elapsed = (Get-Date) - $script:RunStart
    $elapsedStr = '{0:00}:{1:00}:{2:00}' -f [int]$elapsed.TotalHours, $elapsed.Minutes, $elapsed.Seconds
    $costStr = '$' + ('{0:N2}' -f $script:RunCost)
    $costCol = if ($script:RunState -eq 'stopped') { $C.boldred } else { $C.boldgreen }
    $line1 = @(
        Seg ' tr-harness  ' $C.bold
        Seg ('started {0}   ' -f $script:RunStart.ToString('HH:mm:ss')) $C.gray
        Seg ('elapsed {0}   ' -f $elapsedStr) ''
        Seg ("$costStr billed") $costCol
    )
    # Actual running model (from the stream), and a red flag if it differs from
    # what we asked for — this is what would have caught "why no Sonnet?".
    $fam = if ($script:RunModel -match 'opus') { 'opus' }
           elseif ($script:RunModel -match 'fable') { 'fable' }
           elseif ($script:RunModel -match 'sonnet') { 'sonnet' }
           elseif ($script:RunModel -match 'haiku') { 'haiku' }
           elseif ($script:RunModel) { $script:RunModel }
           else { '' }
    if (-not $fam)                        { $line1 += Seg ("   model {0}?" -f $script:ModelArg) $C.gray }
    elseif ($fam -eq $script:ModelArg)    { $line1 += Seg ("   model {0}" -f $fam) $C.cyan }
    else                                  { $line1 += Seg ("   model {0} (asked {1}!)" -f $fam, $script:ModelArg) $C.boldred }
    if     ($script:RunState -eq 'stopped') { $line1 += Seg '   STOPPED' $C.boldred }
    elseif ($script:RunState -eq 'paused')  { $line1 += Seg '   ⏸ LIMIT — resuming after reset' $C.yellow }

    # Line 2 — queue. Epics render as a bracketed group of children followed by the
    # finalize step, marked ⊕:  150  [✓153 ▶154 ·155 ·156 ·⊕151]  152
    $doneCount = ($script:IssueState.Values | Where-Object { $_ -eq 'done' }).Count
    $queueSegs = @(Seg ' queue: ' $C.gray)
    $inEpic = $null
    foreach ($n in $script:IssueState.Keys) {
        $it  = $script:ItemByIssue["$n"]
        $st  = $script:IssueState["$n"]
        $col = switch ($st) { 'done' { $C.green } 'running' { $C.boldcyan } 'failed' { $C.red } 'blocked' { $C.yellow } default { $C.gray } }
        $gl  = switch ($st) { 'done' { '✓' }      'running' { '▶' }         'failed' { '✗' }    'blocked' { '⊘' }       default { '·' } }
        if ($it -and $it.Mode -eq 'subtask') {
            if ($inEpic -ne $it.EpicIssue) { $queueSegs += Seg '[' $C.gray; $inEpic = $it.EpicIssue }
            $queueSegs += Seg ("$gl$n ") $col
        }
        elseif ($it -and $it.Mode -eq 'finalize') {
            $queueSegs += Seg ("$gl⊕$n] ") $col
            $inEpic = $null
        }
        else {
            if ($inEpic) { $queueSegs += Seg '] ' $C.gray; $inEpic = $null }
            $queueSegs += Seg ("$gl $n  ") $col
        }
    }
    if ($inEpic) { $queueSegs += Seg ']' $C.gray }
    $failCount = ($script:IssueState.Values | Where-Object { $_ -eq 'failed' }).Count
    $queueSegs += Seg (" (done {0}/{1})" -f $doneCount, $script:IssueState.Count) $C.gray
    if ($failCount -gt 0) { $queueSegs += Seg (" ✗$failCount quarantined") $C.red }
    $line2 = $queueSegs

    # Line 3 — current issue
    if ($script:CurrentIssue) {
        $glyph = if ($script:RunState -eq 'stopped') { '✗' } else { '▶' }
        $gcol  = if ($script:RunState -eq 'stopped') { $C.boldred } else { $C.boldcyan }
        $inFor = if ($script:IssueStart) {
            $d = (Get-Date) - $script:IssueStart
            '{0}m {1:00}s in' -f [int]$d.TotalMinutes, $d.Seconds
        } else { '' }
        # Live context gauge: prompt size of the latest turn. A run whose context
        # balloons past ~300K (issue-38 hit 365K) is self-correcting/looping —
        # amber past 180K, red past 300K. This, not a cost figure, is the real
        # early-warning signal a long/messy run gives off.
        $ctxK = $script:CurCtx / 1e3
        $ctxCol = if ($ctxK -gt 300) { $C.boldred } elseif ($ctxK -gt 180) { $C.yellow } else { $C.gray }
        # IssueCost is the authoritative billed total; it's $0 until the first
        # attempt's process finishes and reports total_cost_usd.
        $costSeg = if ($script:IssueCost -gt 0) { Seg ('   $' + ('{0:N2}' -f $script:IssueCost) + ' billed') '' }
                   else { Seg '   $-- (pending)' $C.gray }
        # Epic context: for a child, how many of its epic's children are done; for a
        # finalize, that it's the epic's review-and-land step.
        $epicTag = ''
        if ($script:CurItem -and $script:CurItem.Mode -eq 'subtask') {
            $epic  = $script:CurItem.EpicIssue
            $ctot  = if ($script:EpicAgg.Contains("$epic")) { $script:EpicAgg["$epic"].child_total } else { 0 }
            $cdone = 0
            foreach ($k in $script:ItemByIssue.Keys) {
                $i2 = $script:ItemByIssue["$k"]
                if ($i2.Mode -eq 'subtask' -and $i2.EpicIssue -eq $epic -and $script:IssueState["$k"] -eq 'done') { $cdone++ }
            }
            $epicTag = "epic #$epic child $($cdone + 1)/$ctot"
        }
        elseif ($script:CurItem -and $script:CurItem.Mode -eq 'finalize') {
            $epicTag = "epic #$($script:CurItem.EpicIssue) finalize"
        }
        $epicSeg = if ($epicTag) { Seg ("[$epicTag]  ") $C.cyan } else { Seg '' '' }
        $line3 = @(
            Seg " $glyph #$($script:CurrentIssue)  " $gcol
            $epicSeg
            Seg $inFor $C.gray
            Seg ("   attempt {0}/{1}" -f $script:Attempt, $script:MaxAtt) $C.gray
            $costSeg
            Seg ('   ctx ~{0:N0}K' -f $ctxK) $ctxCol
        )
    } else {
        $line3 = @(Seg ' (preparing next issue…)' $C.gray)
    }

    # Line 4 — phase track
    $curIdx = if ($script:Phase) { [Array]::IndexOf($PHASES, $script:Phase) } else { -1 }
    $trackSegs = @(Seg '   phase  ' $C.gray)
    for ($i = 0; $i -lt $PHASES.Count; $i++) {
        if ($i -gt 0) { $trackSegs += Seg ' ─ ' $C.gray }
        if ($i -lt $curIdx)     { $trackSegs += Seg $PHASES[$i] $C.green }
        elseif ($i -eq $curIdx) { $trackSegs += Seg ('▶' + $PHASES[$i]) $C.boldcyan }
        else                    { $trackSegs += Seg $PHASES[$i] $C.gray }
    }
    $line4 = $trackSegs

    # Line 5 — now
    $nowText = if ($script:Phase) {
        $p = $script:Phase
        if ($script:PhaseDetail) { $p += " ($($script:PhaseDetail))" }
        if ($script:NowDetail)   { $p += "   $($script:NowDetail)" }
        $p
    } else { '(waiting for first phase marker…)' }
    $line5 = @(Seg '   now    ' $C.gray; Seg $nowText '')

    return @(
        (Format-Line $rule  $Width)
        (Format-Line $line1 $Width)
        (Format-Line $line2 $Width)
        (Format-Line $rule  $Width)
        (Format-Line $line3 $Width)
        (Format-Line $line4 $Width)
        (Format-Line $line5 $Width)
        (Format-Line $rule  $Width)
    )
}

function Draw-Panel {
    if (-not $script:PanelMode) { return }
    $h = [Console]::WindowHeight
    $w = [Console]::WindowWidth
    $panelTop = $h - $PanelRows + 1
    $lines = Get-PanelLines -Width ($w - 1)
    $out = "$ESC`7"                      # save cursor (DECSC)
    for ($i = 0; $i -lt $PanelRows; $i++) {
        $row = $panelTop + $i
        $text = if ($i -lt $lines.Count) { $lines[$i] } else { '' }
        $out += "$ESC[$row;1H$ESC[2K$text"
    }
    $out += "$ESC`8"                     # restore cursor (DECRC)
    [Console]::Write($out)
}

function Initialize-Panel {
    if (-not $script:PanelMode) { return }
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $h = [Console]::WindowHeight
    [Console]::Write("$ESC[2J$ESC[H")                  # clear screen, home
    Set-ScrollRegion 1 ($h - $PanelRows)               # logs scroll above panel
    [Console]::Write("$ESC[1;1H")                      # cursor into scroll region
    Draw-Panel
}

function Close-Panel {
    if (-not $script:PanelMode) { return }
    Draw-Panel                                         # final state
    Reset-ScrollRegion
    $h = [Console]::WindowHeight
    [Console]::Write("$ESC[$h;1H`n")                   # park cursor below panel
}

# Top-region log write (works in both modes).
function Write-Log {
    param([string]$Text, [string]$Color = 'Gray')
    Write-Host $Text -ForegroundColor $Color
    Draw-Panel
}

# --------------------------------------------------------------------------
# One headless dev-cycle run with streaming + phase parsing.
# --------------------------------------------------------------------------
function Invoke-DevCycleRun {
    param([string]$Prompt, [string]$LogPath)

    $script:FinalText = ''
    $script:CliExit = 0
    $script:LastCost = 0.0
    $script:LimitHit    = $false
    $script:LimitReason = ''
    $script:LimitSeen   = $false          # a raw limit line was streamed
    $script:LimitMsg    = ''              # that line's text (for the pause banner)
    $script:ApiErr      = $null           # api_error_status from the result object
    Reset-Analytics
    $PSNativeCommandUseErrorActionPreference = $false

    $writer = [System.IO.StreamWriter]::new($LogPath, $false)
    $writer.AutoFlush = $true
    try {
        claude -p $Prompt --model $script:ModelArg --output-format stream-json --verbose --dangerously-skip-permissions |
            ForEach-Object {
                $line = [string]$_
                $writer.WriteLine($line)

                # Raw-line usage/session-limit signal (the CLI prints a plain "hit your
                # session limit · resets ..." line and exits without a clean result object).
                if (-not $script:LimitSeen -and (Test-LimitLine $line)) {
                    $script:LimitSeen = $true
                    $t = $line.Trim()
                    $script:LimitMsg = if ($t.StartsWith('{') -or $t.StartsWith('[')) { 'session/usage limit reached' } else { $t }
                    if ($script:LimitMsg.Length -gt 140) { $script:LimitMsg = $script:LimitMsg.Substring(0, 140) }
                }

                $obj = $null
                try { $obj = $line | ConvertFrom-Json -ErrorAction Stop } catch { }
                if ($null -eq $obj) {
                    if ($line.Trim()) { Write-Log "    $line" 'DarkGray' }
                    return
                }

                switch ($obj.type) {
                    'system' {
                        if ($obj.subtype -eq 'init') {
                            if ($obj.model) { $script:RunModel = [string]$obj.model }
                            Write-Log "    * session started ($($script:RunModel))" 'DarkGray'
                        }
                    }
                    'assistant' {
                        Update-Ctx -Usage $obj.message.usage
                        Add-TurnTokens -Usage $obj.message.usage -IsMain (-not $obj.parent_tool_use_id)
                        # Track the actual model — but only from main-agent turns, so a
                        # haiku/sonnet review subagent doesn't masquerade as the session model.
                        if ($obj.message.model -and -not $obj.parent_tool_use_id) {
                            $script:RunModel = [string]$obj.message.model
                        }
                        foreach ($block in $obj.message.content) {
                            if ($block.type -eq 'text' -and $block.text.Trim()) {
                                # Intercept phase + metric markers before logging.
                                foreach ($raw in ($block.text -split "`r?`n")) {
                                    # Models copy the markers with markdown wrapping
                                    # (`...`, **...**) from the skill doc — strip it
                                    # before matching or no marker is ever recognized.
                                    $raw = $raw.Trim() -replace '^[`*_]+|[`*_]+$', ''
                                    if (Read-MetricMarker $raw) {
                                        Write-Log "    ◆ $($raw.Trim())" 'DarkMagenta'
                                        continue
                                    }
                                    $m = [regex]::Match($raw, '^\s*DEVCYCLE_PHASE:\s*(.+?)\s*$')
                                    if ($m.Success) {
                                        $parts = $m.Groups[1].Value -split '\|', 2
                                        $name  = $parts[0].Trim()
                                        if ($PHASES -contains $name) {
                                            $script:Phase = $name
                                            $detail = if ($parts.Count -gt 1) { $parts[1].Trim() } else { '' }
                                            $script:PhaseDetail = $detail
                                            Open-Phase $name
                                            if ($name -eq 'review') {
                                                $cm = [regex]::Match($detail, 'cycle\s*(\d+)\s*/\s*(\d+)')
                                                if ($cm.Success) {
                                                    Start-ReviewCycle ([int]$cm.Groups[1].Value) ([int]$cm.Groups[2].Value)
                                                }
                                            }
                                            Write-Log "    ▸ phase: $name" 'Magenta'
                                        }
                                    }
                                }
                                $t = ($block.text.Trim() -replace '\s+', ' ')
                                if ($t -notmatch '^[`*_]*DEVCYCLE_PHASE:') {
                                    if ($t.Length -gt 160) { $t = $t.Substring(0, 160) + '...' }
                                    Write-Log "    $t" 'Gray'
                                }
                            }
                            elseif ($block.type -eq 'tool_use') {
                                if ($script:CurPhase) { $script:CurPhase.tools++ }
                                if ($script:CurCycle -and $script:CurPhase -and $script:CurPhase.phase -eq 'review') { $script:CurCycle.tools++ }
                                $d = ''
                                if ($block.input.command)       { $d = ": $($block.input.command)" }
                                elseif ($block.input.file_path)  { $d = ": $($block.input.file_path)" }
                                elseif ($block.input.pattern)    { $d = ": $($block.input.pattern)" }
                                $script:NowDetail = "$($block.name)$d".Trim()
                                if ($script:NowDetail.Length -gt 80) { $script:NowDetail = $script:NowDetail.Substring(0, 80) + '...' }
                                $dd = $d
                                if ($dd.Length -gt 120) { $dd = $dd.Substring(0, 120) + '...' }
                                Write-Log "    -> $($block.name)$dd" 'Cyan'
                            }
                        }
                    }
                    'result' {
                        if ($null -ne $obj.result) { $script:FinalText = [string]$obj.result }
                        if ($null -ne $obj.total_cost_usd) { $script:LastCost = [double]$obj.total_cost_usd }
                        if ($null -ne $obj.api_error_status) { $script:ApiErr = $obj.api_error_status }
                    }
                }
            }
        $script:CliExit = $LASTEXITCODE
    }
    finally {
        $writer.Dispose()
    }

    # Did this run stop on a usage/session/API limit? (raw limit line, or a surfaced
    # api_error_status / limit wording in the result text.)
    $script:LimitHit = $script:LimitSeen -or (Test-UsageLimit -ResultText $script:FinalText -ApiErrorStatus $script:ApiErr)
    $script:LimitReason = if ($script:LimitMsg) { $script:LimitMsg } elseif ($script:LimitHit) { 'usage/API limit' } else { '' }

    return $script:FinalText
}

# --------------------------------------------------------------------------
# Epic expansion. An input issue may be an epic — it has GitHub sub-issues, or a
# "Subtasks"/"Tasks" section in its body listing child issues. When it is, we
# splice its children in ahead of it and turn the epic's own slot into a finalize
# step:
#   [150, 151(epic->153,154), 152]  ->  [150, sub:153, sub:154, finalize:151, 152]
# Children build on a shared epic branch (no develop PR, issue stays open); the
# finalize step runs the full multi-lens review once and lands the whole stack.
# If an issue looks epic-ish but its children can't be parsed, we FAIL LOUD rather
# than silently run it as a normal task (which would re-introduce per-task review cost).
# --------------------------------------------------------------------------
function Get-Slug {
    param([string]$Title)
    $s = ($Title.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
    if (-not $s) { return 'epic' }
    ($s -split '-' | Select-Object -First 4) -join '-'
}

function Resolve-Epic {
    # @{ IsEpic=[bool]; Children=@(int...); Title=[string] }. Throws to fail loud.
    param([int]$Issue)

    $title = gh issue view $Issue --json title -q .title 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "gh issue view $Issue failed - cannot resolve issue #$Issue (is gh authenticated and the issue real?)."
    }

    # 1) Native GitHub sub-issues (primary signal).
    $childNums = @()
    $subJson = gh api "repos/{owner}/{repo}/issues/$Issue/sub_issues" 2>$null
    if ($LASTEXITCODE -eq 0 -and $subJson) {
        try { $childNums = @(($subJson | ConvertFrom-Json) | ForEach-Object { [int]$_.number }) } catch { $childNums = @() }
    }
    if ($childNums.Count -gt 0) {
        return @{ IsEpic = $true; Children = $childNums; Title = $title }
    }

    # 2) Fallback: a "Subtasks"/"Sub-tasks"/"Child issues"/"Tasks" section listing #NN.
    $body = gh issue view $Issue --json body -q .body 2>$null
    if ($LASTEXITCODE -eq 0 -and $body) {
        $hdr = [regex]::Match($body, '(?im)^\s{0,3}#{1,6}\s*(sub.?tasks|child issues|tasks)\b')
        if ($hdr.Success) {
            $tail = $body.Substring($hdr.Index)
            $nums = @([regex]::Matches($tail, '#(\d+)') | ForEach-Object { [int]$_.Groups[1].Value } |
                     Where-Object { $_ -ne $Issue } | Select-Object -Unique)
            if ($nums.Count -eq 0) {
                throw "issue #$Issue has a Subtasks section but no parseable '#NN' child references - refusing to treat it as a normal task. Fix the epic body or add GitHub sub-issues."
            }
            return @{ IsEpic = $true; Children = $nums; Title = $title }
        }
    }

    return @{ IsEpic = $false; Children = @(); Title = $title }
}

function Expand-Queue {
    param([int[]]$InputIssues)
    $work = @()
    foreach ($n in $InputIssues) {
        $epic = Resolve-Epic -Issue $n
        if (-not $epic.IsEpic) {
            $work += [ordered]@{ Issue = $n; Mode = 'default'; EpicIssue = 0; EpicBranch = ''; Children = @() }
            continue
        }
        $branch = "epic/issue-$n-$(Get-Slug $epic.Title)"
        foreach ($c in $epic.Children) {
            $work += [ordered]@{ Issue = $c; Mode = 'subtask'; EpicIssue = $n; EpicBranch = $branch; Children = @() }
        }
        $work += [ordered]@{ Issue = $n; Mode = 'finalize'; EpicIssue = $n; EpicBranch = $branch; Children = $epic.Children }
    }
    return ,$work
}

# --------------------------------------------------------------------------
# Resume detection. Before dispatching claude for an item, we check deterministically
# whether its work is already complete from a prior run — and if so, skip it without a
# (paid) claude invocation. This is what makes a re-run of the same list a true resume:
#   - subtask  -> a "merge(#n)" commit already exists on the epic branch (local, else origin)
#   - finalize -> the epic issue is already CLOSED (the single PR landed)
#   - default  -> the issue is already CLOSED
# All checks are local-first git / a single gh call; safe to call repeatedly.
# --------------------------------------------------------------------------
function Test-ChildMerged {
    param([string]$Branch, [int]$Issue)
    $ref = $null
    $local = git rev-parse --verify --quiet "refs/heads/$Branch" 2>$null
    if (-not [string]::IsNullOrWhiteSpace([string]$local)) {
        $ref = $Branch
    } else {
        git fetch origin $Branch 2>$null | Out-Null
        $remote = git rev-parse --verify --quiet "refs/remotes/origin/$Branch" 2>$null
        if (-not [string]::IsNullOrWhiteSpace([string]$remote)) { $ref = "origin/$Branch" }
    }
    if (-not $ref) { return $false }
    $hit = git log $ref --grep "merge(#$Issue)" --oneline -1 2>$null
    return -not [string]::IsNullOrWhiteSpace([string]$hit)
}

function Test-IssueClosed {
    param([int]$Issue)
    $st = gh issue view $Issue --json state -q .state 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }   # can't tell -> treat as not-done; let the run proceed
    return ($st -eq 'CLOSED')
}

function Test-ItemDone {
    # True when the item's work is already complete from a prior run.
    param($Item)
    switch ($Item.Mode) {
        'subtask'  { return (Test-ChildMerged -Branch $Item.EpicBranch -Issue $Item.Issue) }
        'finalize' { return (Test-IssueClosed -Issue $Item.EpicIssue) }
        default    { return (Test-IssueClosed -Issue $Item.Issue) }
    }
}

# --------------------------------------------------------------------------
# KB graduation review. Runs once, after the WHOLE queue lands (or standalone via
# -GraduateOnly). Reviews the review-KB's *active* lessons — recurred in >=2 issues,
# currently hot-path only — and decides which to graduate to the cold path
# (dev-docs/review-rules.md, @-imported by CLAUDE.md into EVERY agent's context).
#
# Flow: one headless claude call ranks the candidates with an honest graduate/hold
# recommendation (it is explicitly told that recommending AGAINST is often right —
# cold-path context is expensive and shared) -> an interactive picker, ordered by
# the agent's priority, recommended items pre-selected -> the picks are applied via
# scripts/kb/graduate.mjs, which rewrites the store and regenerates review-rules.md.
# --------------------------------------------------------------------------
$lessonsJsonl = Join-Path $analyticsDir 'review-lessons.jsonl'
$graduateMjs  = Join-Path $PSScriptRoot 'scripts/kb/graduate.mjs'

function Get-KbLessons {
    if (-not (Test-Path $lessonsJsonl)) { return ,@() }
    $out = @()
    foreach ($line in [System.IO.File]::ReadAllLines($lessonsJsonl)) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $out += ,($line | ConvertFrom-Json) } catch { }
    }
    return ,$out
}

# Ask the model for an honest ranking of the active lessons. Returns an array of
# advice records ({id, verdict, priority, confidence, why_include, why_not}) or @()
# when the call fails / can't be parsed — the picker then degrades gracefully.
function Get-GraduationAdvice {
    param([object[]]$Active, [object[]]$Graduated)

    $cand = @($Active | ForEach-Object {
        [ordered]@{
            id = $_.id; title = $_.title; category = $_.category; severity = $_.severity
            rule = $_.rule; rationale = $_.rationale; occurrences = $_.occurrences
            source_issues = @($_.source_issues); file_globs = @($_.file_globs); last_seen = $_.last_seen
        }
    })
    $candJson = ConvertTo-Json $cand -Depth 6
    $gradList = if ($Graduated.Count) {
        ($Graduated | ForEach-Object { "- [$($_.category)] $($_.title): $($_.rule)" }) -join "`n"
    } else { '(none yet)' }

    $prompt = @"
You are the honest curator of a code-review knowledge base for this repository.

Below are its ACTIVE lessons. Each already recurred in >=2 distinct issues and is
already injected into the implementer agent for matching files (the "hot path").
GRADUATING a lesson moves it to the cold path: it is compiled into
dev-docs/review-rules.md, which CLAUDE.md @-imports — so it loads into EVERY agent's
context on EVERY run, forever. That context space is expensive and shared. Only rules
that are codebase-wide, keep recurring, and are high-leverage deserve it; area-specific
lessons are usually better left on the hot path, whose file-glob targeting already
serves them. Recommending AGAINST graduation is often the right call — be honest, not
generous. A reasonable outcome is that only a minority of candidates get "graduate".

Judge each candidate on:
1. Breadth — does the rule apply codebase-wide (any file, any module), or only to a
   narrow area the hot path's file-glob targeting already covers?
2. Recurrence pressure — many distinct source_issues, and recent last_seen, i.e. is
   the hot path failing to prevent it?
3. Leverage — how bad is a violation, and would an always-on one-liner plausibly have
   prevented the cited findings?
4. Marginal value vs the already-graduated rules below — a near-duplicate adds context
   cost without new signal (say so in why_not and hold it).

Already graduated (the cold path today):
$gradList

Candidates (JSON):
$candJson

Do not use any tools. Respond IMMEDIATELY with ONLY a JSON array — no markdown fences,
no commentary. One element per candidate, ALL candidates included, ordered
strongest-graduate-case first:
[
  {
    "id": "<candidate id>",
    "verdict": "graduate" | "hold",
    "priority": 1,
    "confidence": "high" | "medium" | "low",
    "why_include": "<1-2 sentences: the case FOR making this always-on>",
    "why_not": "<1-2 sentences: the honest case AGAINST / what it costs>"
  }
]
"priority" is a unique 1..N rank (1 = strongest case for graduation).
"@

    # Pipe the prompt via stdin — it can be large, and Windows caps argv length.
    $raw = ''
    try { $raw = ($prompt | claude -p --model $script:ModelArg --output-format json 2>$null | Out-String) } catch { }
    if ([string]::IsNullOrWhiteSpace($raw)) {
        Write-Host '    ! recommendation call returned nothing - showing candidates without agent advice.' -ForegroundColor Yellow
        return ,@()
    }
    $text = $raw
    try { $text = [string](($raw | ConvertFrom-Json).result) } catch { }
    # The reply should be a bare JSON array; tolerate fences or prose around it.
    $m = [regex]::Match($text, '(?s)```(?:json)?\s*(\[.*?\])\s*```')
    if ($m.Success) { $text = $m.Groups[1].Value }
    else {
        $s = $text.IndexOf('['); $e = $text.LastIndexOf(']')
        if ($s -ge 0 -and $e -gt $s) { $text = $text.Substring($s, $e - $s + 1) }
    }
    $advice = @()
    try { $advice = @($text | ConvertFrom-Json) } catch {
        Write-Host '    ! could not parse the agent recommendation - showing candidates without advice.' -ForegroundColor Yellow
        return ,@()
    }
    $ids = @($Active | ForEach-Object { $_.id })
    return ,@($advice | Where-Object { $_.id -and ($ids -contains $_.id) })
}

# Word-wrap $Text to $Width, capped at $MaxLines (last line ellipsized if truncated).
function Split-Wrapped {
    param([string]$Text, [int]$Width, [int]$MaxLines = 2)
    if ([string]::IsNullOrWhiteSpace($Text)) { return ,@() }
    if ($Width -lt 20) { $Width = 20 }
    $words = (($Text -replace '\s+', ' ').Trim()) -split ' '
    $lines = @(); $line = ''; $truncated = $false
    foreach ($word in $words) {
        if ($line -and ($line.Length + 1 + $word.Length) -gt $Width) {
            if ($lines.Count + 1 -ge $MaxLines) { $lines += $line; $truncated = $true; break }
            $lines += $line; $line = $word
        } else {
            $line = if ($line) { "$line $word" } else { $word }
        }
    }
    if (-not $truncated -and $line) { $lines += $line }
    elseif ($truncated) { $lines[-1] = $lines[-1].Substring(0, [Math]::Min($lines[-1].Length, $Width - 1)) + '…' }
    return ,$lines
}

# Render one picker item as clipped, colored lines (header, title, +case, -case).
function Format-GradItemLines {
    param($Item, [int]$Index, [bool]$IsCursor, [int]$Width)
    $l = $Item.Lesson; $a = $Item.Advice
    $mark = if ($Item.Selected) { '[x]' } else { '[ ]' }
    $lineA = @(
        Seg (' ' + ($IsCursor ? '▶ ' : '  ')) $C.boldcyan
        Seg "$mark " ($Item.Selected ? $C.boldgreen : $C.gray)
        Seg ("{0,2}. " -f ($Index + 1)) $C.gray
        Seg $l.id ($IsCursor ? $C.boldcyan : $C.bold)
        Seg ("   [{0}/{1}] seen {2}x (#{3})" -f $l.category, $l.severity, $l.occurrences, (@($l.source_issues) -join ' #')) $C.gray
    )
    if ($a) {
        $lineA += Seg ("   agent: {0}" -f ([string]$a.verdict).ToUpper()) (($a.verdict -eq 'graduate') ? $C.boldgreen : $C.yellow)
        if ($a.confidence) { $lineA += Seg (" ({0})" -f $a.confidence) $C.gray }
    } else {
        $lineA += Seg '   agent: no advice' $C.gray
    }
    $lines = @(,(Format-Line $lineA $Width))
    $lines += Format-Line @(Seg ("          {0}" -f $l.title) $C.dim) $Width
    if ($a) {
        $wrapped = Split-Wrapped ([string]$a.why_include) ($Width - 12)
        for ($k = 0; $k -lt $wrapped.Count; $k++) {
            $pre = if ($k -eq 0) { '          + ' } else { '            ' }
            $lines += Format-Line @(Seg $pre $C.green; Seg $wrapped[$k] '') $Width
        }
        $wrapped = Split-Wrapped ([string]$a.why_not) ($Width - 12)
        for ($k = 0; $k -lt $wrapped.Count; $k++) {
            $pre = if ($k -eq 0) { '          - ' } else { '            ' }
            $lines += Format-Line @(Seg $pre $C.red; Seg $wrapped[$k] $C.dim) $Width
        }
    }
    # Emit the lines enumerated (no leading comma): the fancy picker collects them
    # with @(...), and a comma-wrapped return would double-nest into one object[]
    # element that -join renders as "System.Object[]".
    return $lines
}

# Interactive checkbox picker on the alternate screen buffer (scrollback preserved).
# Returns the selected lesson ids, an empty array for "confirmed nothing", or $null
# if the user quit. Falls back to a numbered Read-Host prompt on non-VT terminals.
function Show-GraduationPicker {
    param([object[]]$Items)

    $fancy = (-not [Console]::IsInputRedirected) -and (-not $NoPanel) -and ($Panel -or [bool]$env:WT_SESSION)
    if (-not $fancy) { return (Show-GraduationPickerPlain -Items $Items) }

    $cur = 0; $top = 0
    [Console]::Write("$ESC[?1049h$ESC[?25l")   # alt screen, hide cursor
    try {
        while ($true) {
            $w = [Math]::Max(60, [Console]::WindowWidth) - 1
            $h = [Console]::WindowHeight
            $blocks = @()
            for ($i = 0; $i -lt $Items.Count; $i++) {
                $blocks += ,(@(Format-GradItemLines $Items[$i] $i ($i -eq $cur) $w) + '')
            }
            $selCount = @($Items | Where-Object Selected).Count
            $head = @(
                (Format-Line @(
                    Seg ' KB graduation review ' $C.boldcyan
                    Seg ("— {0} active lesson(s), {1} selected. Graduated rules load into EVERY agent's context." -f $Items.Count, $selCount) $C.gray
                ) $w)
                (Format-Line @(Seg ('─' * $w) $C.gray) $w)
            )
            $foot = @(
                (Format-Line @(Seg ('─' * $w) $C.gray) $w)
                (Format-Line @(Seg ' ↑/↓ move   space toggle   r reset to recommended   a all/none   enter graduate selected   q skip' $C.gray) $w)
            )
            $view = [Math]::Max(4, $h - $head.Count - $foot.Count - 1)
            # Scroll so the cursor's whole block is visible.
            if ($cur -lt $top) { $top = $cur }
            while ($top -lt $cur) {
                $used = 0
                for ($i = $top; $i -le $cur; $i++) { $used += $blocks[$i].Count }
                if ($used -le $view) { break }
                $top++
            }
            $body = @()
            for ($i = $top; $i -lt $Items.Count; $i++) {
                if ($i -gt $top -and ($body.Count + $blocks[$i].Count) -gt $view) { break }
                $body += $blocks[$i]
            }
            if ($body.Count -gt $view) { $body = $body[0..($view - 1)] }
            [Console]::Write("$ESC[2J$ESC[H" + (($head + $body + $foot) -join "`r`n"))

            $k = [Console]::ReadKey($true)
            switch ($k.Key) {
                { $_ -in 'UpArrow', 'K' }   { if ($cur -gt 0) { $cur-- } }
                { $_ -in 'DownArrow', 'J' } { if ($cur -lt $Items.Count - 1) { $cur++ } }
                'Spacebar' { $Items[$cur].Selected = -not $Items[$cur].Selected }
                'R'        { foreach ($it in $Items) { $it.Selected = [bool]($it.Advice -and $it.Advice.verdict -eq 'graduate') } }
                'A'        {
                    $turnOn = @($Items | Where-Object Selected).Count -lt $Items.Count
                    foreach ($it in $Items) { $it.Selected = $turnOn }
                }
                'Enter'    { return ,@($Items | Where-Object Selected | ForEach-Object { $_.Lesson.id }) }
                { $_ -in 'Escape', 'Q' }    { return $null }
            }
        }
    }
    finally {
        [Console]::Write("$ESC[?1049l$ESC[?25h")   # back to main buffer, show cursor
    }
}

function Show-GraduationPickerPlain {
    param([object[]]$Items)
    $w = (& { try { [Math]::Max(60, [Console]::WindowWidth) } catch { 100 } }) - 1
    Write-Host ''
    for ($i = 0; $i -lt $Items.Count; $i++) {
        foreach ($line in (Format-GradItemLines $Items[$i] $i $false $w)) { [Console]::WriteLine($line) }
        [Console]::WriteLine('')
    }
    if ([Console]::IsInputRedirected) {
        Write-Host '    (no interactive console — graduate manually: node scripts/kb/graduate.mjs --id <id>)' -ForegroundColor Yellow
        return $null
    }
    $rec = @($Items | Where-Object { $_.Advice -and $_.Advice.verdict -eq 'graduate' } | ForEach-Object { $_.Lesson.id })
    $ans = [string](Read-Host ("Graduate which? Enter = agent-recommended ({0}), numbers like '1,3', or 'none'" -f $rec.Count))
    $ans = $ans.Trim().ToLower()
    if ($ans -in @('none', 'n', 'q')) { return $null }
    if ($ans -eq '') { return ,$rec }
    $ids = @()
    foreach ($tok in ($ans -split '[,\s]+')) {
        if ($tok -match '^\d+$') {
            $idx = [int]$tok - 1
            if ($idx -ge 0 -and $idx -lt $Items.Count) { $ids += $Items[$idx].Lesson.id }
        }
    }
    return ,$ids
}

function Invoke-GraduationReview {
    $script:PanelMode = $false   # plain console from here on (panel is already closed)
    Write-Host ''
    Write-Host '=== KB graduation review ===' -ForegroundColor Cyan

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host '    ! node not found on PATH - skipping graduation review.' -ForegroundColor Yellow
        return
    }
    $lessons = Get-KbLessons
    $active = @($lessons | Where-Object { $_.status -eq 'active' })
    if ($active.Count -eq 0) {
        Write-Host '    no active lessons awaiting graduation - nothing to review.' -ForegroundColor DarkGray
        return
    }
    $graduated = @($lessons | Where-Object { $_.status -eq 'graduated' })

    Write-Host ("    {0} active lesson(s); asking {1} for an honest ranking (one short headless call)..." -f $active.Count, $script:ModelArg) -ForegroundColor Gray
    $advice = Get-GraduationAdvice -Active $active -Graduated $graduated
    $adviceById = @{}
    foreach ($a in $advice) { if (-not $adviceById.ContainsKey([string]$a.id)) { $adviceById[[string]$a.id] = $a } }

    $sevRank = @{ critical = 0; high = 1; medium = 2; low = 3 }
    $items = @($active | ForEach-Object {
        $a = $adviceById[[string]$_.id]
        [pscustomobject]@{
            Lesson   = $_
            Advice   = $a
            Selected = [bool]($a -and $a.verdict -eq 'graduate')
        }
    } | Sort-Object -Property `
        @{ Expression = { if ($_.Advice -and $_.Advice.priority) { [int]$_.Advice.priority } else { 999 } } },
        @{ Expression = { $r = $sevRank[[string]$_.Lesson.severity]; if ($null -ne $r) { $r } else { 9 } } },
        @{ Expression = { -[int]$_.Lesson.occurrences } })

    $picked = Show-GraduationPicker -Items $items
    if ($null -eq $picked -or @($picked).Count -eq 0) {
        Write-Host '    nothing graduated - KB unchanged.' -ForegroundColor DarkGray
        return
    }

    Write-Host ("    graduating: {0}" -f (@($picked) -join ', ')) -ForegroundColor Cyan
    $nodeArgs = @($graduateMjs)
    foreach ($id in @($picked)) { $nodeArgs += @('--id', $id) }
    node @nodeArgs 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray }
    if ($LASTEXITCODE -ne 0) {
        Write-Host '    ! graduate.mjs failed - the KB may be unchanged.' -ForegroundColor Red
        return
    }
    Write-Host '    done - dev-docs/review-rules.md regenerated. Commit review-lessons.jsonl + review-rules.md when ready.' -ForegroundColor Green
}

# --------------------------------------------------------------------------
# Main loop
# --------------------------------------------------------------------------
# Test hook: dot-source with $env:RIP_NOEXEC set to load the functions (and create
# the output dirs) without launching claude — used by the analytics smoke test.
if ($env:RIP_NOEXEC) { return }

# Standalone graduation review — no queue, no panel.
if ($GraduateOnly) {
    Invoke-GraduationReview
    exit 0
}

try {
    Initialize-Panel

    $panelLabel = if ($script:PanelMode) { 'panel ON' } else { 'panel OFF (plain streaming)' }
    $resumeLabel = if ($WaitForReset) { "resume-on-limit ON (max $MaxWaits)" } else { 'resume-on-limit OFF' }
    Write-Log "=== tr-harness: model=$Model | review-cycles=$ReviewCycles | $resumeLabel | $panelLabel | issues: $($Issues -join ', ') ===" 'Cyan'

    # Expand epics into [children..., finalize] runs; plain issues pass through unchanged.
    Write-Log '    resolving epics (GitHub sub-issues / "Subtasks" section)...' 'DarkGray'
    try {
        $script:WorkList = Expand-Queue -InputIssues $Issues
    } catch {
        Write-Log "=== EPIC RESOLUTION FAILED - $($_.Exception.Message) Stopping. ===" 'Red'
        exit 1
    }
    foreach ($item in $script:WorkList) { $script:IssueState["$($item.Issue)"] = 'pending' }
    # Lookups for the panel + per-epic roll-up (seeded from finalize items, which
    # carry the full child list).
    $script:ItemByIssue = @{}
    foreach ($item in $script:WorkList) { $script:ItemByIssue["$($item.Issue)"] = $item }
    foreach ($item in $script:WorkList) {
        if ($item.Mode -eq 'finalize') {
            $script:EpicAgg["$($item.EpicIssue)"] = [ordered]@{
                epic = $item.EpicIssue; branch = $item.EpicBranch; children = @($item.Children)
                start = $null; billed_usd = 0.0; child_ok = 0; child_total = @($item.Children).Count
                resumed = $false   # set when any child/finalize was skipped as already-done -> billed/wall are partial
            }
        }
    }
    $plan = ($script:WorkList | ForEach-Object {
        switch ($_.Mode) {
            'subtask'  { "$($_.Issue)->$($_.EpicBranch)" }
            'finalize' { "finalize#$($_.Issue)[$($_.Children -join ',')]" }
            default    { "$($_.Issue)" }
        }
    }) -join '   '
    Write-Log "    plan: $plan" 'Cyan'

    foreach ($item in $script:WorkList) {
        $n    = $item.Issue
        $mode = $item.Mode
        $what = switch ($mode) {
            'subtask'  { "subtask #$n (epic #$($item.EpicIssue))" }
            'finalize' { "epic #$n finalize (children $($item.Children -join ', '))" }
            default    { "issue #$n" }
        }

        # Failure quarantine: an earlier failure in this epic blocked its remaining
        # steps — skip them without a run (states were marked when the epic tripped).
        if ($item.Mode -ne 'default' -and $script:IssueState["$n"] -eq 'blocked') {
            Write-Log "=== $what BLOCKED - epic #$($item.EpicIssue) quarantined after an earlier failure. ===" 'Yellow'
            Draw-Panel
            continue
        }

        # Resume-skip: if this item's work is already complete from a prior invocation,
        # mark it done and move on WITHOUT a (paid) claude run. -Fresh forces a re-run.
        if (-not $Fresh -and (Test-ItemDone -Item $item)) {
            $script:IssueState["$n"] = 'done'
            $ea = if ($mode -ne 'default') { $script:EpicAgg["$($item.EpicIssue)"] } else { $null }
            if ($ea) {
                $ea.resumed = $true                       # this epic's billed/wall now cover only the re-run
                if ($mode -eq 'subtask') { $ea.child_ok++ }
            }
            $skipMsg = switch ($mode) {
                'subtask'  { "already stacked on $($item.EpicBranch)" }
                'finalize' { 'epic already finalized (issue closed)' }
                default    { 'issue already closed' }
            }
            Write-Log "=== $what SKIP - $skipMsg (resume). ===" 'DarkGray'
            Draw-Panel
            continue
        }

        $succeeded  = $false
        $failReason = ''
        $script:CurItem      = $item
        $script:CurrentIssue = $n
        $script:IssueState["$n"] = 'running'
        $script:IssueCost = 0.0
        $script:CurCtx    = 0.0

        # Per-epic roll-up: stamp the epic's wall-clock start at its first run.
        $agg = if ($mode -ne 'default') { $script:EpicAgg["$($item.EpicIssue)"] } else { $null }
        if ($agg -and -not $agg.start) { $agg.start = Get-Date }

        for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
            $isResume = $attempt -gt 1
            $script:Attempt = $attempt
            $script:IssueStart = Get-Date
            $script:Phase = $null
            $script:PhaseDetail = ''
            $script:NowDetail = ''

            $ts  = Get-Date -Format 'yyyyMMdd-HHmmss'
            $log = Join-Path $logDir "issue-$n-$ts.log"
            $label = if ($isResume) { "RESUME (attempt $attempt of $maxAttempts)" } else { 'starting' }
            Write-Log "=== $what - $label dev-cycle (log: $log) ===" 'Cyan'

            # Dispatch loop. Normally runs once. When the account hits its usage/session
            # limit mid-run and -WaitForReset is on (the default), the limit-hit run is NOT
            # counted as an attempt: sleep until the parsed reset time and re-dispatch this
            # same attempt (fresh log). -NoWaitForReset (or exceeding -MaxWaits) lets the
            # limit fall through to the normal incomplete/resume path below.
            $attemptBilled = 0.0
            $limitWaits    = 0
            $resultText    = ''
            while ($true) {
                # A limit-retry resumes existing branch/PR work, so it carries the resume note
                # even on attempt 1 (where $isResume is still false).
                $effectiveResume = $isResume -or ($limitWaits -gt 0)

                # Mode -> skill flags. The script owns the epic-branch name; the skill
                # stacks children on it (subtask) and lands the whole epic in one PR (finalize).
                $modeFlags = switch ($mode) {
                    'subtask'  { "--epic-branch $($item.EpicBranch) --epic-issue $($item.EpicIssue) --fast-lens on" }
                    'finalize' { "--finalize-epic $($item.Children -join ',') --epic-branch $($item.EpicBranch)" }
                    default    { '' }
                }
                $invoke = ("/dev-cycle-phases $n $modeFlags").TrimEnd()

                $resumeNote = if ($effectiveResume) {
                    switch ($mode) {
                        'subtask' {
@"

NOTE: a previous run of this child was interrupted. Its branch may already be
merged into $($item.EpicBranch). Resume: if the epic branch already has a
"merge(#$n)" commit, this child is done. Otherwise continue from the first
incomplete step. Do NOT branch off develop or open a develop PR, and do not
re-implement work already on the epic branch.
"@
                        }
                        'finalize' {
@"

NOTE: a previous finalize run was interrupted. The epic branch $($item.EpicBranch)
already holds every child; a PR to develop may already exist. Resume: reuse the
existing PR and continue the review loop / merge from the first incomplete step.
Do not re-create the branch or re-run the children.
"@
                        }
                        default {
@'

NOTE: a previous run was interrupted mid-cycle. The branch and PR for this issue
may already exist. Resume: check out the existing branch, assess what is already
done (commits, PR, build, tests), and continue from the first incomplete step.
Do not recreate the branch/PR or re-implement from scratch.
'@
                        }
                    }
                } else { '' }

                # Mode-specific definition of "done" for the success sentinel.
                $okCond = switch ($mode) {
                    'subtask'  { "the child built, passed build + test + coverage and the SEC fast-lens pass, and was merged into $($item.EpicBranch) - the issue is intentionally left OPEN for epic finalize to close." }
                    'finalize' { "the epic PR was opened, the whole stack passed build+tests, completed the review loop, merged to develop, and the epic plus every child issue was closed." }
                    default    { "the PR was opened, passed build+tests, completed the review loop, merged to develop, and the issue was closed." }
                }

                $prompt = @"
$invoke
$resumeNote
Use at most $ReviewCycles code-review cycle(s) in Phase 6 (this overrides the default cap of 3).
Run fully autonomously: do not pause for confirmation — proceed with best judgment.
When the cycle is truly finished, print the result on the VERY LAST line, nothing after it:
  - exactly "$OK" if $okCond
  - exactly "${FAIL}: <one-line reason>" if anything blocked completion (build/test failure, unresolved blockers after 3 cycles, merge conflict, missing gh/npm, etc.).
Do not print either sentinel until the run is genuinely complete.
"@

                Write-Log '    (streaming live - a full issue takes several minutes)' 'DarkGray'
                $resultText = Invoke-DevCycleRun -Prompt $prompt -LogPath $log
                $script:RunCost   += $script:LastCost   # authoritative cost from this process's result line
                $script:IssueCost += $script:LastCost
                $attemptBilled    += $script:LastCost   # sum across this attempt's limit-retries
                if ($agg) { $agg.billed_usd += $script:LastCost }   # epic roll-up (children + finalize)

                # Usage/session-limit stall: wait out the reset and re-dispatch WITHOUT
                # consuming an attempt. Disabled by -NoWaitForReset; capped by -MaxWaits.
                if ($script:LimitHit -and $WaitForReset -and $limitWaits -lt $MaxWaits) {
                    $limitWaits++
                    $script:RunState = 'paused'
                    Write-Log "=== $what LIMIT ($($script:LimitReason)) - auto-resuming after reset (wait $limitWaits/$MaxWaits). Use -NoWaitForReset to opt out. ===" 'Yellow'
                    Draw-Panel
                    [void](Wait-UntilReset -Reason $script:LimitReason)
                    $script:RunState = 'running'
                    $ts  = Get-Date -Format 'yyyyMMdd-HHmmss'
                    $log = Join-Path $logDir "issue-$n-$ts.log"
                    Write-Log "=== $what RESUME - limit reset; re-dispatching (log: $log) ===" 'Green'
                    continue
                }
                break
            }
            $cliExit = $script:CliExit

            $resultLines = ($resultText -split "`r?`n") | Where-Object { $_.Trim() -ne '' }
            $lastLine = if ($resultLines) { ($resultLines | Select-Object -Last 1).Trim() } else { '' }

            # Persist per-run analytics (every attempt, whatever the outcome).
            $runOutcome = if ($lastLine -like "$FAIL*") { 'failed' }
                          elseif ($cliExit -ne 0 -or $lastLine -ne $OK) { 'incomplete' }
                          else { 'ok' }
            Write-Analytics -Issue $n -Attempt $attempt -Outcome $runOutcome -BilledUsd $attemptBilled -Mode $mode -EpicIssue $item.EpicIssue

            # Hard failure — not retryable. Leave the attempt loop; the quarantine
            # handler below decides whether the queue continues.
            if ($lastLine -like "$FAIL*") {
                $failReason = "$lastLine (not retryable)"
                break
            }

            # Incomplete — crashed or ended mid-cycle without a sentinel.
            if ($cliExit -ne 0 -or $lastLine -ne $OK) {
                $why = if ($cliExit -ne 0) { "claude exited $cliExit" } else { 'no success sentinel (run stopped mid-cycle)' }
                if ($attempt -lt $maxAttempts) {
                    Write-Log "=== $what INCOMPLETE - $why. Resuming... ===" 'Yellow'
                    continue
                }
                $failReason = "$why after $maxAttempts attempts"
                break
            }

            # Success sentinel — verify the run actually did what its mode claims.
            if ($mode -eq 'subtask') {
                # Child must be stacked on the epic branch; its issue is intentionally left OPEN.
                if (-not (Test-ChildMerged -Branch $item.EpicBranch -Issue $n)) {
                    $failReason = "MISMATCH: reported $OK but no 'merge(#$n)' commit on $($item.EpicBranch)"
                    break
                }
            }
            else {
                # default / finalize: the issue (the epic, for finalize) must be CLOSED.
                $ghState = gh issue view $n --json state -q .state 2>$null
                if ($LASTEXITCODE -ne 0) {
                    $failReason = "UNVERIFIED: 'gh issue view $n' failed; cannot confirm merge"
                    break
                }
                if ($ghState -ne 'CLOSED') {
                    $failReason = "MISMATCH: run reported $OK but issue is '$ghState', not CLOSED"
                    break
                }
            }

            $doneMsg = switch ($mode) {
                'subtask'  { "merged into $($item.EpicBranch); issue left open for epic finalize" }
                'finalize' { "stack reviewed, merged to develop, epic + children closed" }
                default    { 'merged to develop, issue closed' }
            }
            Write-Log "=== $what DONE - $doneMsg. ===" 'Green'
            $script:IssueState["$n"] = 'done'
            # Epic roll-up: tally a completed child; write the epic record when the
            # finalize lands (its review cycles are still in $script:RunCycles here).
            if ($agg -and $mode -eq 'subtask')  { $agg.child_ok++ }
            if ($agg -and $mode -eq 'finalize') {
                Write-EpicRollup -Agg $agg -FinalizeOutcome 'ok'
                Write-Log ("    epic #{0} complete: {1} child(ren), {2:N2} billed total" -f $agg.epic, $agg.child_total, $agg.billed_usd) 'Green'
            }
            $succeeded = $true
            break
        }

        if (-not $succeeded) {
            if (-not $failReason) { $failReason = 'did not complete' }
            $script:IssueState["$n"] = 'failed'
            $script:HadFailures = $true
            $extra = if ($mode -ne 'default') { ' (develop untouched; epic branch left for inspection)' } else { '' }

            if ($StopOnFail) {
                $script:RunState = 'stopped'
                Write-Log "=== $what FAILED - $failReason. Stopping (-StopOnFail).$extra ===" 'Red'
                exit 1
            }

            # Failure quarantine: skip this item and keep the queue running.
            $script:ConsecFails++
            Write-Log "=== $what FAILED - $failReason. QUARANTINED - continuing with the rest of the queue.$extra ===" 'Red'

            # An epic with a failed child/finalize is compromised: block its remaining
            # steps so a finalize can't land an incomplete stack or close unfixed issues.
            if ($mode -ne 'default') {
                $epicKey = "$($item.EpicIssue)"
                if (-not $script:BlockedEpics.ContainsKey($epicKey)) {
                    $script:BlockedEpics[$epicKey] = $true
                    $blockedNow = @()
                    foreach ($k in @($script:IssueState.Keys)) {
                        $i2 = $script:ItemByIssue["$k"]
                        if ($i2 -and $i2.Mode -ne 'default' -and "$($i2.EpicIssue)" -eq $epicKey -and $script:IssueState[$k] -eq 'pending') {
                            $script:IssueState[$k] = 'blocked'
                            $blockedNow += "#$k"
                        }
                    }
                    if ($blockedNow.Count -gt 0) {
                        Write-Log "    epic #$epicKey quarantined - blocking its remaining steps: $($blockedNow -join ', ')" 'Yellow'
                    }
                }
            }

            # Circuit breaker: consecutive failures look systemic (broken gh/npm/network),
            # and each further item would burn a paid claude run before failing too.
            if ($script:ConsecFails -ge $MaxConsecutiveFails) {
                $script:RunState = 'stopped'
                Write-Log "=== $($script:ConsecFails) consecutive item failures - looks systemic, not per-issue. Stopping the queue (cap -MaxConsecutiveFails $MaxConsecutiveFails). ===" 'Red'
                exit 1
            }

            $script:CurrentIssue = $null
            $script:CurItem      = $null
            Draw-Panel
            continue
        }

        $script:ConsecFails  = 0
        $script:CurrentIssue = $null
        $script:CurItem      = $null
        Draw-Panel
    }

    $failedIssues  = @($script:IssueState.Keys | Where-Object { $script:IssueState["$_"] -eq 'failed' })
    $blockedIssues = @($script:IssueState.Keys | Where-Object { $script:IssueState["$_"] -eq 'blocked' })
    if ($failedIssues.Count -eq 0) {
        Write-Log "All issues completed successfully: $($Issues -join ', ')" 'Green'
    } else {
        $doneIssues = @($script:IssueState.Keys | Where-Object { $script:IssueState["$_"] -eq 'done' })
        $blockedNote = if ($blockedIssues.Count -gt 0) { " | blocked: #$($blockedIssues -join ', #')" } else { '' }
        Write-Log "Queue finished with quarantined failures - done: $($doneIssues.Count)/$($script:IssueState.Count) | failed: #$($failedIssues -join ', #')$blockedNote. Re-run the same list to resume (done items skip for free)." 'Yellow'
    }
    $script:QueueCompleted = $true
}
finally {
    Close-Panel
}

# Post-run KB graduation review. Reached whenever the queue ran to its end —
# including with quarantined failures (an aborted run exits above) — unless opted out.
if ($script:QueueCompleted -and -not $NoGraduate) {
    Invoke-GraduationReview
}

# Quarantined failures still make the run a failure for callers/CI.
if ($script:HadFailures) { exit 1 }
