# AI Maturity Score — Calibration Notes

**Status:** launch (git-only / `git_estimate` basis). Recorded at the close of
Phase 3 (Task 3.13) for future tuning. These notes capture how the score behaves
against teams whose habits we know, what feels right, and what to re-check once
direct tool-usage connectors come online and the basis moves to `mixed` /
`measured`.

> The score is always labelled a **git-based estimate** at launch. Nothing here
> changes that label — it is a sanity-check of the *number*, not a claim that it
> measures direct tool usage.

---

## What the score is

A composite 0–100 per team per period (`src/aggregation/maturity.ts`), weighted:

| Component | Weight | Git-only input |
|-----------|-------:|----------------|
| `adoption_breadth` | 0.30 | active developers / team size |
| `adoption_consistency` | 0.25 | mean(active_days / possible_days) per member |
| `output_health` | 0.20 | PR-throughput trend, centred at 0.5 |
| `churn_quality` | 0.15 | `1 − avg_code_churn` (low churn = high quality) |
| `cost_efficiency` | 0.10 | team cost-per-PR vs the org average |

Adoption (breadth + consistency) is **55% of the weight by design** — at launch,
*whether and how regularly* a team is shipping is the most trustworthy git signal;
churn and cost are supporting evidence.

---

## Calibration run (Task 3.13)

A representative git-only org was seeded with a deliberate adoption gradient and
run through the real backfill + rollup pipeline
(`tests/integration/phase3-pipeline.test.ts`). The three teams, and the scores
the formula produced for 2026-Q2:

| Team | Adoption | Churn | Cost/PR | **Maturity (Q2)** |
|------|----------|------:|--------:|------------------:|
| **backend** — both devs active, low churn, steady PRs | 2/2 active | 0.165 | $2.38 | **65** |
| **frontend** — both active, higher churn | 2/2 active | 0.335 | $4.75 | **64** |
| **platform** — one active dev + one idle seat, high churn | 1/2 active | 0.52 | $19.00 | **45** |

**Ordering holds:** strong → moderate → weak ⇒ 65 → 64 → 45. The pipeline test
asserts this ordering so a future weighting change that breaks it fails CI.

### Does the number feel right?

- **Yes, directionally.** A team with one of two seats idle and high churn
  landing at **45** (a clear "needs attention") versus fully-engaged teams in the
  **mid-60s** matches our intuition about these habits.
- **The 45 is adoption-driven, not churn-driven.** platform loses most of its
  points to `adoption_breadth` (one idle seat halves it to 0.5 → −15 pts of the
  30 available) — exactly the design intent: *low adoption scores low even when
  other signals are fine.*

### The calibration surprise worth recording

**backend (65) and frontend (64) are nearly tied** despite frontend having ~2×
the churn and a higher cost-per-PR. The reason: both teams have **identical
adoption breadth and consistency** (2/2 active, same cadence), so they share 55%
of the score, and churn (0.15) + cost (0.10) can only move the remaining 25
points. The churn gap (0.165 vs 0.335) is worth ≈2.5 points; cost a fraction
more.

**Implication for tuning:** at launch the score is **adoption-dominated**. Two
teams with the same activity cadence will read close together regardless of code
quality. That is acceptable — and arguably correct — for a *git-based adoption*
estimate, but it means the score should **not** yet be read as a code-quality
ranking. If we later want quality to separate otherwise-similar teams more, raise
the `churn_quality` weight (and add an acceptance-quality component once tool data
exists) rather than reading more into small gaps than the weighting supports.

---

## Boundary behaviour (verified)

- **0–100 always.** Every component is clamped to [0,1]; the unit tests
  (`tests/aggregation/maturity.test.ts`) cover extremes. No fixture has ever
  produced an out-of-range score.
- **Empty period → null, not 0.** A quarter with no registered developers yields
  a `null` score (and `null` basis on the org fold), never a misleading 0. The
  pipeline test relies on this for the pre-activity quarters.
- **First period → null delta.** No prior period ⇒ `maturity_score_delta` is null,
  not a fabricated 0% movement.

---

## Re-calibrate when tool connectors land

The score is built to keep its 0–100 scale and meaning as the basis upgrades, so
**trend history built now stays valid**. When direct tool usage connects:

1. `adoption_breadth` / `adoption_consistency` become *measured* (tool activity)
   rather than inferred from git — expect the adoption components to firm up and,
   for teams that are active in git but light in the tools, possibly drop.
2. Add the planned **acceptance-quality** component; rebalance weights. Re-run
   this calibration table and confirm the strong→moderate→weak ordering still
   holds against the same known teams.
3. `ai_maturity_basis` moves `git_estimate` → `mixed` → `measured`. Re-read the
   adoption-dominated caveat above: once adoption is measured, churn/cost gaps may
   deserve more weight.

Keep this file updated each time the weighting or component set changes — it is
the record of *why* the numbers look the way they do.
