---
name: dev-cycle-phases
description: |
  Full development cycle for a single GitHub issue: read issue → create branch → implement →
  build + test + coverage → open PR → code review loop (max 3x) → merge → report done.
  Identical to dev-cycle, but emits DEVCYCLE_PHASE: markers at each phase boundary so a
  supervising runner (tr-harness.ps1) can show live phase state.
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

Mode flags (see **Run modes** below) select stacked-epic batching:
- `/dev-cycle-phases 153 --epic-branch epic/issue-151-browse-ui --epic-issue 151` — build child 153 onto the epic branch.
- `/dev-cycle-phases 151 --finalize-epic 153,154,155,156 --epic-branch epic/issue-151-browse-ui` — review the whole stack and land it.

---

## Run modes

This skill runs in one of three modes, chosen by the invocation flags. **Default
mode** (no mode flags) is the original standalone-issue flow in Phases 1–8 below and
is **unchanged** — use it for any normal, non-epic issue.

The other two modes implement **stacked-epic batching**: an epic's children are each
built on a shared epic integration branch (cheap per-child gate, no review loop,
nothing merged to develop), then the epic runs the full multi-lens review **once** on
the whole stack and lands it in a single PR to develop. This removes the per-child
review/PR overhead while keeping develop free of un-reviewed code.

> **When `--epic-branch` or `--finalize-epic` is present you are in a non-default
> mode. The per-phase deltas in this section OVERRIDE the default Phase 2/3/5/6/7
> behavior below.** Most dangerously: a child must never branch off develop or merge
> to develop, and a child issue must never be closed by the child run.

### Flags

| Flag | Mode | Meaning |
|------|------|---------|
| `--epic-branch <name>` (without `--finalize-epic`) | **subtask** | This issue is a child of an epic. Stack it on `<name>`; do **not** PR to develop, do **not** close the issue. |
| `--epic-issue <N>` | subtask | The parent epic's issue number, for context resolution. |
| `--fast-lens <on\|off>` | subtask | Run the single-lens SEC quick pass after the gate. Default **on**. |
| `--finalize-epic <csv>` | **epic-finalize** | This issue is the epic. Its children (`<csv>`, e.g. `153,154,155,156`) are already stacked on `--epic-branch`; review the whole stack, PR to develop, merge, close the epic **and** every child. |

The scheduling script owns the epic-branch **name** and passes it in. When testing this
skill by hand, use `epic/issue-{epic-number}-{slug}`.

### Subtask mode — `--epic-branch <name>` (no `--finalize-epic`)

Build one child on the epic branch. Deltas from the default flow, by phase:

- **Phase 1 (read):** unchanged, but resolve the **epic** (`--epic-issue`) in full for
  its cross-cutting acceptance criteria. Read sibling children only where this child
  explicitly references them (per the existing epic/sibling resolution rules).
- **Phase 2 (branch):** stack on the epic branch — do **not** branch off develop.
  ```bash
  EPIC_BRANCH="<name>"          # passed via --epic-branch
  # First child creates the epic branch off develop; later children reuse it.
  if ! git rev-parse --verify "$EPIC_BRANCH" >/dev/null 2>&1; then
    git checkout develop && git pull origin develop
    git checkout -b "$EPIC_BRANCH"
  else
    git checkout "$EPIC_BRANCH"
    git pull --ff-only 2>/dev/null || true
  fi
  git checkout -b feature/issue-{number}-{slug}    # child branch OFF the epic branch
  ```
  Resume: if a merge commit for this child already exists on the epic branch
  (`git log "$EPIC_BRANCH" --grep "merge(#{number})"`), the child is already done —
  skip to the success sentinel.
- **Phase 3 (implement):** unchanged.
- **Phase 4 (build+test):** unchanged — the **full** gate (build + test + coverage)
  still runs per child. A child that breaks the build or drops a new file to 0% does
  not advance.
- **Fast lens (replaces Phase 6 for children; only if `--fast-lens on`):** emit
  `DEVCYCLE_PHASE: review | fast SEC`. Dispatch a **single** Security/Correctness
  reviewer subagent over this child's diff
  (`git diff $(git merge-base "$EPIC_BRANCH" HEAD)..HEAD`) using the `[SEC]` lens prompt
  from `/multi-lens-code-review` — **one pass only, no cycles, not the full four lenses.**
  Fix only **Critical/High** findings here (you hold the implementation intent — "fix
  while hot"), then re-run the gate. Medium/Low are deferred to the epic review. Keep
  this deliberately cheap; it is a safety net, not the real review.
- **Phase 5 (pr):** **skipped.** A child never opens a PR to develop.
- **Phase 7 (merge):** merge the child into the **epic branch** — never develop —
  keeping a merge commit for history, and do **not** close the issue:
  ```bash
  git checkout "$EPIC_BRANCH"
  git merge --no-ff feature/issue-{number}-{slug} \
    -m "merge(#{number}): {slug} into ${EPIC_BRANCH}"
  git branch -d feature/issue-{number}-{slug}
  git push origin "$EPIC_BRANCH" 2>/dev/null || true   # only if the epic branch is tracked
  ```
  The child issue stays **open** — epic-finalize closes it.
- **Phase 8 (report):** skip the per-issue report file (the epic writes one report
  covering all children). Still end with the `DEVCYCLE_OK` / `DEVCYCLE_FAIL` sentinel so
  the runner can sequence the next child.

Markers emitted in subtask mode: `read`, `branch`, `implement`, `build+test`,
(`review | fast SEC`), `merge`. `pr` is **not** emitted.

### Epic-finalize mode — `--finalize-epic <csv> --epic-branch <name>`

Every child is already stacked on `<name>`. Review the whole epic and land it.

- **Phase 1 (read):** read the **epic** issue in full **and** each child's
  title + acceptance criteria. The combined acceptance set = every child's criteria +
  the epic's cross-cutting criteria; this is what the review anchors on.
- **Phase 2 (branch):** check out the **existing** epic branch (do not create it):
  `git checkout "$EPIC_BRANCH" && git pull --ff-only 2>/dev/null || true`.
- **Phase 3 (implement):** usually **skipped** — the epic is an umbrella and its code is
  the children. Implement only if the epic issue itself carries acceptance criteria that
  no child owns.
- **Phase 4 (build+test):** run the full gate on the **integrated** epic branch. The
  coverage gate applies to every file the epic diff (vs develop) adds or changes.
- **Phase 5 (pr):** open the **single** PR for the whole epic. List `Closes #` for the
  epic **and every child** so the PR documents the full set:
  ```bash
  gh pr create --base develop \
    --title "feat(#{epic}): {epic title}" \
    --body "$(cat <<'EOF'
  Closes #{epic}
  Closes #{child1}
  Closes #{child2}
  ...

  ## Summary
  {one bullet per child: what it added}

  ## Acceptance Criteria
  {combined: every child's criteria + the epic's cross-cutting criteria, - [x] each}

  ## Test plan
  {per-child criterion -> test mapping + per-changed-file coverage for the whole stack}

  🤖 Generated with [Claude Code](https://claude.ai/code)
  EOF
  )"
  ```
- **Phase 6 (review):** the **full four-lens loop**, exactly as the default Phase 6, but
  the diff under review is the entire stack (`merge-base develop..$EPIC_BRANCH`). Run up
  to `MAX_CYCLES`, fix blockers on the epic branch, and emit the same
  `DEVCYCLE_METRIC:` lines. Anchor on the combined epic + children intent.
- **Phase 7 (merge):** squash-merge the epic PR to develop, then close the epic **and
  every child** (the `Closes #` lines don't auto-fire — this merges to develop, not main):
  ```bash
  gh pr merge {epic-pr} --squash --delete-branch
  for n in {epic} {children…}; do gh issue close "$n"; done
  git checkout develop && git pull origin develop
  ```
- **Phase 8 (report):** write `reports/issue-{epic}.md` for the whole epic — one
  "What was built" subsection per child, the combined acceptance criteria, and the
  single review outcome.

Markers emitted in epic-finalize mode: `read`, `branch`, (`build+test`), `pr`,
`review | cycle n/m`, `merge`. `implement` is usually **not** emitted.

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
- No markdown around the marker: no backticks, no bold, no code fence. The line must
  start with the literal characters `DEVCYCLE_PHASE:`. (This doc renders markers as
  inline code for readability — do not copy the backticks.)
- For the review loop (Phase 6), print the marker at the start of **each** iteration and
  append the cycle number as a detail after a pipe:
  `DEVCYCLE_PHASE: review | cycle 2/3`
- On a resume, emit the marker for whatever phase you actually resume into, even if it is
  not `read` — the runner expects phases to be able to jump.
- In **subtask** and **epic-finalize** modes some phases are skipped or reordered (see
  **Run modes**). Emit only the markers your mode actually runs — the runner tolerates a
  subset and out-of-order jumps; it never requires the full `read…merge` sequence.
- These markers are in addition to, and never replace, the final `DEVCYCLE_OK` /
  `DEVCYCLE_FAIL` result line. Never print a phase marker on the very last line.

---

## Analytics reporting (REQUIRED in Phase 6)

In addition to the phase markers, emit `DEVCYCLE_METRIC:` lines during the review
loop so the supervising runner can record findings counts and split review time
from fix time. Each on its own line, plain assistant text, exactly in these forms:

```
DEVCYCLE_METRIC: review_done  | review_cycle=N | critical=C high=H medium=M low=L style=S
DEVCYCLE_METRIC: fix_start    | review_cycle=N
DEVCYCLE_METRIC: fix_done     | review_cycle=N
DEVCYCLE_METRIC: dispositions | review_cycle=N | fixed=F rejected_intentional=RI rejected_wrong=RW deferred=D
```

- `review_done` — print **once per cycle**, right after you have read the review
  file and bucketed its findings (Phase 6 step 2). Use the actual counts from the
  review (0 is fine for any bucket). `N` is the current review cycle number. The
  counts are **across all four lenses** (SO, SEC, OR, TST) — a Test-Adequacy
  finding ranked High folds into `high=`, and so on.
- `fix_start` — print right before you begin editing files to fix findings.
- `fix_done` — print right after the cycle's `git push` succeeds.
- `dispositions` — print **once per cycle**, after you have decided the fate of
  every deduped finding: right after `fix_done`, or right after `review_done` when
  the cycle has no fix pass. The four counts cover ALL of the cycle's deduped
  findings and must sum to the same total as `review_done`'s buckets:
  - `fixed` — the finding led to a code/test change in this cycle.
  - `rejected_intentional` — the flagged code is deliberately structured that way
    because of a real, **verifiable** constraint (a library limitation, an
    architectural rule in CLAUDE.md, an acceptance criterion). Name the constraint
    in your prose before emitting the line — "I meant to do it" is not a constraint.
  - `rejected_wrong` — the reviewer's claim is factually incorrect, and you
    verified that against the code, not from memory.
  - `deferred` — real but non-blocking; intentionally left as a follow-up (the
    Medium/Low findings you file on exit).
  Be honest. These counts exist to measure whether context-blind reviewers produce
  false positives (`rejected_*`); classifying "couldn't be bothered" as a rejection
  poisons that signal — when in doubt between `deferred` and `rejected_*`, it is
  `deferred`.
- Skip `fix_start`/`fix_done` for any cycle with zero Blocker findings (you exit
  without a blocker-fix pass — emit only `review_done` + `dispositions`). Medium is
  no longer auto-fixed, so a Medium-only cycle also emits just those two.
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

### Epic & sibling context resolution (REQUIRED when the issue references them)

From the epic-and-subtask trackers (Phase 6+), a child issue inherits context **by
reference** rather than restating it. Resolve those references before summarizing:

1. **Epic parent — always, in full.** If the issue body contains an `Epic: #NN` line
   (or otherwise names a parent epic issue), fetch it and read it completely:
   ```bash
   gh issue view NN --comments
   ```
   The epic carries the shared mental model and the **cross-cutting acceptance
   criteria** that apply to every child — treat those as additional acceptance
   criteria for this issue.

2. **Referenced siblings — selectively, compactly.** Scan this issue's body for
   explicit references to sibling tasks (e.g. `6.1.5`, `6.2.6`, or a bare `#NN`
   pointing at another child of the same epic — phrases like "via the 6.1.2 gate",
   "uses 6.1.5 search", "stored in practice_metric_pins (6.2.1)"). For each one that
   is named, fetch it but read only its **title + Scope + Acceptance Criteria** — you
   need its contract, not its whole body:
   ```bash
   gh issue view NN --json title,body
   ```
   - For siblings **already merged**, the codebase is the source of truth — lean on
     Phase 3's code exploration for their actual shape; the issue just tells you which
     module to go read.
   - For siblings **not yet built** that this task must anticipate (a hook to leave, a
     contract to honor), the issue is the only source — capture what this task must
     provide for them.

3. **Do NOT fetch every sibling of the epic** — only the ones this issue actually
   names. Pulling an epic's full child set into context bloats the run and has been
   observed to make runs loop; targeted-by-reference keeps it lean.

Cross-reference with `Additional_Tasks_Git_Providers.md` for the matching task section, **and read the corresponding section of the relevant phase design document** (e.g. `dev-docs/Phase2_Design_Document.md`, or the design doc named by the issue's phase) for the detailed design (architecture, data shapes, component breakdown, decisions) behind this issue. Summarize what will be built and list the acceptance criteria explicitly **(including the epic's cross-cutting criteria and any sibling contracts you must honor)** before writing any code. If anything is ambiguous, ask before starting.

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

### Review-KB pitfalls (REQUIRED — do this before writing code)

Pull the lessons distilled from past code reviews for the area you are about to
touch, so you avoid repeating findings the reviewers already caught once. From the
acceptance criteria and design doc, identify the module globs this issue will touch
(e.g. `src/practices/**`, `src/dashboard/api/**`), then run:

```bash
node scripts/kb/retrieve.mjs --paths "<comma-separated globs you will touch>" --top 8
```

Treat each printed pitfall as a hard constraint on your implementation — these are
recurring, real findings from this codebase, not generic advice. If the output is the
empty marker (`<!-- review-KB: no relevant active lessons -->`), there's nothing
relevant; proceed. (Graduated rules are already in your context via `CLAUDE.md`'s
import of `dev-docs/review-rules.md`, so this step only surfaces the *area-specific*
active lessons that haven't graduated.)

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

   Toprope-specific cases that must be tested when the code touches them: a
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
   Before leaving the loop, adjudicate each deduped finding (see the `dispositions`
   definition under Analytics reporting) and emit:
   ```
   DEVCYCLE_METRIC: dispositions | review_cycle={REVIEW_CYCLE} | fixed=0 rejected_intentional={RI} rejected_wrong={RW} deferred={D}
   ```
4. **Auto-fix all Blocker findings without pausing to ask the user.** Emit `DEVCYCLE_METRIC: fix_start | review_cycle={REVIEW_CYCLE}` before your first edit. Fix in this context — you hold the implementation intent, and each finding carries the reviewer's independent reasoning. As you work through the findings, track each one's disposition (`fixed` / `rejected_intentional` / `rejected_wrong` / `deferred`) — you will report the counts after the push. When you reject a finding, state the verifiable constraint or the factual error in your text at the moment you decide it. **A [TST] blocker is fixed by writing the missing test (and any code change it exposes), not by deleting or weakening the test.**
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
7. Push, then emit the fix-done metric and the cycle's dispositions (counts across
   ALL deduped findings, summing to `review_done`'s total):
   ```bash
   git push
   ```
   ```
   DEVCYCLE_METRIC: fix_done | review_cycle={REVIEW_CYCLE}
   DEVCYCLE_METRIC: dispositions | review_cycle={REVIEW_CYCLE} | fixed={F} rejected_intentional={RI} rejected_wrong={RW} deferred={D}
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

### Distill review findings into the knowledge base (REQUIRED)

Feed this run's review findings back into the KB so future implementations avoid them.
You already hold every blocker you fixed this cycle (Phase 6) plus the deferred
Medium/Low findings — that *is* the input; you do not need to re-read the review files,
though `reviews/issue-{number}-multi-pass-*.md` is there if you want to confirm wording.

1. See what the KB already knows so you merge instead of duplicating:
   ```bash
   node scripts/kb/catalog.mjs
   ```
2. For each **generalizable** finding from this issue (a rule a future implementer
   could follow — skip one-off, issue-specific nits and pure style), build one JSON
   item. If it matches an existing lesson from the catalog, set `match_id` to that
   lesson's id (this increments its recurrence); otherwise omit `match_id` to create a
   new candidate. Write the array to a temp file:
   ```json
   [
     {
       "match_id": "<existing-lesson-id, or omit for a new one>",
       "title": "<short canonical name>",
       "category": "security|correctness|over-abstraction|performance|testing|data-integrity|determinism|api-contract",
       "rule": "<terse imperative generalizable rule>",
       "rationale": "#{number}: <what actually went wrong>",
       "severity": "critical|high|medium",
       "source_issue": {number},
       "file_globs": ["<globs for the area this issue touched>"]
     }
   ]
   ```
3. Apply it:
   ```bash
   node scripts/kb/apply.mjs --in <temp-file>.json
   ```
   A finding that recurs across 2+ issues auto-promotes to **active** and starts
   surfacing to the implementer (Phase 3). Promotion to the always-loaded cold path is
   a separate human-gated step (`node scripts/kb/graduate.mjs --list`) — do **not**
   graduate from the skill.
4. Commit the updated store so the KB persists:
   ```bash
   git add dev-cycle-analytics/review-lessons.jsonl
   git commit -m "chore(#{number}): distill review findings into KB" && git push
   ```
   (If this run found zero generalizable findings — a clean review — skip this section.)

See `dev-cycle-analytics/REVIEW_KB.md` for the full lifecycle.

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
