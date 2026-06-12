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
import {DEFAULT_WINDOW, periodKeysEndingAt} from '../period-window';
import {resolvePRReviewThresholds} from './config';
import {
    aggregateTeamPeriod,
    computeReworkTrend,
    countSufficientPeriods,
    latestSufficientSignal,
    type DevPeriodMetric,
    type TrajectoryLike,
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
    VariantTrajectoryOf,
} from './types';

// The period-window helpers (DEFAULT_WINDOW, periodKeysEndingAt) are shared with
// the available-data coaching surface — see ../period-window. Re-exported here so
// existing importers of this module keep resolving the same symbol.
export {periodKeysEndingAt} from '../period-window';

interface MetricRow {
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

/**
 * Build one scope variant's trajectory (the derived trend + latest signal + the
 * sufficient-period count) over its point series. Generic over the point shape
 * so the developer (PRReviewTrajectoryPoint) and team (TeamAggregatePoint)
 * surfaces share one builder — both point types satisfy TrajectoryLike, which is
 * all the derivation helpers read.
 */
function buildTrajectory<P extends TrajectoryLike>(
    variant: ScopeVariant,
    points: P[],
    thresholds: PRReviewThresholds,
): VariantTrajectoryOf<P> {
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
): DeveloperPRReviewCoaching {
    const thresholds = resolvePRReviewThresholds(db);
    const keys = periodKeysEndingAt(unit, now.toISOString().slice(0, 10), DEFAULT_WINDOW[unit]);

    const rows = db
        .prepare(
            `SELECT period, scope_variant, prs_total, prs_merged, rework_rate,
                    avg_review_rounds, review_rejection_rate, avg_comment_density,
                    comment_density_vs_baseline, avg_time_to_merge_hours, avg_churn, combined_signal
             FROM pr_review_metrics
             WHERE developer_id = ? AND period IN (${placeholders(keys.length)})`,
        )
        .all(developerId, ...keys) as MetricRow[];

    // Keyed by the two known variant literals; any unexpected scope_variant value
    // stored by a future writer is simply never looked up (fail-closed) — the
    // column is plain TEXT, so the read deliberately doesn't trust it blindly.
    const byVariantPeriod = new Map<string, MetricRow>();
    for (const row of rows) byVariantPeriod.set(`${row.scope_variant}|${row.period}`, row);

    const variantPoints = (variant: ScopeVariant): PRReviewTrajectoryPoint[] =>
        keys.map((period) => {
            const row = byVariantPeriod.get(`${variant}|${period}`);
            return row ? rowToPoint(row) : emptyPoint(period);
        });

    return {
        period_unit: unit,
        all_pr: buildTrajectory('all_pr', variantPoints('all_pr'), thresholds),
        ai_assisted: buildTrajectory('ai_assisted_pr', variantPoints('ai_assisted_pr'), thresholds),
    };
}

/** Only the columns the team aggregate consumes — the per-developer signal and */
/** comment-density-vs-baseline are deliberately NOT read on the manager path. */
interface TeamMetricRow {
    period: string;
    scope_variant: ScopeVariant;
    prs_total: number;
    prs_merged: number;
    rework_rate: number | null;
    avg_review_rounds: number | null;
    review_rejection_rate: number | null;
    avg_comment_density: number | null;
    avg_time_to_merge_hours: number | null;
    avg_churn: number | null;
}

function rowToDevMetric(row: TeamMetricRow): DevPeriodMetric {
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
 * Aggregate a manager-facing coaching view over an already-resolved set of
 * developer ids. The caller owns scoping (org = all developers, team = the
 * team's members), so there is no scope sentinel to collide with a real team
 * name. Every period is pooled across these developers and suppressed when too
 * few contributed (k-anonymity) — no individual's numbers are ever returned, and
 * no developer id appears in the output. Both variants stay labeled
 * factual/inferred.
 *
 * Membership is the developers' CURRENT team (same as every team-scoped query in
 * the app): a developer who changed teams carries their metric history to the
 * new team's aggregate. Acceptable here because the floor still prevents any
 * individual read; noted so a future reader doesn't mistake it for a bug.
 *
 * Org pooling deliberately overrides team-level suppression: a developer whose
 * period is suppressed in their thin team is still pooled into the org roll-up,
 * which is fine because the org cohort must itself clear the floor (>= 3
 * contributors) before any number is shown, so no individual is isolable.
 */
function aggregateForDeveloperIds(
    db: Database.Database,
    scopeLabel: string,
    devIds: string[],
    unit: PRReviewPeriodUnit,
    now: Date,
): TeamPRReviewCoaching {
    const thresholds = resolvePRReviewThresholds(db);
    const keys = periodKeysEndingAt(unit, now.toISOString().slice(0, 10), DEFAULT_WINDOW[unit]);

    // No developers in scope → every period suppressed, but the variant pair and
    // window stay complete so the UI renders an honest "not enough data" state.
    const rows =
        devIds.length === 0
            ? []
            : (db
                  .prepare(
                      `SELECT period, scope_variant, prs_total, prs_merged, rework_rate,
                              avg_review_rounds, review_rejection_rate, avg_comment_density,
                              avg_time_to_merge_hours, avg_churn
                       FROM pr_review_metrics
                       WHERE developer_id IN (${placeholders(devIds.length)})
                         AND period IN (${placeholders(keys.length)})`,
                  )
                  .all(...devIds, ...keys) as TeamMetricRow[]);

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
        scope: scopeLabel,
        period_unit: unit,
        all_pr: buildTrajectory('all_pr', variantPoints('all_pr'), thresholds),
        ai_assisted: buildTrajectory('ai_assisted_pr', variantPoints('ai_assisted_pr'), thresholds),
    };
}

/**
 * Org-wide manager aggregate — every developer pooled.
 *
 * Loads every developer id into a single `IN (...)` clause (same pattern as
 * leaderboard.ts / compare.ts). SQLite caps bound parameters
 * (SQLITE_MAX_VARIABLE_NUMBER, ~32k on current builds), so an org of tens of
 * thousands of developers would need this chunked or pooled in SQL; trivial at
 * launch scale, flagged so it isn't a surprise in prod.
 */
export function getOrgPRReviewCoaching(
    db: Database.Database,
    unit: PRReviewPeriodUnit,
    now: Date = new Date(),
): TeamPRReviewCoaching {
    const devIds = (db.prepare('SELECT id FROM developers').all() as Array<{id: string}>).map((r) => r.id);
    return aggregateForDeveloperIds(db, 'org', devIds, unit, now);
}

/**
 * One team's manager aggregate. Scopes strictly by the team's CURRENT members —
 * a team literally named 'org' is still just that team, never the whole org.
 */
export function getTeamPRReviewCoaching(
    db: Database.Database,
    team: string,
    unit: PRReviewPeriodUnit,
    now: Date = new Date(),
): TeamPRReviewCoaching {
    const devIds = (
        db.prepare('SELECT id FROM developers WHERE team = ?').all(team) as Array<{id: string}>
    ).map((r) => r.id);
    return aggregateForDeveloperIds(db, team, devIds, unit, now);
}
