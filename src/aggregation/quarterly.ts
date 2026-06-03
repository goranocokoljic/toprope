/**
 * Quarterly rollup job (Task 3.2 / #71).
 *
 * Computes one team's quarterly aggregate from immutable daily snapshots and
 * UPSERTs it into quarterly_aggregates, keyed by UNIQUE(team, quarter). Quarters
 * are calendar quarters (Q1 Jan–Mar … Q4 Oct–Dec); re-running a quarter
 * recomputes and overwrites that one row — idempotent and safe to backfill.
 *
 * Quarterly (and yearly) aggregates are team-level, unlike the per-developer
 * weekly/monthly rollups. The team metrics are folded by computeTeamPeriodMetrics,
 * the period waste figures by computePeriodWaste, and the AI maturity score by
 * computeTeamMaturity (Task 3.4).
 *
 * ai_maturity_basis is 'git_estimate' — at launch every aggregate is a git-only
 * estimate. The *_delta columns are owned by Task 3.3 (deltas).
 */

import type Database from 'better-sqlite3';
import {quarterRange, priorQuarter} from './dates';
import {computeTeamPeriodMetrics, listTeams, type MaturityBasis} from './team-period';
import {computePeriodWaste} from './waste-period';
import {computeOrgAvgCostPerPr, computeTeamMaturity} from './maturity';
import {teamDeltas} from './deltas';

export interface QuarterlyAggregateRow {
    id: string;
    team: string;
    quarter: string;
    developer_count: number;
    active_developer_count: number;
    utilization_rate: number | null;
    total_subscription_cost: number;
    total_estimated_api_cost: number;
    unused_seat_count: number;
    wasted_spend: number;
    avg_acceptance_rate: number | null;
    avg_code_churn: number | null;
    total_prs_merged: number;
    cost_per_pr: number | null;
    ai_maturity_score: number | null;
    ai_maturity_basis: MaturityBasis;
    utilization_rate_delta: number | null;
    maturity_score_delta: number | null;
    computed_at: string;
}

function upsertRow(db: Database.Database, row: QuarterlyAggregateRow): void {
    db.prepare(
        `INSERT INTO quarterly_aggregates (
            id, team, quarter, developer_count, active_developer_count,
            utilization_rate, total_subscription_cost, total_estimated_api_cost,
            unused_seat_count, wasted_spend, avg_acceptance_rate, avg_code_churn,
            total_prs_merged, cost_per_pr, ai_maturity_score, ai_maturity_basis,
            utilization_rate_delta, maturity_score_delta, computed_at
        ) VALUES (
            @id, @team, @quarter, @developer_count, @active_developer_count,
            @utilization_rate, @total_subscription_cost, @total_estimated_api_cost,
            @unused_seat_count, @wasted_spend, @avg_acceptance_rate, @avg_code_churn,
            @total_prs_merged, @cost_per_pr, @ai_maturity_score, @ai_maturity_basis,
            @utilization_rate_delta, @maturity_score_delta, @computed_at
        )
        ON CONFLICT(team, quarter) DO UPDATE SET
            developer_count = excluded.developer_count,
            active_developer_count = excluded.active_developer_count,
            utilization_rate = excluded.utilization_rate,
            total_subscription_cost = excluded.total_subscription_cost,
            total_estimated_api_cost = excluded.total_estimated_api_cost,
            unused_seat_count = excluded.unused_seat_count,
            wasted_spend = excluded.wasted_spend,
            avg_acceptance_rate = excluded.avg_acceptance_rate,
            avg_code_churn = excluded.avg_code_churn,
            total_prs_merged = excluded.total_prs_merged,
            cost_per_pr = excluded.cost_per_pr,
            ai_maturity_score = excluded.ai_maturity_score,
            ai_maturity_basis = excluded.ai_maturity_basis,
            utilization_rate_delta = excluded.utilization_rate_delta,
            maturity_score_delta = excluded.maturity_score_delta,
            computed_at = excluded.computed_at`,
    ).run(row);
}

/**
 * Compute and persist one team's quarterly aggregate for `quarter`
 * (`YYYY-Q1`..`YYYY-Q4`). Returns the row written. A team with no qualifying
 * developers yields a zero/null row — valid and idempotent, not an error.
 *
 * `orgAvgCostPerPr` is the cost_per_pr benchmark averaged across all teams for
 * this quarter, the input to the maturity score's cost_efficiency component.
 * Omit it (the single-team path) and it is computed here; the all-teams driver
 * computes it once and passes it down so the cross-team fold runs only once.
 * Note `null` is a real value (no team had PRs) and is honoured — only
 * `undefined` triggers the on-demand compute.
 */
export function computeQuarterlyAggregate(
    db: Database.Database,
    team: string,
    quarter: string,
    now: Date = new Date(),
    orgAvgCostPerPr?: number | null,
): QuarterlyAggregateRow {
    const {start, end} = quarterRange(quarter);
    const metrics = computeTeamPeriodMetrics(db, team, start, end);
    const waste = computePeriodWaste(db, team, start, end);

    const orgAvg = orgAvgCostPerPr === undefined ? computeOrgAvgCostPerPr(db, start, end) : orgAvgCostPerPr;
    // Maturity must be computed before the deltas, which compare this quarter's
    // score against the prior quarter's stored one.
    const maturity = computeTeamMaturity(db, {
        table: 'quarterly_aggregates',
        periodColumn: 'quarter',
        team,
        previousPeriod: priorQuarter(quarter),
        start,
        end,
        metrics,
        orgAvgCostPerPr: orgAvg,
    });

    // Final step: deltas vs the prior quarter's stored aggregate (null on first
    // quarter, or whenever either side's score is null).
    const deltas = teamDeltas(db, 'quarterly_aggregates', 'quarter', team, priorQuarter(quarter), {
        utilization_rate: metrics.utilization_rate,
        ai_maturity_score: maturity.ai_maturity_score,
    });

    const row: QuarterlyAggregateRow = {
        id: `quarterly:${team}:${quarter}`,
        team,
        quarter,
        developer_count: metrics.developer_count,
        active_developer_count: metrics.active_developer_count,
        utilization_rate: metrics.utilization_rate,
        total_subscription_cost: metrics.total_subscription_cost,
        total_estimated_api_cost: metrics.total_estimated_api_cost,
        unused_seat_count: waste.unused_seat_count,
        wasted_spend: waste.wasted_spend,
        avg_acceptance_rate: metrics.avg_acceptance_rate,
        avg_code_churn: metrics.avg_code_churn,
        total_prs_merged: metrics.total_prs_merged,
        cost_per_pr: metrics.cost_per_pr,
        ai_maturity_score: maturity.ai_maturity_score,
        ai_maturity_basis: maturity.ai_maturity_basis,
        utilization_rate_delta: deltas.utilization_rate_delta,
        maturity_score_delta: deltas.maturity_score_delta,
        computed_at: now.toISOString(),
    };
    upsertRow(db, row);
    return row;
}

/**
 * Compute and persist the quarterly aggregate for every team for `quarter`.
 * Returns all rows written, in team-name order. The org-average cost-per-PR
 * benchmark is computed once for the quarter and shared across teams.
 *
 * Cost note: computeOrgAvgCostPerPr folds every team once to build the
 * benchmark, then each computeQuarterlyAggregate folds its team again for the
 * row — so each team is folded twice per period. This is the same
 * consistency-over-throughput trade-off team-period.ts already documents:
 * trivial at launch scale, and acceptable rather than threading precomputed
 * metrics through both the benchmark and the row path. A future large-org
 * backfill that wants the single-fold path would fold each team once, derive the
 * benchmark from those metrics, and reuse them to build the rows.
 */
export function computeAllQuarterlyAggregates(
    db: Database.Database,
    quarter: string,
    now: Date = new Date(),
): QuarterlyAggregateRow[] {
    const {start, end} = quarterRange(quarter);
    const orgAvg = computeOrgAvgCostPerPr(db, start, end);
    return listTeams(db).map((team) => computeQuarterlyAggregate(db, team, quarter, now, orgAvg));
}
