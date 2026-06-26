#!/usr/bin/env pwsh
# run-issues-panel.ps1 — run /dev-cycle-phases on a list of GitHub issues
# sequentially, with a pinned status panel at the bottom of the terminal.
#
# This is the panel variant of run-issues.ps1. Behaviour (fresh process per
# issue, stop-on-first-failure, resumable incomplete runs) is identical; the
# difference is the live HUD pinned to the bottom rows while logs scroll above.
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
#   ./run-issues-panel.ps1 6 7 8
#   ./run-issues-panel.ps1 -Issues 6,7,8 -MaxResumes 1
#   ./run-issues-panel.ps1 6 7 8 -Model opus      # default is fable
#   ./run-issues-panel.ps1 6 7 8 -ReviewCycles 2  # cap Phase-6 review cycles (default 3)
#   ./run-issues-panel.ps1 6 7 8 -Panel           # force panel (e.g. WebStorm terminal)
#   ./run-issues-panel.ps1 6 7 8 -NoPanel
#   ./run-issues-panel.ps1 150 151 152 -Fresh     # re-run every item, ignoring the resume-skip
#
# Epics: if an issue has GitHub sub-issues (or a "Subtasks" section listing #NN), its
# children are built on a shared epic branch and reviewed once at the end. Re-running
# the same list RESUMES: already-merged children and already-closed epics/issues are
# skipped deterministically (no claude run, no tokens) before dispatch — unless -Fresh.
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
    [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)]
    [int[]]$Issues,

    # How many times to resume a single issue after an incomplete (non-failure) run.
    [int]$MaxResumes = 2,

    # Maximum code-review cycles per issue (Phase 6 of the dev-cycle). Passed through
    # to the skill, which otherwise defaults to 3. Each cycle = one multi-lens review
    # + fix + gate + push. Lower it for cheaper/faster runs; raise it for tougher issues.
    [ValidateRange(1, 10)]
    [int]$ReviewCycles = 3,

    # Model passed to `claude -p --model`. Defaults to fable (Fable 5,
    # claude-fable-5). Always passed explicitly so the headless CLI never
    # silently falls back to the configured default. Fast mode is
    # interactive-only, so it is not offered here.
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
    [switch]$Fresh
)

$ErrorActionPreference = 'Stop'
# We manage native (git/gh) exit codes ourselves via $LASTEXITCODE, so a non-zero
# exit must NOT throw — except where we explicitly `throw` to fail loud (epic resolution).
$PSNativeCommandUseErrorActionPreference = $false

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
$script:PanelMode = (-not $NoPanel) -and ($Panel -or [bool]$env:WT_SESSION) -and ([Console]::WindowHeight -gt ($PanelRows + 4))

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
    $m = [regex]::Match($Raw, '^\s*DEVCYCLE_METRIC:\s*(\w+)\s*(?:\|\s*(.*))?$')
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
        'fix_done'  { if ($script:CurCycle) { $script:CurCycle.fix_end   = Get-Date; $script:CurSub = 'done' } }
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
    $totReview = 0.0; $totFix = 0.0
    foreach ($c in $script:RunCycles) {
        foreach ($k in 'critical','high','medium','low','style') { $sumFind[$k] += $c[$k] }
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
            cycles_run        = $cycleRecs.Count
            max_cycles        = $ReviewCycles
            total_review_sec  = [math]::Round($totReview, 1)
            total_fix_sec     = [math]::Round($totFix, 1)
            findings_total    = $sumFind
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
        Seg ' run-issues-panel  ' $C.bold
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
    if ($script:RunState -eq 'stopped') { $line1 += Seg '   STOPPED' $C.boldred }

    # Line 2 — queue. Epics render as a bracketed group of children followed by the
    # finalize step, marked ⊕:  150  [✓153 ▶154 ·155 ·156 ·⊕151]  152
    $doneCount = ($script:IssueState.Values | Where-Object { $_ -eq 'done' }).Count
    $queueSegs = @(Seg ' queue: ' $C.gray)
    $inEpic = $null
    foreach ($n in $script:IssueState.Keys) {
        $it  = $script:ItemByIssue["$n"]
        $st  = $script:IssueState["$n"]
        $col = switch ($st) { 'done' { $C.green } 'running' { $C.boldcyan } 'failed' { $C.red } default { $C.gray } }
        $gl  = switch ($st) { 'done' { '✓' }      'running' { '▶' }         'failed' { '✗' }     default { '·' } }
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
    $queueSegs += Seg (" (done {0}/{1})" -f $doneCount, $script:IssueState.Count) $C.gray
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
    Reset-Analytics
    $PSNativeCommandUseErrorActionPreference = $false

    $writer = [System.IO.StreamWriter]::new($LogPath, $false)
    $writer.AutoFlush = $true
    try {
        claude -p $Prompt --model $script:ModelArg --output-format stream-json --verbose --dangerously-skip-permissions |
            ForEach-Object {
                $line = [string]$_
                $writer.WriteLine($line)

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
                                if ($t -notmatch '^DEVCYCLE_PHASE:') {
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
                    }
                }
            }
        $script:CliExit = $LASTEXITCODE
    }
    finally {
        $writer.Dispose()
    }

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
# Main loop
# --------------------------------------------------------------------------
# Test hook: dot-source with $env:RIP_NOEXEC set to load the functions (and create
# the output dirs) without launching claude — used by the analytics smoke test.
if ($env:RIP_NOEXEC) { return }

try {
    Initialize-Panel

    $panelLabel = if ($script:PanelMode) { 'panel ON' } else { 'panel OFF (plain streaming)' }
    Write-Log "=== run-issues-panel: model=$Model | review-cycles=$ReviewCycles | $panelLabel | issues: $($Issues -join ', ') ===" 'Cyan'

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

        $succeeded = $false
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

            # Mode -> skill flags. The script owns the epic-branch name; the skill
            # stacks children on it (subtask) and lands the whole epic in one PR (finalize).
            $modeFlags = switch ($mode) {
                'subtask'  { "--epic-branch $($item.EpicBranch) --epic-issue $($item.EpicIssue) --fast-lens on" }
                'finalize' { "--finalize-epic $($item.Children -join ',') --epic-branch $($item.EpicBranch)" }
                default    { '' }
            }
            $invoke = ("/dev-cycle-phases $n $modeFlags").TrimEnd()

            $resumeNote = if ($isResume) {
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
            $cliExit = $script:CliExit
            $script:RunCost   += $script:LastCost   # authoritative cost from this process's result line
            $script:IssueCost += $script:LastCost
            if ($agg) { $agg.billed_usd += $script:LastCost }   # epic roll-up (children + finalize)

            $resultLines = ($resultText -split "`r?`n") | Where-Object { $_.Trim() -ne '' }
            $lastLine = if ($resultLines) { ($resultLines | Select-Object -Last 1).Trim() } else { '' }

            # Persist per-run analytics (every attempt, whatever the outcome).
            $runOutcome = if ($lastLine -like "$FAIL*") { 'failed' }
                          elseif ($cliExit -ne 0 -or $lastLine -ne $OK) { 'incomplete' }
                          else { 'ok' }
            Write-Analytics -Issue $n -Attempt $attempt -Outcome $runOutcome -BilledUsd $script:LastCost -Mode $mode -EpicIssue $item.EpicIssue

            # Hard failure — not retryable.
            if ($lastLine -like "$FAIL*") {
                $script:IssueState["$n"] = 'failed'
                $script:RunState = 'stopped'
                $extra = if ($mode -ne 'default') { ' (develop untouched; epic branch left for inspection)' } else { '' }
                Write-Log "=== $what FAILED - $lastLine. Stopping (not retryable).$extra ===" 'Red'
                exit 1
            }

            # Incomplete — crashed or ended mid-cycle without a sentinel.
            if ($cliExit -ne 0 -or $lastLine -ne $OK) {
                $why = if ($cliExit -ne 0) { "claude exited $cliExit" } else { 'no success sentinel (run stopped mid-cycle)' }
                if ($attempt -lt $maxAttempts) {
                    Write-Log "=== $what INCOMPLETE - $why. Resuming... ===" 'Yellow'
                    continue
                }
                $script:IssueState["$n"] = 'failed'
                $script:RunState = 'stopped'
                Write-Log "=== $what FAILED - $why after $maxAttempts attempts. Stopping. ===" 'Red'
                exit 1
            }

            # Success sentinel — verify the run actually did what its mode claims.
            if ($mode -eq 'subtask') {
                # Child must be stacked on the epic branch; its issue is intentionally left OPEN.
                if (-not (Test-ChildMerged -Branch $item.EpicBranch -Issue $n)) {
                    $script:IssueState["$n"] = 'failed'
                    $script:RunState = 'stopped'
                    Write-Log "=== $what MISMATCH - reported $OK but no 'merge(#$n)' commit on $($item.EpicBranch). Stopping. ===" 'Red'
                    exit 1
                }
            }
            else {
                # default / finalize: the issue (the epic, for finalize) must be CLOSED.
                $ghState = gh issue view $n --json state -q .state 2>$null
                if ($LASTEXITCODE -ne 0) {
                    $script:IssueState["$n"] = 'failed'
                    $script:RunState = 'stopped'
                    Write-Log "=== $what UNVERIFIED - 'gh issue view $n' failed; cannot confirm merge. Stopping. ===" 'Red'
                    exit 1
                }
                if ($ghState -ne 'CLOSED') {
                    $script:IssueState["$n"] = 'failed'
                    $script:RunState = 'stopped'
                    Write-Log "=== $what MISMATCH - run reported $OK but issue is '$ghState', not CLOSED. Stopping. ===" 'Red'
                    exit 1
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
            $script:IssueState["$n"] = 'failed'
            $script:RunState = 'stopped'
            Write-Log "=== $what did not complete. Stopping. ===" 'Red'
            exit 1
        }

        $script:CurrentIssue = $null
        $script:CurItem      = $null
        Draw-Panel
    }

    Write-Log "All issues completed successfully: $($Issues -join ', ')" 'Green'
}
finally {
    Close-Panel
}
