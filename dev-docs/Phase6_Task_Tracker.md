# Toprope — Phase 6 Task Tracker

**Phase 6: Improvement Layer — Knowledge Sharing + Showcase**

3 Epics + 2 standalone tasks | Estimated 3–4 weeks | First tracker in epic-and-subtask format

> NEW FORMAT. Epics are parent issues carrying full context + cross-cutting
> acceptance criteria (the documentation, written once). Children are day-or-less,
> independently-testable, PR-per-unit work items that inherit the epic's context by
> reference and carry their own mechanical acceptance criteria.
>
> Two-level numbering: epic = `6.1`; children = `6.1.1`, `6.1.2`, … Feed the LEAF
> numbers (children) into the dev-cycle-phases skill as executable units; the epic
> number is the tracking parent, not a work unit.
>
> GitHub: each epic is a parent issue with a checklist linking child issues
> (`- [ ] #NN 6.1.1 — name`); each child is its own issue back-referencing the epic.
> The epic closes when all its children are checked.

---

## Workflow Per Child Task

```
1. Open the child issue (context inherited from its epic)
2. Create branch: task/6.X.Y-short-name
3. Implement in Claude Code (reference the child's acceptance criteria)
4. Write tests alongside
5. npm test
6. PR referencing the child issue ("Closes #N"); check it off in the epic checklist
7. AI-assisted review → address → re-test
8. Merge → tag v0.6.X.Y
9. When all children checked, close the epic
```

## Build Order

```
Epic 6.1 (shared primitives) — FULLY before 6.2/6.3, since both sit on it
Then 6.2 and 6.3 can proceed (6.3 also extends the Phase 5 showcase)
6.4 settings can land alongside 6.2/6.3 (they read these settings)
6.5 standalone, any time after Phase 5 retrospective exists
Within each epic: children are numbered in dependency order (schema first → logic →
surface → wiring). Do them in order.
```

## Phase 6 Cross-Cutting Principles (inherited by every task)

- Sharing is opt-in; the developer's consent is ALWAYS the gate (self-publish =
  initiate; joint = approve)
- Public surfaces stay encouraging; sharper "how could this be better" critique
  stays private and self-directed
- Settings pattern: global default + per-team override + permission toggle
- Both features sit on the shared primitives (Epic 6.1) — no parallel stacks
- Tier-aware where relevant: contextual surfacing works against whatever metrics
  exist (git-derived now), strengthening as tool data connects

---

# EPIC 6.1 — Shared Primitives

**Parent issue.** Build the feature-agnostic foundation both improvement-layer
features sit on, so they're one coherent system rather than two bolted-on corners.
Build this epic FULLY before 6.2/6.3.

### Epic context (inherited by all 6.1.x children)

```
Four primitives underpin both Best Practices and the Showcase: a contribution flow
(submit→review→publish), versioning, org/team inheritance/scope, and search — over
a shared content spine. The machinery of moving content through states, recording
who did what, versioning edits, scoping to org/team, and finding content is shared;
the type-specific rules are delegated to the features.

Mental model: showcase = pattern library; best practices = the prose tying it
together. Distinct surfaces, shared foundations.

The shared spine (see 6.1.1) carries content_type (best_practice|showcase_example),
title, author, scope, state, current_version, and an audit trail. Feature-specific
detail lives in companion tables that reference the spine.
```

### Cross-cutting acceptance criteria (apply to the whole epic)

```
- Primitives are feature-agnostic: no best-practice- or showcase-specific logic
  leaks into 6.1 code
- Every state transition and governance action is recorded in the audit trail
- Org/team scope resolution is explicit and consistent with the Phase 2 settings
  inheritance pattern
- Search returns correctly scoped results (a viewer never sees content outside
  their access)
- All 6.1 children have unit tests; the epic has an integration test exercising
  submit→review→publish→version→search end to end with a stub content_type
```

### Children checklist

```
- [ ] #__ 6.1.1 — Shared content schema + migration
- [ ] #__ 6.1.2 — Contribution-flow state machine
- [ ] #__ 6.1.3 — Versioning
- [ ] #__ 6.1.4 — Org/team inheritance + scope resolution
- [ ] #__ 6.1.5 — Search
```

---

## 6.1.1 — Shared Content Schema + Migration

```
## 6.1.1 — Shared Content Schema + Migration
Epic: #__ (6.1 Shared Primitives)

### Scope
The shared content spine + companion structure that both features build on.

### Schema (migration)
CREATE TABLE contributions (
  id TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,           -- best_practice | showcase_example
  title TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES developers(id),
  scope TEXT NOT NULL,                  -- org | team
  scope_target TEXT,                    -- team name if team-scoped
  state TEXT NOT NULL,                  -- draft|submitted|published|unpublished|removed
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE contribution_versions (
  id TEXT PRIMARY KEY,
  contribution_id TEXT NOT NULL REFERENCES contributions(id),
  version INTEGER NOT NULL,
  body TEXT NOT NULL,                   -- versioned payload (JSON)
  author_id TEXT NOT NULL,
  change_note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(contribution_id, version)
);
CREATE TABLE contribution_tags (
  contribution_id TEXT NOT NULL REFERENCES contributions(id),
  tag TEXT NOT NULL,
  PRIMARY KEY (contribution_id, tag)
);
CREATE TABLE contribution_review_events (
  id TEXT PRIMARY KEY,
  contribution_id TEXT NOT NULL REFERENCES contributions(id),
  event TEXT NOT NULL,                  -- submitted|approved|published|unpublished|removed|redacted
  actor_id TEXT NOT NULL,
  note TEXT,
  occurred_at TEXT NOT NULL
);

### Deliverables
- [ ] Migration creating the four tables above
- [ ] Basic data-access layer (create/read/update contributions + versions + tags +
      events)
- [ ] content_type is an open enum (best_practice, showcase_example) extensible later

### Acceptance Criteria
- [ ] Migration creates all tables + constraints; idempotent
- [ ] CRUD works for each table
- [ ] A contribution can carry tags and accumulate review events
- [ ] No feature-specific columns leak into the spine
- [ ] Unit tests for the data-access layer
```

---

## 6.1.2 — Contribution-Flow State Machine

```
## 6.1.2 — Contribution-Flow State Machine
Epic: #__ (6.1 Shared Primitives)

### Scope
The generic state machine moving content draft→submitted→published (+unpublished,
removed), with a CONFIGURABLE review step delegated to the feature.

### States & transitions
draft → submitted → [review gate?] → published
published → unpublished (by author/lead)
published/unpublished → removed (by lead governance)
- Review gate is configured per content_type / contribution model:
  - required-approval (e.g., top-down best practices: lead approves; showcase:
    developer approves + redaction done)
  - auto-publish (e.g., bottom-up best practices)
- Every transition writes a contribution_review_event (actor, event, time, note)

### Deliverables
- [ ] State machine enforcing legal transitions only
- [ ] Configurable review gate (required-approval vs auto-publish) supplied by the
      feature at submit time
- [ ] Enforces that published content went through any required gate (cannot skip)
- [ ] Records every transition in the audit trail
- [ ] Hooks for feature-specific pre-publish steps (e.g., showcase redaction/scrub)

### Acceptance Criteria
- [ ] Illegal transitions are rejected
- [ ] A required-approval gate cannot be bypassed to reach published (verified)
- [ ] Auto-publish path reaches published without a gate when configured
- [ ] Every transition produces an audit event with actor + timestamp
- [ ] Pre-publish hook fires (so showcase can require redaction/scrub before publish)
- [ ] Unit tests: each transition, gate enforcement, bypass prevention, audit
```

---

## 6.1.3 — Versioning

```
## 6.1.3 — Versioning
Epic: #__ (6.1 Shared Primitives)

### Scope
Linear version history for any contribution. Each published edit creates a new
version; prior versions retained; current version served.

### Deliverables
- [ ] Creating a new version increments current_version and writes a
      contribution_versions row (body, author, change_note, timestamp)
- [ ] View version history for a contribution
- [ ] Revert to a prior version (creates a new version equal to the old body, never
      destroys history)
- [ ] Current version is what read APIs serve by default
- [ ] NOT in scope: branching/merging (linear only)

### Acceptance Criteria
- [ ] Editing published content creates a new version, increments current_version
- [ ] All prior versions retained and viewable
- [ ] Revert produces a new version (history preserved, not rewritten)
- [ ] Default reads serve the current version
- [ ] Unit tests: version creation, history, revert-preserves-history
```

---

## 6.1.4 — Org/Team Inheritance + Scope Resolution

```
## 6.1.4 — Org/Team Inheritance + Scope Resolution
Epic: #__ (6.1 Shared Primitives)

### Scope
Content exists at org or team level with explicit visibility + resolution, matching
the Phase 2 settings inheritance pattern. Also carries the team-only vs org-wide
SCOPE used by the showcase visibility decision and best-practice placement.

### Model
- org-scoped content visible to all teams
- team-scoped content visible to that team
- where relevant, a team may hide an org item for itself (if permitted)
- resolution helper: given a viewer (team membership) and a content set, return what
  they can see

### Deliverables
- [ ] Scope stored on contributions (scope + scope_target, already in 6.1.1)
- [ ] Resolution helper: effective visible content for a given viewer/team
- [ ] Optional per-team hide of an org item (permission-gated)
- [ ] Used identically by both features

### Acceptance Criteria
- [ ] Org content visible to all teams; team content only to that team
- [ ] A viewer never sees content outside their scope (verified)
- [ ] Per-team hide works when permitted, rejected when not
- [ ] Resolution helper returns correct sets for org-only, team-only, and mixed
- [ ] Unit tests: each visibility case, hide permission, viewer scoping
```

---

## 6.1.5 — Search

```
## 6.1.5 — Search
Epic: #__ (6.1 Shared Primitives)

### Scope
Shared search over contributed content so both features are discoverable.

### Deliverables
- [ ] Index over contributions (title, body of current version, tags, content_type,
      scope)
- [ ] Query by free text + filter by tag, content_type, team, scope
- [ ] SQLite FTS (or equivalent at current scale)
- [ ] Results respect scope resolution (6.1.4) — no out-of-scope leakage
- [ ] Reasonable ranking (text relevance; feature-specific ranking layered on later)

### Acceptance Criteria
- [ ] Free-text search returns relevant content
- [ ] Tag/type/team/scope filters work and combine
- [ ] Results never include content outside the viewer's scope (verified)
- [ ] Index updates when content is published/edited/unpublished
- [ ] Unit tests: text search, each filter, scope enforcement, index freshness
```

---

# EPIC 6.2 — Best Practices

**Parent issue.** A knowledge-sharing surface whose differentiator is contextual
surfacing — practices appear next to the metric they relate to, not in a docs
graveyard. Built on Epic 6.1.

### Epic context (inherited by all 6.2.x children)

```
Best practices for working with AI tools, surfaced contextually next to relevant
metrics. Contribution model is configurable per team (top-down default, bottom-up,
hybrid), switchable by the manager via settings. Practices attach to metrics via
tag-based auto-surfacing + manual override. Authoring uses a rich editor (markdown,
code blocks, metric refs). Feedback is richer than an upvote: helpful/not-helpful +
usage-signal correlation (does engaging with a practice correlate with metric
improvement). Tier-aware: surfacing is tied to which metric is shown, not data
quality — works for git-only developers today.
```

### Cross-cutting acceptance criteria

```
- All three contribution models work and are switchable per team without schema
  change
- Contextual surfacing shows the right practices next to the right metric
- Public-facing best-practice surfaces stay encouraging in tone
- Everything built on the 6.1 primitives (no parallel content/version/search stacks)
- Integration test: author a practice → surfaces next to its metric → feedback
  recorded → appears in search
```

### Children checklist

```
- [ ] #__ 6.2.1 — Best-practice schema (specifics, metric attachments, feedback)
- [ ] #__ 6.2.2 — Contribution-model engine (top-down/bottom-up/hybrid, switchable)
- [ ] #__ 6.2.3 — Rich authoring editor
- [ ] #__ 6.2.4 — Feedback mechanics (helpful/not-helpful + usage signals)
- [ ] #__ 6.2.5 — Tag-based auto-surfacing
- [ ] #__ 6.2.6 — Manual override (pin/suppress)
- [ ] #__ 6.2.7 — Contextual display next to metrics
- [ ] #__ 6.2.8 — Browse UI
```

---

## 6.2.1 — Best-Practice Schema

```
## 6.2.1 — Best-Practice Schema
Epic: #__ (6.2 Best Practices)

### Schema (companion to contributions)
CREATE TABLE practice_details (
  contribution_id TEXT PRIMARY KEY REFERENCES contributions(id),
  -- body lives in contribution_versions; this holds practice-specific fields
  model_used TEXT,                      -- if AI-assisted authoring
  endorsed INTEGER DEFAULT 0            -- hybrid model lead-endorsement flag
);
CREATE TABLE practice_metric_pins (
  id TEXT PRIMARY KEY,
  contribution_id TEXT NOT NULL REFERENCES contributions(id),
  metric TEXT NOT NULL,                 -- churn|acceptance_rate|cost_per_pr|...
  action TEXT NOT NULL,                 -- pin | suppress
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE practice_feedback (
  id TEXT PRIMARY KEY,
  contribution_id TEXT NOT NULL REFERENCES contributions(id),
  developer_id TEXT NOT NULL REFERENCES developers(id),
  signal TEXT NOT NULL,                 -- helpful | not_helpful
  created_at TEXT NOT NULL,
  UNIQUE(contribution_id, developer_id) -- one current signal per dev
);
CREATE TABLE practice_usage_events (
  id TEXT PRIMARY KEY,
  contribution_id TEXT NOT NULL REFERENCES contributions(id),
  developer_id TEXT NOT NULL,
  event TEXT NOT NULL,                  -- viewed | applied (self-marked)
  metric_context TEXT,                  -- metric the practice was surfaced against
  occurred_at TEXT NOT NULL
);

### Acceptance Criteria
- [ ] Migration creates the tables; idempotent
- [ ] Metric pins/suppressions stored; feedback one-per-dev (UPSERT)
- [ ] Usage events recordable for the later usage-signal correlation
- [ ] Unit tests for the data layer
```

---

## 6.2.2 — Contribution-Model Engine

```
## 6.2.2 — Contribution-Model Engine
Epic: #__ (6.2 Best Practices)

### Scope
The three switchable models, each configuring the 6.1.2 review gate differently.

### Behavior
- top-down (default): only leads/curators can publish; submit → lead-approval gate
  → published
- bottom-up: anyone posts; auto-publish to a pool; ranked by feedback (6.2.4)
- hybrid: anyone posts; auto-publish to a pool; lead endorsement (practice_details
  .endorsed) elevates/surfaces
- Active model read from settings (per team; global default top_down) — see 6.4
- Switching the model changes which mechanics are active, NOT the schema

### Acceptance Criteria
- [ ] Each model enforces the correct publish path via the 6.1.2 gate
- [ ] top-down: non-leads cannot publish (verified)
- [ ] bottom-up: anyone publishes; ordering by feedback
- [ ] hybrid: anyone publishes; endorsement elevates
- [ ] Model is per-team switchable at runtime with no migration
- [ ] Unit tests: each model's publish path, the switch, permission enforcement
```

---

## 6.2.3 — Rich Authoring Editor

```
## 6.2.3 — Rich Authoring Editor
Epic: #__ (6.2 Best Practices)

### Scope
The authoring surface for practices: markdown with formatting, code blocks
(critical for prompt/code examples), and embedded metric references.

### Deliverables
- [ ] Markdown editor with formatting toolbar + code-block support
- [ ] Embedded metric reference syntax (e.g., insert a reference to `churn`) that
      also contributes a tag for auto-surfacing
- [ ] Live preview
- [ ] Saves through the versioning primitive (each save = a version)

### Acceptance Criteria
- [ ] Author can write markdown with code blocks and see a faithful preview
- [ ] Metric references can be embedded and produce the matching tag
- [ ] Saving creates a version (6.1.3)
- [ ] Renders safely (no script injection from markdown)
- [ ] Matches aesthetic + dark mode
- [ ] Tests: render fidelity, metric-ref→tag, version-on-save, sanitization
```

---

## 6.2.4 — Feedback Mechanics

```
## 6.2.4 — Feedback Mechanics
Epic: #__ (6.2 Best Practices)

### Scope
Richer-than-upvote feedback: helpful/not-helpful + usage-signal correlation.

### Deliverables
- [ ] helpful / not_helpful signal (one current signal per developer; togglable)
- [ ] Ranking input: helpful-ratio feeds bottom-up/hybrid surfacing order
- [ ] Usage-signal correlation (LIGHTWEIGHT, directional): correlate practice
      engagement (viewed/applied for a metric) with subsequent movement in that
      developer's metric; surface as a directional, clearly-labeled signal
      ("developers who engaged with this saw churn improve") — NOT a causal claim
- [ ] Guards: minimum sample before showing a usage-signal; label as directional

### Acceptance Criteria
- [ ] helpful/not-helpful recorded, one current signal per dev, togglable
- [ ] Ranking reflects helpful-ratio for bottom-up/hybrid
- [ ] Usage-signal correlation computed and shown ONLY above a minimum sample
- [ ] Usage signal is labeled directional/non-causal (copy reviewed)
- [ ] Unit tests: signal capture, ranking, usage correlation, min-sample guard,
      non-causal labeling
```

---

## 6.2.5 — Tag-Based Auto-Surfacing

```
## 6.2.5 — Tag-Based Auto-Surfacing
Epic: #__ (6.2 Best Practices)

### Scope
Practices auto-surface next to metrics matching their tags.

### Deliverables
- [ ] Given a metric being displayed, query practices tagged with that metric
      (within the viewer's scope) and return the surfacing set
- [ ] Ranking: endorsed/helpful first; respects contribution model
- [ ] Respects manual suppressions (6.2.6)

### Acceptance Criteria
- [ ] A practice tagged `churn` surfaces against the churn metric
- [ ] Only scope-appropriate practices surface (6.1.4)
- [ ] Suppressed practices do not surface
- [ ] Ranking sensible (endorsed/helpful first)
- [ ] Unit tests: tag match, scope filtering, suppression respect, ranking
```

---

## 6.2.6 — Manual Override (Pin/Suppress)

```
## 6.2.6 — Manual Override (Pin/Suppress)
Epic: #__ (6.2 Best Practices)

### Scope
Lead precision on top of auto-surfacing: pin a practice to a metric, or suppress one.

### Deliverables
- [ ] Lead can PIN a practice to a specific metric (forces surfacing there)
- [ ] Lead can SUPPRESS an auto-surfaced practice for a metric
- [ ] Stored in practice_metric_pins (6.2.1); merged into the surfacing query
- [ ] Permission-gated to leads/curators

### Acceptance Criteria
- [ ] Pin forces a practice to surface at the chosen metric
- [ ] Suppress removes an auto-surfaced practice from that metric
- [ ] Only leads/curators can pin/suppress (verified)
- [ ] Manual overrides correctly merged with auto-surfacing
- [ ] Unit tests: pin, suppress, permission gating, merge behavior
```

---

## 6.2.7 — Contextual Display Next to Metrics

```
## 6.2.7 — Contextual Display Next to Metrics
Epic: #__ (6.2 Best Practices)

### Scope
The dashboard UI that shows surfaced practices beside the metric (the payoff).

### Deliverables
- [ ] A reusable "related practices" affordance next to metric displays (e.g., a
      churn figure shows a link/panel to relevant practices)
- [ ] Uses 6.2.5 surfacing + 6.2.6 overrides
- [ ] Unobtrusive: present when relevant, never noisy
- [ ] Records a usage view event (feeds 6.2.4)
- [ ] Encouraging tone; never scolding ("here's a practice that may help", not
      "your churn is bad")

### Acceptance Criteria
- [ ] Relevant practices appear next to their metric across the dashboard
- [ ] Affordance is unobtrusive and tonally encouraging (copy reviewed)
- [ ] Viewing a surfaced practice records a usage event
- [ ] Matches aesthetic + dark mode
- [ ] Tests: surfacing in context, usage-event recording, tone
```

---

## 6.2.8 — Browse UI

```
## 6.2.8 — Browse UI
Epic: #__ (6.2 Best Practices)

### Scope
A browsable/searchable best-practices library (the non-contextual discovery path).

### Deliverables
- [ ] List/search practices (uses 6.1.5 search): filter by tag, team, scope
- [ ] Practice detail view (rendered rich content, feedback affordance, version
      history access)
- [ ] Create/edit entry points respecting the active contribution model
- [ ] Cross-link affordance to a showcase that demonstrates the practice (6.3.8)

### Acceptance Criteria
- [ ] Browse + search + filter work (via 6.1.5)
- [ ] Detail view renders rich content and exposes feedback + history
- [ ] Create/edit respects the team's contribution model + permissions
- [ ] Cross-link to a showcase works when present
- [ ] Matches aesthetic + dark mode
- [ ] Tests: browse/filter, detail render, model-aware authoring, cross-link
```

---

# EPIC 6.3 — Showcase

**Parent issue.** Curated exemplar conversations as teaching examples, org-internal
only. Extends the Phase 5 showcase (developer self-publish) with joint curation,
rich annotation, the new scrubber, and best-practice linkage. Built on Epic 6.1 and
reusing the Phase 5 shared store/governance.

### Epic context (inherited by all 6.3.x children)

```
A standout conversation shared as a teaching example. Two publish paths: developer
self-publish (Phase 5 path) OR joint manager+developer curation — DEVELOPER APPROVAL
ALWAYS REQUIRED either way (self = initiate; joint = approve). This is "the
difference between a showcase and surveillance."

A showcase unit = the conversation (turn by turn) + inline developer annotations
anchored to specific turns (the highest-value layer — teaches the reasoning the
transcript can't show) + the outcome (PR/code) + a MANDATORY curators' note +
optional AI prompt-technique annotation (local model, specific-or-silent) + optional
cross-link to a best practice.

Content scrubbing before publish: a NEW auto-flag detector (the proxy-era scanner
was removed — this is new work) with TWO confidence tiers (secrets/keys/credentials
flagged firmly; softer PII as fallible non-blocking hints), PLUS a MANDATORY manual
review that is always required regardless of what auto-flag found.

"How it could be better" is deliberately EXCLUDED here (kept private — see task 6.5).
Org-internal only, never platform-wide. Reuses the Phase 5 shared store + governance.
```

### Cross-cutting acceptance criteria

```
- Developer approval is ALWAYS required before publish, in BOTH paths (the defining
  privacy property — exhaustively verified)
- Nothing is auto-harvested from private captures; publishing is always a deliberate,
  developer-approved act
- Mandatory manual review cannot be bypassed; scrub tiers are visually distinct
- The public showcase carries NO critique (celebratory only)
- Built on 6.1 primitives + reuses the Phase 5 shared store (no duplicate store)
- Integration test: both publish paths → annotate → scrub (both tiers) → mandatory
  review → publish → browse, with developer-approval enforced throughout
```

### Children checklist

```
- [ ] #__ 6.3.1 — Showcase schema (units, annotations, consent, scrub_flags, x-links)
- [ ] #__ 6.3.2 — Dual publish paths (self-publish + joint curation; consent gate)
- [ ] #__ 6.3.3 — Inline developer annotations (anchored to turns)
- [ ] #__ 6.3.4 — Curators' note (mandatory) + outcome linkage
- [ ] #__ 6.3.5 — Auto-flag scrubber (NEW two-tier detector)
- [ ] #__ 6.3.6 — Mandatory manual-review flow
- [ ] #__ 6.3.7 — Optional AI annotation (local, specific-or-silent)
- [ ] #__ 6.3.8 — Showcase ↔ best-practice cross-link
- [ ] #__ 6.3.9 — Browse/governance (extends Phase 5)
```

---

## 6.3.1 — Showcase Schema

```
## 6.3.1 — Showcase Schema
Epic: #__ (6.3 Showcase)

### Schema (companion to contributions; reuse Phase 5 shared store where it fits)
CREATE TABLE showcase_units (
  contribution_id TEXT PRIMARY KEY REFERENCES contributions(id),
  conversation TEXT NOT NULL,           -- redacted conversation content (JSON, turns)
  outcome_link TEXT,                    -- PR/code/goal reference
  curators_note TEXT NOT NULL,          -- MANDATORY (enforced at publish)
  ai_annotation TEXT,                   -- optional, local-model, specific-or-silent
  publish_path TEXT NOT NULL            -- self_publish | joint_curation
);
CREATE TABLE showcase_annotations (
  id TEXT PRIMARY KEY,
  contribution_id TEXT NOT NULL REFERENCES contributions(id),
  turn_ref TEXT NOT NULL,               -- which turn this annotation anchors to
  author_id TEXT NOT NULL,              -- the developer (their reasoning)
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE showcase_consent (
  id TEXT PRIMARY KEY,
  contribution_id TEXT NOT NULL REFERENCES contributions(id),
  developer_id TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0,
  visibility_scope TEXT NOT NULL,       -- team | org (explicit, no default)
  approved_at TEXT
);
CREATE TABLE scrub_flags (
  id TEXT PRIMARY KEY,
  contribution_id TEXT NOT NULL REFERENCES contributions(id),
  tier TEXT NOT NULL,                   -- secret_high | pii_hint_low
  finding TEXT NOT NULL,                -- what/where (for reviewer)
  resolved INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE showcase_practice_links (
  showcase_id TEXT NOT NULL REFERENCES contributions(id),
  practice_id TEXT NOT NULL REFERENCES contributions(id),
  PRIMARY KEY (showcase_id, practice_id)
);

### Acceptance Criteria
- [ ] Migration creates the tables; idempotent
- [ ] curators_note is enforced NOT NULL at publish (gate, not just column)
- [ ] consent carries explicit visibility_scope (no silent default)
- [ ] scrub_flags distinguishes the two tiers
- [ ] Reuses the Phase 5 shared store where it already fits (no duplicate store)
- [ ] Unit tests for the data layer
```

---

## 6.3.2 — Dual Publish Paths (Consent Gate)

```
## 6.3.2 — Dual Publish Paths
Epic: #__ (6.3 Showcase)

### Scope
Both publish paths, unified by the always-required developer-approval gate.

### Behavior
- self_publish: developer promotes from their own retrospective → drafts a unit →
  (annotate, scrub, review) → publishes. Developer is the initiator.
- joint_curation: a manager proposes a conversation → the developer must APPROVE
  (showcase_consent.approved = 1, with explicit visibility_scope) before publish.
  Manager CANNOT publish without that approval.
- Both run through the 6.1.2 flow with a developer-approval gate + the mandatory
  pre-publish scrub/review hook.

### Acceptance Criteria
- [ ] self_publish path works end to end (developer-initiated)
- [ ] joint_curation requires explicit developer approval before publish (verified)
- [ ] A manager CANNOT publish a joint unit without developer approval (verified —
      the defining privacy property)
- [ ] visibility_scope is chosen explicitly in both paths (no default)
- [ ] Consent + scope recorded in showcase_consent + audit trail
- [ ] Unit tests: both paths, approval enforcement, manager-cannot-bypass, scope capture
```

---

## 6.3.3 — Inline Developer Annotations

```
## 6.3.3 — Inline Developer Annotations
Epic: #__ (6.3 Showcase)

### Scope
The highest-value layer: developer comments anchored to specific conversation turns,
explaining reasoning ("I gave it the failing test first on purpose").

### Deliverables
- [ ] Anchor an annotation to a specific turn (turn_ref)
- [ ] Only the conversation's developer-author can write these (their reasoning)
- [ ] Display annotations inline beside the anchored turns
- [ ] Editable before publish (versioned with the unit)

### Acceptance Criteria
- [ ] Annotations anchor correctly to turns and display inline
- [ ] Only the developer-author can author them (verified)
- [ ] Editable pre-publish; changes versioned
- [ ] Tests: anchoring, author restriction, inline display, versioning
```

---

## 6.3.4 — Curators' Note (Mandatory) + Outcome Linkage

```
## 6.3.4 — Curators' Note + Outcome Linkage
Epic: #__ (6.3 Showcase)

### Scope
The mandatory curators' note (what to take away) and the outcome link (PR/code).

### Deliverables
- [ ] Curators' note input — MANDATORY; publish is blocked without it
- [ ] Outcome link field (PR URL / commit / goal description)
- [ ] Both displayed prominently in the unit (the note makes it legible at a glance)

### Acceptance Criteria
- [ ] Publish is blocked if curators_note is empty (verified — hard gate)
- [ ] Outcome link captured and displayed
- [ ] Note + outcome render prominently in the unit
- [ ] Tests: mandatory-note gate, outcome capture, display
```

---

## 6.3.5 — Auto-Flag Scrubber (NEW Two-Tier Detector)

```
## 6.3.5 — Auto-Flag Scrubber
Epic: #__ (6.3 Showcase)

### Scope
NEW focused detector (the proxy-era scanner was removed — this is new work). Flags
likely-sensitive content for human review before publish. TWO confidence tiers.

### Behavior
- HIGH-confidence (tier=secret_high): secrets / API keys / credentials —
  pattern-reliable (key-shaped strings, token patterns, common credential formats).
  Flagged firmly as likely-sensitive.
- LOW-confidence (tier=pii_hint_low): softer PII (names, emails, customer ids) —
  noisy/false-positive-prone. Surfaced as fallible "possible PII" HINTS that draw
  the reviewer's eye. NEVER blocking, NEVER asserted as fact.
- Writes scrub_flags rows; does NOT itself gate publish (the mandatory manual review
  in 6.3.6 is the control). Flag-only, no auto-redaction.

### Acceptance Criteria
- [ ] Secrets/keys/credentials reliably flagged at high confidence (test corpus)
- [ ] Softer PII surfaced as low-confidence hints, clearly distinguished, non-blocking
- [ ] The two tiers are stored + presented distinctly (no blurring)
- [ ] Detector is flag-only (no auto-redaction, no request-path substitution)
- [ ] False-positive-tolerant by design for the PII tier (documented)
- [ ] Unit tests: secret detection corpus, PII-hint corpus, tier separation,
      non-blocking behavior
```

---

## 6.3.6 — Mandatory Manual-Review Flow

```
## 6.3.6 — Mandatory Manual-Review Flow
Epic: #__ (6.3 Showcase)

### Scope
The real safety control: a human must review and confirm before publish, regardless
of what auto-flag found.

### Behavior
- Pre-publish, the curator sees the conversation + all scrub_flags (both tiers,
  visually distinct) and must explicitly confirm review complete
- The curator can redact/edit content to resolve flags
- Publish is BLOCKED until manual review is confirmed — even if auto-flag found
  nothing (auto-flag never substitutes for review)
- Review confirmation recorded in the audit trail (review_event = redacted/approved)

### Acceptance Criteria
- [ ] Publish blocked until manual review is explicitly confirmed (verified)
- [ ] Review is required EVEN WHEN auto-flag found nothing (verified)
- [ ] Curator can redact to resolve flags; redactions versioned
- [ ] Both scrub tiers shown distinctly during review
- [ ] Review confirmation recorded in audit trail
- [ ] Tests: review-required gate, no-auto-flag-still-requires-review, redaction,
      audit
```

---

## 6.3.7 — Optional AI Annotation (Local, Specific-or-Silent)

```
## 6.3.7 — Optional AI Annotation
Epic: #__ (6.3 Showcase)

### Scope
Optional AI annotation on prompt technique — must be SPECIFIC to the actual move
("provides the type signature up front, so the model doesn't guess the interface").
If it can only manage generic praise, it says NOTHING. Local-default model. Visually
marked as clearly AI-generated and secondary.

### Behavior
- Runs on a LOCAL model by default (reuses the Phase 3/5 model-client pattern);
  configurable, but local is the documented default
- "Specific or silent" rule: the prompt instructs the model to name the concrete
  technique or output nothing; generic praise is filtered/suppressed
- Output stored in showcase_units.ai_annotation; rendered as clearly AI + secondary
- Gated by showcase_ai_annotation_enabled setting (6.4)

### Acceptance Criteria
- [ ] Runs on a local model by default; nothing leaves the network for it
- [ ] Produces SPECIFIC technique annotations on good fixtures
- [ ] Produces NOTHING (not generic praise) when it can't be specific (verified)
- [ ] Rendered as clearly AI-generated and visually secondary to human voice
- [ ] Respects the enable/disable setting
- [ ] Tests: local default, specific-or-silent (incl. the silent case), rendering,
      setting gate
```

---

## 6.3.8 — Showcase ↔ Best-Practice Cross-Link

```
## 6.3.8 — Showcase ↔ Best-Practice Cross-Link
Epic: #__ (6.3 Showcase)

### Scope
Lightweight two-way link between a showcase and a best practice it demonstrates.

### Deliverables
- [ ] Link a showcase to a best practice (showcase_practice_links, 6.3.1)
- [ ] Surface the link both ways: showcase shows "demonstrates: <practice>";
      practice shows "see it in action: <showcase>"
- [ ] Respects scope/permissions of both linked items

### Acceptance Criteria
- [ ] A showcase can link to a practice and vice versa
- [ ] The link surfaces on both the showcase and the practice
- [ ] Out-of-scope linked items are not exposed
- [ ] Tests: link creation, two-way surfacing, scope respect
```

---

## 6.3.9 — Browse/Governance (Extends Phase 5)

```
## 6.3.9 — Browse/Governance
Epic: #__ (6.3 Showcase)

### Scope
Consume + govern the showcase, extending the Phase 5 browse/governance.

### Deliverables
- [ ] Showcase gallery: browse/search/filter (via 6.1.5) within access scope
- [ ] Unit detail view: conversation + inline annotations + outcome + curators' note
      + optional AI annotation + cross-links
- [ ] Governance: owner can unpublish; lead can remove from their team's showcase but
      CANNOT publish on a developer's behalf (carry the Phase 5 rule)
- [ ] Removal logged + author notified
- [ ] No path back into anyone's private captures

### Acceptance Criteria
- [ ] Gallery browse/search/filter works within scope
- [ ] Detail view renders all unit components
- [ ] Owner unpublish works; lead remove works; lead CANNOT publish for a dev (verified)
- [ ] Removal logged + author notified
- [ ] No leak from showcase back to private captures (verified)
- [ ] Matches aesthetic + dark mode
- [ ] Tests: browse/filter, detail render, governance rules, no-private-leak
```

---

# 6.4 — Settings Extensions (standalone task, no children)

```
## 6.4 — Settings Extensions
(standalone — not an epic)

### Scope
Consolidate the new Phase 6 settings on the Phase 2 settings system (global default
+ per-team override + permission toggle).

### Settings
- bestpractices_enabled: bool
- bestpractices_contribution_model: top_down | bottom_up | hybrid (per team; default
  top_down)
- showcase_enabled: bool
- showcase_scope_permitted: team_only | org_wide
- showcase_ai_annotation_enabled: bool
- curator_permission: who can act as lead/curator (default: manager/admin role)

### Acceptance Criteria
- [ ] All settings persist + resolve (global + per-team)
- [ ] contribution_model drives 6.2.2; scope_permitted drives showcase scope;
      ai_annotation_enabled drives 6.3.7
- [ ] Per-team override honored only where permitted
- [ ] Non-admins cannot change org policy
- [ ] Settings UI sections present
- [ ] Tests: resolution, gating, that values drive the dependent features
```

---

# 6.5 — Private "How Could This Be Better" Tool (standalone task, no children)

```
## 6.5 — Private "How Could This Be Better" Tool
(standalone — not an epic)

### Scope
The counterpart to the critique deliberately excluded from the public showcase: a
SEPARATE, purpose-built private tool a developer runs on their OWN conversations for
self-directed improvement. Never published. Shares the privacy posture + local-
default model of the Phase 5 retrospective but is its own tool with its own entry
point/UI.

### Behavior
- Developer selects one of their own conversations → runs "how could this be better?"
- Analysis on a LOCAL model by default (cloud only via the Phase 5 double-opt-in if
  the org permits) — raw content stays within org infra by default
- Output is constructive, specific, learning-oriented improvement suggestions
- Fully private to the developer; NEVER published, NEVER manager-visible
- Distinct from the celebratory showcase — this is where sharp feedback lives

### Acceptance Criteria
- [ ] Developer can run it on their own conversations only (scoping verified)
- [ ] Analysis local-default; cloud only under the Phase 5 opt-in + org permission
- [ ] Output is specific + constructive (not generic)
- [ ] Fully private — never published, never manager-visible (verified)
- [ ] Clearly separate from the showcase publish flow (no accidental publish path)
- [ ] Tests: self-scoping, local-default, privacy (no publish/manager path),
      output quality
```

---

## Phase 6 Completion Checklist

```
[ ] Epic 6.1 closed — shared primitives (flow, versioning, inheritance, search) done
[ ] Both features built ON the primitives (no parallel stacks) — verified
[ ] Best practices: 3 contribution models, switchable per team
[ ] Best practices: rich editor; helpful/not-helpful + usage signals
[ ] Best practices surface contextually next to their metric (tag-auto + manual)
[ ] Showcase: both publish paths; developer approval ALWAYS required — verified
[ ] Showcase: inline annotations, mandatory curators' note, outcome link
[ ] Showcase: NEW two-tier scrubber (secrets firm, PII hints) + MANDATORY review
[ ] Showcase: optional AI annotation (local, specific-or-silent)
[ ] Showcase ↔ best-practice cross-links both ways
[ ] Public showcase carries NO critique; 6.5 private tool carries it instead
[ ] Settings (6.4) drive contribution model, scope, AI annotation
[ ] npm test — all pass, incl. developer-approval, mandatory-review, no-private-leak
[ ] Roadmap source-of-truth updated: Phase 6 → DONE
```

**Phase 6 is complete when the improvement layer meets the measurement layer: a
developer sees the right guidance next to the metric that prompted it, teams share
practices in the model that suits them, and standout conversations become teaching
examples — always with the developer's genuine consent, the public surface
celebratory, the sharp critique kept private — all on one shared foundation.**

Next: Phase 7 — Production Hardening & Scale (PostgreSQL, SSO/SAML, RBAC).

---

*End of Document — Toprope Phase 6 Task Tracker*
