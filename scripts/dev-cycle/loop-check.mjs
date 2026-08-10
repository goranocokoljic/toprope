#!/usr/bin/env node
// loop-check.mjs — convergence guard for the dev-cycle harness.
//
// Detects the "fix-of-fix loop" signature: a run of review-spawned follow-up
// issues whose reviews keep finding more, with rising cost and a single
// churning hotspot file. All signals are computed from data the harness
// already records (dev-cycle-analytics/tasks.jsonl) plus `gh` / `git`, both
// optional — an unavailable source skips its signals rather than failing.
//
// Exit codes: 0 = ok, 1 = warn (log it, keep going), 2 = stop (halt the queue).
// The last stdout line is always:  LOOPCHECK: <ok|warn|stop> | <reasons or ->
//
// Invoked by tr-harness.ps1 after every completed item (opt out: -NoLoopGuard).
// Thresholds are calibrated against this repo's own history: the June baseline
// ran $10-30/task with a median of ~1 high-severity finding; the July git-sync
// loop ran $50-240/task, medians of 4-14 highs, and an 18-issue spawn chain.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const W = 5; // trailing window size (tasks) for trend comparisons

const exec = (cmd) => {
  try {
    return execSync(cmd, {
      cwd: repoRoot, encoding: 'utf8', timeout: 20000,
      maxBuffer: 32 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch { return null; }
};

const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// ---- load tasks.jsonl, collapse attempts to one record per issue ----------
const tasksFile = path.join(repoRoot, 'dev-cycle-analytics', 'tasks.jsonl');
const byIssue = new Map();
if (fs.existsSync(tasksFile)) {
  for (const line of fs.readFileSync(tasksFile, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let t; try { t = JSON.parse(line); } catch { continue; }
    const g = byIssue.get(t.issue) ?? { issue: t.issue, ts: '', cost: 0, blockers: 0, ok: false };
    g.cost += t.billed_cost_usd ?? 0;
    const f = t.review?.findings_total;
    if (f) g.blockers = Math.max(g.blockers, (f.critical ?? 0) + (f.high ?? 0));
    if (t.ts > g.ts) g.ts = t.ts;
    if (t.outcome === 'ok') g.ok = true;
    byIssue.set(t.issue, g);
  }
}
const done = [...byIssue.values()].filter((g) => g.ok).sort((a, b) => a.ts.localeCompare(b.ts));
const last = done.slice(-W);
const prev = done.slice(-2 * W, -W);

const warns = [];
const strongs = [];
const info = [];

// ---- S1: cost per task trending up ----------------------------------------
if (last.length === W && prev.length === W) {
  const mLast = median(last.map((g) => g.cost));
  const mPrev = Math.max(median(prev.map((g) => g.cost)), 1);
  const ratio = mLast / mPrev;
  info.push(`cost/task median: $${mLast.toFixed(0)} (prev window $${mPrev.toFixed(0)}, x${ratio.toFixed(1)})`);
  if (ratio >= 3.5) strongs.push(`cost/task x${ratio.toFixed(1)} vs previous ${W}-task window`);
  else if (ratio >= 2) warns.push(`cost/task x${ratio.toFixed(1)} vs previous ${W}-task window`);
}

// ---- S2: review blockers (critical+high) not converging --------------------
if (last.length === W) {
  const mLast = median(last.map((g) => g.blockers));
  const mPrev = prev.length === W ? median(prev.map((g) => g.blockers)) : null;
  info.push(`blockers/task median: ${mLast}${mPrev !== null ? ` (prev ${mPrev})` : ''}`);
  const newest = last[last.length - 1].blockers;
  if (mLast >= 8) strongs.push(`median ${mLast} critical+high findings per task over the last ${W} tasks`);
  else if (mLast >= 3 && newest >= 3 && (mPrev === null || mLast >= Math.max(mPrev * 0.75, 2))) {
    // A plateau counts: only a clear decline is convergence. But the NEWEST task must
    // sustain it — a high median whose latest member is already clean is history
    // decaying out of the window, not a live loop (seen 2026-08-10: median 4 driven
    // entirely by pre-policy tasks while the newest task had 0 blockers).
    warns.push(`critical+high findings not converging (median ${mLast}/task, newest ${newest}, prev ${mPrev ?? 'n/a'})`);
  }
}

// ---- S3 + S4: issue provenance via gh --------------------------------------
const SPAWN_RE = /(multi-?lens review|surfaced (by|in) (the )?#\d+|from the #\d+ review|review (cycle|\(cycle)|split out of #\d+|deferred from (the )?#\d+|follow-?up (to|of|:)? ?#\d+|#\d+ follow-?up|left out of (#\d+|its) scope)/i;
const ghRaw = exec('gh issue list --state all --limit 40 --json number,title,body,createdAt,closedAt,state');
if (ghRaw) {
  let issues = [];
  try { issues = JSON.parse(ghRaw); } catch { /* skip */ }
  issues.sort((a, b) => b.number - a.number);

  // S3: consecutive newest issues that were spawned by a review
  let streak = 0;
  for (const is of issues) {
    if (SPAWN_RE.test(is.body ?? '')) streak++;
    else break;
  }
  info.push(`review-spawn streak: ${streak} newest issue(s) cite a review as their origin`);
  if (streak >= 6) strongs.push(`${streak} consecutive issues spawned from review findings`);
  else if (streak >= 4) warns.push(`${streak} consecutive issues spawned from review findings`);

  // S4: OPEN review-spawned issues — the inflow the guard exists to catch. Raw
  // opened-vs-closed was a false positive: importing a planned epic (5 roadmap
  // issues in one day, 2026-08-10) read as queue growth, and spawned issues that
  // were already triaged into the parking lot kept counting. Open + spawn-marked
  // measures the live backlog the review pipeline itself created.
  const spawnedOpen = issues.filter((i) => i.state === 'OPEN' && SPAWN_RE.test(i.body ?? '')).length;
  info.push(`open review-spawned issues: ${spawnedOpen}`);
  if (spawnedOpen >= 6) strongs.push(`${spawnedOpen} open review-spawned issues`);
  else if (spawnedOpen >= 4) warns.push(`${spawnedOpen} open review-spawned issues`);
}

// ---- S5: single-file churn hotspot -----------------------------------------
const gitRaw = exec('git log -25 --pretty=format:%H --name-only -- src');
if (gitRaw) {
  const commits = gitRaw.split(/\r?\n(?=[0-9a-f]{40}$)/m).filter(Boolean);
  const touch = new Map();
  for (const c of commits) {
    for (const f of new Set(c.split(/\r?\n/).slice(1).filter((l) => l.endsWith('.ts') && !l.includes('.test.')))) {
      touch.set(f, (touch.get(f) ?? 0) + 1);
    }
  }
  const top = [...touch.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && commits.length >= 15) {
    const share = top[1] / commits.length;
    info.push(`hotspot: ${top[0]} touched in ${top[1]}/${commits.length} recent src commits`);
    if (share >= 0.6) warns.push(`${top[0]} churned in ${Math.round(share * 100)}% of the last ${commits.length} commits`);
  }
}

// ---- verdict ---------------------------------------------------------------
const verdict = strongs.length >= 1 || warns.length >= 3 ? 'stop' : warns.length >= 1 ? 'warn' : 'ok';
for (const l of info) console.log(`  ${l}`);
for (const w of warns) console.log(`  WARN: ${w}`);
for (const s of strongs) console.log(`  STOP-SIGNAL: ${s}`);
if (verdict !== 'ok') {
  console.log('  A fix-of-fix loop looks likely: pause the queue, triage open issues against');
  console.log('  the spawn policy (dev-docs/parking-lot.md), and question the invariant being');
  console.log('  defended before hardening it further.');
}
console.log(`LOOPCHECK: ${verdict} | ${[...strongs, ...warns].join('; ') || '-'}`);
process.exit(verdict === 'stop' ? 2 : verdict === 'warn' ? 1 : 0);
