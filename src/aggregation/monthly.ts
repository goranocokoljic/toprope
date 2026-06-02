/**
 * Monthly rollup job (Task 3.1 / #70).
 *
 * Computes one developer's monthly aggregate from immutable daily snapshots and
 * UPSERTs it into monthly_aggregates. The period is a calendar month (YYYY-MM)
 * keyed by the UNIQUE(developer_id, month) constraint. Re-running a month
 * recomputes and overwrites that one row — idempotent and safe to backfill.
 *
 * monthly_aggregates differs from weekly_aggregates in two ways relevant here:
 * it has no total_acceptances column, and it adds active_weeks (distinct ISO
 * weeks with activity). The delta_* columns are owned by Task 3.3 and left NULL.
 */

import type Database from 'better-sqlite3';
import {computePeriodMetrics, type PeriodMetrics} from './compute';
import {monthRange, isoWeekStart} from './dates';

export interface MonthlyAggregateRow {
    id: string;
    developer_id: string;
    month: string;
    team: string;
    active_days: number;
    active_weeks: number;
    total_interactions: number;
    avg_acceptance_rate: number | null;
    tools_used: string;
    estimated_total_cost: number | null;
    total_commits: number;
    total_lines_added: number;
    total_prs_merged: number;
    avg_code_churn: number | null;
    avg_ai_signature_score: number | null;
    subscription_cost: number;
    cost_per_pr: number | null;
    is_active: 0 | 1;
    data_quality: string;
    computed_at: string;
}

interface DeveloperRow {
    id: string;
    team: string;
}

/** Distinct ISO weeks (by their Monday) that any active day in the month fell in. */
function countActiveWeeks(activeDates: string[]): number {
    const weeks = new Set<string>();
    for (const date of activeDates) {
        weeks.add(isoWeekStart(date));
    }
    return weeks.size;
}

function buildRow(
    developer: DeveloperRow,
    month: string,
    metrics: PeriodMetrics,
    computedAt: string,
): MonthlyAggregateRow {
    return {
        id: `monthly:${developer.id}:${month}`,
        developer_id: developer.id,
        month,
        team: developer.team,
        active_days: metrics.active_days,
        active_weeks: countActiveWeeks(metrics.active_dates),
        total_interactions: metrics.total_interactions,
        avg_acceptance_rate: metrics.avg_acceptance_rate,
        tools_used: JSON.stringify(metrics.tools_used),
        estimated_total_cost: metrics.estimated_total_cost,
        total_commits: metrics.total_commits,
        total_lines_added: metrics.total_lines_added,
        total_prs_merged: metrics.total_prs_merged,
        avg_code_churn: metrics.avg_code_churn,
        avg_ai_signature_score: metrics.avg_ai_signature_score,
        subscription_cost: metrics.subscription_cost,
        cost_per_pr: metrics.cost_per_pr,
        is_active: metrics.is_active,
        data_quality: metrics.data_quality,
        computed_at: computedAt,
    };
}

function upsertRow(db: Database.Database, row: MonthlyAggregateRow): void {
    db.prepare(
        `INSERT INTO monthly_aggregates (
            id, developer_id, month, team, active_days, active_weeks,
            total_interactions, avg_acceptance_rate, tools_used, estimated_total_cost,
            total_commits, total_lines_added, total_prs_merged, avg_code_churn,
            avg_ai_signature_score, subscription_cost, cost_per_pr, is_active,
            data_quality, computed_at
        ) VALUES (
            @id, @developer_id, @month, @team, @active_days, @active_weeks,
            @total_interactions, @avg_acceptance_rate, @tools_used, @estimated_total_cost,
            @total_commits, @total_lines_added, @total_prs_merged, @avg_code_churn,
            @avg_ai_signature_score, @subscription_cost, @cost_per_pr, @is_active,
            @data_quality, @computed_at
        )
        ON CONFLICT(developer_id, month) DO UPDATE SET
            team = excluded.team,
            active_days = excluded.active_days,
            active_weeks = excluded.active_weeks,
            total_interactions = excluded.total_interactions,
            avg_acceptance_rate = excluded.avg_acceptance_rate,
            tools_used = excluded.tools_used,
            estimated_total_cost = excluded.estimated_total_cost,
            total_commits = excluded.total_commits,
            total_lines_added = excluded.total_lines_added,
            total_prs_merged = excluded.total_prs_merged,
            avg_code_churn = excluded.avg_code_churn,
            avg_ai_signature_score = excluded.avg_ai_signature_score,
            subscription_cost = excluded.subscription_cost,
            cost_per_pr = excluded.cost_per_pr,
            is_active = excluded.is_active,
            data_quality = excluded.data_quality,
            computed_at = excluded.computed_at`,
    ).run(row);
}

/**
 * Compute and persist one developer's monthly aggregate for `month` (YYYY-MM).
 * Returns the row written. Throws if the developer is unknown (team is a NOT
 * NULL column sourced from the developer record).
 */
export function computeMonthlyAggregate(
    db: Database.Database,
    developerId: string,
    month: string,
    now: Date = new Date(),
): MonthlyAggregateRow {
    const developer = db
        .prepare('SELECT id, team FROM developers WHERE id = ?')
        .get(developerId) as DeveloperRow | undefined;
    if (!developer) {
        throw new Error(`Unknown developer: ${developerId}`);
    }

    const {start, end} = monthRange(month);
    const metrics = computePeriodMetrics(db, developerId, start, end);
    const row = buildRow(developer, month, metrics, now.toISOString());
    upsertRow(db, row);
    return row;
}

/**
 * Compute and persist the monthly aggregate for every developer for `month`
 * (YYYY-MM). Returns all rows written, in developer-id order.
 */
export function computeAllMonthlyAggregates(
    db: Database.Database,
    month: string,
    now: Date = new Date(),
): MonthlyAggregateRow[] {
    const developers = db
        .prepare('SELECT id FROM developers ORDER BY id')
        .all() as {id: string}[];
    return developers.map((d) => computeMonthlyAggregate(db, d.id, month, now));
}
