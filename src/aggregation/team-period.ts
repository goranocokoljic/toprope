/**
 * Shared team-level period rollup for the quarterly and yearly jobs (Task 3.2 / #71).
 *
 * Quarterly and yearly aggregates are *team*-level, unlike the per-developer
 * weekly/monthly rollups. Both fold the same per-developer metrics over a
 * [start, end] window into one team row, differing only in which columns they
 * store and (for quarterly) the period waste detection. This module owns that
 * common fold so the two jobs cannot drift.
 *
 * Per the design (Phase3_Design_Document §3.1), every level is computed directly
 * from daily snapshots — here by reusing the already-tested computePeriodMetrics
 * per developer and summing across the team, rather than re-querying snapshots.
 * That keeps the per-developer and team numbers consistent by construction.
 */

import type Database from 'better-sqlite3';
import {computePeriodMetrics, type PeriodMetrics} from './compute';

export interface TeamMember {
    id: string;
    metrics: PeriodMetrics;
}

export interface TeamPeriodMetrics {
    /** Developers who belonged to the team and existed on or before the period end. */
    developer_count: number;
    /** Of those, the ones with any activity (git or tool) during the period. */
    active_developer_count: number;
    /** active / total; null when the team had no members in the period (no /0). */
    utilization_rate: number | null;
    total_subscription_cost: number;
    /** Tool-billed (API) cost — 0 at launch (git-only, no tool data). */
    total_estimated_api_cost: number;
    total_commits: number;
    total_prs_merged: number;
    avg_code_churn: number | null;
    avg_ai_signature_score: number | null;
    /** Interaction-weighted; null at launch (no tool interactions to divide by). */
    avg_acceptance_rate: number | null;
    cost_per_pr: number | null;
    /** Per-member metrics, retained so the quarterly job can run waste detection. */
    members: TeamMember[];
}

/** Round to `dp` decimals, preserving null. */
function round(value: number, dp: number): number;
function round(value: number | null, dp: number): number | null;
function round(value: number | null, dp: number): number | null {
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

interface DeveloperRow {
    id: string;
}

/**
 * The developers who count toward a team for a period: those currently assigned
 * to the team whose `created_at` falls on or before the period end. A developer
 * who joined mid-period is therefore included (partial-quarter case), while one
 * who joined after the period is excluded so a past period's utilization isn't
 * diluted by people who weren't there yet.
 *
 * Team membership uses the developer's *current* team (the schema tracks no
 * membership history), so a developer who changed teams during the period is
 * attributed wholly to their present team — the honest limit of the data, and
 * the same simplification the rest of the engine makes.
 */
function getTeamDevelopers(db: Database.Database, team: string, end: string): DeveloperRow[] {
    return db
        .prepare(
            `SELECT id FROM developers
             WHERE team = ? AND substr(created_at, 1, 10) <= ?
             ORDER BY id`,
        )
        .all(team, end) as DeveloperRow[];
}

/**
 * Fold every team member's per-developer metrics over [start, end] into the
 * team-level rollup. Pure read — writes no aggregate row.
 */
export function computeTeamPeriodMetrics(
    db: Database.Database,
    team: string,
    start: string,
    end: string,
): TeamPeriodMetrics {
    const developers = getTeamDevelopers(db, team, end);
    const members: TeamMember[] = developers.map((d) => ({
        id: d.id,
        metrics: computePeriodMetrics(db, d.id, start, end),
    }));

    const developerCount = members.length;
    let activeDeveloperCount = 0;
    let totalSubscriptionCost = 0;
    let totalEstimatedApiCost = 0;
    let totalCommits = 0;
    let totalPrsMerged = 0;
    let totalInteractions = 0;
    let totalAcceptances = 0;
    for (const {metrics} of members) {
        if (metrics.is_active === 1) {
            activeDeveloperCount += 1;
        }
        totalSubscriptionCost += metrics.subscription_cost;
        totalEstimatedApiCost += metrics.estimated_total_cost ?? 0;
        totalCommits += metrics.total_commits;
        totalPrsMerged += metrics.total_prs_merged;
        totalInteractions += metrics.total_interactions;
        totalAcceptances += metrics.total_acceptances;
    }

    const utilizationRate = developerCount > 0 ? activeDeveloperCount / developerCount : null;
    // Team churn/signature average the per-developer period averages over the
    // members that reported them (git-only members carry null; tool-only periods
    // carry null signature) — null when no member had the metric.
    const avgCodeChurn = meanOrNull(members.map((m) => m.metrics.avg_code_churn));
    const avgAiSignature = meanOrNull(members.map((m) => m.metrics.avg_ai_signature_score));
    // Interaction-weighted across the team, not a mean of per-developer rates, so
    // a heavy user isn't outweighed by a light one. Null at launch (no interactions).
    const avgAcceptanceRate = totalInteractions > 0 ? totalAcceptances / totalInteractions : null;
    const costPerPr = totalPrsMerged > 0 ? totalSubscriptionCost / totalPrsMerged : null;

    return {
        developer_count: developerCount,
        active_developer_count: activeDeveloperCount,
        utilization_rate: round(utilizationRate, 4),
        total_subscription_cost: round(totalSubscriptionCost, 2),
        total_estimated_api_cost: round(totalEstimatedApiCost, 2),
        total_commits: totalCommits,
        total_prs_merged: totalPrsMerged,
        avg_code_churn: round(avgCodeChurn, 4),
        avg_ai_signature_score: round(avgAiSignature, 4),
        avg_acceptance_rate: round(avgAcceptanceRate, 4),
        cost_per_pr: round(costPerPr, 2),
        members,
    };
}

/** Distinct team names present in the developer registry, in name order. */
export function listTeams(db: Database.Database): string[] {
    const rows = db
        .prepare('SELECT DISTINCT team FROM developers ORDER BY team')
        .all() as {team: string}[];
    return rows.map((r) => r.team);
}
