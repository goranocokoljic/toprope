/**
 * Period-over-period delta computation (Task 3.3 / #72).
 *
 * Deltas power the "up 8% vs last month" language in the dashboard and the
 * summaries. Each aggregate stores its change from the previous comparable
 * period (prior week / month / quarter / year). When there is no prior period —
 * the first week of data — every delta is NULL, not 0, so the UI and summaries
 * say "first period — no comparison yet" rather than fabricating a flat 0%.
 *
 * Two kinds of delta, kept deliberately distinct (an acceptance criterion):
 *   - *_delta_pct  — percentage CHANGE: (this - prev) / max(prev, floor) * 100.
 *                    The max(prev, floor) guard makes divide-by-zero impossible
 *                    even when the prior period had zero commits / PRs / cost.
 *   - *_delta      — percentage POINTS: a plain (this - prev) subtraction, used
 *                    for values already expressed as rates/scores (churn rate,
 *                    AI signature, utilization, maturity).
 *
 * This module is invoked as the final step of each rollup job: the job has the
 * current period's metrics in hand and passes them here together with the prior
 * period's key; the lookup reads the prior period's stored aggregate row and the
 * deltas are folded into the row the job upserts. Because the job overwrites the
 * whole row, re-running a period (late data) recomputes its deltas against the
 * prior period's current stored values — always correct for the re-run period.
 *
 * Known limitation (non-cascade): re-running period N updates N's deltas but does
 * NOT refresh the deltas of N+1, which compared against N's old values. This is
 * deliberate — deltas are not cascaded — and bounded in practice: the scheduler
 * (Task 3.4 §3.4) and backfill recompute a *contiguous* range in chronological
 * order, so after a normal backfill or scheduled run every period's delta is
 * correct. Only an isolated re-run of a single past period leaves the immediately
 * following period stale until it too is recomputed. A future scheduler that
 * re-runs N+1 whenever N is re-run would close this gap; it is out of scope for
 * Task 3.3 (deltas) and tracked as debt rather than built here.
 */

import type Database from 'better-sqlite3';
import {round} from './compute';

/**
 * Percentage change from `previous` to `current`, guarded against divide-by-zero
 * by flooring the denominator at `floor` (the `max(prev, floor)` pattern from the
 * issue: floor 1 for count metrics, 0.01 for cost). Null when either side is null
 * — a missing value is not a 0% change. Rounded to 2 decimal places (percent).
 */
export function pctChange(
    current: number | null,
    previous: number | null,
    floor: number,
): number | null {
    if (current === null || previous === null) {
        return null;
    }
    return round(((current - previous) / Math.max(previous, floor)) * 100, 2);
}

/**
 * `pctChange` specialised for count metrics that default to 0 and are never null
 * (commits, PRs merged, tool interactions). When BOTH periods are 0 the metric
 * was simply absent on both sides — a git-only developer has no tool
 * interactions, a tool-only developer no commits — so reporting a "0% change"
 * would fabricate a comparison from no data. Return null instead, matching how
 * the rate metrics (acceptance rate, cost-per-PR) stay null when their source
 * data is absent. A real value on either side (activity starting or stopping)
 * still produces a delta via the normal `pctChange` path.
 */
export function countPctChange(current: number, previous: number, floor: number): number | null {
    if (current === 0 && previous === 0) {
        return null;
    }
    return pctChange(current, previous, floor);
}

/**
 * Plain difference in percentage POINTS (`current - previous`) for values that are
 * already rates or scores. Null when either side is null. Rounded to 4 decimals to
 * match the precision the metrics themselves are stored at.
 */
export function pointDelta(current: number | null, previous: number | null): number | null {
    if (current === null || previous === null) {
        return null;
    }
    return round(current - previous, 4);
}

/** The per-developer source values a delta is computed from (current or prior period). */
export interface DeveloperDeltaValues {
    total_interactions: number;
    avg_acceptance_rate: number | null;
    total_commits: number;
    total_prs_merged: number;
    avg_code_churn: number | null;
    avg_ai_signature_score: number | null;
    cost_per_pr: number | null;
}

/** The per-developer delta columns stored on weekly_aggregates / monthly_aggregates. */
export interface DeveloperDeltas {
    interaction_delta_pct: number | null;
    acceptance_rate_delta: number | null;
    commit_velocity_delta_pct: number | null;
    prs_merged_delta_pct: number | null;
    churn_rate_delta: number | null;
    ai_signature_delta: number | null;
    cost_per_pr_delta_pct: number | null;
}

const NULL_DEVELOPER_DELTAS: DeveloperDeltas = {
    interaction_delta_pct: null,
    acceptance_rate_delta: null,
    commit_velocity_delta_pct: null,
    prs_merged_delta_pct: null,
    churn_rate_delta: null,
    ai_signature_delta: null,
    cost_per_pr_delta_pct: null,
};

/**
 * Compute the seven per-developer deltas from the current period's values and the
 * prior period's. `previous === null` means there is no prior period (first period
 * for this developer) — every delta is null, never 0.
 */
export function computeDeveloperDeltas(
    current: DeveloperDeltaValues,
    previous: DeveloperDeltaValues | null,
): DeveloperDeltas {
    if (previous === null) {
        return {...NULL_DEVELOPER_DELTAS};
    }
    return {
        // The three count-derived pct deltas use countPctChange so a metric that
        // was absent on both sides (zero both periods) yields null, not a
        // fabricated 0% — uniform across interactions, commits, and PRs so a
        // git-only or tool-only developer never shows a phantom 0% change for the
        // dimension they don't have data in.
        interaction_delta_pct: countPctChange(current.total_interactions, previous.total_interactions, 1),
        acceptance_rate_delta: pointDelta(current.avg_acceptance_rate, previous.avg_acceptance_rate),
        commit_velocity_delta_pct: countPctChange(current.total_commits, previous.total_commits, 1),
        prs_merged_delta_pct: countPctChange(current.total_prs_merged, previous.total_prs_merged, 1),
        churn_rate_delta: pointDelta(current.avg_code_churn, previous.avg_code_churn),
        ai_signature_delta: pointDelta(current.avg_ai_signature_score, previous.avg_ai_signature_score),
        cost_per_pr_delta_pct: pctChange(current.cost_per_pr, previous.cost_per_pr, 0.01),
    };
}

/** The team source values a delta is computed from (current or prior period). */
export interface TeamDeltaValues {
    utilization_rate: number | null;
    ai_maturity_score: number | null;
}

/** The team delta columns stored on quarterly_aggregates / yearly_aggregates. */
export interface TeamDeltas {
    utilization_rate_delta: number | null;
    maturity_score_delta: number | null;
}

/**
 * Compute the two team deltas (both percentage POINTS). `previous === null` →
 * both null. maturity_score_delta stays null until Task 3.4 populates the maturity
 * score; pointDelta yields null whenever either side's score is null.
 */
export function computeTeamDeltas(
    current: TeamDeltaValues,
    previous: TeamDeltaValues | null,
): TeamDeltas {
    if (previous === null) {
        return {utilization_rate_delta: null, maturity_score_delta: null};
    }
    // No count-style both-zero guard here (unlike the developer count deltas):
    // both team metrics are rates/scores fed through pointDelta, which already
    // null-propagates when either side is null, so there is nothing to fabricate.
    return {
        utilization_rate_delta: pointDelta(current.utilization_rate, previous.utilization_rate),
        maturity_score_delta: pointDelta(current.ai_maturity_score, previous.ai_maturity_score),
    };
}

const DEVELOPER_VALUE_COLUMNS =
    'total_interactions, avg_acceptance_rate, total_commits, total_prs_merged, ' +
    'avg_code_churn, avg_ai_signature_score, cost_per_pr';

/**
 * Look up the prior period's per-developer values and compute the deltas against
 * `current`. `previousPeriod` is the immediately-preceding period key (e.g. last
 * week's Monday, last month) — deltas are always "vs the period right before this
 * one," never vs the most recent period that happened to have activity. Returns
 * all-null deltas when that prior period has no stored row: this covers both the
 * genuine first period and a gap where the preceding period was never rolled up.
 * In normal operation the rollups write a row for every developer every period
 * (a zero-activity period still produces a row), so a gap only arises when the
 * preceding period was never computed at all — and a null delta is the honest
 * "no comparable prior period" answer there too.
 *
 * `table`/`periodColumn` are internal constants (never user input), so the
 * interpolation into the query is safe; the period key is bound as a parameter.
 */
export function developerDeltas(
    db: Database.Database,
    table: 'weekly_aggregates' | 'monthly_aggregates',
    periodColumn: 'week_start' | 'month',
    developerId: string,
    previousPeriod: string,
    current: DeveloperDeltaValues,
): DeveloperDeltas {
    const previous = db
        .prepare(
            `SELECT ${DEVELOPER_VALUE_COLUMNS} FROM ${table}
             WHERE developer_id = ? AND ${periodColumn} = ?`,
        )
        .get(developerId, previousPeriod) as DeveloperDeltaValues | undefined;
    return computeDeveloperDeltas(current, previous ?? null);
}

/**
 * Look up the prior period's team values and compute the team deltas against
 * `current`. Returns null deltas when the prior period has no stored row.
 */
export function teamDeltas(
    db: Database.Database,
    table: 'quarterly_aggregates' | 'yearly_aggregates',
    periodColumn: 'quarter' | 'year',
    team: string,
    previousPeriod: string,
    current: TeamDeltaValues,
): TeamDeltas {
    const previous = db
        .prepare(
            `SELECT utilization_rate, ai_maturity_score FROM ${table}
             WHERE team = ? AND ${periodColumn} = ?`,
        )
        .get(team, previousPeriod) as TeamDeltaValues | undefined;
    return computeTeamDeltas(current, previous ?? null);
}
