#!/usr/bin/env node
// kb/catalog.mjs — print the existing lessons (id · title · rule) so a distiller can
// set match_id on new findings instead of creating near-duplicate lessons.
//
// Usage: node scripts/kb/catalog.mjs            # all lessons
//        node scripts/kb/catalog.mjs --json     # machine-readable {id,title,category}

import { readStore, parseArgs } from './lib.mjs';

function main() {
  const args = parseArgs(process.argv.slice(2));
  const lessons = readStore();
  if (args.json) {
    console.log(
      JSON.stringify(
        lessons.map((l) => ({ id: l.id, title: l.title, category: l.category })),
        null,
        2
      )
    );
    return;
  }
  if (lessons.length === 0) {
    console.log('(KB empty — no lessons yet)');
    return;
  }
  for (const l of lessons) {
    console.log(`${l.id}  [${l.category}/${l.severity}/${l.status}]  ${l.title}\n    ${l.rule}`);
  }
}

main();
