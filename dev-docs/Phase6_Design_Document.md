# Toprope — Phase 6 Design Document

**Phase 6: Improvement Layer — Knowledge Sharing + Showcase**

Status: DESIGN — decisions resolved | Version 1.0 — May 2026

> Companion to the canonical roadmap (GovProxy_Roadmap_Source_of_Truth.md v1.1).
> All decisions resolved (Section 8). This is the first phase written in the
> epic-and-subtask format (see Section 9). Feeds directly into the Phase 6 Task
> Tracker.

---

## 1. Phase 6 Goal

Everything through Phase 5 is a **measurement layer** (and a private coaching
layer): it answers "how are we doing?" and "how do I personally improve?" Phase 6
adds an **improvement layer** that answers "how do we get better, together?" — it
turns individual insight into organizational learning.

The two layers reinforce each other. The measurement layer tells a developer their
churn is high; the improvement layer gives them somewhere to learn what to do about
it — surfaced right where the metric appears, not in a separate docs graveyard.

**Theme:** intelligence → intelligence + enablement.

**Posture shift (deliberate):** the product so far is private and self-reflective,
never a report card. The improvement layer is more *social and shared*. That's a
real shift, and it must be intentional. The guiding rule: **sharing is always
opt-in and never quietly exposes an individual's usage.** Public-facing surfaces
stay encouraging; sharper, critical feedback stays private and self-directed.

**Scope:** two features — knowledge sharing / best practices, and the showcase —
built on a foundation of shared primitives. The internal artifact repository
(Feature 2 of the improvement-layer draft) is deliberately NOT in Phase 6; it's
parked as a possible standalone product.

**Duration estimate:** 3–4 weeks (refine at tracker stage).

---

## 2. Shape of Phase 6 (Three Epics)

```
Epic 6.1 — Shared Primitives          (built FIRST; both features depend on it)
Epic 6.2 — Knowledge Sharing / Best Practices
Epic 6.3 — Showcase: Curated Exemplar Conversations
```

Plus any genuinely small standalone tasks (e.g., a settings extension) as single
numbered tasks, not forced into an epic.

**A useful mental model (from the draft):** the showcase is a *pattern library*,
best practices are the *prose* tying things together. (The artifact repository
would have been the *thing library* — parked for now.) Distinct surfaces, shared
foundations.

---

## 3. Epic 6.1 — Shared Primitives (Built First)

Both features overlap enough that we build the building blocks once and reuse them,
rather than two parallel stacks. This is the foundation; it ships before either
feature so they inherit it cleanly.

### 3.1 Contribution Flow (submit → review → publish)

A generic state machine for a piece of shared content moving from draft to
published, reused by both best practices and showcase:

```
draft → submitted → (review) → published → (unpublished | removed)
```

- The *review* step is configurable per feature/contribution-model (e.g.,
  top-down requires lead approval; bottom-up may auto-publish then rely on voting;
  showcase requires the developer's approval + mandatory scrubbing review)
- Generic enough to carry either a best-practice or a showcase unit as its payload
- Tracks author, reviewers, state transitions, timestamps (audit trail)

### 3.2 Versioning

- Shared content can be edited after publishing; versioning preserves history
- Each published item has a version lineage (v1, v2, …) with who changed what, when
- Consumers see the current version; the history is available
- Matters most for best practices (which evolve) but available to both

### 3.3 Org / Team Inheritance

- Content can exist at **org** level or **team** level
- Org-level content is visible to all; team-level to that team
- Inheritance model: org-created content can be *adopted* or *overridden* at team
  level (a team can take an org best practice and adapt it for their context)
- This is the same org-creates / team-modifies pattern from the draft's artifact
  repository idea, generalized into a primitive
- Resolution: when both an org and a team version exist, the team version wins for
  that team (override), but the link to the org origin is preserved

### 3.4 Search

- A single search across shared content (best practices + showcase examples)
- Filter by type, tag, scope (org/team), tool, metric, task type
- Good search is what prevents the "wiki nobody reads" failure — content has to be
  findable at the moment of need
- Powers both the contextual surfacing (best practices next to metrics) and the
  showcase browse

### 3.5 Why First

If we built one feature fully then the other, the second would reimplement
slightly-different versions of these four primitives and we'd get drift. Building
them once, as a foundation, is the difference between a coherent system and two
bolted-on corners. Within the epic, the schema/migration child comes first, then
each primitive, so each builds on a merged predecessor.

---

## 4. Epic 6.2 — Knowledge Sharing / Best Practices

A space to share best practices for working with AI tools, surfaced *contextually*
next to the metric they relate to.

### 4.1 Contextual Surfacing (the differentiator)

- A best practice appears where its relevant metric appears — a developer looking
  at a high churn figure sees a linked practice on reviewing AI suggestions before
  accepting them
- The practice meets them at the moment it's relevant, tying the improvement layer
  back to the measurement layer
- This is what makes it more than a docs site nobody visits

### 4.2 Configurable Contribution Model (resolved)

Three models, **switchable per team** by the manager (global default + per-team,
the established settings pattern):

- **Top-down (default):** leads curate practices; only leads publish. Lowest noise.
- **Bottom-up:** anyone posts; voting surfaces the good material.
- **Hybrid:** anyone posts; leads endorse/promote the strong ones.

All three are built; the active model is a setting a manager can change at any time.
Each model uses the shared contribution flow (3.1) with a different review-step
configuration:
- top-down → lead-approval gate before publish
- bottom-up → post publishes to a pool; feedback ranks/surfaces
- hybrid → post publishes to a pool; lead endorsement elevates

**Feedback mechanics (resolved: richer than a raw upvote).** Bottom-up and hybrid
use a "helpful / not-helpful" signal rather than a single upvote — "did this
actually help you" is a more meaningful quality signal than "I liked this." In
addition, **usage signals** are captured: because the platform sees the metrics, it
can correlate practice views/applications with subsequent metric movement (did
developers who engaged with a churn practice see churn improve?). This is a
differentiated signal only this product can produce. Ranking blends
helpful-ratio + usage signal; recency as a tiebreaker. (Keep the usage-signal
correlation lightweight in Phase 6 — directional, clearly labeled, not overclaimed.)

### 4.3 Metric Attachment (resolved: tag-based auto + manual override)

- **Tag-based auto-surfacing:** practices are tagged (e.g., `churn`,
  `acceptance-rate`, `prompt-quality`); a practice auto-surfaces next to any metric
  matching its tags. Scales without hand-linking everything.
- **Manual override:** a lead can pin a specific practice to a specific metric/
  location, or suppress an auto-surfaced one. Precision where tagging gets it wrong.

### 4.4 Anatomy of a Best Practice

- Title + body authored in a **rich editor (resolved)** — markdown with formatting,
  code blocks (important for prompt/code examples), and embedded metric references.
  The editor is real build work (its own child task), justified because a
  knowledge-sharing surface lives or dies on readability.
- Tags (drive auto-surfacing)
- Scope (org or team)
- Contribution metadata (author, model used, helpful/not-helpful + usage signals
  depending on model)
- Optional cross-link to a showcase that demonstrates the practice (see 5.x)
- Version lineage (from the versioning primitive)

---

## 5. Epic 6.3 — Showcase: Curated Exemplar Conversations

Standout conversations shared as teaching examples, org-internal only. This extends
the Phase 5 showcase (which was developer-self-publish only) with joint curation,
rich annotation, and the draft's best ideas.

### 5.1 The Core Value (from the draft)

The value of a showcase isn't that it shows a good *outcome* — it's that it shows
good *reasoning*. The code is the least transferable part; the thinking behind the
prompts is what someone learns from. **Annotation is what turns a transcript into a
teaching artifact.**

### 5.2 Dual Publish Paths (resolved)

Either path is allowed; **developer approval is ALWAYS required**:

- **Developer self-publish** (the Phase 5 model): a developer promotes a
  conversation from their own retrospective.
- **Joint manager+developer curation** (the draft's model): a manager spots a
  standout conversation and proposes it; the developer genuinely approves before
  it publishes — a real approval step, not a checkbox the manager ticks. This is
  the difference between a showcase and surveillance.

In both paths the developer is the consent gate. Self-publish: the developer
initiates. Joint: the developer approves. Nothing is ever showcased without the
developer's real consent.

### 5.3 What Makes Up a Showcase Unit

- **The conversation** — turn by turn, the spine
- **Developer inline annotations** — comments anchored to the specific turns that
  mattered, explaining reasoning the transcript can't show ("I gave it the failing
  test first on purpose"). The highest-value layer, and the one only the developer
  can provide. Makes the developer an author, not a specimen.
- **The outcome** — resulting code, PR link, or goal achieved; connects prompts to
  real shipped work
- **Curators' note (mandatory)** — a sentence or two on why this was chosen and
  what to take away. Non-optional — it's what makes the showcase legible at a glance
  instead of "here's a transcript, figure out why it's good."
- **AI annotation on prompt technique (optional)** — must be specific, naming the
  actual move ("provides the type signature up front, so the model doesn't have to
  guess the interface"). If it can only manage generic praise, it says nothing.
  Visually marked as clearly AI-generated and secondary, so the human voice stays
  primary.
- **Link to a reusable artifact (optional)** — if the conversation demonstrates a
  reusable pattern; (would tie to the artifact repository if/when that's built)

### 5.4 Consent & Safety

- **Joint, recorded consent** — the developer genuinely approves before publishing;
  a real approval step
- **Explicit visibility scope at publish time** — team-only vs org-wide are
  different consent levels (a developer may share with 8 teammates but feel
  differently about the whole org). Curators choose explicitly, no silent default.
- **Content scrubbing (resolved: auto-flag + mandatory manual review)** — before
  publish, an automated detector flags likely sensitive content, AND a mandatory
  manual review step is always required regardless of what the auto-flag found.
  Neither alone is sufficient; both are required.
  - IMPORTANT: the auto-flag detector is NEW work. The draft assumed reusing the
    proxy-era secret/PII detection, but that scanning pipeline was removed in the
    pivot away from the proxy. So this is a new, focused detector that flags for
    human review (much smaller than the old live-substitution pipeline — it only
    needs to flag, not reversibly redact in a request path).
  - **Two-tier confidence (resolved):** the scrubber covers BOTH secrets and softer
    PII, but at clearly different confidence levels, and the UI must distinguish
    them:
    - **High-confidence — secrets / API keys / credentials.** Pattern-reliable (an
      API key looks like an API key). Flagged firmly as likely-sensitive.
    - **Low-confidence — softer PII (names, emails, customer identifiers).** Pattern
      matching here is NOISY and false-positive-prone (every example email, every
      capitalized product name). These are surfaced as fallible "possible PII" HINTS
      that draw the reviewer's eye — explicitly not verdicts, never blocking.
    - Rationale: treating noisy PII flags as authoritative causes alert-fatigue
      (reviewers start ignoring flags, including real ones) or needless blocking. So
      secrets are reliable flags; soft PII is an attention prompt; the mandatory
      manual review is the real control for both.

### 5.5 Deliberately Excluded: "How It Could Be Better"

A critique bolted onto a showcase undercuts the "this is exemplary" framing and
quietly reintroduces the report-card dynamic. The developer who agreed to be
showcased shouldn't also be publicly corrected.

Instead: "how could this be better?" is offered as a **private, self-directed tool**
a developer runs on their own conversations — learning-oriented, never published.
Same capability, completely different social meaning. The showcase stays purely
celebratory; sharper feedback lives in private where it costs no one face. This
mirrors the analytics posture: public stays encouraging, critical feedback stays
private.

(Note resolved: this private "how could this be better" tool is built as a SEPARATE
purpose-built tool in Phase 6, not a thin reuse of the Phase 5 retrospective. It's
purpose-built for "analyze one specific conversation for improvement," with its own
entry point and UI. It shares the privacy posture and the local-default model
pattern of the Phase 5 retrospective, but is its own task. Rationale: a dedicated
tool feels intentional, where a retrospective pointed sideways would feel
retrofitted.)

### 5.6 Relationship to the Phase 5 Showcase

Phase 5 shipped a developer-self-publish showcase with promote → redact → publish,
a separate shared store, browse with access scoping, and owner/lead governance.
Phase 6 EXTENDS that: adds the joint-curation publish path, inline annotations, the
mandatory curators' note, the new auto-flag scrubber, optional AI annotation, and
ties it to the best-practices surface. The Phase 5 shared store and governance are
reused, not rebuilt.

---

## 6. Cross-Cutting Principles

Consistent with every prior phase:

- **Sharing is opt-in; developer consent is always the gate** (self-publish =
  initiate; joint = approve)
- **Public stays encouraging; critique stays private** (the excluded-critique
  principle)
- **Settings pattern:** contribution model, scrubbing strictness, scope permissions
  use global-default + per-team-override + permission toggle
- **Shared primitives, not bolted-on corners:** both features sit on the 6.1
  foundation
- **Tier-aware where relevant:** contextual surfacing works against whatever metrics
  exist (git-derived now), strengthening as tool data connects

---

## 7. Schema Impact (Preview — detailed in tracker)

Likely additions (finalized per child task):
- `shared_content` — generic published-content records (the contribution-flow
  payload; type = best_practice | showcase_example), with state, author, scope,
  version lineage
- `content_versions` — version history for shared content
- `content_tags` — tags for auto-surfacing + search
- `votes` / `endorsements` — for bottom-up and hybrid contribution models
- `best_practices` — best-practice specifics (or folded into shared_content)
- `metric_attachments` — manual practice↔metric pins/suppressions (auto-surfacing
  is tag-driven, no row needed; manual overrides are rows here)
- `showcase_units` — showcase specifics: conversation ref, outcome link, curators'
  note, scope
- `showcase_annotations` — developer inline annotations anchored to turns; optional
  AI annotation
- `showcase_consent` — recorded joint-consent + visibility-scope decisions
- `scrub_flags` — auto-flagged secret/PII findings awaiting manual review
- Reuses the Phase 5 `showcase_examples` shared store where it already fits;
  Phase 6 extends rather than duplicates

Settings keys: contribution_model (per team), scrub strictness, showcase scope
permissions.

---

## 8. Resolved Decisions (was Open Questions)

All six settled:

1. **Best-practice authoring:** RICH editor now — markdown, formatting, code blocks,
   embedded metric references. Its own child task. (Readability matters most for a
   knowledge-sharing surface.)

2. **Feedback mechanics (bottom-up & hybrid):** RICHER than a raw upvote —
   helpful/not-helpful signal plus usage signals (correlate practice engagement with
   subsequent metric movement). A differentiated signal only this product can
   produce. Keep the usage correlation lightweight/directional in Phase 6.

3. **Private "how could this be better" tool:** built as a SEPARATE purpose-built
   tool in Phase 6 (not a reuse of the Phase 5 retrospective). Shares the privacy
   posture + local-default model, but its own entry point/UI and its own task.

4. **AI prompt-technique annotation:** LOCAL-default model, specific-or-silent rule
   (no generic praise — if it can't be specific, it says nothing). Consistent with
   summaries/retrospective.

5. **Showcase ↔ best-practice cross-link:** YES — lightweight cross-link both ways.
   Cheap given the shared primitives; connects the "pattern library" to "the prose
   tying it together."

6. **Scrubber scope:** covers BOTH secrets and softer PII, at TWO confidence tiers.
   High-confidence for secrets/keys/credentials (pattern-reliable, flagged firmly);
   low-confidence "possible PII" HINTS for names/emails/customer-ids (fallible,
   non-blocking, draw the reviewer's eye). UI must distinguish the tiers. Mandatory
   manual review remains the real control for both. (Avoids alert-fatigue from
   treating noisy PII detection as authoritative.)

---

## 9. Epic-and-Subtask Format (New for Phase 6)

This is the first tracker in the new format:

- **Epics** are parent issues carrying the full context, rationale, and
  cross-cutting acceptance criteria — the documentation lives here, written once.
- **Children** are day-or-less, independently-testable, PR-per-unit work items that
  inherit the epic's context by reference and carry their own mechanical acceptance
  criteria.
- **Two-level numbering:** epic = `6.1`; children = `6.1.1`, `6.1.2`, … The leaf
  numbers are the executable units fed into the dev-cycle-phases skill; the epic
  number is the tracking parent, not a work unit.
- **GitHub representation:** parent issue with a checklist linking child issues
  (`- [ ] #NN 6.1.1 — name`); each child its own issue with a back-reference to its
  epic. Epic closes when all children are checked.
- **Child ordering within an epic:** schema/migration first → core logic → surface/
  UI → wiring, so each child builds on a merged predecessor.
- Genuinely small pieces stay single numbered tasks, not forced into an epic.

Proposed epic/child outline (finalized in the tracker):

```
Epic 6.1 — Shared Primitives
  6.1.1 schema + migration (shared_content, versions, tags)
  6.1.2 contribution-flow state machine
  6.1.3 versioning
  6.1.4 org/team inheritance + resolution
  6.1.5 search

Epic 6.2 — Best Practices
  6.2.1 schema (best-practice specifics, metric_attachments, feedback/usage)
  6.2.2 contribution-model engine (top-down / bottom-up / hybrid, switchable)
  6.2.3 rich authoring editor (markdown, code blocks, metric refs)
  6.2.4 feedback mechanics (helpful/not-helpful + usage-signal correlation)
  6.2.5 tag-based auto-surfacing
  6.2.6 manual override (pin/suppress)
  6.2.7 contextual display next to metrics
  6.2.8 browse UI

Epic 6.3 — Showcase
  6.3.1 schema (showcase_units, annotations, consent, scrub_flags, cross-links)
  6.3.2 dual publish paths (self-publish + joint curation; consent gate)
  6.3.3 inline developer annotations (anchored to turns)
  6.3.4 curators' note (mandatory) + outcome linkage
  6.3.5 auto-flag scrubber (NEW two-tier detector: secrets firm, PII hints)
  6.3.6 mandatory manual-review flow
  6.3.7 optional AI annotation (local, specific-or-silent)
  6.3.8 showcase ↔ best-practice cross-link
  6.3.9 browse/governance (extends Phase 5)

Single tasks (no children):
  6.4 settings extensions (contribution model, scrub strictness, scope perms)
  6.5 private "how could this be better" tool (separate purpose-built tool)
```

---

## 10. Phase 6 Milestone (Proposed)

By the end of Phase 6:

- A developer looking at a high-churn figure sees a relevant best practice right
  there — the improvement layer meets the measurement layer
- A team can run best-practice sharing in whichever contribution model suits them
  (top-down, bottom-up, or hybrid), switchable by the manager
- A standout AI conversation can be showcased either by the developer alone or via
  joint manager+developer curation — always with the developer's real consent —
  enriched with inline annotations that teach the *reasoning*, a mandatory curators'
  note, and the outcome it produced
- Secrets and credentials are auto-flagged before any showcase publishes, with
  mandatory human review on top
- Sharper "how could this be better" feedback stays private and self-directed; the
  public showcase stays purely celebratory
- All of it sits on shared primitives, so it's a coherent system rather than two
  bolted-on corners

---

*End of Document — Toprope Phase 6 Design (in discussion)*
