---
description: >-
  Multi-lens code review of the current branch's changes for Toprope.
  The parent captures the diff once and dispatches four independent
  reviewer subagents in parallel — Senior Overlord, Security/Correctness,
  Occam's Razor, Test Adequacy — each with an isolated, diff-only context,
  then concatenates their sections into a single file in /reviews. With
  --post, it also publishes a summary + inline findings to the branch's
  GitHub PR. Diff scope is merge-base against a configurable base branch.
argument-hint: "[anchor: what this change does and why — the bug/issue/feature being addressed] [--base <branch> (default: develop)] [--post (publish to the GitHub PR)]"
---

# Multi-Lens PR Review

## How this command works

Parallel, isolated review. The parent orchestrator captures the diff
once, dispatches four independent subagents — one per lens — and
concatenates their returned sections into a single file. Toprope is a
single Node/TypeScript repo on GitHub, so there is one diff to review
and (optionally) one PR to post to.

Phases:

1. **Initialize** — parse `--base`/`--post`, extract issue number from
   the branch, resolve merge-base, capture the diff once to a gitignored
   temp file, decide the output filename. The parent does **not** read
   the diff into its own context.
2. **Four lens subagents (parallel)** — dispatch SO, SEC, OR, TST as four
   independent subagents in one message. Each gets only the diff file
   path and its lens prompt, reads the diff itself, and returns its
   composed markdown section.
3. **Single Write** — concatenate the four returned sections and write
   the entire review file in one tool call.
4. **Post (only if `--post`)** — publish one GitHub review: a summary
   body plus one inline comment per finding that maps to a diff line.
5. **Finish** — delete the temp diff file, print the path (and PR URL if
   posted).

**Cross-lens isolation is real, not approximated.** Each lens runs in
its own subagent with a fresh context containing only the diff and its
disposition — no subagent can see another's findings. Independent reads
converging on the same line is real triangulation signal. The parent
never holds the diff text; it only assembles the sections the subagents
return.

## Operational rules (apply throughout)

These keep cost predictable. They are operational, not editorial.

1. **Read the diff in full, never truncated — inside each subagent.**
   The parent captures the diff once to a file and passes the path; each
   subagent reads it in full. Do not slice by file. Do not skip
   sections. See *Reading large diffs* at the bottom for the chunking
   protocol when a diff exceeds the Read cap.
2. **The parent never reads the diff into its own context.** It captures
   to disk via a Bash redirect and hands subagents the path only. The
   parent context holds only the four returned sections.
3. **One Write at the end.** Concatenate the four returned sections and
   write in one tool call in Phase 3. No header-first pattern, no `Edit`
   ceremony per lens.
4. **No task-list plumbing.** A short pipeline does not need
   `TaskCreate`/`TaskUpdate`. Track progress in your reasoning.
5. **Batch independent tool calls.** In Phase 1 the git commands are
   independent — fire them in a single message. In Phase 2 the four
   subagents are independent — dispatch them in a single message.
6. **Use the Bash tool for git/gh.** The snippets below are bash (the
   Bash tool runs git-bash on this Windows host, so `$(...)` and standard
   POSIX tools work). Do not translate them to PowerShell.

## Investigation policy

**Read surrounding files when judgment requires context the diff
doesn't show.** Function bodies referenced but not changed, sibling
connectors the diff diverges from, the SQLite schema/migrations a query
depends on, related tests. These reads catch the cross-file findings —
"this connector races with the aggregation job," "this endpoint leaks
individual data into a team response," "this snapshot write isn't
append-only," "this exported function has no test." They are the most
valuable findings the lenses produce.

**Anchor verification.** Treat the anchor as a position the diff
defends, not a checklist it satisfies. If a clause appears unaddressed,
do one targeted read (`grep -n` + narrow `Read`) to confirm the gap or
confirm existing code already satisfies it. If `$ARGUMENTS` is empty (no
anchor), reconstruct intent from the linked issue, commit messages, and
the diff, and note in the output header that no anchor was provided.

What this is *not* license for: speculative reading of everything
`grep` surfaces, or reading the same file three times when one read
would do. A lens should read what a *finding genuinely depends on*. If
you find yourself reading without a finding in mind, stop and reason
from the diff first.

Use `offset`/`limit` for targeted reads. `grep -n` then a narrow `Read`
is usually cheaper than a full-file read.

## Phase 1 — Initialize

Batch the independent commands into a single message.

**Parse flags from `$ARGUMENTS`.**
- If `$ARGUMENTS` contains `--base <branch>`, set `$BASE_BRANCH` to that
  value and strip the token. Otherwise `$BASE_BRANCH=develop`.
- If `$ARGUMENTS` contains `--post`, set `$POST=1` and strip the token.
  Otherwise `$POST=0`.
- The remaining text is the anchor.

**Extract the issue number** (for the filename and PR linkage only, not
for diff scoping). Toprope branches are `feature/issue-{n}-{slug}`:

    BRANCH=$(git rev-parse --abbrev-ref HEAD)
    ISSUE=$(echo "$BRANCH" | grep -oE 'issue-[0-9]+' | grep -oE '[0-9]+' | head -1)

If no issue number is found, proceed and use a timestamp filename.

**Resolve the merge-base:**

    BASE_SHA=$(git merge-base "$BASE_BRANCH" HEAD 2>/dev/null)

If `merge-base` fails, **abort** with an error naming `$BASE_BRANCH`. No
silent fallback. (If the repo has no commits yet, there is nothing to
review — say so and stop.)

Diff scope:
- `BASE_SHA != HEAD` → committed diff is `git diff $BASE_SHA..HEAD`
- Plus uncommitted: `git diff HEAD` (always)

If there is no committed diff and no uncommitted changes, print
`Nothing to review — HEAD matches base and there are no uncommitted changes.`
and stop.

**Capture the diff once to a gitignored temp file at the repo root.**
Use an absolute, repo-rooted path so the subagents (which share the
working directory) resolve it unambiguously. Do **not** read the diff
into the parent context:

    DIFF="$(git rev-parse --show-toplevel)/.review-diff.patch"
    { git diff "$BASE_SHA"..HEAD; git diff HEAD; } > "$DIFF"

`.review-diff.patch` is gitignored. The parent holds only `$DIFF` (the
path); the diff content stays on disk until the subagents read it.

**Determine the output path:**

    mkdir -p reviews
    if [ -n "$ISSUE" ]; then
      HIGHEST=$(ls reviews/issue-${ISSUE}-multi-pass-*.md 2>/dev/null \
                  | grep -oE 'multi-pass-[0-9]+' | grep -oE '[0-9]+' \
                  | sort -n | tail -1)
      N=$((${HIGHEST:-0} + 1))
      OUTPUT=reviews/issue-${ISSUE}-multi-pass-${N}.md
    else
      OUTPUT=reviews/multi-pass-review-$(date +%s).md
    fi

**Do not write the review file yet, and do not read the diff.** Phase 2
subagents read the diff and return sections; Phase 3 writes once.

## Phase 2 — Four lens subagents (parallel, isolated)

Dispatch four independent subagents — one per lens — in a **single
message** (one `Agent` call each, `subagent_type: general-purpose` so
each has Read + Bash + Grep for the investigation policy). They run in
parallel with fully isolated contexts; no subagent can see another's
findings, so isolation is structural — there is no "approach the diff
fresh" instruction to give.

Each subagent prompt must be self-contained. Build it by including,
verbatim:

- **The diff location:** "Read the review diff in full from
  `<the absolute $DIFF path>`. It contains the committed diff
  (`base..HEAD`) followed by the uncommitted diff (`HEAD`). Read it in
  full before reviewing — if it exceeds the Read cap, chunk it with
  `offset`/`limit` per the protocol below. Do not slice by file or skip
  sections."
- **The anchor:** the one-line `$ARGUMENTS` restatement (or "no anchor
  provided").
- **The context:** the base branch, and that this is the Toprope repo
  (so the subagent can apply the investigation policy against the real
  working tree).
- **The lens prompt** for that subagent's lens, copied verbatim from the
  lens definitions below — Lens 1 → SO subagent, Lens 2 → SEC subagent,
  Lens 3 → OR subagent, Lens 4 → TST subagent.
- **The investigation policy** (the *Investigation policy* section
  above), copied in so the subagent reads surrounding files when a
  finding genuinely depends on them, verifies the anchor holistically,
  and does not speculatively read everything `grep` surfaces.
- **The chunking protocol** from *Reading large diffs* at the bottom.
- **The common output structure** (below), with the correct prefix
  (`SO`/`SEC`/`OR`) and stable IDs.
- **The output instruction:** "Return ONLY your lens section as
  markdown, in the exact structure given. Do not write any file. No
  preamble — your entire final message is the section."

**Do not cap findings.** Report every Critical, High, Medium, and
Low/Style finding the disposition surfaces. If a bucket has no findings,
write `_None._` under the heading.

### Common per-lens output structure

```markdown
## [<PREFIX>] <Lens Name>

Anchor: <one-line restatement of $ARGUMENTS or "no anchor provided">

### Critical
#### <PREFIX>-1. <one-sentence headline>
<body — file:line citations, evidence, recommendation>

### High
…

### Medium
…

### Low / Style
…

### Net assessment
<2–3 sentences>

---
```

Stable IDs (`SO-1`, `SEC-1`, `OR-1`, `TST-1`, …) are required so the
reader can cross-reference and so Phase 4 can attach each finding to a
PR line.

### Lens 1: [SO] Senior Overlord

You are the senior engineer who will own this code after merge. You'll
explain it to whoever inherits it next. You're not arguing the change
shouldn't happen — that's someone else's job. You're asking: *given that
this is going in, what will I regret?*

Read with that ownership in mind. What's the asymmetry between this code
and similar code elsewhere — does this connector handle pagination/rate
limits the way the others do? What error gets swallowed and surfaces
three releases later as an inexplicable gap in the snapshots? Where does
the test coverage make you feel safe versus where does it just exist?
What edge case is unhandled because the author tested the happy path —
empty API response, missing developer, a day with zero activity, a CSV
row with a malformed amount?

Mind the Toprope invariants: daily snapshots are the atomic unit and
**append-only** (never mutate history); all timestamps are UTC ISO; data
quality is tagged per point (high/medium/low). A change that quietly
breaks one of these is exactly the kind of thing you'll regret owning.

Focus on changes introduced by this diff. Note pre-existing issues only
if the diff makes them materially worse. Anchor on `$ARGUMENTS`: does the
diff actually address the reported scenario, or something adjacent the
author confused for it?

If the code is genuinely solid, say so plainly. Don't manufacture
findings. A clean SO pass is information.

### Lens 2: [SEC] Security & Correctness

You are reviewing for security and data-correctness defects specific to
this codebase. Assume the change ships; your job is to find the way it
mishandles untrusted input, leaks data, or corrupts state.

Work through these axes against the diff:

- **Boundary validation.** Every external input is suspect: CSV expense
  rows, YAML config, connector API responses (Copilot/Claude Code/
  Windsurf), and inbound REST API params. Is input validated and typed
  at the boundary, or trusted into the core? Unparsed numbers, dates,
  enums?
- **Injection & traversal.** SQLite access via better-sqlite3 must use
  parameterized statements — flag any string-built SQL. Watch for path
  traversal in config/CSV file loading and SSRF in connector base URLs.
- **Secrets.** The three API tokens (and any expense data) must not be
  logged, echoed in errors, returned by an endpoint, or written into
  snapshots. Flag tokens passed through error messages or debug output.
- **Privacy model (hard constraint).** Individual developer data is
  visible only to that developer; managers see **team aggregates only**.
  Flag any endpoint, query, or serializer that lets individual rows
  escape into a team/aggregate response, or that returns another
  developer's data.
- **Append-only / snapshot integrity.** Flag any write that UPDATEs or
  DELETEs historical snapshots rather than appending. One row per
  developer per day per tool — flag paths that can produce duplicates or
  clobber a day.
- **TypeScript strictness.** Per project rules: no `any` (use `unknown`
  + narrowing), explicit return types on exported functions, no unsafe
  casts that paper over a real shape mismatch. Verify discriminated-union
  `switch` statements are exhaustive (a `const _: never = x` guard in the
  `default`) — unless the `default` is a deliberate, documented fail-closed
  branch (e.g. an auth/role gate that must deny unrecognized values), in
  which case a `never` guard would be wrong; don't flag it.

Cite concrete `file:line`. A theoretical risk with no path to it in this
diff is a Low, not a Critical — rank by exploitability/likelihood given
the actual code. If the diff is clean on these axes, say so.

### Lens 3: [OR] Occam's Razor

Assume the change needs to happen. Find complexity inside the diff that
the problem didn't require — extra abstractions, premature
generalization, defensive code for cases that can't occur, parameters
nobody passes, config knobs with one caller, parallel branches that
could collapse to a single expression, a new connector helper that
duplicates an existing one. If a simpler implementation resolves the
same issue with less new code or less architectural change, name it
concretely with the collapsed form. If the change is already minimal and
well-targeted, say so.

Anchor on `$ARGUMENTS`: does the diff fix the reported scenario, or does
it fix more than was asked?

### Lens 4: [TST] Test Adequacy

You are reviewing whether the tests in this change actually *prove* the
code is correct — not whether tests exist, but whether they would catch
the regressions that matter. Assume the implementation ships; your job is
to find where a future bug slips through a green test suite.

Work through these axes against the diff (read the test files **and** the
source they cover — a test's adequacy is only judgeable against the code
it claims to exercise):

- **Per-criterion coverage.** Treat the anchor as the list of behaviors
  this change promises. Does each one have at least one test that would
  **fail if that behavior regressed**? A promised behavior with no
  failing-on-regression test is a gap, not a nitpick.
- **Untested branches & paths.** Error paths, `catch` blocks, early
  returns, and discriminated-union arms the diff adds that no test
  exercises. New source with zero covering test is the strongest finding.
- **Toprope edge cases.** When the changed code touches them, these must
  be tested: a zero-activity day, a missing/unknown developer, a
  malformed CSV amount or date, an empty or paginated connector API
  response, a duplicate-day write (append-only must hold), and UTC date
  boundaries.
- **Assertion strength.** Tests that call the code but assert only
  truthiness, a snapshot, or the mock itself are false confidence — worse
  than no test. Flag any test that cannot fail for the right reason.
- **Coupling & determinism.** Tests coupled to implementation detail that
  will break on a harmless refactor; shared mutable state across tests;
  real network/clock/filesystem where it should be faked; time/random/
  order dependence that makes a test flaky.

Severity rubric (calibrate deliberately — this lens feeds an auto-fix
loop, so over-ranking burns cycles):
- **Critical/High** — an acceptance criterion has no test that proves it;
  an error path or an invariant-critical branch (append-only, the privacy
  model, snapshot integrity) is entirely untested; new logic's only
  coverage is a test that asserts nothing.
- **Medium** — a meaningful edge case is untested while the happy path is
  solid; present-but-weak assertions on secondary logic.
- **Low / Style** — test naming, structure, minor duplication.

Cite concrete `file:line` for both the test and the source line it should
cover. Don't demand tests for trivial glue, pure type declarations, or
generated code. If the tests are genuinely thorough, say so plainly — a
clean TST pass is real signal, not a reason to manufacture findings.

## Phase 3 — Single Write

Concatenate the four sections returned by the subagents — **SO, then
SEC, then OR, then TST** — under the header below. Assembly is mechanical:
do not edit, dedup, re-rank, or merge findings across sections. If a
subagent failed to return a usable section, note that inline under that
lens's heading rather than dropping the lens silently. Full file content:

```markdown
# Review (multi-lens) — issue #<ISSUE or "uncommitted"> — iteration <N>

**Branch:** <branch>
**Base:** <BASE_BRANCH> (<default | --base override>)
**Committed:** <yes/no>  **Uncommitted:** <yes/no>
**Anchor:** <one-liner from $ARGUMENTS, or "no anchor provided">
**Date:** <YYYY-MM-DD>

---

<SO section>

<SEC section>

<OR section>

<TST section>
```

Then call `Write` **once** with that content to `$OUTPUT`.

## Phase 4 — Post to GitHub (only if `$POST=1`)

Skip this entire phase unless `--post` was passed. Publishing a review
is team-visible — `--post` is the user's authorization to do it.

The parent did not read the diff in Phase 1. To decide which findings
map to changed lines (inline) versus not (body), read `$DIFF` now — it
is still on disk until Phase 5. The retry-on-rejection step below is the
backstop if a line is misjudged.

**Find the PR for the current branch:**

    PR=$(gh pr view --json number -q .number 2>/dev/null)

If there is no PR for this branch, print
`No open PR found for <branch>; review written to <OUTPUT> but not posted.`
and skip to Phase 5. Do not create a PR.

**Build one review payload.** Compose `review.json` in working memory and
write it with the `Write` tool, then post it with a single `gh api` call.
Structure:

```json
{
  "commit_id": "<git rev-parse HEAD>",
  "event": "COMMENT",
  "body": "<summary: one line per lens net-assessment, plus any finding whose location is NOT in the diff>",
  "comments": [
    { "path": "src/...", "line": <n>, "side": "RIGHT", "body": "[SEC-1] <headline>\n\n<short body + recommendation>" }
  ]
}
```

Rules for the payload:
- `event` is always `COMMENT` — never auto-approve and never
  auto-request-changes. The human decides the verdict.
- One inline comment per finding **whose `file:line` falls on a line
  present in this PR's diff** (added/changed lines, `side: RIGHT`).
  Inline comments on lines outside the diff are rejected by the API —
  put those findings in `body` instead, each tagged with its stable ID
  and `file:line`.
- Keep each inline body short: the stable ID, the headline, and the
  recommendation. The full reasoning lives in `$OUTPUT`.
- The `body` should open with a one-line pointer: `Full multi-lens
  review committed to \`<OUTPUT>\`.`

**Post it once:**

    gh api repos/{owner}/{repo}/pulls/$PR/reviews --input review.json

(`{owner}`/`{repo}` are substituted automatically by `gh` from the
current repo.) If the call fails because a comment targets a line not in
the diff, move that finding to `body` and retry once.

## Phase 5 — Finish

Delete the temp diff file (also remove it on any earlier abort path):

    rm -f "$DIFF"

Print:

    Review complete — issue #<ISSUE or "uncommitted"> — multi-lens, iteration <N>
    File: <OUTPUT>

If posted, add:

    Posted to PR #<PR>: <gh pr view --json url -q .url>

No index, no consolidated findings list, no terminal echo of the file.
The file is the artifact; the human reads it.

---

## Reading large diffs (footnote)

The Read tool has a ~25K-token cap per call. For diffs that exceed it,
read the diff file at the path you were given with `limit=1000` (≈1000
patch lines at ~22 tokens/line). If the Read truncates, continue with `offset=1001,
limit=1000`, then `offset=2001`, until the diff is exhausted. Do not run
`wc -l` to pre-measure; just read until done. The invariant is "read the
diff in full" — chunking is the implementation, not the rule.
