// Shared helpers for the review knowledge base (KB).
// No external dependencies — Node 18+ ESM only.
//
// The KB is a JSONL store of "lessons" distilled from multi-lens code reviews.
// Each lesson is one record; see REVIEW_KB.md for the schema and lifecycle.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..', '..');
export const STORE_PATH = resolve(REPO_ROOT, 'dev-cycle-analytics', 'review-lessons.jsonl');
export const RULES_MD_PATH = resolve(REPO_ROOT, 'dev-docs', 'review-rules.md');

/** Recurrence at which a candidate auto-promotes to the implementer hot path. */
export const ACTIVE_THRESHOLD = 2;

export const CATEGORIES = [
  'security',
  'correctness',
  'over-abstraction',
  'performance',
  'testing',
  'data-integrity',
  'determinism',
  'api-contract',
  'style',
];

export const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

export function nowIso() {
  return new Date().toISOString();
}

export function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Read the store as an array of lesson objects (empty if missing). */
export function readStore() {
  if (!existsSync(STORE_PATH)) return [];
  const raw = readFileSync(STORE_PATH, 'utf8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch (e) {
        throw new Error(`review-lessons.jsonl line ${i + 1} is not valid JSON: ${e.message}`);
      }
    });
}

/** Write lessons back to the store (one JSON object per line, stable key order). */
export function writeStore(lessons) {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  const ordered = [...lessons].sort(
    (a, b) =>
      (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
      (b.occurrences ?? 0) - (a.occurrences ?? 0) ||
      a.id.localeCompare(b.id)
  );
  const body = ordered.map((l) => JSON.stringify(normalizeLesson(l))).join('\n');
  writeFileSync(STORE_PATH, body + (body ? '\n' : ''), 'utf8');
}

/** Enforce a stable field order and sane defaults on a lesson record. */
export function normalizeLesson(l) {
  return {
    id: l.id,
    title: l.title ?? '',
    category: l.category ?? 'correctness',
    rule: l.rule ?? '',
    rationale: l.rationale ?? '',
    severity: l.severity ?? 'medium',
    status: l.status ?? 'candidate',
    occurrences: l.occurrences ?? 1,
    source_issues: dedupeSortedNums(l.source_issues ?? []),
    file_globs: [...new Set(l.file_globs ?? [])],
    first_seen: l.first_seen ?? nowIso(),
    last_seen: l.last_seen ?? nowIso(),
  };
}

function dedupeSortedNums(arr) {
  return [...new Set(arr.map(Number).filter((n) => !Number.isNaN(n)))].sort((a, b) => a - b);
}

/**
 * Convert a glob (supporting **, *, ?) to a RegExp anchored to the whole string.
 * Good enough for path-shaped globs like "src/practices/**" or "src/**\/state*.ts".
 */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // collapse "**/" so it can match zero dirs
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

/** Does a lesson's file_globs overlap any of the caller-provided path globs? */
export function lessonMatchesPaths(lesson, paths) {
  if (!paths || paths.length === 0) return false;
  const lessonGlobs = lesson.file_globs ?? [];
  if (lessonGlobs.length === 0) return false;
  // Bidirectional: a lesson matches if either side's glob matches the other's
  // first two path segments (the module dir), which is robust to glob-vs-glob.
  const dirKey = (g) => g.split('/').slice(0, 2).join('/');
  const pathKeys = new Set(paths.map(dirKey));
  return lessonGlobs.some((lg) => {
    if (pathKeys.has(dirKey(lg))) return true;
    const lre = globToRegExp(lg);
    return paths.some((p) => lre.test(p) || globToRegExp(p).test(lg));
  });
}

export function bySeverityThenOccurrence(a, b) {
  return (
    (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
    (b.occurrences ?? 0) - (a.occurrences ?? 0)
  );
}

/** Parse `--flag value` / `--flag=value` / `--bool` style argv into an object. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      out[a.slice(2)] = argv[++i];
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}
