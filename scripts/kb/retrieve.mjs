#!/usr/bin/env node
// kb/retrieve.mjs — HOT PATH. Print the implementer-facing lesson digest.
//
// Returns the ACTIVE lessons relevant to the files this issue will touch, capped and
// ranked, as a terse markdown list to paste into the implementer's working notes.
// Graduated lessons are intentionally EXCLUDED — they already live in the always-loaded
// dev-docs/review-rules.md, so re-injecting them here would double-load context.
//
// Usage:
//   node scripts/kb/retrieve.mjs --paths "src/practices/**,src/dashboard/api/**" --top 8
//   node scripts/kb/retrieve.mjs --category security --top 5
//   node scripts/kb/retrieve.mjs --top 10            # top active overall (no path filter)
//
// Selection: lessons whose file_globs overlap --paths rank first; remaining slots are
// filled with the highest-recurrence cross-cutting active lessons. Output is empty
// (a single comment line) when nothing is relevant, so the caller can skip injection.

import {
  readStore,
  lessonMatchesPaths,
  bySeverityThenOccurrence,
  parseArgs,
} from './lib.mjs';

function main() {
  const args = parseArgs(process.argv.slice(2));
  const top = Number(args.top ?? 8);
  const paths = args.paths
    ? String(args.paths)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const category = args.category ? String(args.category) : null;

  const active = readStore().filter((l) => l.status === 'active');
  const eligible = category ? active.filter((l) => l.category === category) : active;

  const matched = paths.length ? eligible.filter((l) => lessonMatchesPaths(l, paths)) : [];
  const rest = eligible
    .filter((l) => !matched.includes(l))
    .sort(bySeverityThenOccurrence);
  matched.sort(bySeverityThenOccurrence);

  const picked = [...matched, ...rest].slice(0, top);

  if (picked.length === 0) {
    console.log('<!-- review-KB: no relevant active lessons -->');
    return;
  }

  const lines = [];
  lines.push('### Review-KB pitfalls (avoid these — distilled from past reviews)');
  lines.push('');
  for (const l of picked) {
    const seen = l.source_issues.length;
    lines.push(
      `- **[${l.category}/${l.severity}]** ${l.rule}` +
        `  _(${l.title}; seen ${seen}×: #${l.source_issues.join(', #')})_`
    );
  }
  console.log(lines.join('\n'));
}

main();
