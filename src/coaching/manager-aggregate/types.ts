/**
 * Manager Aggregate Coaching Signals — shared types (Task 5.11 / #132).
 *
 * This is the single most privacy-sensitive manager surface in the product. The
 * manager gets, from all three coaching pillars, TEAM-LEVEL AGGREGATE patterns
 * only — framed as team coaching opportunities, never any individual's coaching
 * data. The defining invariant: NO individual coaching signal is ever reachable.
 *
 * The two existing aggregates (PR/review §5.3, available-data churn §5.1) already
 * carry their own k-anonymity floor. The NEW surface here is the loop/nudge
 * pattern aggregate (Pillar 3), which is built from CAPTURE-DERIVED data and so
 * must additionally include ONLY opted-in developers — plus the cross-pillar
 * "team coaching opportunities" the panel synthesizes from all three.
 *
 * Every shape below is snake_case (the API wire convention shared by every
 * sibling coaching payload). No type here carries a developer id, an observation
 * sentence, or any single individual's number — the boundary is structural.
 */

import type {NudgeType} from '../realtime/types';
import type {PeriodUnit} from '../period-window';
import type {TeamPRReviewCoaching} from '../pr-review/types';
import type {TeamCoaching} from '../available/types';

/**
 * One aggregated count cell (loops, or one nudge type) with its OWN min-group-size
 * guard. A cell is suppressed when fewer than the floor of distinct opted-in
 * developers contributed to it — and a suppressed cell carries NO numbers, only
 * the marker, so it can never reveal that (say) exactly one developer hit a
 * pattern. Flooring per cell, not just for the block as a whole, is what stops a
 * thin pattern from de-anonymizing an individual inside an otherwise-large cohort.
 */
export interface LoopNudgeCell {
    /** True when fewer than the min-group-size floor of developers contributed. */
    suppressed: boolean;
    /** Distinct opted-in developers who contributed — null when suppressed. */
    developers: number | null;
    /** Total events across those developers — null when suppressed. */
    total: number | null;
}

/** A nudge-type cell: the structural nudge type plus its floored count cell. */
export interface LoopNudgeTypeCell extends LoopNudgeCell {
    nudge_type: NudgeType;
}

/**
 * The Pillar 3 loop/nudge pattern aggregate for a scope. Built ONLY from
 * opted-in developers' synced metadata (counts + nudge types — never prompt
 * content, which the schema cannot store anyway). Each cell is independently
 * floored, so any number that survives represents at least the floor of
 * developers.
 */
export interface LoopNudgeAggregate {
    scope: string;
    period_unit: PeriodUnit;
    /**
     * Developers in scope who have effectively opted into capture (org-permission
     * gated). This is an ELIGIBILITY count, not a coaching signal — it tells the
     * UI how much of the team's pattern data is even available, and lets it
     * explain a fully-suppressed view ("only N developers opted in"). It is NOT
     * floored: it names no pattern and no individual, just how many chose in.
     */
    opted_in_developers: number;
    /** Distinct opted-in developers who hit a detection loop in the window (floored). */
    loops: LoopNudgeCell;
    /** One floored cell per nudge type, stable order, suppressed cells included. */
    nudges: LoopNudgeTypeCell[];
}

/**
 * The pillar a coaching opportunity was derived from — purely so the UI can group
 * and label suggestions by where the signal came from.
 */
export type OpportunityPillar = 'pr_review' | 'available' | 'loop_nudge';

/**
 * A single team coaching opportunity: a suggestion framed as a team-level
 * opportunity ("a debugging template may help"), NEVER a judgment of any
 * individual or even of the team. Derived strictly from already-aggregated,
 * already-floored inputs — an opportunity can only exist when its underlying
 * aggregate cleared the floor, so surfacing one never leaks an individual.
 */
export interface TeamCoachingOpportunity {
    /** Stable id for keys/testing (e.g. 'rework_rising', 'nudge_missing_context'). */
    id: string;
    pillar: OpportunityPillar;
    /** Short headline, e.g. "Rising rework on AI-assisted PRs". */
    title: string;
    /** The opportunity framing — a suggestion, never a verdict on a person. */
    suggestion: string;
}

/**
 * The unified manager coaching panel for one scope (org or a team). Bundles the
 * three pillar aggregates plus the synthesized opportunities behind a single
 * admin-only surface, so the "team aggregate only, no individual drill-down"
 * guarantee flows through ONE place. Each pillar carries its own enabled flag so
 * a pillar disabled by org/team policy (Task 5.10) is simply absent here too.
 */
export interface ManagerCoachingPanel {
    scope: string;
    period_unit: PeriodUnit;
    /** Pillar 2 PR/review aggregate, or {enabled:false} when the pillar is off. */
    pr_review: PillarSection<TeamPRReviewCoaching>;
    /** Pillar 1 available-data (churn/effectiveness) aggregate, or disabled. */
    available: PillarSection<TeamCoaching>;
    /**
     * Pillar 3 loop/nudge pattern aggregate (opted-in only), or disabled. Gated by
     * whether capture is permitted at the scope — when capture isn't permitted
     * there is, by construction, no opted-in cohort to aggregate.
     */
    loop_nudge: PillarSection<LoopNudgeAggregate>;
    /** Cross-pillar team coaching opportunities, framed as suggestions. */
    opportunities: TeamCoachingOpportunity[];
}

/**
 * A pillar section discriminated by `enabled`, mirroring the per-pillar response
 * shape the existing manager endpoints already use, so the UI narrows the same
 * way everywhere: `{enabled:false}` → hidden; `{enabled:true, ...}` → render.
 */
export type PillarSection<T> = {enabled: false} | ({enabled: true} & T);
