# GovProxy — Phase 5 Task Tracker

**Phase 5: Developer Coaching**

12 Tasks | Estimated 4–5 weeks | Largest phase | Privacy-critical

> Each task below is a COMPLETE GitHub issue — schema, formulas, flows, and
> acceptance criteria all inline. A developer should be able to implement any task
> from its issue alone. Phase 5 is privacy-critical: several tasks have privacy
> verification as a hard acceptance criterion, not an afterthought.

---

## Workflow Per Task (same as prior phases)

```
1. Create GitHub Issue (copy the full description below)
2. Create branch: task/5.X-short-name
3. Implement in Claude Code (reference acceptance criteria)
4. Write tests alongside implementation
5. Run full test suite: npm test
6. Push + open PR (reference issue: "Closes #N")
7. AI-assisted code review (paste diff into Claude)
8. Address feedback + re-test
9. Merge to main
10. Tag: v0.5.X
11. Verify against acceptance criteria
```

## Recommended Build Order

```
Pillar 2 first (most value on existing data, git-only friendly):
  5.2 → 5.3
Pillar 1 (available-data coaching):
  5.1
Cross-cutting settings early (others depend on it):
  5.10
Pillar 3 (opt-in capture — most architecturally involved):
  5.4 → 5.5 → 5.6 → 5.7
Showcase:
  5.8 → 5.9
Manager aggregate + close-out:
  5.11 → 5.12
```

Rationale: Pillar 2 (PR/review) delivers real coaching value on data you already
have, works for git-only WMG developers, and de-risks the phase — build and
dogfood it first. Settings (5.10) is a dependency for capture/showcase
permissions, so it comes before Pillar 3. Prompt capture (5.4–5.7) is the
heaviest architecture; showcase (5.8–5.9) builds on the retrospective surface.

## Phase 5 Privacy Principles (apply to EVERY task)

- Individual coaching signals are PRIVATE to the developer; managers see
  AGGREGATE team-level only — never an individual's numbers
- Individual signals framed as WITHIN-DEVELOPER-OVER-TIME (trajectory), never
  cross-developer ranking or snapshot verdict
- Local-by-default privacy floor; external/cloud analysis is a conscious opt-in
- Inferred signals (AI-specific) clearly SEPARATED from factual (all-PR) signals
- Coaching, not surveillance — every signal is a mirror, never a stick
- Tier-aware: works on existing data now (git-only included), strengthens as
  sources connect

---

# TASK 5.2: PR/Review Outcome Metrics Engine

**Branch:** `task/5.2-pr-review-metrics`
**Depends on:** Phase 1 git providers (PR/review data), Phase 1 AI signature
**Estimate:** 3–4 days

### GitHub Issue Description

```
## Task 5.2: PR/Review Outcome Metrics Engine

### Context
The richest coaching signal isn't in prompts — it's in what happens to code AFTER
the AI helps: the PR and its review are the verdict on AI-assisted work. This
engine computes PR/review outcome metrics per developer from git-provider data
already integrated in Phase 1 (GitHub/Bitbucket/GitLab all expose PR/MR + review
data). NO prompt capture required — works for git-only developers today.

Produces TWO clearly-separated metric sets: all-PR (factual) and AI-assisted-PR
(inferred via AI signature, lower confidence).

### Schema (NEW)
CREATE TABLE pr_review_metrics (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  period TEXT NOT NULL,                 -- YYYY-Www or YYYY-MM
  scope_variant TEXT NOT NULL,          -- all_pr | ai_assisted_pr
  -- Outcome signals
  prs_total INTEGER DEFAULT 0,
  prs_merged INTEGER DEFAULT 0,
  rework_rate REAL,                     -- PRs requiring changes / prs_total
  avg_review_rounds REAL,               -- mean review cycles before merge
  review_rejection_rate REAL,           -- PRs sent back for changes / prs_total
  avg_comment_density REAL,             -- review comments / PR, this period
  comment_density_vs_baseline REAL,     -- ratio to developer's own baseline
  avg_time_to_merge_hours REAL,
  review_comments_given INTEGER,        -- reciprocity signal
  -- Combination signal (churn already in git_snapshots)
  avg_churn REAL,                       -- mean churn for these PRs' commits
  combined_signal TEXT,                 -- struggling | healthy_iteration |
                                        -- effective | insufficient_data
  -- Confidence
  basis TEXT NOT NULL,                  -- factual (all_pr) | inferred (ai_assisted_pr)
  computed_at TEXT NOT NULL,
  UNIQUE(developer_id, period, scope_variant)
);

### Formulas
  rework_rate           = prs_requiring_changes / max(prs_total, 1)
  review_rejection_rate = prs_sent_back / max(prs_total, 1)
  avg_review_rounds     = mean(review_cycles_per_pr)
  comment_density        = total_review_comments / max(prs_total, 1)
  comment_density_vs_baseline = this_period_density / max(dev_baseline_density, eps)
  -- baseline = developer's trailing average density (e.g., prior 8 periods)

### Combined signal (churn + review) — the disambiguator
  high_churn  = avg_churn  >= churn_high_threshold      (config, e.g. 0.20)
  high_reject = review_rejection_rate >= reject_threshold (config, e.g. 0.30)
  if not enough PRs (prs_total < min_prs): "insufficient_data"
  elif high_churn and high_reject:        "struggling"
  elif high_churn and not high_reject:    "healthy_iteration"
  elif not high_churn and not high_reject:"effective"
  else:                                   "effective"   (low churn, some reject)

### AI-assisted-PR variant (inferred)
For scope_variant = "ai_assisted_pr", include only PRs whose commits have a high
AI signature (>= ai_signature_threshold, config). basis = "inferred". This is an
inference on an inference (AI signature is already estimated) — label accordingly.
For scope_variant = "all_pr", include all PRs. basis = "factual".

### Deliverables
- [ ] Migration creating pr_review_metrics
- [ ] src/coaching/pr-review/engine.ts computing both scope variants per developer
      per period from git-provider PR/review data
- [ ] Provider-agnostic: works across GitHub/Bitbucket/GitLab via the Phase 1
      provider abstraction (PRs/MRs, review comments, review rounds normalized)
- [ ] Comment-density baseline = developer's own trailing average (within-developer)
- [ ] Combined churn+review signal per the logic above
- [ ] Configurable thresholds (churn_high, reject, ai_signature, min_prs)
- [ ] Computed on the aggregation schedule (after Phase 3 aggregation)
- [ ] Idempotent UPSERT per (developer, period, scope_variant)

### Acceptance Criteria
- [ ] all_pr metrics computed correctly from fixtures (factual, basis="factual")
- [ ] ai_assisted_pr metrics computed from high-AI-signature PRs only
      (basis="inferred")
- [ ] The two variants are stored separately and never merged
- [ ] rework_rate, rejection_rate, review_rounds, comment_density correct
- [ ] comment_density_vs_baseline uses the DEVELOPER'S OWN baseline (within-dev)
- [ ] Combined signal disambiguates correctly: high churn+high reject=struggling;
      high churn+clean=healthy_iteration; low churn+clean=effective
- [ ] insufficient_data when PR count below minimum (no false coaching on thin data)
- [ ] Works identically across GitHub, Bitbucket, GitLab fixtures
- [ ] Divide-by-zero guarded (eps) everywhere
- [ ] Idempotent recompute
- [ ] Unit tests: each formula, both variants, combined-signal branches,
      insufficient-data guard, multi-provider equivalence
```

---

# TASK 5.3: PR/Review Coaching Surface

**Branch:** `task/5.3-pr-review-surface`
**Depends on:** 5.2, Phase 2 dashboard
**Estimate:** 2–3 days

### GitHub Issue Description

```
## Task 5.3: PR/Review Coaching Surface

### Context
Surfaces the 5.2 metrics as coaching — PRIVATE to the developer as a trajectory,
AGGREGATE-only to the manager. This is where the fairness/anti-gaming principles
become concrete UI: no individual numbers to the manager, no cross-developer
ranking, trajectory framing not snapshot verdicts.

### Deliverables
DEVELOPER VIEW (private, their own data only):
- [ ] PR/review coaching panel in the developer's own area
- [ ] Two clearly-separated sections: "All your PRs" (factual) and "Your
      AI-assisted PRs" (inferred, labeled lower-confidence)
- [ ] Trajectory framing: trends over time ("your rework rate on AI-assisted PRs
      rose from 15% to 30% this month"), NEVER a bare snapshot verdict
- [ ] The combined churn+review signal explained in plain language with guidance
      ("high churn + frequent rework suggests reviewing AI output more before
      committing")
- [ ] Gentle, actionable, non-judgmental copy throughout

MANAGER VIEW (aggregate team-level only):
- [ ] Team aggregate trends (all-PR and AI-assisted, separated) — rework rate,
      rejection rate, comment density at TEAM level
- [ ] Team coaching opportunities surfaced ("rising rework on AI-assisted PRs —
      the team might benefit from AI-output-review practices")
- [ ] NO individual developer numbers anywhere in the manager view

### Acceptance Criteria
- [ ] Developer sees ONLY their own PR/review coaching
- [ ] All-PR and AI-assisted sections visually + structurally separated, with
      the AI-assisted one labeled inferred/lower-confidence
- [ ] All individual signals framed as trajectory over time, not snapshot verdict
- [ ] Manager view shows TEAM AGGREGATE only — verified: no individual developer's
      rework/rejection numbers are reachable by a manager anywhere
- [ ] A manager cannot drill from team aggregate into an individual's PR/review
      coaching signal
- [ ] Copy reviewed for coaching (not punitive) tone
- [ ] Matches aesthetic + dark mode
- [ ] Unit/integration tests: developer-scoping, manager-aggregate-only (the
      privacy boundary is the critical test), separation of variants
```

---

# TASK 5.1: Available-Data Coaching

**Branch:** `task/5.1-available-data-coaching`
**Depends on:** Phase 3 aggregates, Phase 4 adoption journey
**Estimate:** 2–3 days

### GitHub Issue Description

```
## Task 5.1: Available-Data Coaching

### Context
Coaching grounded in data the platform already has — works for every developer,
git-only included, no new capture. Delivers the personal insights deferred from
Phase 2, now tier-aware and private.

### Schema (NEW)
CREATE TABLE coaching_signals (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  period TEXT NOT NULL,
  signal_type TEXT NOT NULL,            -- churn_reflection | acceptance_trend |
                                        -- journey_coaching | personal_insight
  basis TEXT NOT NULL,                  -- git_estimate | measured
  observation TEXT NOT NULL,            -- the coaching text (private to dev)
  metric_context TEXT,                  -- JSON: the numbers behind it
  created_at TEXT NOT NULL
);

### Features
- churn_reflection: from git_snapshots churn trend (within-developer). "Your churn
  is elevated vs your baseline — you may be committing AI output before fully
  reviewing it."
- acceptance_trend: from tool data WHERE IT EXISTS (null/absent for git-only — do
  NOT fabricate). "Your acceptance rate has climbed — you're prompting better."
- journey_coaching: interprets the Phase 4 adoption journey. "You've plateaued on
  autocomplete — many developers find agent/chat unlocks a step change."
- personal_insight: tier-aware rule-based insights on the developer's own data

### Deliverables
- [ ] Migration creating coaching_signals
- [ ] src/coaching/available/generator.ts producing the signals above per developer
      per period, tier-aware (git_estimate vs measured basis)
- [ ] Acceptance-trend signals ONLY when tool data exists (honestly absent for
      git-only, never fabricated)
- [ ] All signals within-developer-over-time framing
- [ ] Developer view: a coaching panel showing their own signals (private)
- [ ] Aggregate-only team version for the manager (trends, no individual text)

### Acceptance Criteria
- [ ] Churn reflection generated from the developer's own churn trajectory
- [ ] Acceptance-trend signals absent (not faked) for git-only developers
- [ ] Journey coaching interprets real adoption-journey data
- [ ] basis labeled correctly (git_estimate at launch)
- [ ] All signals private to the developer; manager sees aggregate trends only
- [ ] Within-developer framing (no cross-developer comparison)
- [ ] Unit tests: each signal type, tier-awareness (no fabricated acceptance for
      git-only), privacy scoping
```

---

# TASK 5.10: Coaching Settings & Permissions

**Branch:** `task/5.10-coaching-settings`
**Depends on:** Phase 2 settings system
**Estimate:** 2 days

### GitHub Issue Description

```
## Task 5.10: Coaching Settings & Permissions

### Context
Phase 5 has the most nuanced permission model yet, because many controls are
DEVELOPER-level (their own privacy choices) rather than admin-level. The org sets
the outer boundary of what's permitted; the developer makes their own choices
within it. Build early — capture (5.4) and showcase (5.8) depend on these.

### Settings
ORG / ADMIN level (global default + per-team override, Phase 2 pattern):
- coaching_pillar1_enabled: bool (available-data coaching)
- coaching_pillar2_enabled: bool (PR/review coaching)
- coaching_capture_permitted: bool (is Pillar 3 prompt capture allowed at all)
- coaching_cloud_analysis_permitted: bool (may retrospective use cloud models)
- showcase_enabled: bool
- showcase_scope_permitted: team_only | org_wide
- nudge_default_frequency / nudge_dismissible_default

DEVELOPER level (the developer's own choices, within org permission):
- capture_opt_in: bool (opt-in #1)
- capture_mechanism: local_agent | editor_extension
- capture_recovery_choice: no_recovery | recovery_path
- cloud_analysis_opt_in: bool (opt-in #2, only if org permits)
- nudge_frequency / nudges_enabled

### Deliverables
- [ ] Extend the settings system with org-level keys (reuses Phase 2 key/value
      settings table + resolution)
- [ ] NEW developer-level preferences store (or extend user_preferences) for the
      developer's own coaching choices
- [ ] Resolution logic: a developer-level choice is only honored if the org
      permits it (e.g., cloud_analysis_opt_in is moot if
      coaching_cloud_analysis_permitted is false)
- [ ] Settings UI: admin section (org coaching policy) + developer section
      (my coaching preferences / opt-ins)
- [ ] Clear messaging when an org policy blocks a developer choice
- [ ] API: settings endpoints extended; developer preference endpoints

### Acceptance Criteria
- [ ] Org-level coaching settings persist and resolve (global + per-team)
- [ ] Developer-level choices persist per developer
- [ ] A developer choice is honored ONLY within org permission (cloud opt-in
      ignored if org forbids cloud analysis — verified)
- [ ] Disabling a pillar org-wide hides/disables it everywhere
- [ ] Non-admins cannot change org policy; developers can only change their own
      preferences
- [ ] Clear UI messaging when org policy blocks a developer option
- [ ] Unit tests: org resolution, developer choice, org-gates-developer logic,
      permission boundaries
```

---

# TASK 5.4: Prompt Capture Mechanism

**Branch:** `task/5.4-prompt-capture`
**Depends on:** 5.10 (capture permission/opt-in)
**Estimate:** 4–5 days

### GitHub Issue Description

```
## Task 5.4: Prompt Capture Mechanism

### Context
The opt-in deep layer. Captures a developer's own prompts/responses — under their
control, encrypted, private by default. Developer picks the mechanism: a local
agent OR an editor/IDE extension. Both feed the same encrypted store. This is
opt-in #1; cloud analysis is a separate opt-in #2 (Task 5.7).

### Schema (NEW)
CREATE TABLE prompt_captures (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  session_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  tool TEXT,                            -- which AI tool, if known
  -- Encrypted payload: prompts + responses, encrypted with the dev's key
  ciphertext BLOB NOT NULL,
  encryption_meta TEXT NOT NULL,        -- JSON: algo, iv, key-id ref (NOT the key)
  mechanism TEXT NOT NULL,              -- local_agent | editor_extension
  -- Lightweight non-sensitive metadata (for the dev's own indexing only)
  prompt_count INTEGER,
  created_at TEXT NOT NULL
);

### Encryption
- Payload encrypted at rest, server-side, with a DEVELOPER-CONTROLLED key
  (key management in Task 5.5)
- Server stores ciphertext + encryption_meta only — NEVER the raw key, NEVER
  plaintext at rest
- Standard authenticated encryption (e.g., AES-GCM); per-session IV

### Capture mechanisms (developer picks one)
- Local agent: a lightweight process on the dev's machine that captures their AI
  tool interactions and sends encrypted payloads to the server
- Editor/IDE extension: same capture, delivered via an editor extension
- Both produce identical encrypted prompt_captures rows

### Deliverables
- [ ] Migration creating prompt_captures
- [ ] Capture ingestion endpoint: accepts already-encrypted payloads from
      agent/extension (encryption happens client-side with the dev's key so
      plaintext never reaches the server at rest)
- [ ] Local agent (reference implementation): captures + encrypts + sends
- [ ] Editor extension (reference implementation): same
- [ ] Strict opt-in gate: capture only functions if the developer opted in (5.10)
      AND the org permits capture
- [ ] Server NEVER logs or persists plaintext; verified by design + test
- [ ] Mechanism recorded per capture

### Acceptance Criteria
- [ ] Capture only works when developer opted in AND org permits (else inert)
- [ ] Payloads are encrypted CLIENT-SIDE; server receives only ciphertext
- [ ] Server stores ciphertext + meta; NEVER the key, NEVER plaintext (verified
      by inspecting storage + logs in tests)
- [ ] Both local-agent and editor-extension paths produce valid captures
- [ ] mechanism correctly recorded
- [ ] A developer's captures are scoped to them; no cross-developer access
- [ ] Disabling/opting out stops capture immediately
- [ ] Unit/integration tests: opt-in gating, client-side encryption, no-plaintext
      verification, both mechanisms, scoping
```

---

# TASK 5.5: Key Management & Recovery

**Branch:** `task/5.5-key-management`
**Depends on:** 5.4
**Estimate:** 3 days

### GitHub Issue Description

```
## Task 5.5: Key Management & Recovery

### Context
The developer controls the key to their encrypted captures. At opt-in they choose
their recovery posture: no-recovery (max privacy, data unrecoverable if key lost,
informed) OR a recovery path. CRITICAL: any use of a recovery flow is logged in a
way the DEVELOPER can see — no silent backdoor. The developer can audit whether
their recovery was ever used.

### Schema (NEW — stores recovery METADATA and audit, never the raw key)
CREATE TABLE capture_keys (
  developer_id TEXT PRIMARY KEY REFERENCES developers(id),
  key_id TEXT NOT NULL,                 -- identifier, not the key material
  recovery_choice TEXT NOT NULL,        -- no_recovery | recovery_path
  recovery_blob BLOB,                   -- encrypted recovery material IF chosen
                                        -- (e.g., key wrapped by a recovery secret
                                        --  the dev holds) — null if no_recovery
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE key_recovery_log (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  event TEXT NOT NULL,                  -- recovery_initiated | recovery_completed |
                                        -- recovery_failed
  initiated_by TEXT NOT NULL,           -- who triggered it
  occurred_at TEXT NOT NULL,
  visible_to_developer INTEGER DEFAULT 1
);

### Recovery model
- no_recovery: no recovery_blob stored. Key loss = captures unrecoverable, by
  design. Developer is clearly informed at opt-in.
- recovery_path: developer-held recovery secret wraps the key (recovery_blob).
  Using it requires the developer's recovery secret. EVERY recovery event is
  written to key_recovery_log, surfaced in the developer's own view.
- The server alone can NEVER decrypt captures (it lacks the key and, for
  no_recovery, lacks any recovery material).

### Deliverables
- [ ] Migrations creating capture_keys + key_recovery_log
- [ ] Key setup at capture opt-in: generate/register key_id; store recovery_choice
- [ ] Recovery-path flow: wrap/unwrap key with the developer's recovery secret
- [ ] EVERY recovery action logged to key_recovery_log and shown in the developer's
      view ("your recovery flow was used on <date>")
- [ ] no_recovery path: explicit informed-consent step; no recovery material stored
- [ ] Developer-facing recovery-log view
- [ ] No admin-only path to decrypt a developer's captures (verified by design)

### Acceptance Criteria
- [ ] Developer chooses no_recovery or recovery_path at opt-in
- [ ] no_recovery: no recovery material stored; key loss is unrecoverable (verified)
- [ ] recovery_path: recovery works with the developer's recovery secret
- [ ] EVERY recovery event is logged AND visible to the developer
- [ ] The server cannot decrypt captures on its own (no plaintext key stored)
- [ ] No admin backdoor to read a developer's captures
- [ ] Informed-consent step present for no_recovery
- [ ] Unit tests: both recovery choices, recovery-log visibility, no-silent-recovery,
      server-cannot-decrypt, informed consent
```

---

# TASK 5.6: Real-Time Loop Detection + Prompt-Quality Nudges

**Branch:** `task/5.6-loop-nudges`
**Depends on:** 5.4
**Estimate:** 3 days

### GitHub Issue Description

```
## Task 5.6: Real-Time Loop Detection + Prompt-Quality Nudges

### Context
Lightweight, real-time coaching that runs LOCALLY at the capture layer (agent/
extension) — it does NOT need the heavy retrospective model, so it's instant and
fully private (nothing leaves the machine for these). Loop detection = similarity
matching; nudges = structural checks.

### Schema (NEW — local-origin events; store only non-sensitive metadata)
CREATE TABLE loop_events (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  session_id TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  similar_prompt_count INTEGER,         -- how many similar prompts in the loop
  -- NO prompt content stored here; this is metadata only
  created_at TEXT NOT NULL
);
CREATE TABLE nudge_events (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  session_id TEXT NOT NULL,
  nudge_type TEXT NOT NULL,             -- short_prompt | missing_context |
                                        -- missing_error | repeated_prompt
  delivered_at TEXT NOT NULL,
  dismissed INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

### Loop detection (local, real-time)
  - Maintain a rolling window of recent prompts in the session (local memory)
  - Similarity = token-set Jaccard (or similar) between the new prompt and recent
    ones; if similarity >= threshold for >= N prompts → loop
  - Nudge: "You've sent similar requests a few times. Try including the actual
    error output, or a different framing."
  - Runs ENTIRELY locally; only the loop_event metadata (count, time) optionally
    syncs — never the prompt text

### Prompt-quality nudges (local, real-time)
Structural checks on the outgoing prompt (no model needed):
  - short_prompt: length below threshold
  - missing_context: asks about code but includes no code/file reference
  - missing_error: describes a bug/error but includes no error text
  - Gentle, dismissible, non-blocking. "This prompt is short — including the
    relevant code or error usually gets a better result."

### Deliverables
- [ ] Migrations creating loop_events + nudge_events
- [ ] Loop detector running locally at the capture layer (agent + extension)
- [ ] Structural nudge checks running locally
- [ ] Nudges are gentle, dismissible, never block the developer's action
- [ ] Only non-sensitive metadata persisted (counts, types, timestamps) — NEVER
      prompt content in loop_events/nudge_events
- [ ] Respects nudge settings (frequency, enabled) from 5.10
- [ ] Works for the developer privately; no manager visibility into individual
      loop/nudge events (aggregate-only patterns may inform team coaching in 5.11)

### Acceptance Criteria
- [ ] Loop detection fires on >= N similar prompts (similarity threshold)
- [ ] Loop detection runs locally; prompt text never leaves the machine for it
- [ ] Each nudge type triggers on the right structural condition
- [ ] Nudges are dismissible and never block
- [ ] loop_events/nudge_events store metadata ONLY — no prompt content (verified)
- [ ] Respects nudge frequency/enabled settings
- [ ] No individual loop/nudge data visible to managers
- [ ] Unit tests: loop similarity detection, each nudge condition, no-content
      verification, dismissal, settings adherence
```

---

# TASK 5.7: Session Retrospective

**Branch:** `task/5.7-session-retrospective`
**Depends on:** 5.4, 5.5, 5.10
**Estimate:** 4 days

### GitHub Issue Description

```
## Task 5.7: Session Retrospective

### Context
The deep async coaching feature: an AI coach reviews a developer's captured
session and produces personalized feedback. Analysis DEFAULTS to a LOCAL model so
raw prompts stay within org infrastructure. Cloud analysis is the conscious second
opt-in (opt-in #2), only if the org permits it. Fully private to the developer.

### Schema (NEW)
CREATE TABLE retrospectives (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  session_id TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  analysis_model TEXT NOT NULL,         -- local model name | cloud model name
  analysis_location TEXT NOT NULL,      -- local | cloud
  retrospective_text TEXT NOT NULL,     -- the coaching narrative (private to dev)
  highlights TEXT,                      -- JSON: what worked / what to improve
  created_at TEXT NOT NULL
);

### Analysis flow
1. Developer requests a retrospective for a captured session
2. The session's ciphertext is decrypted TRANSIENTLY using the developer's key
   (plaintext in memory only, never persisted)
3. Analysis runs:
   - DEFAULT: local model (Ollama) — plaintext never leaves org infrastructure
   - OPT-IN #2: cloud model — ONLY if org permits AND developer opted in; the
     developer is clearly informed prompts will be sent externally for this
4. Retrospective text + highlights stored (the analysis OUTPUT, not the raw prompts)
5. Conversational follow-up: developer can ask "why was this flagged?" — same
   model, same privacy rules

### Retrospective content
- What worked well in the session
- Where prompts were underspecified (with specific, kind guidance)
- Where loops burned time/tokens (ties to 5.6 loop events)
- Personalized, within-developer framing, never compared to peers

### Deliverables
- [ ] Migration creating retrospectives
- [ ] src/coaching/retrospective/generator.ts: transient decrypt → analyze → store
      output
- [ ] Local-model-default analysis; cloud only via opt-in #2 + org permission
- [ ] Plaintext exists only transiently in memory; never persisted, never logged
- [ ] Conversational follow-up endpoint (developer asks questions about their own
      retrospective)
- [ ] Clear in-UI indication of where analysis ran (local vs cloud)
- [ ] Fully private to the developer; no manager access ever

### Acceptance Criteria
- [ ] Retrospective generates from a captured session
- [ ] DEFAULT analysis runs on a local model; raw prompts never leave org infra
      (verified)
- [ ] Cloud analysis runs ONLY when org permits AND developer opted in (opt-in #2)
- [ ] Plaintext is never persisted or logged (verified in tests)
- [ ] analysis_location recorded and shown to the developer
- [ ] Conversational follow-up works and stays private
- [ ] No manager can access any individual's retrospective (verified)
- [ ] Within-developer framing; no peer comparison
- [ ] Unit/integration tests: local-default, cloud-opt-in gating, no-plaintext-
      persistence, privacy scoping, follow-up
```

---

# TASK 5.8: Exemplary-Conversation Showcase — Promote/Redact/Publish

**Branch:** `task/5.8-showcase-publish`
**Depends on:** 5.7, 5.10
**Estimate:** 3 days

### GitHub Issue Description

```
## Task 5.8: Exemplary-Conversation Showcase — Promote/Redact/Publish

### Context
The bridge from private self-coaching to organizational learning. A developer can
deliberately share a conversation they're proud of. CRITICAL: sharing is ALWAYS a
deliberate act by the owner — never auto-harvested, never system-selected, never
manager-extracted. The act of publishing IS the act of de-privatizing that one
conversation. Published examples live in a SEPARATE shared store, distinct from
the private encrypted captures.

### Schema (NEW — separate shared store, normal org access controls)
CREATE TABLE showcase_examples (
  id TEXT PRIMARY KEY,
  author_developer_id TEXT NOT NULL REFERENCES developers(id),
  published_at TEXT NOT NULL,
  scope TEXT NOT NULL,                  -- team | org
  scope_target TEXT,                    -- team name if team-scoped
  title TEXT NOT NULL,
  task_type TEXT,                       -- debugging | refactor | feature | etc.
  tool TEXT,                            -- which AI tool
  -- The deliberately-shared, REDACTED conversation content (NOT encrypted with
  -- the dev's private key — it's been made org-visible by the owner's choice)
  content TEXT NOT NULL,
  author_note TEXT,                     -- optional "why this is a good example"
  status TEXT NOT NULL DEFAULT 'published', -- published | unpublished | removed
  created_at TEXT NOT NULL
);

### Promote/redact/publish flow (all owner-initiated)
1. While reviewing their OWN retrospective, the developer chooses "promote this
   conversation"
2. The conversation is decrypted transiently (owner's key) into an editable draft
3. REDACTION STEP (mandatory): the developer reviews and redacts anything
   sensitive before publishing — cannot skip
4. The developer sets scope (team or org, within showcase_scope_permitted), title,
   task_type, optional note
5. Publish → writes to showcase_examples (the separate shared store). The original
   private capture is untouched and remains encrypted.

### Deliverables
- [ ] Migration creating showcase_examples
- [ ] Promote action available ONLY from the developer's own retrospective view
- [ ] Transient decrypt → editable draft (owner's key; plaintext not persisted
      except as the redacted content the owner chooses to publish)
- [ ] MANDATORY redaction step before publish (cannot be skipped)
- [ ] Scope selection respects showcase_scope_permitted (5.10)
- [ ] Publish writes to the separate shared store with normal org access controls
- [ ] The private capture is never modified by publishing
- [ ] Nothing is ever auto-harvested or system-selected — verified by design

### Acceptance Criteria
- [ ] Promote is available ONLY from the owner's own retrospective (no other path)
- [ ] No manager/admin can promote or publish on a developer's behalf
- [ ] Redaction step is mandatory and cannot be bypassed
- [ ] Scope respects org permission (team_only vs org_wide)
- [ ] Published example lands in showcase_examples, separate from prompt_captures
- [ ] The original private capture is unchanged after publishing
- [ ] Nothing is auto-harvested — publishing requires explicit owner action (verified)
- [ ] Unit/integration tests: owner-only promote, mandatory redaction, scope
      permission, store separation, capture-untouched, no-auto-harvest
```

---

# TASK 5.9: Showcase Browse/Discovery + Governance

**Branch:** `task/5.9-showcase-browse`
**Depends on:** 5.8
**Estimate:** 2–3 days

### GitHub Issue Description

```
## Task 5.9: Showcase Browse/Discovery + Governance

### Context
The consumption side of the showcase: others browse and learn from published
examples. Plus governance: owners can unpublish; team leads can remove from their
team's showcase but can NEVER publish on a developer's behalf.

### Deliverables
BROWSE/DISCOVERY:
- [ ] Showcase browse view: list/grid of published examples within the viewer's
      access (team and/or org scope)
- [ ] Filters: task_type, tool, team, scope
- [ ] Example detail view: the redacted conversation + author note + metadata
- [ ] Respects access controls: team-scoped examples visible to that team; org-scoped
      to all

GOVERNANCE:
- [ ] Owner can unpublish their own example (status=unpublished; removed from browse)
- [ ] Team lead can remove an example from THEIR team's showcase (status=removed)
      — but CANNOT publish or edit on a developer's behalf
- [ ] Removal is logged; the author is notified
- [ ] No de-anonymization of private captures via the showcase (only what the owner
      published is ever visible)

### Acceptance Criteria
- [ ] Browse shows published examples within the viewer's access scope
- [ ] Filters work (task_type, tool, team, scope)
- [ ] Team-scoped examples are NOT visible outside the team
- [ ] Owner can unpublish their own example
- [ ] Team lead can remove from their team's showcase but CANNOT publish for a dev
- [ ] Removal logged + author notified
- [ ] No path from the showcase back into anyone's private captures
- [ ] Matches aesthetic + dark mode
- [ ] Unit/integration tests: access-scoped browse, filters, unpublish, lead-remove
      (but not publish), no-private-leak
```

---

# TASK 5.11: Manager Aggregate Coaching Signals

**Branch:** `task/5.11-manager-aggregate-coaching`
**Depends on:** 5.1, 5.2, 5.6
**Estimate:** 2 days

### GitHub Issue Description

```
## Task 5.11: Manager Aggregate Coaching Signals

### Context
What the manager gets from all the coaching pillars: TEAM-LEVEL AGGREGATE patterns
only, framed as team coaching opportunities — never any individual's coaching data.
This is the single most privacy-sensitive manager surface in the product; the
defining test is that NO individual coaching signal is ever reachable.

### Deliverables
- [ ] Team aggregate coaching panel (manager view):
      - Aggregate PR/review trends (all-PR + AI-assisted, separated) at team level
      - Aggregate churn/effectiveness trends at team level
      - Aggregate (anonymized) loop/nudge patterns from opted-in developers ONLY
        ("several developers hit loops on debugging — a debugging template may help")
      - Team coaching opportunities surfaced as suggestions
- [ ] Strict aggregation: minimum group size before any aggregate shows (avoid
      de-anonymization when a team is tiny — e.g., require >= N developers)
- [ ] NO drill-down to individuals from any coaching aggregate
- [ ] Only opted-in developers' data contributes to capture-derived aggregates

### Acceptance Criteria
- [ ] Manager sees team-level coaching aggregates only
- [ ] NO individual coaching signal is reachable from any manager view (the
      critical privacy test — exhaustively verified)
- [ ] Minimum-group-size guard prevents de-anonymization on small teams
- [ ] Capture-derived aggregates include ONLY opted-in developers
- [ ] Aggregates framed as team coaching opportunities, not judgments
- [ ] Unit/integration tests: aggregate-only enforcement, no-individual-drilldown,
      min-group-size guard, opted-in-only inclusion
```

---

# TASK 5.12: Phase 5 Integration Testing + Privacy Verification + Dogfood

**Branch:** `task/5.12-integration-privacy-dogfood`
**Depends on:** all prior Phase 5 tasks
**Estimate:** 2–3 days

### GitHub Issue Description

```
## Task 5.12: Phase 5 Integration Testing + Privacy Verification + Dogfood

### Context
Phase 5 is privacy-critical. Beyond normal integration testing, this task does a
dedicated, exhaustive PRIVACY VERIFICATION pass — because a single leak of
individual coaching data would break the trust the whole product depends on.

### Deliverables
FUNCTIONAL E2E:
- [ ] Pillar 2 E2E: PR/review metrics → developer-private surface + manager
      aggregate, across GitHub/Bitbucket/GitLab data
- [ ] Pillar 1 E2E: available-data coaching for a git-only developer
- [ ] Pillar 3 E2E: opt-in → capture (both mechanisms) → local loop/nudges →
      local-model retrospective → (cloud opt-in path) → key recovery flow
- [ ] Showcase E2E: promote → mandatory redact → publish → browse → unpublish →
      lead-remove

PRIVACY VERIFICATION (the critical pass):
- [ ] Verify NO individual coaching signal (PR/review, churn, loops, nudges,
      retrospectives) is reachable by any manager/admin anywhere
- [ ] Verify capture plaintext never persisted or logged server-side
- [ ] Verify server cannot decrypt captures on its own; no admin backdoor
- [ ] Verify recovery events are logged and visible to the developer
- [ ] Verify local-model-default retrospective; cloud only on double-opt-in + org
      permission
- [ ] Verify showcase publishing is always owner-initiated; nothing auto-harvested;
      private captures untouched by publishing
- [ ] Verify min-group-size guard on manager aggregates
- [ ] Verify all-PR vs AI-assisted variants never blurred; inferred clearly labeled

DOGFOOD:
- [ ] Dogfood Pillar 2 with real WMG git-only data (the highest-value, no-opt-in
      coaching) and sanity-check the signals against developers whose work you know
- [ ] Update setup/onboarding doc with Phase 5
- [ ] Update roadmap source-of-truth: Phase 5 → DONE with feature inventory; bump
      version + changelog

### Acceptance Criteria
- [ ] All functional E2E flows pass
- [ ] EVERY item in the privacy-verification list passes (this is the gate)
- [ ] Pillar 2 dogfooded on real WMG data; signals sane
- [ ] Onboarding doc updated
- [ ] Roadmap source-of-truth updated (Phase 5 → DONE)
```

---

## Phase 5 Completion Checklist

```
[ ] Pillar 1: available-data coaching works for git-only developers (private)
[ ] Pillar 2: PR/review metrics — all-PR + AI-assisted, clearly separated
[ ] Pillar 2: individual signals private + within-developer-over-time framing
[ ] Pillar 2: manager sees TEAM AGGREGATE only (no individual numbers) — verified
[ ] Pillar 3: opt-in capture, both mechanisms (local agent + editor extension)
[ ] Pillar 3: client-side encryption; server never holds plaintext or the key
[ ] Pillar 3: developer-chosen recovery; recovery use logged + visible to developer
[ ] Pillar 3: loop detection + nudges run locally/real-time; metadata only
[ ] Pillar 3: retrospective local-model-default; cloud = conscious double-opt-in
[ ] Showcase: owner-only promote → mandatory redact → publish; never auto-harvested
[ ] Showcase: separate shared store; private captures untouched by publishing
[ ] Showcase: browse with access scoping; owner unpublish; lead-remove (not publish)
[ ] Manager aggregates: no individual coaching data reachable; min-group-size guard
[ ] Settings: org policy + developer choices; org gates developer options
[ ] Privacy verification pass complete — every item passes (the gate)
[ ] npm test — all pass, including the no-plaintext and no-individual-leak tests
[ ] Roadmap source-of-truth updated: Phase 5 → DONE
```

**Phase 5 is complete when a developer opens their private coaching view and finds
it genuinely useful — a mirror that helps them improve, grounded in what happened
to their code — while the manager sees only team-level patterns, and a developer
can deliberately share their best AI conversation for others to learn from. The
product has become something developers want, not something they tolerate.**

Next: Phase 6 — Production Hardening & Scale (PostgreSQL, SSO/SAML, RBAC).

---

*End of Document — GovProxy Phase 5 Task Tracker*
