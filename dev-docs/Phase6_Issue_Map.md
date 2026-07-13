# Phase 6 — GitHub Issue Map & Run Guide

Maps the Phase 6 task tracker (`Phase6_Task_Tracker.md`) to the GitHub issues that
were imported from it, and gives the exact harness commands to execute them.

- **Repo:** `goranocokoljic/toprope`
- **Milestone:** `Phase 6: Improvement Layer - Knowledge Sharing + Showcase` (#4) — on all 27 issues
- **Labels:** `phase-6` (all) · `epic` (the 3 parents only — **never run these**) ·
  `epic-6.1` / `epic-6.2` / `epic-6.3` (membership) · `standalone` (6.4 / 6.5)

> **The `epic` label is the "do NOT run" marker.** Epics (#148/#149/#150) are tracking
> parents with no code unit. Feed the harness only the **leaf children** + the standalones.

---

## Epic 6.1 — Shared Primitives (parent #148)

Build this epic **fully** before 6.2/6.3 — both sit on it.

| Task  | Issue | Title |
|-------|-------|-------|
| 6.1.1 | #151  | Shared Content Schema + Migration |
| 6.1.2 | #152  | Contribution-Flow State Machine |
| 6.1.3 | #153  | Versioning |
| 6.1.4 | #154  | Org/Team Inheritance + Scope Resolution |
| 6.1.5 | #155  | Search |

## Epic 6.2 — Best Practices (parent #149)

| Task  | Issue | Title |
|-------|-------|-------|
| 6.2.1 | #156  | Best-Practice Schema |
| 6.2.2 | #157  | Contribution-Model Engine |
| 6.2.3 | #158  | Rich Authoring Editor |
| 6.2.4 | #159  | Feedback Mechanics |
| 6.2.5 | #160  | Tag-Based Auto-Surfacing |
| 6.2.6 | #161  | Manual Override (Pin/Suppress) |
| 6.2.7 | #162  | Contextual Display Next to Metrics |
| 6.2.8 | #163  | Browse UI |

## Epic 6.3 — Showcase (parent #150)

| Task  | Issue | Title |
|-------|-------|-------|
| 6.3.1 | #164  | Showcase Schema |
| 6.3.2 | #165  | Dual Publish Paths (Consent Gate) |
| 6.3.3 | #166  | Inline Developer Annotations |
| 6.3.4 | #167  | Curators' Note (Mandatory) + Outcome Linkage |
| 6.3.5 | #168  | Auto-Flag Scrubber (Two-Tier Detector) |
| 6.3.6 | #169  | Mandatory Manual-Review Flow |
| 6.3.7 | #170  | Optional AI Annotation (Local, Specific-or-Silent) |
| 6.3.8 | #171  | Showcase ↔ Best-Practice Cross-Link |
| 6.3.9 | #172  | Browse/Governance (Extends Phase 5) |

## Standalone tasks (no epic)

| Task | Issue | Title |
|------|-------|-------|
| 6.4  | #173  | Settings Extensions |
| 6.5  | #174  | Private "How Could This Be Better" Tool |

---

## Build order

The tracker mandates: **Epic 6.1 fully → then 6.2 and 6.3** (both depend on the
6.1 primitives). `6.4` settings can land alongside 6.2/6.3 (they read these settings).
`6.5` is standalone, any time after the Phase 5 retrospective exists. Within each epic,
children are numbered in dependency order (schema → logic → surface → wiring) — run
them in that order.

## Harness commands

Run the **children only**, in order. Default model is `opus` (override with `-Model`).

```powershell
# Epic 6.1 — shared primitives (do first, fully)
./tr-harness.ps1 151 152 153 154 155 -Panel

# Epic 6.2 — best practices
./tr-harness.ps1 156 157 158 159 160 161 162 163 -Panel

# Epic 6.3 — showcase
./tr-harness.ps1 164 165 166 167 168 169 170 171 172 -Panel

# Standalone settings + private tool (6.4 reads settings used by 6.2/6.3)
./tr-harness.ps1 173 174 -Panel
```

The harness stops at the first hard failure, so a bad run never cascades into the rest
of the queue. You can also run a single issue (`./tr-harness.ps1 151`) or split a
batch across sessions.

> **Never** pass an epic number (148/149/150) to the harness — there is no code unit to
> implement, build, or test, and the run would flail or false-close.

## Context inheritance (how children get epic + sibling context)

Each child issue body carries an `Epic: #NN` line and inline sibling references
(e.g. "uses 6.1.5 search / #155"). The `dev-cycle` / `dev-cycle-phases` skills resolve
these in Phase 1:

- **Epic parent** (`Epic: #NN`) — fetched in full; its cross-cutting acceptance criteria
  apply to the child as additional criteria.
- **Referenced siblings** — only the ones the child names are fetched, and only their
  title + scope + acceptance criteria (their contract, not their whole body). Already-merged
  siblings are read from the codebase during implementation; not-yet-built ones from the issue.

No harness change is needed — resolution lives entirely in the skill.

## When children close

Closing a child auto-checks it in the epic's native sub-issue panel (and the text
checklist in the epic body). An epic closes when all its children are done — close the
epic manually once its sub-issues are complete.

> Note: these PRs merge into `develop`, so `Closes #N` does **not** auto-close the issue
> (GitHub only auto-closes on merge to the default branch, `main`). The dev-cycle skill
> closes each child explicitly via `gh issue close`. `develop → main` promotion is manual
> at phase end.
