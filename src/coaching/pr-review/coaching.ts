/**
 * PR/Review coaching — read layer (Task 5.3 / #124).
 *
 * Turns the stored per-developer-per-period rows (pr_review_metrics, written by
 * Task 5.2's engine) into the two coaching surfaces:
 *   - getDeveloperPRReviewCoaching — ONE developer's private trajectory, both
 *     scope variants kept separate (all_pr factual / ai_assisted_pr inferred).
 *     The caller passes a developer id resolved STRICTLY from the session, so
 *     this can only ever return the caller's own data.
 *   - getTeamPRReviewCoaching — a TEAM (or org) aggregate with a k-anonymity
 *     floor. It never reads or returns any individual's numbers: every period is
 *     pooled across the team's developers and suppressed when the contributing
 *     cohort is too small (guidance.ts MIN_TEAM_COHORT). There is deliberately no
 *     function here that returns one developer's coaching to a manager — the only
 *     individual-scoped path is the developer's own /api/me surface.
 *
 * Pure math (trend, pooling, suppression) lives in guidance.ts; this module owns
 * the period enumeration and the SQL.
 */

import type Database from 'better-sqlite3';
import {isoWeekLabel, monthOf, priorIsoWeek, priorMonth} from '../../aggregation/dates';
import {resolvePRReviewThresholds} from './config';
import {
    aggregateTeamPeriod,
    computeReworkTrend,
    countSufficientPeriods,
    latestSufficientSignal,
    type DevPeriodMetric,
} from './guidance';
import {BASIS_FOR_VARIANT} from './types';
import type {
    CombinedSignal,
    DeveloperPRReviewCoaching,
    PRReviewPeriodUnit,
    PRReviewThresholds,
    PRReviewTrajectoryPoint,
    ScopeVariant,
    TeamAggregatePoint,
    TeamPRReviewCoaching,
    TeamVariantTrajectory,
    VariantTrajectory,
} from './types';

/** Default trajectory window per unit — enough history to read a trend, not so */
/** long it drags in ancient periods. Monthly reads as "the last half-year". */
const DEFAULT_WINDOW: Record<PRReviewPeriodUnit, number> = {weekly: 12, monthly: 6};

/**
 * The `count` period keys ending at `refDate`, oldest first. Walking back with
 * the same prior-period helpers the engine uses keeps the key shape identical to
 * what is stored, so the IN-clause lookups hit.
 */
export function periodKeysEndingAt(
    unit: PRReviewPeriodUnit,
    refDate: string,
    count: number,
): string[] {
    const current = unit === 'weekly' ? isoWeekLabel(refDate) : monthOf(refDate);
    const prior = unit === 'weekly' ? priorIsoWeek : priorMonth;
    const keys: string[] = [current];
    let key = current;
    for (let i = 1; i < count; i++) {
        key = prior(key);
        keys.push(key);
    }
    return keys.reverse();
}

interface MetricRow {
    developer_id: string;
    period: string;
    scope_variant: ScopeVariant;
    prs_total: number;
    prs_merged: number;
    rework_rate: number | null;
    avg_review_rounds: number | null;
    review_rejection_rate: number | null;
    avg_comment_density: number | null;
    comment_density_vs_baseline: number | null;
    avg_time_to_merge_hours: number | null;
    avg_churn: number | null;
    combined_signal: CombinedSignal | null;
}

function placeholders(n: number): string {
    return new Array(n).fill('?').join(', ');
}

/** A period with no stored row — no PRs in scope, nothing to coach on. */
function emptyPoint(period: string): PRReviewTrajectoryPoint {
    return {
        period,
        prs_total: 0,
        prs_merged: 0,
        rework_rate: null,
        review_rejection_rate: null,
        avg_review_rounds: null,
        avg_comment_density: null,
        comment_density_vs_baseline: null,
        avg_time_to_merge_hours: null,
        avg_churn: null,
        combined_signal: 'insufficient_data',
    };
}

function rowToPoint(row: MetricRow): PRReviewTrajectoryPoint {
    return {
        period: row.period,
        prs_total: row.prs_total,
        prs_merged: row.prs_merged,
        rework_rate: row.rework_rate,
        review_rejection_rate: row.review_rejection_rate,
        avg_review_rounds: row.avg_review_rounds,
        avg_comment_density: row.avg_comment_density,
        comment_density_vs_baseline: row.comment_density_vs_baseline,
        avg_time_to_merge_hours: row.avg_time_to_merge_hours,
        avg_churn: row.avg_churn,
        combined_signal: row.combined_signal ?? 'insufficient_data',
    };
}

function buildVariantTrajectory(
    variant: ScopeVariant,
    points: PRReviewTrajectoryPoint[],
    thresholds: PRReviewThresholds,
): VariantTrajectory {
    return {
        scope_variant: variant,
        basis: BASIS_FOR_VARIANT[variant],
        points,
        rework_trend: computeReworkTrend(points, thresholds.minPrs),
        latest_signal: latestSufficientSignal(points, thresholds.minPrs),
        sufficient_periods: countSufficientPeriods(points, thresholds.minPrs),
    };
}

/**
 * One developer's private PR/review coaching: each scope variant's trajectory
 * over the window, with the derived trend and latest combined signal the UI
 * frames as coaching. Periods with no PRs appear as empty points so the series
 * is continuous (and the absence of a trend reads honestly as "not enough yet").
 */
export function getDeveloperPRReviewCoaching(
    db: Database.Database,
    developerId: string,
    unit: PRReviewPeriodUnit,
    now: Date = new Date(),
    windowPeriods?: number,
): DeveloperPRReviewCoaching {
    const thresholds = resolvePRReviewThresholds(db);
    const count = windowPeriods ?? DEFAULT_WINDOW[unit];
    const keys = periodKeysEndingAt(unit, now.toISOString().slice(0, 10), count);

    const rows = db
        .prepare(
            `SELECT developer_id, period, scope_variant, prs_total, prs_merged, rework_rate,
                    avg_review_rounds, review_rejection_rate, avg_comment_density,
                    comment_density_vs_baseline, avg_time_to_merge_hours, avg_churn, combined_signal
             FROM pr_review_metrics
             WHERE developer_id = ? AND period IN (${placeholders(keys.length)})`,
        )
        .all(developerId, ...keys) as MetricRow[];

    const byVariantPeriod = new Map<string, MetricRow>();
    for (const row of rows) byVariantPeriod.set(`${row.scope_variant}|${row.period}`, row);

    const variantPoints = (variant: ScopeVariant): PRReviewTrajectoryPoint[] =>
        keys.map((period) => {
            const row = byVariantPeriod.get(`${variant}|${period}`);
            return row ? rowToPoint(row) : emptyPoint(period);
        });

    return {
        period_unit: unit,
        all_pr: buildVariantTrajectory('all_pr', variantPoints('all_pr'), thresholds),
        ai_assisted: buildVariantTrajectory('ai_assisted_pr', variantPoints('ai_assisted_pr'), thresholds),
    };
}

function buildTeamVariantTrajectory(
    variant: ScopeVariant,
    points: TeamAggregatePoint[],
    thresholds: PRReviewThresholds,
): TeamVariantTrajectory {
    return {
        scope_variant: variant,
        basis: BASIS_FOR_VARIANT[variant],
        points,
        rework_trend: computeReworkTrend(points, thresholds.minPrs),
        latest_signal: latestSufficientSignal(points, thresholds.minPrs),
        sufficient_periods: countSufficientPeriods(points, thresholds.minPrs),
    };
}

function rowToDevMetric(row: MetricRow): DevPeriodMetric {
    return {
        prsTotal: row.prs_total,
        prsMerged: row.prs_merged,
        reworkRate: row.rework_rate,
        reviewRejectionRate: row.review_rejection_rate,
        avgReviewRounds: row.avg_review_rounds,
        avgCommentDensity: row.avg_comment_density,
        avgTimeToMergeHours: row.avg_time_to_merge_hours,
        avgChurn: row.avg_churn,
    };
}

/**
 * The developer ids in scope: every developer for the org roll-up, or the named
 * team's members. Returned ids are the only rows the aggregate will ever read,
 * so team scoping is enforced here, once.
 */
function scopeDeveloperIds(db: Database.Database, scope: string): string[] {
    const rows =
        scope === 'org'
            ? (db.prepare('SELECT id FROM developers').all() as Array<{id: string}>)
            : (db.prepare('SELECT id FROM developers WHERE team = ?').all(scope) as Array<{id: string}>);
    return rows.map((r) => r.id);
}

/**
 * A team (or org) PR/review coaching aggregate for the manager view. Every
 * period is pooled across the scope's developers and suppressed when too few
 * contributed (k-anonymity) — no individual's numbers are ever returned, and no
 * developer id appears in the output. Both scope variants are aggregated
 * separately and stay labeled factual/inferred.
 *
 * `scope` is a team name or the literal 'org'. The route layer validates that a
 * named team exists before calling.
 */
export function getTeamPRReviewCoaching(
    db: Database.Database,
    scope: string,
    unit: PRReviewPeriodUnit,
    now: Date = new Date(),
    windowPeriods?: number,
): TeamPRReviewCoaching {
    const thresholds = resolvePRReviewThresholds(db);
    const count = windowPeriods ?? DEFAULT_WINDOW[unit];
    const keys = periodKeysEndingAt(unit, now.toISOString().slice(0, 10), count);
    const devIds = scopeDeveloperIds(db, scope);

    // No developers in scope → every period suppressed, but the variant pair and
    // window stay complete so the UI renders an honest "not enough data" state.
    const rows =
        devIds.length === 0
            ? []
            : (db
                  .prepare(
                      `SELECT developer_id, period, scope_variant, prs_total, prs_merged, rework_rate,
                              avg_review_rounds, review_rejection_rate, avg_comment_density,
                              comment_density_vs_baseline, avg_time_to_merge_hours, avg_churn, combined_signal
                       FROM pr_review_metrics
                       WHERE developer_id IN (${placeholders(devIds.length)})
                         AND period IN (${placeholders(keys.length)})`,
                  )
                  .all(...devIds, ...keys) as MetricRow[]);

    // (variant, period) -> the contributing developers' metrics for that cell.
    const grouped = new Map<string, DevPeriodMetric[]>();
    for (const row of rows) {
        const cell = `${row.scope_variant}|${row.period}`;
        const list = grouped.get(cell) ?? [];
        list.push(rowToDevMetric(row));
        grouped.set(cell, list);
    }

    const variantPoints = (variant: ScopeVariant): TeamAggregatePoint[] =>
        keys.map((period) =>
            aggregateTeamPeriod(period, grouped.get(`${variant}|${period}`) ?? [], thresholds),
        );

    return {
        scope,
        period_unit: unit,
        all_pr: buildTeamVariantTrajectory('all_pr', variantPoints('all_pr'), thresholds),
        ai_assisted: buildTeamVariantTrajectory('ai_assisted_pr', variantPoints('ai_assisted_pr'), thresholds),
    };
}
