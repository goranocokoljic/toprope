# GovProxy — Phase 5 Design Document

**Phase 5: Developer Coaching**

Status: DESIGN — decisions resolved | Version 1.0 — May 2026

> Companion to the canonical roadmap (GovProxy_Roadmap_Source_of_Truth.md).
> All design decisions below are resolved; this document feeds directly into the
> Phase 5 Task Tracker.

---

## 1. Phase 5 Goal

Phases 1–4 built the intelligence and reporting layer — what's happening, what it
costs, where it's wasted, what's anomalous. Phase 5 turns that platform from a
*measurement* tool into a *capability-building* tool. It's the differentiator:
managers don't just get visibility, developers get *better*.

The core principle: pure monitoring tools are easy to resent; coaching tools that
respect privacy are welcomed. Phase 5 is built so developers *want* it — it's
their private mirror and growth companion, not a manager's scorecard.

**Theme:** make the product something developers want, not just tolerate.

**Tier-aware, as always:** the coaching that works on existing data works for
git-only developers today; deeper layers light up as data sources connect or as
developers opt in.

**Duration estimate:** 4–5 weeks — the largest phase, because it spans three
coaching pillars plus the sharing surface. (Refine at tracker stage.)

---

## 2. The Shape of Phase 5

Three coaching pillars of increasing depth and data requirements, plus a sharing
surface that turns individual learning into organizational learning.

| Layer | Data needed | Works at launch (git-only)? |
|---|---|---|
| Pillar 1 — Available-data coaching | git + tool metrics (existing) | Yes, fully |
| Pillar 2 — PR/review outcome analysis | git provider PR/review data (existing) | Yes, fully |
| Pillar 3 — Opt-in prompt capture | prompt content (opt-in capture) | Only if developer opts in |
| Showcase — Exemplary conversations | deliberately-shared content | Yes (sharing is a manual act) |

**The big realization driving this design:** the richest coaching signal isn't in
the prompts — it's in what happens to the code *after* the AI helps write it. A PR
and its review are the *verdict* on AI-assisted work, often more informative than
the prompt that produced it. This is why Pillar 2 is an equal partner to the
opt-in prompt features, and why a git-only developer at WMG gets genuinely
valuable coaching from day one without any prompt capture at all.

---

## 3. Cross-Cutting Privacy Principles (apply to all of Phase 5)

These are non-negotiable and consistent with every prior phase:

- **Individual coaching signals are private to the developer.** Their churn
  reflection, rework rate, prompt nudges, retrospectives — all theirs alone.
- **Managers see aggregate team-level signals only.** Never an individual's
  review-rejection rate or coaching score. The moment an individual coaching
  signal becomes manager-visible, it becomes a performance metric and gets gamed
  into meaninglessness.
- **Individual signals are framed as within-developer-over-time**, never as a
  snapshot judgment or cross-developer ranking. "Your rework rate rose from 15% to
  30% this month" is coaching; "your rework rate is 30%" is a verdict. Trajectory,
  not snapshot.
- **Coaching, not surveillance.** Every signal is a mirror the developer can act
  on, never a stick.
- **Local-by-default privacy floor.** Deeper analysis defaults to local models;
  anything that sends data externally is a conscious, separate opt-in.
- **Tier-aware honesty.** Inferred signals (AI-specific analysis) are clearly
  separated from and lower-confidence than factual signals (all-PR data).

---

## 4. Pillar 1 — Available-Data Coaching

Coaching grounded in data the platform already has. Works for every developer,
git-only included, with no new capture.

**Features:**
- **Churn-based self-reflection.** "Your code churn on recent commits is elevated
  — you may be committing AI-assisted code before fully reviewing it. Developers
  who review AI output before committing tend to have lower churn." Framed as a
  pattern to notice, grounded in the developer's own trend.
- **Acceptance-rate trends** (where tool data exists). "Your suggestion acceptance
  rate has climbed steadily — you're getting better at prompting for what you
  actually need." Null/absent for git-only developers (honestly absent, not faked).
- **Adoption-journey coaching.** Builds on the Phase 4 adoption-journey
  visualization, adding gentle interpretation: recognizing ramps, plateaus, and
  suggesting next steps ("you've plateaued on autocomplete — many developers find
  agent/chat features unlock a step change").
- **Personal insights** (the rule-based/AI-generated insights deferred from Phase
  2). Now delivered here, tier-aware, on the developer's own data.

**Privacy:** all private to the developer. Aggregate team trends (e.g., "the team's
average churn is trending down") available to the manager, never individual values.

---

## 5. Pillar 2 — PR / Review Outcome Analysis

The new pillar. Measures the *verdict* on AI-assisted work via pull requests and
code review — all from git-provider data already integrated in Phase 1 (GitHub,
Bitbucket, GitLab all expose PR/MR + review data). No prompt capture required.

### 5.1 Signals

- **Rework / review-rejection rate.** How often a developer's PRs come back for
  changes, and how many review rounds before merge. High rework on AI-heavy PRs
  may signal accepting AI output without enough scrutiny.
- **Review comment density.** Volume of review comments relative to the
  developer's baseline. High density on AI-assisted PRs suggests the output needed
  significant human correction. (Comment *type* categorization — substantive vs
  nit — is a stretch goal; volume-relative-to-baseline is the core signal.)
- **Time-to-merge as friction proxy.** Long multi-round merges indicate the code
  wasn't right the first time; fast clean merges indicate effective use.
- **Review reciprocity.** Review comments *given* to others (already captured)
  correlates with self-scrutiny — developers who review carefully tend to
  scrutinize their own AI output.
- **Churn + review combination (the powerful one).** Churn alone is ambiguous
  (sloppy acceptance vs healthy iteration). Combined with review outcomes it
  disambiguates: high churn + high rejection = struggling with AI output quality
  (coaching opportunity); high churn + clean reviews = healthy iteration (no
  concern); low churn + clean reviews = effective adopter.

### 5.2 Two Clearly-Separated Views

- **All-PR view (factual).** The developer's actual code-review outcomes across
  all PRs. Unambiguous data, no inference. "Here's a fact about your PRs."
- **AI-assisted-PR view (inferred, lower confidence).** Review outcomes correlated
  specifically with high-AI-signature PRs. The more pointed coaching signal, but
  rests on the *estimated* AI signature — an inference on an inference. Clearly
  labeled lower-confidence and visually/structurally separated from the all-PR view.

The two are never blurred. The developer always knows which is fact and which is
inference.

### 5.3 Fairness & Anti-Gaming Guards

- **Within-developer-over-time only.** Individual signals are trajectories, never
  cross-developer rankings. Rejection rates vary by seniority, task difficulty,
  reviewer strictness — so the signal is "your trend," not "you vs your teammates."
- **Private to the developer.** Individual PR/review coaching is the developer's
  mirror. Managers get aggregate team patterns only ("the team's rework rate on
  AI-assisted PRs is climbing — consider a session on reviewing AI output"). This
  is what prevents gaming (rubber-stamp reviews, PR-splitting) — the metrics never
  evaluate individuals, so there's nothing to game.

### 5.4 Manager-Facing Aggregate

The manager sees team-level patterns only:
- Team aggregate rework rate trend (all-PR and AI-assisted, separated)
- Team-level coaching opportunities surfaced ("rising rework on AI-assisted PRs —
  the team might benefit from AI-output-review practices")
- Never an individual's numbers

---

## 6. Pillar 3 — Opt-In Prompt Capture

The deep layer. Double opt-in. Unlocks loop detection, prompt-quality nudges, and
the session retrospective by capturing the developer's own prompts/responses —
under the developer's control, private by default.

### 6.1 Double Opt-In

- **Opt-in #1:** the developer chooses to enable prompt capture at all.
- **Opt-in #2:** separately, if they want cloud-model retrospective analysis (higher
  quality), they consciously enable it knowing prompts will be sent to an external
  model for that analysis. Default is local-model analysis where raw prompts never
  leave org infrastructure.

### 6.2 Capture Mechanism (developer picks)

- **Local agent** on the developer's machine, OR
- **Editor/IDE extension** the developer installs.
- Both feed the same encrypted store. Different developers have different comfort
  levels — some won't run a background agent but will install an extension, and
  vice versa.

### 6.3 Encryption & Key Recovery

- Captured prompts/responses encrypted at rest, server-side, with a
  developer-controlled key.
- **Recovery is the developer's informed choice at opt-in:**
  - **No-recovery (maximum privacy):** key loss means the data is unrecoverable, by
    design. The developer is clearly informed of this tradeoff.
  - **Recovery path:** a recovery mechanism the developer can enable. Any use of the
    recovery flow is **logged in a way the developer can see** — so even recovery
    can't be used silently. The developer can audit whether their recovery key was
    ever used.
- The recovery choice and the logged-flow transparency keep this trustworthy: no
  quiet backdoor, the developer owns and can audit the mechanism.

### 6.4 The Three Prompt-Content Features

- **Loop detection (real-time, local).** Detects repeated similar prompts /
  unproductive cycles via similarity matching. Runs *locally at the capture layer*
  — doesn't need the heavy retrospective model — so it's instant and private. Gentle
  nudge: "You've sent similar requests a few times. Try including the actual error
  output or a different framing."
- **Prompt-quality nudges (real-time, local).** Structural checks on prompts
  (length, presence of context/error/file references). Also runs locally at the
  capture layer. "This prompt is very short — including the relevant code or error
  usually gets a better result." Gentle, dismissible, never blocking.
- **Session retrospective (async, deeper).** An AI coach reviews a developer's
  captured session and produces personalized feedback: what worked, where prompts
  were underspecified, where loops burned time. Conversational — the developer can
  ask "why was this flagged?" Analysis defaults to a **local model** (raw prompts
  stay within org infrastructure); cloud analysis is the conscious second opt-in.

### 6.5 Architecture Note

Lightweight real-time coaching at the edge (loop detection, nudges — local, instant,
no heavy model) + deep retrospective on demand (async, local-model-default). This
split keeps the always-on coaching private and fast, reserving the heavier analysis
for explicit retrospective requests.

### 6.6 Privacy

- All capture data private to the developer. No manager visibility into any
  individual's prompts, nudges, loops, or retrospectives — ever.
- Aggregate, anonymized signals *may* inform team coaching ("several developers hit
  loops on debugging tasks — a debugging-prompt template might help"), but only as
  team-level patterns with no individual attribution, and only from developers who
  opted in.

---

## 7. Showcase — Exemplary Conversations

The bridge from private self-coaching to organizational learning. A curated
collection of AI conversations developers were proud enough to deliberately share,
so others can learn from real examples of effective AI use.

### 7.1 The Privacy Resolution

This feature *appears* to conflict with the private-encrypted-store design ("your
prompts are private and unreadable by anyone but you" vs "share your best prompts
with the team"). The conflict dissolves by separating two different acts:

- **Passive capture for private coaching** — automatic, encrypted, developer-only.
- **Active, deliberate sharing of a chosen example** — the developer picks a
  specific conversation, decides it's good, reviews and redacts it, and explicitly
  publishes it.

Sharing is never automatic, never harvested by the system, never visible to a
manager scanning for good examples. The act of sharing *is* the act of
de-privatizing that one conversation, done consciously by its owner.

### 7.2 How It Works

- While reviewing their own retrospective, a developer can **promote** a
  conversation they're proud of.
- They **review and redact** anything sensitive before publishing (the redaction
  step is mandatory in the flow).
- They **publish** to a shared showcase at team or org scope (their choice).
- Published examples live in a **separate shared store** with normal org access
  controls — distinct from the private encrypted store. Once published, an example
  no longer needs dev-only-key encryption because its owner deliberately made it
  org-visible.
- Others **browse** the showcase: filter by task type, tool, team; learn from how
  effective conversations were structured.

### 7.3 Why This Is Better, Not Just Compatible

Because developers curate what they share, the showcase is a collection of
conversations people were proud enough to publish — a far better quality signal
than a system trying to auto-detect "good" conversations from private data it
shouldn't be reading. It sidesteps every privacy landmine while producing a
higher-quality result.

### 7.4 Governance

- A developer can **unpublish** their own example at any time (removes from shared
  store).
- Optional light moderation: a team lead can remove an example from their team's
  showcase (but cannot publish on a developer's behalf — publishing is always the
  owner's act).
- No manager can publish, edit, or de-anonymize a private conversation. They can
  only curate what developers have already chosen to make public.

---

## 8. Settings & Configuration

Consistent with prior phases (global default + per-team override + permission
toggle). New Phase 5 settings:

- Which coaching pillars are enabled org-wide (e.g., an org could enable Pillars
  1–2 but disable prompt capture entirely)
- Whether prompt capture (Pillar 3) is permitted at all in the org
- Whether cloud-model retrospective analysis is permitted (some orgs will forbid
  it outright)
- Showcase scope permissions (team-only vs org-wide sharing)
- Nudge frequency / dismissibility defaults

Note: many Phase 5 controls are *developer-level* (opt-in, recovery choice, cloud
analysis) rather than admin-level — the developer owns their coaching privacy
choices within whatever the org permits.

---

## 9. Schema Impact (Preview — detailed in tracker)

Likely additions (finalized per task in the tracker):
- `pr_review_metrics` — per-developer per-period PR/review outcome aggregates
  (all-PR and AI-assisted variants, rework rate, comment density, time-to-merge)
- `coaching_signals` — generated coaching observations per developer (private)
- `prompt_captures` — encrypted captured sessions (Pillar 3, opt-in)
- `capture_keys` — key/recovery metadata (NOT the raw key); recovery-use audit log
- `loop_events` / `nudge_events` — real-time coaching events (local-origin)
- `retrospectives` — generated session retrospectives (private)
- `showcase_examples` — deliberately-published conversations (shared store,
  separate from private captures)
- `coaching_settings` keys
- Aggregate team-level coaching tables for manager-facing signals (no individual data)

The private encrypted store (`prompt_captures`) and the shared store
(`showcase_examples`) are deliberately separate systems with separate access
models, connected only by the developer's explicit promote-and-publish action.

---

## 10. Proposed Task Breakdown (Draft — for the tracker)

PILLAR 1:
- **5.1** Available-data coaching (churn reflection, acceptance trends, journey
  coaching, personal insights — tier-aware, private)

PILLAR 2:
- **5.2** PR/review outcome metrics engine (signals from git providers, all-PR +
  AI-assisted separated, within-developer-over-time)
- **5.3** PR/review coaching surface (developer-private view + manager aggregate)

PILLAR 3:
- **5.4** Prompt capture mechanism (local agent + editor extension; encrypted store)
- **5.5** Key management & recovery (dev choice, visible logged recovery flow)
- **5.6** Real-time loop detection + prompt-quality nudges (local at capture layer)
- **5.7** Session retrospective (local-model default, cloud as second opt-in)

SHOWCASE:
- **5.8** Exemplary-conversation showcase — promote/redact/publish flow
- **5.9** Showcase browse/discovery + governance (unpublish, light moderation)

CROSS-CUTTING:
- **5.10** Coaching settings & permissions (org/team/developer-level)
- **5.11** Manager aggregate coaching signals (team-level, no individual data)
- **5.12** Phase 5 integration testing + privacy verification + dogfood

---

## 11. Resolved Design Decisions (Reference)

1. **Prompt-content dependency:** hybrid — available-data + PR/review coaching work
   now; opt-in prompt capture is the deep layer (option 3 leaning, but not
   abandoning available data).
2. **PR/review centrality:** equal partner to the prompt-content features.
3. **PR/review scope:** both AI-assisted-PR (inferred) and all-PR (factual),
   clearly separated.
4. **Who sees coaching signals:** private to developer + aggregate-only to manager.
5. **Capture mechanism:** both local agent and editor extension; developer picks.
6. **Retrospective analysis location:** encrypted at rest, dev-controlled key;
   local-model default; cloud analysis as a conscious second opt-in.
7. **Prompt-content features:** all three — loop detection + nudges + session retro.
8. **Key recovery:** developer chooses no-recovery or a recovery path; any recovery
   use is logged in a flow visible to the developer.
9. **Showcase:** full exemplary-conversation showcase built inside Phase 5;
   deliberate promote/redact/publish; separate shared store; never auto-harvested.

---

## 12. Phase 5 Milestone (Proposed)

By the end of Phase 5:

- A git-only developer at WMG opens their private coaching view and sees genuinely
  useful guidance — churn reflection, PR/review outcome trends — with no prompt
  capture required
- The PR/review analysis tells a developer "your rework rate on AI-assisted PRs is
  rising" as a private, actionable trend — while the manager sees only the team-level
  pattern
- A developer who opts into prompt capture gets real-time loop/nudge coaching
  locally, and can run a private session retrospective on a local model — their
  prompts never leaving org infrastructure unless they consciously enable cloud
  analysis
- A developer who loses their key faces only the consequence they knowingly chose,
  and can see in a visible log if any recovery flow was ever used
- A developer who solves something elegantly with AI can deliberately promote,
  redact, and publish that conversation to a team/org showcase others learn from —
  with nothing ever shared without their explicit action
- The product has become something developers *want*: a private mirror that helps
  them improve, plus a way to share their best work — not a manager's scorecard

---

*End of Document — GovProxy Phase 5 Design (decisions resolved)*
