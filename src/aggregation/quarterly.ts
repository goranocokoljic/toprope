/**
 * Quarterly rollup job (Task 3.2 / #71).
 *
 * Computes one team's quarterly aggregate from immutable daily snapshots and
 * UPSERTs it into quarterly_aggregates, keyed by UNIQUE(team, quarter). Quarters
 * are calendar quarters (Q1 Jan–Mar … Q4 Oct–Dec); re-running a quarter
 * recomputes and overwrites that one row — idempotent and safe to backfill.
 *
 * Quarterly (and yearly) aggregates are team-level, unlike the per-developer
 * weekly/monthly rollups. The team metrics are folded by computeTeamPeriodMetrics
 * and the period waste figures by computePeriodWaste.
 *
 * ai_maturity_score / *_delta columns are owned by later tasks (3.4 maturity,
 * 3.3 deltas) and left NULL here. ai_maturity_basis is set to 'git_estimate' —
 * at launch every aggregate is a git-only estimate.
 */

import type Database from 'better-sqlite3';
import {quarterRange} from './dates';
import {computeTeamPeriodMetrics, listTeams} from './team-period';
import {computePeriodWaste} from './waste-period';

/** Basis label for the AI maturity score; git-only at launch. */
export type MaturityBasis = 'git_estimate' | 'mixed' | 'measured';

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
 */
export function computeQuarterlyAggregate(
    db: Database.Database,
    team: string,
    quarter: string,
    now: Date = new Date(),
): QuarterlyAggregateRow {
    const {start, end} = quarterRange(quarter);
    const metrics = computeTeamPeriodMetrics(db, team, start, end);
    const waste = computePeriodWaste(db, team, start, end);

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
        ai_maturity_score: null, // Task 3.4
        ai_maturity_basis: 'git_estimate',
        utilization_rate_delta: null, // Task 3.3
        maturity_score_delta: null, // Task 3.3
        computed_at: now.toISOString(),
    };
    upsertRow(db, row);
    return row;
}

/**
 * Compute and persist the quarterly aggregate for every team for `quarter`.
 * Returns all rows written, in team-name order.
 */
export function computeAllQuarterlyAggregates(
    db: Database.Database,
    quarter: string,
    now: Date = new Date(),
): QuarterlyAggregateRow[] {
    return listTeams(db).map((team) => computeQuarterlyAggregate(db, team, quarter, now));
}
