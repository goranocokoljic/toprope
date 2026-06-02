/**
 * Shared per-developer period-metric computation for the aggregation engine
 * (Task 3.1 / #70).
 *
 * Weekly and monthly rollups compute the *same* metrics over a [start, end]
 * window of immutable daily snapshots — they differ only in how the window is
 * derived and which period-specific columns they store (week_start vs
 * month + active_weeks). This module owns the common computation so the two
 * rollup jobs cannot drift.
 *
 * Per the design (Phase3_Design_Document §3.1), every level is computed directly
 * from daily snapshots rather than from a lower aggregate, to avoid compounding
 * rounding. All folding happens in JS over a single query per table — clearer
 * and easier to reason about around NULLs than nested SQL aggregates, and the
 * data volume per developer per period is trivial.
 */

import type Database from 'better-sqlite3';
import {getDeveloperProratedCost} from '../expenses/subscription-tracker';

export type DataQuality = 'high' | 'medium' | 'low';

export interface PeriodMetrics {
    active_days: number;
    /** Distinct active dates (YYYY-MM-DD); lets the monthly job count active weeks. */
    active_dates: string[];
    is_active: 0 | 1;
    // Tool-derived — null/zero at launch (git-only), populated as connectors land.
    total_interactions: number;
    total_acceptances: number;
    avg_acceptance_rate: number | null;
    tools_used: string[];
    estimated_total_cost: number | null;
    // Git-derived — the real data at launch.
    total_commits: number;
    total_lines_added: number;
    total_prs_merged: number;
    avg_code_churn: number | null;
    avg_ai_signature_score: number | null;
    // Cost.
    subscription_cost: number;
    cost_per_pr: number | null;
    data_quality: DataQuality;
}

interface GitRow {
    date: string;
    commits: number;
    lines_added: number;
    lines_removed: number;
    files_changed: number;
    prs_opened: number;
    prs_merged: number;
    review_comments_given: number;
    code_churn_rate: number | null;
    ai_signature_score: number | null;
}

interface ToolRow {
    date: string;
    tool: string;
    is_active: number;
    interaction_count: number | null;
    acceptance_count: number | null;
    acceptance_rate: number | null;
    estimated_cost: number | null;
}

/** Round to `dp` decimals, preserving null. Strips float artifacts from sums/means. */
export function round(value: number | null, dp: number): number | null {
    if (value === null) {
        return null;
    }
    const factor = 10 ** dp;
    return Math.round(value * factor) / factor;
}

/** Mean of the non-null values, or null when there are none. */
function meanOrNull(values: Array<number | null>): number | null {
    const present = values.filter((v): v is number => v !== null);
    if (present.length === 0) {
        return null;
    }
    return present.reduce((a, b) => a + b, 0) / present.length;
}

/** A git day counts as active when it carries any git signal, not just commits. */
function hasGitActivity(row: GitRow): boolean {
    return (
        row.commits > 0 ||
        row.lines_added > 0 ||
        row.lines_removed > 0 ||
        row.prs_opened > 0 ||
        row.prs_merged > 0 ||
        row.review_comments_given > 0
    );
}

/** A tool day counts as active when the seat was used at all that day. */
function hasToolActivity(row: ToolRow): boolean {
    return row.is_active === 1 || (row.interaction_count ?? 0) > 0;
}

/**
 * Compute a single developer's aggregate metrics over an inclusive [start, end]
 * window from the daily snapshots. Pure read — does not write any aggregate row.
 */
export function computePeriodMetrics(
    db: Database.Database,
    developerId: string,
    start: string,
    end: string,
): PeriodMetrics {
    const gitRows = db
        .prepare(
            `SELECT date, commits, lines_added, lines_removed, files_changed,
                    prs_opened, prs_merged, review_comments_given,
                    code_churn_rate, ai_signature_score
             FROM git_snapshots
             WHERE developer_id = ? AND date >= ? AND date <= ?`,
        )
        .all(developerId, start, end) as GitRow[];

    const toolRows = db
        .prepare(
            `SELECT date, tool, is_active, interaction_count, acceptance_count,
                    acceptance_rate, estimated_cost
             FROM tool_snapshots
             WHERE developer_id = ? AND date >= ? AND date <= ?`,
        )
        .all(developerId, start, end) as ToolRow[];

    // Active days = distinct dates with any commit OR any tool signal.
    const activeDateSet = new Set<string>();
    for (const row of gitRows) {
        if (hasGitActivity(row)) {
            activeDateSet.add(row.date);
        }
    }
    for (const row of toolRows) {
        if (hasToolActivity(row)) {
            activeDateSet.add(row.date);
        }
    }
    const activeDates = [...activeDateSet].sort();

    // Git metrics summed; churn/signature averaged over the days that reported them.
    let totalCommits = 0;
    let totalLinesAdded = 0;
    let totalPrsMerged = 0;
    for (const row of gitRows) {
        totalCommits += row.commits;
        totalLinesAdded += row.lines_added;
        totalPrsMerged += row.prs_merged;
    }
    const avgCodeChurn = meanOrNull(gitRows.map((r) => r.code_churn_rate));
    const avgAiSignature = meanOrNull(gitRows.map((r) => r.ai_signature_score));

    // Tool metrics. Sums default to 0 (schema default), rates/cost stay null when
    // there is no tool data so git-only periods don't fabricate a 0% rate.
    let totalInteractions = 0;
    let totalAcceptances = 0;
    let estimatedCostSum = 0;
    let estimatedCostSeen = false;
    const toolsUsed = new Set<string>();
    for (const row of toolRows) {
        totalInteractions += row.interaction_count ?? 0;
        totalAcceptances += row.acceptance_count ?? 0;
        if (row.estimated_cost !== null) {
            estimatedCostSum += row.estimated_cost;
            estimatedCostSeen = true;
        }
        if (hasToolActivity(row)) {
            toolsUsed.add(row.tool);
        }
    }
    const avgAcceptanceRate = meanOrNull(toolRows.map((r) => r.acceptance_rate));
    const estimatedTotalCost = estimatedCostSeen ? estimatedCostSum : null;

    // Prorated subscription spend for the window (mid-period plan changes handled
    // by the cost-accounting layer). cost_per_pr guards divide-by-zero with null.
    const subscriptionCost = getDeveloperProratedCost(db, developerId, start, end);
    const costPerPr = totalPrsMerged > 0 ? subscriptionCost / totalPrsMerged : null;

    // Data quality = highest tier available for this developer this period.
    let dataQuality: DataQuality;
    if (toolRows.length > 0) {
        dataQuality = 'high';
    } else if (gitRows.length > 0) {
        dataQuality = 'medium';
    } else {
        dataQuality = 'low';
    }

    return {
        active_days: activeDates.length,
        active_dates: activeDates,
        is_active: activeDates.length > 0 ? 1 : 0,
        total_interactions: totalInteractions,
        total_acceptances: totalAcceptances,
        avg_acceptance_rate: round(avgAcceptanceRate, 4),
        tools_used: [...toolsUsed].sort(),
        estimated_total_cost: round(estimatedTotalCost, 2),
        total_commits: totalCommits,
        total_lines_added: totalLinesAdded,
        total_prs_merged: totalPrsMerged,
        avg_code_churn: round(avgCodeChurn, 4),
        avg_ai_signature_score: round(avgAiSignature, 4),
        subscription_cost: round(subscriptionCost, 2) as number,
        cost_per_pr: round(costPerPr, 2),
        data_quality: dataQuality,
    };
}
