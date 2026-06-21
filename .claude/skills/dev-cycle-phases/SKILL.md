---
name: dev-cycle-phases
description: |
  Full development cycle for a single GitHub issue: read issue → create branch → implement →
  build + test + coverage → open PR → code review loop (max 3x) → merge → report done.
  Identical to dev-cycle, but emits DEVCYCLE_PHASE: markers at each phase boundary so a
  supervising runner (run-issues-panel.ps1) can show live phase state.
  Invoke as: /dev-cycle-phases {issue-number}
  Triggers on: start issue, work on issue, implement issue, dev cycle, build cycle.
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Glob
  - Grep
  - Agent
  - Skill
---

# Dev Cycle Skill (phase-instrumented)

Runs the full issue-to-merge workflow autonomously. Requires `gh` CLI authenticated and `npm` available.

This is a phase-instrumented copy of `dev-cycle`. The workflow is identical; the only
addition is a phase marker emitted at the start of each phase (see below).

## Invocation
`/dev-cycle-phases {issue-number}` — e.g. `/dev-cycle-phases 1`

---

## Phase reporting (REQUIRED)

At the **start of each phase below**, print a marker on its own line, with nothing else on
that line, exactly in this form:

```
DEVCYCLE_PHASE: <name>
```

The `<name>` MUST be one of this fixed vocabulary, in this order over the run:

`read`, `branch`, `implement`, `build+test`, `pr`, `review`, `merge`

Rules:
- Print the marker **before** doing the work of that phase.
- Print it as plain assistant text on its own line — not inside a tool call.
- For the review loop (Phase 6), print the marker at the start of **each** iteration and
  append the cycle number as a detail after a pipe:
  `DEVCYCLE_PHASE: review | cycle 2/3`
- On a resume, emit the marker for whatever phase you actually resume into, even if it is
  not `read` — the runner expects phases to be able to jump.
- These markers are in addition to, and never replace, the final `DEVCYCLE_OK` /
  `DEVCYCLE_FAIL` result line. Never print a phase marker on the very last line.

---

## Analytics reporting (REQUIRED in Phase 6)

In addition to the phase markers, emit `DEVCYCLE_METRIC:` lines during the review
loop so the supervising runner can record findings counts and split review time
from fix time. Each on its own line, plain assistant text, exactly in these forms:

```
DEVCYCLE_METRIC: review_done | review_cycle=N | critical=C high=H medium=M low=L style=S
DEVCYCLE_METRIC: fix_start   | review_cycle=N
DEVCYCLE_METRIC: fix_done    | review_cycle=N
```

- `review_done` — print **once per cycle**, right after you have read the review
  file and bucketed its findings (Phase 6 step 2). Use the actual counts from the
  review (0 is fine for any bucket). `N` is the current review cycle number. The
  counts are **across all four lenses** (SO, SEC, OR, TST) — a Test-Adequacy
  finding ranked High folds into `high=`, and so on.
- `fix_start` — print right before you begin editing files to fix findings.
- `fix_done` — print right after the cycle's `git push` succeeds.
- Skip `fix_start`/`fix_done` for any cycle with zero Blocker findings (you exit
  without a blocker-fix pass — emit only `review_done`). Medium is no longer
  auto-fixed, so a Medium-only cycle also emits just `review_done`.
- These are analytics only; like phase markers, never put one on the last line.

---

## Phase 1 — Read & Understand

Emit `DEVCYCLE_PHASE: read` first.

```bash
gh issue view {number} --comments
```

Extract and confirm with the user:
- Issue title and description
- All acceptance criteria (these are the exit condition for Phase 3 **and the unit of
  test coverage** — each one must end the cycle with a test that proves it)
- Any linked spec sections or design notes

Cross-reference with `Additional_Tasks_Git_Providers.md` for the matching task section, **and read the corresponding section of `dev-docs/Phase2_Design_Document.md`** for the detailed design (architecture, data shapes, component breakdown, decisions) behind this issue. Summarize what will be built and list the acceptance criteria explicitly before writing any code. If anything is ambiguous, ask before starting.

---

## Phase 2 — Branch (resumable)

Emit `DEVCYCLE_PHASE: branch` first.

A previous run may have been interrupted mid-cycle, so first check whether work
for this issue already exists. Branch name is `feature/issue-{number}-{slug}`
(slug: 2–4 words from the issue title, lowercase kebab-case).

```bash
ISSUE={number}
EXISTING_BRANCH=$(git branch -a --list "*feature/issue-${ISSUE}-*" \
  | head -1 | sed 's/[* ] //; s|remotes/origin/||' | xargs)
EXISTING_PR=$(gh pr list --state open --search "issue-${ISSUE}" \
  --json number -q '.[0].number')
```

- **If an existing branch and/or open PR is found → RESUME.** Check it out and
  pull (`git checkout "$EXISTING_BRANCH" && git pull`), record `EXISTING_PR` if
  set, and treat the cycle as in-progress. Assess what is already done (commits,
  PR contents, `npm run build && npm test`) and continue from the first
  incomplete phase. Do **not** recreate the branch/PR or re-implement from
  scratch. When you resume into a later phase, emit that phase's marker.
- **Otherwise → fresh start:**

  ```bash
  git checkout develop
  git pull origin develop
  git checkout -b feature/issue-${ISSUE}-{slug}
  ```

---

## Phase 3 — Implement

Emit `DEVCYCLE_PHASE: implement` first.

If resuming an interrupted run (Phase 2 found existing work), first determine
what is already complete — read the PR, inspect the diff, run the gate — and
continue from the first unfinished step instead of restarting. Commits already
on the branch count as done.

- Work through each acceptance criterion from Phase 1 in order
- Follow the project structure in `V1_Build_Specification_v2.md` Section 3
- Implement to the detailed design in `dev-docs/Phase2_Design_Document.md` — its section for this issue is the source of truth for architecture, data shapes, and component breakdown
- After each significant change run `npm run build && npm test` to catch regressions early
- Do not move to Phase 4 until every acceptance criterion from the issue is satisfied

### Testing standard (not optional)

Tests are part of the implementation, not a follow-up. A criterion is not "done"
until a test proves it. Hold every new or changed module to this bar:

1. **Write tests alongside the code — not after.** Add the Vitest spec in the same
   commit as the module it covers. Code without its test does not advance the cycle.
2. **Per-criterion mandate.** Each acceptance criterion from Phase 1 must have **at
   least one test that fails if that behavior regresses**. Before leaving Phase 3,
   write the criterion → test mapping down — you will paste it into the PR test plan
   (Phase 5). A criterion with no failing-on-regression test is an incomplete criterion.
3. **Cover the unhappy paths, not just the happy one.** For each new module, test:
   - the happy path,
   - boundary/edge inputs, and
   - error and early-return paths (thrown errors, caught-and-handled branches,
     empty/None results).

   GovProxy-specific cases that must be tested when the code touches them: a
   zero-activity day, a missing/unknown developer, a malformed CSV amount or date,
   an empty or paginated connector API response, a duplicate-day write (append-only
   must hold), and UTC date boundaries. Don't test trivial glue or pure type
   declarations — spend the assertions where a regression would actually hurt.
4. **Assert something that can fail.** A test that calls code but asserts only
   truthiness, a snapshot, or the mock is false confidence — worse than no test.
   Assert the concrete output/state/side-effect the criterion promises.

---

## Phase 4 — Pre-PR Gate

Emit `DEVCYCLE_PHASE: build+test` first.

All three checks must pass before continuing:

```bash
npm run build          # must exit 0
npm test               # must exit 0
npm run test:coverage  # must exit 0 — generates the coverage report
```

If any fails: diagnose, fix, and re-run all three from scratch. Do not proceed to
Phase 5 on any failure.

### Coverage gate (per changed file)

`npm run test:coverage` prints a per-file table. The gate is **per file this branch
adds or changes**, not a repo-wide percentage (a global threshold would fail the
whole pre-existing suite on day one). For every non-trivial source file in this
diff (exclude generated code, pure type/interface files, and frontend build
output):

- **No new source module may sit at 0% / untested.** A new module with no coverage
  is a hard stop — go back to Phase 3 and test it.
- **Changed source files should reach ≥ 80% line coverage.** If a file lands below
  80%, either add the missing tests or, if the uncovered lines are genuinely
  untestable (e.g. a defensive `never` branch), note which lines and why in the PR
  test plan. Do not lower the bar silently.

Determine the changed files with `git diff --name-only $(git merge-base develop HEAD)..HEAD`
and read those files' rows out of the coverage table.

---

## Phase 5 — Open PR

Emit `DEVCYCLE_PHASE: pr` first.

**If resuming and a PR already exists for this branch (`EXISTING_PR` from Phase
2, or `gh pr view --json number`), skip creation and reuse that PR number.**
Only create a PR when none exists.

```bash
gh pr create \
  --base develop \
  --title "feat(#{number}): {issue title}" \
  --body "$(cat <<'EOF'
Closes #{number}

## Summary
{2-4 bullet points describing what was built}

## Acceptance Criteria
{copy each criterion from the issue, prefix with - [x] for each one met}

## Test plan
{For EACH acceptance criterion, name the test(s) that prove it — the criterion → test
mapping you recorded in Phase 3. Then summarize the unhappy-path / edge cases covered
(error paths, zero-activity day, malformed input, append-only, etc.) and paste the
per-changed-file coverage numbers from Phase 4. Call out any file under 80% with the
reason.}

🤖 Generated with [Claude Code](https://claude.ai/code)
EOF
)"
```

Note the PR number returned — needed for Phase 7.

---

## Phase 6 — Review Cycle

Let `MAX_CYCLES` be the review-cycle cap: **3 by default**, but if the invoking
prompt specified a maximum number of review cycles, use that value instead.

At the start of **each iteration**, emit `DEVCYCLE_PHASE: review | cycle {REVIEW_CYCLE}/{MAX_CYCLES}`.

Uses `/multi-lens-code-review`, which dispatches **four** isolated reviewer
subagents (Senior Overlord, Security/Correctness, Occam's Razor, and **Test
Adequacy**) and writes the full review to a file under `reviews/` (gitignored).
Because the heavy diff-reading and investigation happen inside those subagents,
running it keeps *this* dev-cycle context lean — only the findings come back here,
where the implementation intent lives to fix them.

Initialize `REVIEW_CYCLE=1`. Repeat up to `MAX_CYCLES` times:

### Each iteration

1. Invoke the multi-lens review, passing the issue's intent as the anchor
   so the lenses check "does this meet the issue," not just style. Do
   **not** pass `--post` — the loop produces a file to fix from, and
   posting to the PR every cycle would spam reviewers.
   ```
   /multi-lens-code-review {1-2 line summary of what this issue builds + its key acceptance criteria}
   ```
   Note the review file path it prints (`reviews/issue-{number}-multi-pass-{n}.md`).
2. Read that review file and collect all findings. The lenses bucket each
   as Critical / High / Medium / Low / Style — map to dev-cycle severity:
   - **Blocker** = Critical or High — correctness bugs, security/privacy issues,
     broken acceptance criteria, **and an untested acceptance criterion or untested
     invariant-critical path flagged High by the [TST] lens**
   - **Medium** = Medium — real issues worth fixing (including missing edge-case tests)
   - **Low / Style** = discretionary polish

   The four lenses don't dedup, so one underlying issue may appear under
   more than one prefix (e.g. `SO-2`, `SEC-1`, and `TST-1`). Treat it as a single
   finding and fix the root cause once.

   Then emit the analytics line with the **deduped** counts (0 is fine for any bucket):
   ```
   DEVCYCLE_METRIC: review_done | review_cycle={REVIEW_CYCLE} | critical={C} high={H} medium={M} low={L} style={S}
   ```
3. If there are zero Blocker findings → exit loop and go to Phase 7. Medium / Low / Style do NOT block exit. (Blockers converge reliably; Medium oscillates — chasing it to zero burns cycles and has been observed to introduce fresh blockers. The real guarantee is "merged with zero blockers.") Any unfixed Medium/Low findings are filed as follow-ups — see "On a clean exit" below.
4. **Auto-fix all Blocker findings without pausing to ask the user.** Emit `DEVCYCLE_METRIC: fix_start | review_cycle={REVIEW_CYCLE}` before your first edit. Fix in this context — you hold the implementation intent, and each finding carries the reviewer's independent reasoning. **A [TST] blocker is fixed by writing the missing test (and any code change it exposes), not by deleting or weakening the test.**
   **Medium findings are discretionary — do NOT auto-fix them broadly.** Apply a Medium fix only when it is clearly safe and self-contained (e.g. a one-line correctness tweak, or adding one missing edge-case test, in code the blocker fixes already touch). Do not refactor for Medium: broad Medium fixes spawn new findings and have introduced fresh blockers in practice. Leave everything else for the after-loop follow-up.
   Apply Low/Style at your judgment; skip if risky or out of scope. Only stop to ask the user when a fix is genuinely ambiguous, would change agreed scope, or conflicts with an acceptance criterion — otherwise keep going.
5. Commit:
   ```bash
   git add <files changed during this fix>
   git commit -m "fix(#{number}): address review findings (cycle {REVIEW_CYCLE})"
   ```
6. Run the pre-PR gate again — all three must pass:
   ```bash
   npm run build && npm test && npm run test:coverage
   ```
7. Push, then emit the fix-done metric:
   ```bash
   git push
   ```
   ```
   DEVCYCLE_METRIC: fix_done | review_cycle={REVIEW_CYCLE}
   ```
8. If `REVIEW_CYCLE < MAX_CYCLES`: increment counter, repeat from step 1
9. If `REVIEW_CYCLE == MAX_CYCLES`: exit loop

### On a clean exit — file the remaining non-blockers

When you exit because a cycle found zero Blockers, open Medium/Low findings you
intentionally left unfixed must not be dropped — file them so they're visible at
the `develop → main` promotion. (If the final cycle had no open Medium/Low findings,
skip this — there is nothing to file.)

```bash
gh pr comment {pr-number} --body "$(cat <<'EOF'
## Deferred review findings (non-blocking)

Merged with zero blockers. These Medium/Low findings from the multi-lens review
were left as follow-ups:

{list each deferred finding: stable ID, file:line, one-line headline}

Full reviews: reviews/issue-{number}-multi-pass-*.md
EOF
)"
```

If a Medium finding is substantial enough to warrant tracked work, open a GitHub
issue for it instead of (or in addition to) the comment.

### After loop — unresolved findings

If blockers remain after `MAX_CYCLES` cycles, post a PR comment:

```bash
gh pr comment {pr-number} --body "$(cat <<'EOF'
## Unresolved after {MAX_CYCLES} review cycles

The following findings were not resolved and require human review before merge:

{list each unresolved blocker}
EOF
)"
```

Then **stop and ask the user** whether to merge anyway, continue manually, or abandon.

---

## Phase 7 — Merge

Emit `DEVCYCLE_PHASE: merge` first.

Only when build + tests + coverage pass and the review loop is complete or exhausted with user approval:

```bash
gh pr merge {pr-number} --squash --delete-branch
gh issue close {number}
git checkout develop
git pull origin develop
```

`gh pr merge` merges into the PR's base, which is `develop`. `main` is left
untouched — the user merges `develop` into `main` manually at phase completion.

`gh issue close` is **required**: GitHub only auto-closes a `Closes #{number}`
issue when the PR merges into the default branch (`main`). These PRs merge into
`develop`, so the issue must be closed explicitly.

When done with this, notify user so he knows that it is merged into develop.

---

## Phase 8 — Report

**First, write a human-readable report file** so each completed task has a durable,
plain-language record (the JSONL analytics are for the runner; this is for people).
`Write` it to `reports/issue-{number}.md`, overwriting if it exists, using this template
— fill every section from what you actually did this run:

```markdown
# Issue #{number} — {title}

- **PR:** #{pr} — {url}
- **Branch:** feature/issue-{number}-{slug}
- **Merged to:** develop on {YYYY-MM-DD}
- **Review:** {N} cycle(s) · {B} blocker(s) fixed · {M} medium finding(s) deferred
- **Status:** {merged | merged with unresolved blockers (see below) | stopped for human}

## What was built
{2–5 plain-language bullets describing the actual change — what now works that didn't before}

## Acceptance criteria
{copy each criterion from the issue, prefixed - [x] (met) or - [ ] (not met, with why)}

## Key files changed
{the handful of files that matter, each with a one-line "what changed and why"}

## Review outcome
- **Blockers fixed:** {one line per Critical/High finding fixed, with its stable ID — or "none"}
- **Deferred (non-blocking):** {Medium/Low left as follow-ups, with stable IDs — or "none"}
- **Unresolved blockers:** {any escalated to human — or "none"}
- Full reviews: `reviews/issue-{number}-multi-pass-*.md`

## How it was tested
{the criterion → test mapping, the unhappy-path / edge cases covered, the per-changed-file
coverage numbers, and any manual verification}
```

Keep it factual and concise — it should let someone understand what shipped without opening
the diff. (`reports/` can be committed as project history or gitignored — your choice.)

**Then tell the user:**
- Issue number and title
- PR number and URL
- How many review cycles were used, blockers fixed, medium deferred
- Any unresolved findings that were noted
- The report path: `reports/issue-{number}.md`
- "Ready to move to the next issue?"

---

## Error handling

| Situation | Action |
|-----------|--------|
| `gh` not found | Stop. Tell user to run `winget install --id GitHub.cli` then `gh auth login` |
| `npm run test:coverage` script missing | Coverage tooling isn't wired up. Stop and tell the user — do not skip the coverage gate silently. |
| Build fails in Phase 4 after 3 fix attempts | Stop and report — do not open PR |
| Test or coverage fails in Phase 6 after a fix | Revert the fix commit, note the regression, continue with remaining findings |
| Merge conflict on develop | Rebase: `git fetch origin && git rebase origin/develop`, resolve, re-run gate |
