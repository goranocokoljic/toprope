/**
 * Team coaching opportunities — cross-pillar synthesis (Task 5.11 / #132).
 *
 * Turns the three already-aggregated, already-floored manager inputs into a short
 * list of TEAM COACHING OPPORTUNITIES — suggestions a lead can act on ("a
 * debugging template may help"), deliberately framed as opportunities and never
 * as judgments of any individual or even of the team.
 *
 * The privacy property is inherited, not re-derived: every input cell this module
 * reads has ALREADY passed its pillar's min-group-size floor (suppressed cells
 * carry null and are skipped), and none carries a developer id. So an opportunity
 * can only ever be produced from a pattern that at least the floor of developers
 * share — surfacing one can never single anyone out. This module is pure (no DB)
 * so that guarantee is directly unit-testable.
 */

import type {NudgeType} from '../realtime/types';
import type {TeamCoaching, TeamCoachingPoint} from '../available/types';
import type {TeamPRReviewCoaching, TeamVariantTrajectory} from '../pr-review/types';
import type {LoopNudgeAggregate, TeamCoachingOpportunity} from './types';

/**
 * A rising rework trend on a PR variant becomes an opportunity. Read only when the
 * variant had enough floored periods to establish a direction — `rework_trend` is
 * computed solely from non-suppressed team points, so a 'rising' direction already
 * reflects a team pattern, not one developer.
 */
function prReviewOpportunity(
    variant: TeamVariantTrajectory,
    id: string,
    title: string,
    suggestion: string,
): TeamCoachingOpportunity | null {
    if (variant.sufficient_periods > 0 && variant.rework_trend.direction === 'rising') {
        return {id, pillar: 'pr_review', title, suggestion};
    }
    return null;
}

/** The most recent non-suppressed point of a signal series, or null if all suppressed. */
function latestSufficientPoint(series: TeamCoaching['series'][number] | undefined): TeamCoachingPoint | null {
    if (!series) return null;
    for (let i = series.points.length - 1; i >= 0; i--) {
        if (!series.points[i].suppressed) return series.points[i];
    }
    return null;
}

/** The category with the highest count in a point's breakdown (ties → first seen). */
function dominantCategory(point: TeamCoachingPoint): string | null {
    if (!point.categories) return null;
    let best: string | null = null;
    let bestCount = 0;
    for (const [category, count] of Object.entries(point.categories)) {
        if (count > bestCount) {
            best = category;
            bestCount = count;
        }
    }
    return bestCount > 0 ? best : null;
}

/** Human-facing copy for each structural nudge type, framed as a team opportunity. */
const NUDGE_OPPORTUNITY: Record<NudgeType, {title: string; suggestion: string}> = {
    short_prompt: {
        title: 'Prompts are often very short',
        suggestion:
            'Several developers were nudged about very short prompts. A shared "good prompt" example or template may help the team get more from each request.',
    },
    missing_context: {
        title: 'Prompts often miss context',
        suggestion:
            'Missing-context nudges are common across the team. A lightweight context checklist (files, goal, constraints) may help developers get better first answers.',
    },
    missing_error: {
        title: 'Error text is often left out',
        suggestion:
            'Several developers were nudged to include the actual error. Encouraging pasting full error output may cut back-and-forth on debugging.',
    },
    repeated_prompt: {
        title: 'Prompts are often repeated',
        suggestion:
            'Repeated-prompt nudges are common. When a request is not landing, a reusable template or a different framing often helps more than re-asking.',
    },
};

/**
 * Synthesize the team coaching opportunities for one scope from the three pillar
 * aggregates. Inputs may be null when a pillar is disabled for the scope (Task
 * 5.10) — a disabled pillar simply contributes no opportunities. Output order is
 * stable (PR/review, churn, loops, then nudges in their canonical order) so the
 * panel renders deterministically.
 */
export function deriveTeamOpportunities(
    prReview: TeamPRReviewCoaching | null,
    available: TeamCoaching | null,
    loopNudge: LoopNudgeAggregate | null,
): TeamCoachingOpportunity[] {
    const out: TeamCoachingOpportunity[] = [];

    // ── Pillar 2: PR/review rework trends ──────────────────────────────────
    if (prReview) {
        const allPr = prReviewOpportunity(
            prReview.all_pr,
            'rework_rising_all_pr',
            "Rising rework on the team's PRs",
            "The team's rework rate has been rising. Smaller PRs and earlier review may help — this is a team trend, not any one developer's number.",
        );
        if (allPr) out.push(allPr);

        const aiPr = prReviewOpportunity(
            prReview.ai_assisted,
            'rework_rising_ai_assisted',
            'Rising rework on AI-assisted PRs',
            'Rework on AI-assisted PRs has been rising (an inferred signal). Reviewing AI-generated changes as carefully as hand-written ones, and sharing prompt patterns that worked, may help.',
        );
        if (aiPr) out.push(aiPr);
    }

    // ── Pillar 1: elevated team churn ──────────────────────────────────────
    if (available) {
        const churnSeries = available.series.find((s) => s.signal_type === 'churn_reflection');
        const point = latestSufficientPoint(churnSeries);
        if (point && dominantCategory(point) === 'elevated') {
            out.push({
                id: 'churn_elevated',
                pillar: 'available',
                title: 'Code churn is elevated across the team',
                suggestion:
                    'Churn has been elevated for several developers recently. Healthy iteration and struggle look the same in churn alone — pairing or earlier review can help the team tell them apart. No individual figures are shown.',
            });
        }
    }

    // ── Pillar 3: loop/nudge patterns (opted-in only, already floored) ──────
    if (loopNudge) {
        if (!loopNudge.loops.suppressed) {
            out.push({
                id: 'loops_common',
                pillar: 'loop_nudge',
                title: 'Several developers hit detection loops',
                suggestion:
                    'Several opted-in developers hit repeat-prompt loops recently. A shared debugging template or a "step back and re-frame" habit may help — derived from anonymized, opted-in patterns only.',
            });
        }
        for (const cell of loopNudge.nudges) {
            if (!cell.suppressed) {
                const copy = NUDGE_OPPORTUNITY[cell.nudge_type];
                out.push({
                    id: `nudge_${cell.nudge_type}`,
                    pillar: 'loop_nudge',
                    title: copy.title,
                    suggestion: copy.suggestion,
                });
            }
        }
    }

    return out;
}
