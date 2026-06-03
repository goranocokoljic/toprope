/**
 * AI maturity score (Task 3.4 / #73).
 *
 * A composite 0–100 score per team per period giving leadership one number for
 * "how mature is our AI adoption." At launch every component is derived from git
 * signals and the score is labelled a **git-based estimate** (ai_maturity_basis =
 * 'git_estimate'). The score is deliberately computed now — before tool
 * connectors land — so trend history exists from day one; the honest labelling
 * keeps it from implying measured usage it doesn't have.
 *
 * The module is split in two:
 *   - `computeMaturityScore` — the pure formula. No DB, fully unit-testable, and
 *     the single place the weights and component math live.
 *   - `computeTeamMaturity` / `computeOrgAvgCostPerPr` — thin DB-aware glue that
 *     gathers the inputs (prior-period PR trend, the org-average benchmark) the
 *     two rollup jobs (quarterly, yearly) feed into the pure formula.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EXTENSION POINT — full composition (FUTURE, do not implement now)
 *
 * When tool connectors arrive the SAME 0–100 score gains directly-measured
 * components without its scale or meaning changing, so the trend history built
 * now stays valid. The planned full formula:
 *
 *   adoption_breadth     — measured from tool usage (devs with a real usage
 *                          signal / total), not inferred from git activity
 *   adoption_consistency — measured active days from tool usage
 *   output_health        — unchanged (git PR throughput trend)
 *   churn_quality        — unchanged (git churn)
 *   cost_efficiency      — includes tool/API spend, not just subscriptions
 *   acceptance_quality   — NEW component: tool acceptance rate
 *
 *   weights rebalance across the six components (the exact split is decided when
 *   the data exists); ai_maturity_basis becomes 'mixed' while only some teams
 *   have tool data, then 'measured' once all components are measured.
 *
 * To extend: add the new component(s) to MaturityComponents + MaturityInputs,
 * branch the basis from the inputs (e.g. a `measured` flag per component), and
 * adjust COMPONENT_WEIGHTS. The pure-function shape stays the same.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type Database from 'better-sqlite3';
import {round, meanOrNull} from './compute';
import {inclusiveDayCount} from './dates';
import {countPctChange} from './deltas';
import {computeTeamPeriodMetrics, listTeams, type MaturityBasis, type TeamPeriodMetrics} from './team-period';

/**
 * Component weights for the git-only launch composition. Sum to exactly 1.0, so
 * a weighted mean of components each in [0,1] yields a value in [0,1] and the
 * final ×100 score is in [0,100] by construction — no extra clamp needed.
 */
export const COMPONENT_WEIGHTS = {
    adoption_breadth: 0.3,
    adoption_consistency: 0.25,
    output_health: 0.2,
    churn_quality: 0.15,
    cost_efficiency: 0.1,
} as const;

/** Neutral 0.5 — used when a component has no data to push the score either way. */
const NEUTRAL = 0.5;

/** Each component's normalized [0,1] value, retained for transparency/tests. */
export interface MaturityComponents {
    adoption_breadth: number;
    adoption_consistency: number;
    output_health: number;
    churn_quality: number;
    cost_efficiency: number;
}

/** The raw signals the maturity formula consumes (already folded to team level). */
export interface MaturityInputs {
    developer_count: number;
    active_developer_count: number;
    /** active_days for each team member over the period. */
    member_active_days: number[];
    /** Inclusive day count of the period — the possible active days per member. */
    possible_days: number;
    /**
     * Team PR-throughput trend vs the prior period, as a percentage change.
     * Null = no prior period to compare against (first period), treated as a
     * neutral (flat) trend.
     */
    prs_merged_delta_pct: number | null;
    /** Team average code churn rate (0–1). Null = no git churn data this period. */
    avg_code_churn: number | null;
    /** Team cost per merged PR for the period. Null = no PRs merged (no ratio). */
    cost_per_pr: number | null;
    /** Org-average cost per PR across teams for the same period (the benchmark). */
    org_avg_cost_per_pr: number | null;
}

export interface MaturityResult {
    /** 0–100, rounded to an integer. Null when the team had no developers. */
    ai_maturity_score: number | null;
    /** 'git_estimate' at launch — every component is git-derived. */
    ai_maturity_basis: MaturityBasis;
    /** The normalized component values behind the score (for hover/expand + tests). */
    components: MaturityComponents;
}

/** Clamp to the [0,1] band every component must live in before weighting. */
function clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
}

/**
 * cost_efficiency benchmarks the team's cost-per-PR against the org average:
 * ~0.5 at the benchmark, higher when the team is cheaper per PR, lower when
 * pricier. Neutral 0.5 when there is no benchmark or no team ratio to compare
 * (no PRs, or a zero/absent org average), since "no data" must not be read as
 * either efficient or wasteful.
 */
function costEfficiency(teamCostPerPr: number | null, orgAvgCostPerPr: number | null): number {
    if (teamCostPerPr === null || orgAvgCostPerPr === null || orgAvgCostPerPr <= 0) {
        return NEUTRAL;
    }
    // At the benchmark (team == org): 1 - org/(2·org) = 0.5. Cheaper → toward 1;
    // pricier → org/(2·team) decays toward 0. Clamped for the free-PR (0 cost) edge.
    const raw =
        teamCostPerPr <= orgAvgCostPerPr
            ? 1 - teamCostPerPr / (2 * orgAvgCostPerPr)
            : orgAvgCostPerPr / (2 * teamCostPerPr);
    return clamp01(raw);
}

/**
 * The pure maturity formula. Folds the team signals into five [0,1] components,
 * weights them, and scales to 0–100. Returns the component values alongside the
 * score so the basis is inspectable. A team with no developers yields a null
 * score (nothing to measure), mirroring how utilization_rate is null there.
 */
export function computeMaturityScore(inputs: MaturityInputs): MaturityResult {
    // adoption_breadth — share of the team showing any (git) activity.
    const adoptionBreadth =
        inputs.developer_count > 0 ? inputs.active_developer_count / inputs.developer_count : 0;

    // adoption_consistency — mean of each member's active_days / possible_days.
    // Per-member ratio is clamped so a stray extra snapshot day can't exceed 1.
    const consistencyRatios =
        inputs.possible_days > 0
            ? inputs.member_active_days.map((d) => clamp01(d / inputs.possible_days))
            : [];
    const adoptionConsistency = meanOrNull(consistencyRatios) ?? 0;

    // output_health — PR-throughput trend, centred at 0.5. A null trend (first
    // period / no PRs either side) is neutral, neither rewarded nor penalised.
    const outputHealth = clamp01(0.5 + (inputs.prs_merged_delta_pct ?? 0) / 200);

    // churn_quality — inverse of churn (low churn = cleaner output). Neutral when
    // no member reported churn, so a no-git-data period doesn't read as flawless.
    const churnQuality = inputs.avg_code_churn === null ? NEUTRAL : clamp01(1 - inputs.avg_code_churn);

    // cost_efficiency — team cost-per-PR vs the org-average benchmark.
    const costEff = costEfficiency(inputs.cost_per_pr, inputs.org_avg_cost_per_pr);

    const components: MaturityComponents = {
        adoption_breadth: round(adoptionBreadth, 4),
        adoption_consistency: round(adoptionConsistency, 4),
        output_health: round(outputHealth, 4),
        churn_quality: round(churnQuality, 4),
        cost_efficiency: round(costEff, 4),
    };

    // No developers → no score to give. Components are reported as computed
    // (all neutral/zero) for transparency, but the headline number is null.
    if (inputs.developer_count <= 0) {
        return {ai_maturity_score: null, ai_maturity_basis: 'git_estimate', components};
    }

    const weighted =
        COMPONENT_WEIGHTS.adoption_breadth * adoptionBreadth +
        COMPONENT_WEIGHTS.adoption_consistency * adoptionConsistency +
        COMPONENT_WEIGHTS.output_health * outputHealth +
        COMPONENT_WEIGHTS.churn_quality * churnQuality +
        COMPONENT_WEIGHTS.cost_efficiency * costEff;

    return {
        ai_maturity_score: Math.round(weighted * 100),
        ai_maturity_basis: 'git_estimate',
        components,
    };
}

/**
 * The org-average cost-per-PR benchmark for a period: the mean of each team's
 * cost_per_pr over the same [start, end] window. Teams with no merged PRs (null
 * cost_per_pr) are excluded — a team that shipped nothing has no per-PR cost to
 * average and shouldn't drag the benchmark toward zero. Null when no team has a
 * ratio (no PRs org-wide), which leaves cost_efficiency neutral downstream.
 *
 * Folds every team's metrics, so callers that need it for many teams in one
 * period (the all-teams rollup) should compute it once and pass it down rather
 * than recomputing per team.
 */
export function computeOrgAvgCostPerPr(
    db: Database.Database,
    start: string,
    end: string,
): number | null {
    const ratios: number[] = [];
    for (const team of listTeams(db)) {
        const metrics = computeTeamPeriodMetrics(db, team, start, end);
        if (metrics.cost_per_pr !== null) {
            ratios.push(metrics.cost_per_pr);
        }
    }
    return round(meanOrNull(ratios), 2);
}

/**
 * Compute a team's maturity score for a period from its already-folded metrics.
 * Gathers the two inputs the pure formula needs that aren't on TeamPeriodMetrics
 * — the prior-period PR trend (looked up from the stored aggregate) and the
 * org-average benchmark (passed in) — then delegates to `computeMaturityScore`.
 *
 * `table`/`periodColumn` are internal constants supplied by the two job modules
 * (never user input), so interpolating them into the lookup is safe; the period
 * key is bound as a parameter. The PR trend reuses `countPctChange` so it matches
 * the prs_merged_delta the delta layer computes elsewhere.
 */
export function computeTeamMaturity(
    db: Database.Database,
    params: {
        table: 'quarterly_aggregates' | 'yearly_aggregates';
        periodColumn: 'quarter' | 'year';
        team: string;
        previousPeriod: string;
        start: string;
        end: string;
        metrics: TeamPeriodMetrics;
        orgAvgCostPerPr: number | null;
    },
): MaturityResult {
    const {table, periodColumn, team, previousPeriod, start, end, metrics, orgAvgCostPerPr} = params;

    const prior = db
        .prepare(`SELECT total_prs_merged FROM ${table} WHERE team = ? AND ${periodColumn} = ?`)
        .get(team, previousPeriod) as {total_prs_merged: number} | undefined;
    // No prior row (first period or an un-rolled gap) → null trend → neutral output_health.
    const prsMergedDeltaPct = prior
        ? countPctChange(metrics.total_prs_merged, prior.total_prs_merged, 1)
        : null;

    return computeMaturityScore({
        developer_count: metrics.developer_count,
        active_developer_count: metrics.active_developer_count,
        member_active_days: metrics.members.map((m) => m.metrics.active_days),
        possible_days: inclusiveDayCount(start, end),
        prs_merged_delta_pct: prsMergedDeltaPct,
        avg_code_churn: metrics.avg_code_churn,
        cost_per_pr: metrics.cost_per_pr,
        org_avg_cost_per_pr: orgAvgCostPerPr,
    });
}
