# Developer coaching

Coaching is GovProxy's differentiator and the heart of Phase 5. It turns the
platform from a *measurement* tool into a *capability-building* one: a private
mirror that helps developers get better at AI-assisted work, while managers see
only team-level patterns.

The governing rule, enforced everywhere in this chapter:

> **Individual coaching signals are private to the developer. Managers see floored
> team aggregates only**, framed within-developer-over-time, never as a
> cross-developer ranking.

Coaching is tier-aware: the first two pillars work on **existing data**, so a
git-only developer gets genuinely useful coaching with **no opt-in and no prompt
capture**.

## Pillar 1 — Available-data coaching

Coaching grounded in data GovProxy already has. Works for everyone, git-only
included. Served privately at `GET /api/me/coaching`.

- **Churn self-reflection** — "Your code churn on recent commits is elevated — you
  may be committing AI-assisted code before fully reviewing it." Framed as a
  pattern to notice in your own trend, not a verdict.
- **Acceptance-rate trends** — where tool data exists; honestly **null** for
  git-only developers rather than faked.
- **Adoption-journey interpretation** — recognizes ramps and plateaus and suggests
  next steps ("you've plateaued on autocomplete — many developers find agent/chat
  features unlock a step change").
- **Personal insights** — tier-aware, on your own data.

**Manager view:** a team aggregate carries contributor counts and category tallies
only — never the observation sentence — with a **k-anonymity floor (≥3
contributors)**.

## Pillar 2 — PR / review outcome coaching

The highest-value signal that needs no opt-in. The richest coaching signal isn't
in the prompts — it's in what happens to the code *after* the AI helps write it. A
PR and its review are the *verdict* on AI-assisted work. Built entirely from
GitHub/Bitbucket/GitLab PR + review data already integrated in Phase 1.

Signals:

- **Rework / review-rejection rate** and **review rounds** before merge
- **Review comment density** relative to your baseline
- **Time-to-merge** as a friction proxy
- **Review reciprocity** — comments you give others correlates with self-scrutiny
- **The churn + review combination** (the powerful one) disambiguates: high churn
  + high rejection = struggling with AI output quality (a coaching opportunity);
  high churn + clean reviews = healthy iteration (no concern); low churn + clean
  reviews = effective adopter.

**Two clearly-separated views**, never blurred:

- **All-PR (factual)** — your actual review outcomes across all PRs. Unambiguous.
- **AI-assisted (inferred, lower-confidence)** — outcomes correlated with
  high-AI-signature PRs. The more pointed signal, but an inference on an
  inference, so it's labeled lower-confidence and kept structurally separate.

Private developer trajectory at `GET /api/me/pr-coaching`; manager sees only the
floored team aggregate at `/api/coaching/pr-review/...` with no individual
reachable. Because the metrics never evaluate individuals, there's nothing to game
(no rubber-stamp reviews, no PR-splitting incentive).

## Pillar 3 — Opt-in prompt capture

The deep layer, **off until an admin permits it and the developer chooses it**. It
unlocks loop detection, prompt-quality nudges, and the session retrospective by
capturing the developer's own prompts/responses — under the developer's control,
private by default.

### Double opt-in
- **Opt-in #1:** enable prompt capture at all.
- **Opt-in #2:** separately, allow cloud-model retrospective analysis. The
  default is a **local model**, so raw prompts never leave org infrastructure.

### Capture mechanism (developer picks)
A **local agent** or an **editor/IDE extension** — both feed the same encrypted
store. Different developers have different comfort levels.

### Encryption & the blind store
Captures are **client-side encrypted** with a developer-controlled key. The server
is a **blind store**: it holds no plaintext and no key material, and rejects any
attempt to send plaintext or key material. Capture ingestion/read lives under
`/api/me/captures`.

### Key recovery — the developer's informed choice
At opt-in the developer chooses their recovery posture (`/api/me/capture-key`):

- **No-recovery (maximum privacy):** losing the key means the data is
  unrecoverable, by design — the developer is told this plainly.
- **Recovery path:** a recovery mechanism the developer enables. **Every use of
  the recovery flow is logged in a developer-visible feed**
  (`/api/me/capture-key/recovery-log`) — no silent use, no admin backdoor.

### The three prompt-content features
- **Loop detection (real-time, local)** — spots repeated similar prompts /
  unproductive cycles via similarity matching, at the capture layer. Gentle nudge:
  "You've sent similar requests a few times — try including the actual error."
- **Prompt-quality nudges (real-time, local)** — structural checks (length,
  presence of context/error/file references). Gentle, dismissible, never blocking.
- **Session retrospective (async, deeper)** — an AI coach reviews a captured
  session and produces personalized feedback (what worked, where prompts were
  underspecified, where loops burned time). Generation **transiently** decrypts the
  session in memory with a key you supply for that one call, runs a
  **local-default** analyser, and persists **only the narrative output** — never
  the key or plaintext. Conversational follow-ups supported.
  (`/api/me/retrospectives`.)

The real-time features sync only non-sensitive **metadata** (counts, types,
timestamps, dismissals) to `/api/me/coaching/loop-events` and `.../nudge-events`.

### Privacy
No manager ever sees any individual's prompts, nudges, loops, or retrospectives.
Aggregate, anonymized signals *may* inform team coaching ("several developers hit
loops on debugging tasks — a debugging-prompt template might help"), but only as
team-level patterns, only from opted-in developers, with no individual
attribution.

## Showcase — exemplary conversations

The bridge from private self-coaching to organizational learning: a curated
collection of AI conversations developers were proud enough to **deliberately**
share. This is never automatic and never harvested — the act of sharing *is* the
act of de-privatizing that one conversation, done consciously by its owner.

The flow (owner-only):

1. **Promote** — while reviewing their own retrospective, the developer promotes a
   conversation they're proud of. Promotion transiently decrypts one of their
   **own** sessions into an editable draft (`/api/me/showcase/draft`).
2. **Redact** — reviewing and redacting anything sensitive is a **mandatory** step
   in the flow.
3. **Publish** — to a **separate shared store** (`showcase_examples`) at team or
   org scope, after the redaction acknowledgement and a live scope/enablement
   check (`POST /api/me/showcase`). The private capture is never touched.
4. **Browse** — others browse within their access scope and filter by task type,
   tool, or team (`/api/me/showcase`, `.../browse/:id`).

Governance:

- The owner can **unpublish** at any time (`.../unpublish`).
- A **team lead can remove** an example from their team's showcase
  (`/api/admin/showcase/:id/remove`) — team-bounded, logged, and the author is
  notified (`/api/me/showcase/removals`). There is deliberately **no** admin route
  that publishes or edits an example on a developer's behalf.

Because developers curate what they share, the showcase is higher-signal than any
system trying to auto-detect "good" conversations from private data it shouldn't
read — and it sidesteps every privacy landmine.

## Settings & permissions

Coaching follows the standard global-default + per-team-override + permission
model, with an important twist: many Phase-5 controls are **developer-level** (the
opt-ins, recovery choice, cloud-analysis consent), because the developer owns
their coaching privacy choices within whatever the org permits.

Admin/org policy can:

- Enable/disable coaching pillars org-wide (e.g. Pillars 1–2 on, prompt capture
  off entirely).
- Permit or forbid prompt capture (Pillar 3) at all.
- Permit or forbid cloud-model retrospective analysis.
- Set showcase scope permissions (team-only vs org-wide) and nudge defaults.

Developer-level coaching preferences live at `/api/me/coaching-preferences`; the
unified, structurally aggregate-only manager surface is
`/api/coaching/manager/...`.

## The privacy guarantee, verified

The whole privacy floor is verified end to end by an integration suite
(`tests/integration/phase5-pipeline.test.ts`): no server-side plaintext, no
individual leak, minimum-group-size flooring, the double opt-in, and owner-only
publishing each have a dedicated assertion. That verification pass is the gate for
the phase.

## Related

- [Core concepts → privacy model](./concepts.md#the-privacy-model)
- [Dashboard → developer views](./dashboard.md#developer-views-private)
- [API reference → coaching & captures](./api-reference.md)
