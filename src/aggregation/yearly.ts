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
 * columns — so it stores commits and AI-signature instead. The AI maturity score
 * is computed by computeTeamMaturity (Task 3.4); the *_delta columns are owned by
 * Task 3.3. ai_maturity_basis is 'git_estimate' at launch.
 */

import type Database from 'better-sqlite3';
import {yearRange, priorYear} from './dates';
import {computeTeamPeriodMetrics, listTeams, type MaturityBasis} from './team-period';
import {computeOrgAvgCostPerPr, computeTeamMaturity} from './maturity';
import {teamDeltas} from './deltas';

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
 *
 * `orgAvgCostPerPr` is the cross-team cost_per_pr benchmark for this year (the
 * maturity score's cost_efficiency input). Omit it (single-team path) and it is
 * computed here; the all-teams driver computes it once and passes it down. `null`
 * is honoured as a real value — only `undefined` triggers the on-demand compute.
 */
export function computeYearlyAggregate(
    db: Database.Database,
    team: string,
    year: string,
    now: Date = new Date(),
    orgAvgCostPerPr?: number | null,
): YearlyAggregateRow {
    const {start, end} = yearRange(year);
    const metrics = computeTeamPeriodMetrics(db, team, start, end);

    const orgAvg = orgAvgCostPerPr === undefined ? computeOrgAvgCostPerPr(db, start, end) : orgAvgCostPerPr;
    // Maturity before deltas: maturity_score_delta compares this year's score
    // against the prior year's stored one.
    const maturity = computeTeamMaturity(db, {
        table: 'yearly_aggregates',
        periodColumn: 'year',
        team,
        previousPeriod: priorYear(year),
        start,
        end,
        metrics,
        orgAvgCostPerPr: orgAvg,
    });

    // Final step: deltas vs the prior year's stored aggregate (null on first year,
    // or whenever either side's score is null).
    const deltas = teamDeltas(db, 'yearly_aggregates', 'year', team, priorYear(year), {
        utilization_rate: metrics.utilization_rate,
        ai_maturity_score: maturity.ai_maturity_score,
    });

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
 * Compute and persist the yearly aggregate for every team for `year`. Returns all
 * rows written, in team-name order. The org-average cost-per-PR benchmark is
 * computed once for the year and shared across teams.
 */
export function computeAllYearlyAggregates(
    db: Database.Database,
    year: string,
    now: Date = new Date(),
): YearlyAggregateRow[] {
    const {start, end} = yearRange(year);
    const orgAvg = computeOrgAvgCostPerPr(db, start, end);
    return listTeams(db).map((team) => computeYearlyAggregate(db, team, year, now, orgAvg));
}
