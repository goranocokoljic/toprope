#!/usr/bin/env node
// kb/apply.mjs — fold distilled review findings into the KB store.
//
// Input: a JSON array (via --in <file> or stdin) of distilled items. Each item is
// either a NEW candidate lesson or a hit against an existing one:
//
//   {
//     "match_id":  "fail-open-gate" | null,   // set to merge into an existing lesson
//     "id":        "fail-open-gate",          // optional explicit id for a new lesson
//     "title":     "Validation gates must fail closed",
//     "category":  "security",
//     "rule":      "Validate gate/enum values against an allowlist; unknown -> reject.",
//     "rationale": "#152: unrecognized approval-gate value bypassed approval.",
//     "severity":  "high",
//     "source_issue": 152,
//     "file_globs": ["src/**/state*.ts", "src/practices/**"]
//   }
//
// Rules:
//  - match_id (or a title/id collision) => increment occurrences, merge source_issues
//    + file_globs, bump last_seen, keep the strongest severity.
//  - new item => stored as a candidate.
//  - any candidate reaching ACTIVE_THRESHOLD distinct source_issues auto-promotes to
//    "active" (the implementer hot path). Graduation to the cold path stays manual.
//
// Usage:
//   node scripts/kb/apply.mjs --in distilled.json
//   cat distilled.json | node scripts/kb/apply.mjs
//   node scripts/kb/apply.mjs --in distilled.json --dry   # print diff, write nothing

import { readFileSync } from 'node:fs';
import {
  readStore,
  writeStore,
  normalizeLesson,
  nowIso,
  slug,
  parseArgs,
  ACTIVE_THRESHOLD,
  SEVERITIES,
} from './lib.mjs';

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const strongerSeverity = (a, b) =>
  (SEVERITY_RANK[a] ?? 9) <= (SEVERITY_RANK[b] ?? 9) ? a : b;

function readInput(args) {
  if (args.in) return JSON.parse(readFileSync(args.in, 'utf8'));
  const stdin = readFileSync(0, 'utf8').trim();
  if (!stdin) throw new Error('no input: pass --in <file> or pipe JSON on stdin');
  return JSON.parse(stdin);
}

function findExisting(lessons, byId, item) {
  if (item.match_id && byId.has(item.match_id)) return byId.get(item.match_id);
  const id = item.id || slug(item.title);
  if (id && byId.has(id)) return byId.get(id);
  // fall back to a title match (distiller may not echo ids)
  const t = (item.title || '').toLowerCase().trim();
  return lessons.find((l) => l.title.toLowerCase().trim() === t && t) || null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const items = readInput(args);
  if (!Array.isArray(items)) throw new Error('input must be a JSON array of distilled items');

  const lessons = readStore();
  const byId = new Map(lessons.map((l) => [l.id, l]));
  const now = nowIso();
  const summary = { merged: 0, created: 0, promoted: 0 };

  for (const item of items) {
    if (item.severity && !SEVERITIES.includes(item.severity)) {
      throw new Error(`item "${item.title}" has invalid severity "${item.severity}"`);
    }
    const existing = findExisting(lessons, byId, item);

    if (existing) {
      const before = existing.source_issues.length;
      const merged = normalizeLesson({
        ...existing,
        rule: existing.rule || item.rule,
        rationale: existing.rationale || item.rationale,
        severity: strongerSeverity(existing.severity, item.severity || 'low'),
        source_issues: [...existing.source_issues, item.source_issue].filter((n) => n != null),
        file_globs: [...existing.file_globs, ...(item.file_globs || [])],
        last_seen: now,
      });
      merged.occurrences = merged.source_issues.length;
      if (merged.status === 'candidate' && merged.occurrences >= ACTIVE_THRESHOLD) {
        merged.status = 'active';
        if (merged.source_issues.length > before) summary.promoted++;
      }
      Object.assign(existing, merged);
      summary.merged++;
    } else {
      const id = item.id || slug(item.title);
      const lesson = normalizeLesson({
        id,
        title: item.title,
        category: item.category,
        rule: item.rule,
        rationale: item.rationale,
        severity: item.severity,
        status: 'candidate',
        occurrences: 1,
        source_issues: item.source_issue != null ? [item.source_issue] : [],
        file_globs: item.file_globs || [],
        first_seen: now,
        last_seen: now,
      });
      // a single distilled item can already carry multiple source issues
      if ((item.source_issues || []).length) {
        lesson.source_issues = [...new Set([...lesson.source_issues, ...item.source_issues])].sort(
          (a, b) => a - b
        );
        lesson.occurrences = lesson.source_issues.length;
        if (lesson.occurrences >= ACTIVE_THRESHOLD) {
          lesson.status = 'active';
          summary.promoted++;
        }
      }
      lessons.push(lesson);
      byId.set(lesson.id, lesson);
      summary.created++;
    }
  }

  if (args.dry) {
    console.log('[dry run] no changes written');
  } else {
    writeStore(lessons);
  }

  const active = lessons.filter((l) => l.status === 'active').length;
  const candidates = lessons.filter((l) => l.status === 'candidate').length;
  const graduated = lessons.filter((l) => l.status === 'graduated').length;
  console.log(
    `applied ${items.length} item(s): +${summary.created} new, ${summary.merged} merged, ` +
      `${summary.promoted} promoted to active.\n` +
      `store: ${lessons.length} lessons (${candidates} candidate, ${active} active, ${graduated} graduated).`
  );
}

main();
