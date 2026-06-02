/**
 * Weekly rollup job (Task 3.1 / #70).
 *
 * Computes one developer's weekly aggregate from immutable daily snapshots and
 * UPSERTs it into weekly_aggregates. The week is an ISO week (Monday start); any
 * date within the target week is accepted and normalised to that week's Monday,
 * which is the canonical week_start the UNIQUE(developer_id, week_start)
 * constraint keys on. Re-running a week recomputes and overwrites that one row —
 * idempotent and safe to backfill.
 */

import type Database from 'better-sqlite3';
import {computePeriodMetrics, type PeriodMetrics} from './compute';
import {weekRange, isoWeekStart} from './dates';

export interface WeeklyAggregateRow {
    id: string;
    developer_id: string;
    week_start: string;
    team: string;
    active_days: number;
    total_interactions: number;
    total_acceptances: number;
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

function buildRow(
    developer: DeveloperRow,
    weekStart: string,
    metrics: PeriodMetrics,
    computedAt: string,
): WeeklyAggregateRow {
    return {
        id: `weekly:${developer.id}:${weekStart}`,
        developer_id: developer.id,
        week_start: weekStart,
        team: developer.team,
        active_days: metrics.active_days,
        total_interactions: metrics.total_interactions,
        total_acceptances: metrics.total_acceptances,
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

function upsertRow(db: Database.Database, row: WeeklyAggregateRow): void {
    db.prepare(
        `INSERT INTO weekly_aggregates (
            id, developer_id, week_start, team, active_days, total_interactions,
            total_acceptances, avg_acceptance_rate, tools_used, estimated_total_cost,
            total_commits, total_lines_added, total_prs_merged, avg_code_churn,
            avg_ai_signature_score, subscription_cost, cost_per_pr, is_active,
            data_quality, computed_at
        ) VALUES (
            @id, @developer_id, @week_start, @team, @active_days, @total_interactions,
            @total_acceptances, @avg_acceptance_rate, @tools_used, @estimated_total_cost,
            @total_commits, @total_lines_added, @total_prs_merged, @avg_code_churn,
            @avg_ai_signature_score, @subscription_cost, @cost_per_pr, @is_active,
            @data_quality, @computed_at
        )
        ON CONFLICT(developer_id, week_start) DO UPDATE SET
            team = excluded.team,
            active_days = excluded.active_days,
            total_interactions = excluded.total_interactions,
            total_acceptances = excluded.total_acceptances,
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
 * Compute and persist one developer's weekly aggregate. `weekDate` may be any
 * date in the target week. Returns the row written. Throws if the developer is
 * unknown (team is a NOT NULL column sourced from the developer record).
 */
export function computeWeeklyAggregate(
    db: Database.Database,
    developerId: string,
    weekDate: string,
    now: Date = new Date(),
): WeeklyAggregateRow {
    const developer = db
        .prepare('SELECT id, team FROM developers WHERE id = ?')
        .get(developerId) as DeveloperRow | undefined;
    if (!developer) {
        throw new Error(`Unknown developer: ${developerId}`);
    }

    const {start, end} = weekRange(weekDate);
    const metrics = computePeriodMetrics(db, developerId, start, end);
    const row = buildRow(developer, isoWeekStart(weekDate), metrics, now.toISOString());
    upsertRow(db, row);
    return row;
}

/**
 * Compute and persist the weekly aggregate for every developer for the week
 * containing `weekDate`. Returns all rows written, in developer-id order.
 */
export function computeAllWeeklyAggregates(
    db: Database.Database,
    weekDate: string,
    now: Date = new Date(),
): WeeklyAggregateRow[] {
    const developers = db
        .prepare('SELECT id FROM developers ORDER BY id')
        .all() as {id: string}[];
    return developers.map((d) => computeWeeklyAggregate(db, d.id, weekDate, now));
}
