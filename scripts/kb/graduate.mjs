#!/usr/bin/env node
// kb/graduate.mjs — the one HUMAN-GATED step. Promote active lessons to the cold path
// (always-loaded project rules) or list the candidates for promotion.
//
// Graduation is the only action that changes context for EVERY agent (it edits the
// @-imported dev-docs/review-rules.md), so it is deliberately manual.
//
// Usage:
//   node scripts/kb/graduate.mjs --list                 # show active lessons ranked for review
//   node scripts/kb/graduate.mjs --id fail-open-gate --id no-unbounded-list
//   node scripts/kb/graduate.mjs --retire stale-lesson-id
//
// After any change it rewrites the store and regenerates dev-docs/review-rules.md.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readStore, writeStore, nowIso, parseArgs, bySeverityThenOccurrence } from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function asList(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// parseArgs collapses repeated --id into the last value; re-scan argv for all of them.
function collectRepeated(flag) {
  const argv = process.argv.slice(2);
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${flag}`) out.push(argv[++i]);
    else if (argv[i]?.startsWith(`--${flag}=`)) out.push(argv[i].split('=').slice(1).join('='));
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const lessons = readStore();

  if (args.list) {
    const active = lessons.filter((l) => l.status === 'active').sort(bySeverityThenOccurrence);
    if (active.length === 0) {
      console.log('No active lessons awaiting graduation.');
      return;
    }
    console.log('Active lessons (graduate the codebase-wide ones with --id <id>):\n');
    for (const l of active) {
      console.log(
        `  ${l.id}\n    [${l.category}/${l.severity}] seen ${l.occurrences}× (#${l.source_issues.join(
          ', #'
        )})\n    ${l.rule}\n`
      );
    }
    return;
  }

  const ids = collectRepeated('id');
  const retire = collectRepeated('retire');
  if (ids.length === 0 && retire.length === 0) {
    console.log('Nothing to do. Use --list, --id <id>, or --retire <id>.');
    return;
  }

  const byId = new Map(lessons.map((l) => [l.id, l]));
  const now = nowIso();
  for (const id of ids) {
    const l = byId.get(id);
    if (!l) {
      console.error(`! no lesson with id "${id}"`);
      continue;
    }
    l.status = 'graduated';
    l.last_seen = now;
    console.log(`graduated: ${id}`);
  }
  for (const id of retire) {
    const l = byId.get(id);
    if (!l) {
      console.error(`! no lesson with id "${id}"`);
      continue;
    }
    l.status = 'retired';
    l.last_seen = now;
    console.log(`retired: ${id}`);
  }

  writeStore(lessons);
  // regenerate the cold-path digest so CLAUDE.md's import reflects the change
  execFileSync('node', [resolve(__dirname, 'regenerate.mjs')], { stdio: 'inherit' });
}

main();
