# Review Knowledge Base

An accumulating store of lessons distilled from multi-lens code reviews. Its job is to
stop the dev cycle from repeating findings the reviewers already caught once — by feeding
recurring patterns back to the **implementer** before it writes code.

## Why it exists

`review-cycles.jsonl` records the *quantitative* shape of every review (finding counts,
timings, cost). The `reviews/*.md` files hold the *qualitative* findings as prose, but no
agent ever re-reads them. The KB is the missing middle layer: distilled, deduplicated,
reusable **rules** with a recurrence count.

## Where knowledge is consumed (two paths)

- **Cold path** — the few rules that recur often and are codebase-wide graduate into
  `dev-docs/review-rules.md`, which `CLAUDE.md` `@`-imports. These load into *every*
  agent's context. Cheap (concise, always-on), high-leverage, but reserved for the top
  rules. **Graduation is human-gated** — it is the only action that changes context
  globally, so a human approves it.
- **Hot path** — the long tail of area-specific *active* lessons is injected only into
  the **implementer** (dev-cycle Phase 3), targeted by the files the issue will touch and
  capped. Reviewers are deliberately **never** fed the KB: it keeps them an independent
  oracle (their findings-per-cycle, tracked in `review-cycles.jsonl`, is how we measure
  whether the KB is working) and avoids anchoring them toward known patterns.

## Lesson lifecycle (status)

| status | meaning | injected where |
|---|---|---|
| `candidate` | seen in 1 issue | nowhere |
| `active` | recurred in ≥2 issues (auto-promoted) | implementer hot path (Phase 3) |
| `graduated` | a human promoted it | cold path (`review-rules.md`, all agents) |
| `retired` | pruned | nowhere |

`candidate → active` is automatic at `ACTIVE_THRESHOLD` (2) distinct source issues.
`active → graduated` and `→ retired` are manual (`graduate.mjs`).

## Record schema (`review-lessons.jsonl`, one JSON object per line)

```json
{
  "id": "fail-closed-gates",
  "title": "Security gates must fail closed and validate at runtime",
  "category": "security",
  "rule": "<terse imperative rule>",
  "rationale": "<what went wrong, citing the issues>",
  "severity": "critical | high | medium | low",
  "status": "candidate | active | graduated | retired",
  "occurrences": 2,
  "source_issues": [152, 153],
  "file_globs": ["src/contributions/**"],
  "first_seen": "<iso>",
  "last_seen": "<iso>"
}
```

`occurrences` always equals `source_issues.length` — recurrence is counted by distinct
issues, so the same issue re-applying a lesson never inflates it.

Categories: `security`, `correctness`, `over-abstraction`, `performance`, `testing`,
`data-integrity`, `determinism`, `api-contract`, `style`.

## Scripts (`scripts/kb/`, Node, no dependencies)

| Command | Does |
|---|---|
| `node scripts/kb/retrieve.mjs --paths "<globs>" --top 8` | **Hot path.** Print active lessons relevant to those paths (graduated ones excluded — they're already in `CLAUDE.md`). |
| `node scripts/kb/catalog.mjs` | List existing lessons (id · title · rule) so a distiller can `match_id` instead of duplicating. |
| `node scripts/kb/apply.mjs --in items.json` | Fold distilled findings in: merge by `match_id`/title (increment), or add as candidate; auto-promote at ≥2 issues. `--dry` to preview. |
| `node scripts/kb/graduate.mjs --list` | **Human gate.** Show active lessons ranked for graduation. |
| `node scripts/kb/graduate.mjs --id <id> [...]` | Graduate lesson(s) to the cold path and regenerate `review-rules.md`. `--retire <id>` to prune. |
| `node scripts/kb/regenerate.mjs` | Rebuild `dev-docs/review-rules.md` from graduated lessons (graduate.mjs calls this for you). |

`apply.mjs` input item:

```json
{ "match_id": "<existing id, or omit>", "title": "...", "category": "...",
  "rule": "...", "rationale": "#NNN: ...", "severity": "high",
  "source_issue": 163, "file_globs": ["src/practices/**"] }
```

## Dev-cycle integration

- **Phase 3 (Implement):** runs `retrieve.mjs` for the area being touched and treats the
  pitfalls as hard constraints.
- **Phase 8 (Report):** distills this run's findings (set `match_id` against `catalog.mjs`)
  and runs `apply.mjs`, then commits the store.

## Graduating lessons (the human step)

Periodically (e.g. at a `develop → main` promotion) review what's accrued:

```bash
node scripts/kb/graduate.mjs --list
node scripts/kb/graduate.mjs --id fail-closed-gates --id bound-list-endpoints
```

Graduate the rules that are **codebase-wide and stable** — the ones worth every agent
carrying in context permanently. Leave area-specific ones active (the hot path already
targets them). Retire anything that turns out wrong or obsolete.

## Seed

Seeded from the last 80 review files (issues #102–#163): 40 lessons, 16 active. Nothing
graduated yet — run `graduate.mjs --list` to choose the first cold-path rules.
