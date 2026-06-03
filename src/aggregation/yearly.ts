/**
 * Yearly rollup job (Task 3.2 / #71).
 *
 * Computes one team's yearly aggregate from immutable daily snapshots and UPSERTs
 * it into yearly_aggregates, keyed by UNIQUE(team, year). The year is a calendar
 * year (YYYY); re-running recomputes and overwrites that one row — idempotent and
 * safe to backfill.
 *
 * Like quarterly, yearly is team-level and folds computeTeamPeriodMetrics. Its
 * schema is leaner than quarterly's — no period waste, API cost, or acceptance
 * columns — so it stores commits and AI-signature instead. ai_maturity_score /
 * *_delta are owned by later tasks (3.4, 3.3) and left NULL; ai_maturity_basis is
 * 'git_estimate' at launch.
 */

import type Database from 'better-sqlite3';
import {yearRange} from './dates';
import {computeTeamPeriodMetrics, listTeams} from './team-period';
import type {MaturityBasis} from './quarterly';

export interface YearlyAggregateRow {
    id: string;
    team: string;
    year: string;
    developer_count: number;
    active_developer_count: number;
    utilization_rate: number | null;
    total_subscription_cost: number;
    total_commits: number;
    total_prs_merged: number;
    avg_code_churn: number | null;
    avg_ai_signature_score: number | null;
    cost_per_pr: number | null;
    ai_maturity_score: number | null;
    ai_maturity_basis: MaturityBasis;
    utilization_rate_delta: number | null;
    maturity_score_delta: number | null;
    computed_at: string;
}

function upsertRow(db: Database.Database, row: YearlyAggregateRow): void {
    db.prepare(
        `INSERT INTO yearly_aggregates (
            id, team, year, developer_count, active_developer_count,
            utilization_rate, total_subscription_cost, total_commits,
            total_prs_merged, avg_code_churn, avg_ai_signature_score, cost_per_pr,
            ai_maturity_score, ai_maturity_basis, utilization_rate_delta,
            maturity_score_delta, computed_at
        ) VALUES (
            @id, @team, @year, @developer_count, @active_developer_count,
            @utilization_rate, @total_subscription_cost, @total_commits,
            @total_prs_merged, @avg_code_churn, @avg_ai_signature_score, @cost_per_pr,
            @ai_maturity_score, @ai_maturity_basis, @utilization_rate_delta,
            @maturity_score_delta, @computed_at
        )
        ON CONFLICT(team, year) DO UPDATE SET
            developer_count = excluded.developer_count,
            active_developer_count = excluded.active_developer_count,
            utilization_rate = excluded.utilization_rate,
            total_subscription_cost = excluded.total_subscription_cost,
            total_commits = excluded.total_commits,
            total_prs_merged = excluded.total_prs_merged,
            avg_code_churn = excluded.avg_code_churn,
            avg_ai_signature_score = excluded.avg_ai_signature_score,
            cost_per_pr = excluded.cost_per_pr,
            ai_maturity_score = excluded.ai_maturity_score,
            ai_maturity_basis = excluded.ai_maturity_basis,
            utilization_rate_delta = excluded.utilization_rate_delta,
            maturity_score_delta = excluded.maturity_score_delta,
            computed_at = excluded.computed_at`,
    ).run(row);
}

/**
 * Compute and persist one team's yearly aggregate for `year` (YYYY). Returns the
 * row written. A team with no qualifying developers yields a zero/null row —
 * valid and idempotent, not an error.
 */
export function computeYearlyAggregate(
    db: Database.Database,
    team: string,
    year: string,
    now: Date = new Date(),
): YearlyAggregateRow {
    const {start, end} = yearRange(year);
    const metrics = computeTeamPeriodMetrics(db, team, start, end);

    const row: YearlyAggregateRow = {
        id: `yearly:${team}:${year}`,
        team,
        year,
        developer_count: metrics.developer_count,
        active_developer_count: metrics.active_developer_count,
        utilization_rate: metrics.utilization_rate,
        total_subscription_cost: metrics.total_subscription_cost,
        total_commits: metrics.total_commits,
        total_prs_merged: metrics.total_prs_merged,
        avg_code_churn: metrics.avg_code_churn,
        avg_ai_signature_score: metrics.avg_ai_signature_score,
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
 * Compute and persist the yearly aggregate for every team for `year`. Returns all
 * rows written, in team-name order.
 */
export function computeAllYearlyAggregates(
    db: Database.Database,
    year: string,
    now: Date = new Date(),
): YearlyAggregateRow[] {
    return listTeams(db).map((team) => computeYearlyAggregate(db, team, year, now));
}
