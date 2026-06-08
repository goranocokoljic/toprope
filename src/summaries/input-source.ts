/**
 * Summary input source (Task 3.9 / #78).
 *
 * Builds the numbers-only {@link SummaryInputPayload} for a {@link SummaryTarget}
 * directly from the immutable daily snapshots — the bridge between the aggregation
 * engine and the input-builder (Task 3.7). It is the single source of truth the
 * generator and the staleness check both call: the generator hashes the payload
 * it produces and feeds it to the prompt; the staleness check rebuilds the payload
 * and re-hashes to detect that an underlying aggregate moved. Because both go
 * through here, a "fresh" rebuild can never disagree with what was generated.
 *
 * Metrics are folded from snapshots (not read back from the stored aggregate rows)
 * for two reasons: weekly/monthly aggregate rows are per-developer and carry no
 * team/org maturity score, and computing every level the same way — the approach
 * team-period.ts and the quarterly/yearly jobs already take — keeps the team and
 * org numbers consistent by construction. The cost is the documented
 * fold-per-member trade-off; trivial at launch scale.
 *
 * Tier discipline holds automatically: every component flows from
 * computePeriodMetrics / computeMaturityScore, which are git-only at launch, so the
 * payload's ai_maturity_basis is 'git_estimate' and the privacy gate in
 * buildSummaryInput runs on the result.
 */

import type Database from 'better-sqlite3';
import {computeTeamPeriodMetrics, listTeams, type TeamMember} from '../aggregation/team-period';
import {meanOrNull, round, type DataQuality} from '../aggregation/compute';
import {computeMaturityScore, computeOrgAvgCostPerPr} from '../aggregation/maturity';
import {countPctChange} from '../aggregation/deltas';
import {inclusiveDayCount} from '../aggregation/dates';
import {periodRange, priorPeriod, type SummaryTarget} from './target';
import {listSurfaceableTeamAnomalies} from '../anomaly/store';
import {
    buildSummaryInput,
    type AggregateMetrics,
    type SummaryInputPayload,
    type SummaryScope,
} from './input-builder';
import type {SummaryLevel} from './model-client';

/** The per-member metrics folded into one scope-level metric set. */
interface ScopeFold {
    developer_count: number;
    active_developer_count: number;
    total_commits: number;
    total_prs_merged: number;
    avg_code_churn: number | null;
    avg_ai_signature_score: number | null;
    subscription_cost: number;
    cost_per_pr: number | null;
    /** active_days per member — the maturity score's adoption_consistency input. */
    member_active_days: number[];
    data_quality: DataQuality;
}

/**
 * The members in a scope for a window: one team's members, or every team's
 * members folded together for the org. Reuses computeTeamPeriodMetrics so the
 * per-member computation matches the rest of the engine exactly.
 */
function scopeMembers(
    db: Database.Database,
    scope: SummaryScope,
    start: string,
    end: string,
): TeamMember[] {
    if (scope.type === 'team') {
        return computeTeamPeriodMetrics(db, scope.name, start, end).members;
    }
    return listTeams(db).flatMap((team) => computeTeamPeriodMetrics(db, team, start, end).members);
}

/** Best (highest-confidence) data-quality tier present across members; low when empty. */
function bestQuality(members: TeamMember[]): DataQuality {
    let best: DataQuality = 'low';
    for (const {metrics} of members) {
        if (metrics.data_quality === 'high') return 'high';
        if (metrics.data_quality === 'medium') best = 'medium';
    }
    return best;
}

/**
 * Fold a member list into one scope-level metric set (sums, member-weighted means).
 *
 * This deliberately pools the *member* metrics rather than reusing
 * computeTeamPeriodMetrics's team-level result. The reason is the org scope: an
 * org metric must be the member-weighted mean across every developer (pooling all
 * teams' members), not a mean-of-team-means — so org churn/signature averages stay
 * weighted by developer, not by team size. Pooling members is the single arithmetic
 * that is correct for both a one-team scope and the whole org, which is why both
 * paths run through here. For a single team this fold is, by construction, identical
 * to computeTeamPeriodMetrics (same members, same sums/means); the equivalence is
 * locked by a test so the two folds cannot silently drift.
 */
function foldScope(members: TeamMember[]): ScopeFold {
    let active = 0;
    let totalCommits = 0;
    let totalPrsMerged = 0;
    let subscriptionCost = 0;
    for (const {metrics} of members) {
        if (metrics.is_active === 1) active += 1;
        totalCommits += metrics.total_commits;
        totalPrsMerged += metrics.total_prs_merged;
        subscriptionCost += metrics.subscription_cost;
    }
    const costPerPr = totalPrsMerged > 0 ? subscriptionCost / totalPrsMerged : null;
    return {
        developer_count: members.length,
        active_developer_count: active,
        total_commits: totalCommits,
        total_prs_merged: totalPrsMerged,
        avg_code_churn: round(meanOrNull(members.map((m) => m.metrics.avg_code_churn)), 4),
        avg_ai_signature_score: round(
            meanOrNull(members.map((m) => m.metrics.avg_ai_signature_score)),
            4,
        ),
        subscription_cost: round(subscriptionCost, 2),
        cost_per_pr: round(costPerPr, 2),
        member_active_days: members.map((m) => m.metrics.active_days),
        data_quality: bestQuality(members),
    };
}

/** Whether the prior period carried any real activity worth comparing against. */
function foldHasActivity(fold: ScopeFold): boolean {
    return (
        fold.active_developer_count > 0 ||
        fold.total_commits > 0 ||
        fold.total_prs_merged > 0 ||
        fold.subscription_cost > 0
    );
}

/**
 * Compute one scope's aggregate metrics for a (level, period), including the
 * tier-aware maturity score. `orgAvgCostPerPr` (the cost_efficiency benchmark) is
 * computed here when omitted; pass it in to avoid re-folding every team when many
 * aggregates share the same period (the org-average-maturity loop does this).
 *
 * The prior period is folded only to supply the maturity score's PR-throughput
 * trend; a prior period with no activity yields a null trend (neutral), never a
 * fabricated comparison.
 */
export function computeScopeAggregate(
    db: Database.Database,
    scope: SummaryScope,
    level: SummaryLevel,
    period: string,
    orgAvgCostPerPr?: number | null,
): AggregateMetrics {
    const {start, end} = periodRange(level, period);
    const fold = foldScope(scopeMembers(db, scope, start, end));

    // The prior period is folded only to derive the maturity score's PR-throughput
    // trend. This mirrors computeTeamMaturity's wiring but cannot reuse it: that
    // helper reads the prior PR count from the *stored* quarterly/yearly aggregate
    // row, whereas the summary layer must build every level (incl. weekly/monthly,
    // which have no team-level stored row) directly from snapshots. The prior source
    // genuinely differs, so the small overlap with computeTeamMaturity is intentional.
    const priorRange = periodRange(level, priorPeriod(level, period));
    const priorFold = foldScope(scopeMembers(db, scope, priorRange.start, priorRange.end));
    const prsMergedDeltaPct = foldHasActivity(priorFold)
        ? countPctChange(fold.total_prs_merged, priorFold.total_prs_merged, 1)
        : null;

    const orgAvg =
        orgAvgCostPerPr === undefined ? computeOrgAvgCostPerPr(db, start, end) : orgAvgCostPerPr;
    const maturity = computeMaturityScore({
        developer_count: fold.developer_count,
        active_developer_count: fold.active_developer_count,
        member_active_days: fold.member_active_days,
        possible_days: inclusiveDayCount(start, end),
        prs_merged_delta_pct: prsMergedDeltaPct,
        avg_code_churn: fold.avg_code_churn,
        cost_per_pr: fold.cost_per_pr,
        org_avg_cost_per_pr: orgAvg,
    });

    return {
        developer_count: fold.developer_count,
        active_developer_count: fold.active_developer_count,
        total_commits: fold.total_commits,
        total_prs_merged: fold.total_prs_merged,
        avg_code_churn: fold.avg_code_churn,
        avg_ai_signature_score: fold.avg_ai_signature_score,
        subscription_cost: fold.subscription_cost,
        cost_per_pr: fold.cost_per_pr,
        ai_maturity_score: maturity.ai_maturity_score,
        ai_maturity_basis: maturity.ai_maturity_basis,
        data_quality: fold.data_quality,
    };
}

/** The org-average maturity score for a period — the benchmark's second figure. */
function computeOrgAvgMaturity(
    db: Database.Database,
    level: SummaryLevel,
    period: string,
    orgAvgCostPerPr: number | null,
): number | null {
    const scores = listTeams(db).map(
        (team) =>
            computeScopeAggregate(db, {type: 'team', name: team}, level, period, orgAvgCostPerPr)
                .ai_maturity_score,
    );
    return round(meanOrNull(scores), 0);
}

/** Whether any git/tool snapshot exists for a scope within an inclusive window. */
function hasSnapshotData(
    db: Database.Database,
    scope: SummaryScope,
    start: string,
    end: string,
): boolean {
    const teamClause = scope.type === 'team' ? 'AND d.team = @team' : '';
    const params =
        scope.type === 'team' ? {start, end, team: scope.name} : {start, end};
    const git = db
        .prepare(
            `SELECT 1 FROM git_snapshots g JOIN developers d ON d.id = g.developer_id
             WHERE g.date >= @start AND g.date <= @end ${teamClause} LIMIT 1`,
        )
        .get(params);
    if (git) return true;
    const tool = db
        .prepare(
            `SELECT 1 FROM tool_snapshots t JOIN developers d ON d.id = t.developer_id
             WHERE t.date >= @start AND t.date <= @end ${teamClause} LIMIT 1`,
        )
        .get(params);
    return Boolean(tool);
}

/**
 * Build the full numbers-only payload for a summary target. Assembles the current
 * metrics, the prior period's metrics for deltas (null when the prior period has
 * no snapshot data — a genuine first period), and the org benchmark, then hands
 * them to buildSummaryInput, which enforces the privacy allowlist on the result.
 *
 * Cost note: for an org scope this folds the developer pool more than once — the
 * cost-per-PR benchmark (computed here and threaded into `current` to avoid one
 * re-fold), the org aggregate's current+prior folds, and the per-team
 * org-average-maturity pass. This is the same consistency-over-throughput
 * trade-off team-period.ts documents (every figure folded directly from snapshots
 * so the numbers can't drift): trivial at launch scale, and a future large-org
 * path would thread a single per-period member fold through all three. Kept simple
 * deliberately rather than optimised pre-emptively.
 */
export function buildSummaryInputForTarget(
    db: Database.Database,
    target: SummaryTarget,
): SummaryInputPayload {
    const {level, period, scope} = target;
    const {start, end} = periodRange(level, period);
    const orgAvgCostPerPr = computeOrgAvgCostPerPr(db, start, end);

    const current = computeScopeAggregate(db, scope, level, period, orgAvgCostPerPr);

    const priorKey = priorPeriod(level, period);
    const priorRange = periodRange(level, priorKey);
    const prior = hasSnapshotData(db, scope, priorRange.start, priorRange.end)
        ? computeScopeAggregate(db, scope, level, priorKey)
        : null;

    // Notable/high anomalies whose week falls in this period (Task 4.8). Anomalies
    // are detected at TEAM scope on a weekly cadence; the start/end of the summary
    // period bound which weeks count. A team summary pins its own team; an org
    // summary spans every team (null). Folded into the numbers-only payload, so
    // the privacy gate validates them before they can reach the model.
    //
    // Two deliberate edges: (1) an org fold is team-BLIND — SummaryAnomaly drops
    // scope_id for the numbers-only guarantee, so the org narrative can't name
    // which team an anomaly belongs to (the privacy trade-off). (2) An anomaly's
    // period is its week_start Monday, matched with period >= start AND <= end, so
    // a week whose Monday falls in the prior month attaches to that prior month's
    // summary, not this one — bucket-by-Monday, consistent with the weekly cadence.
    const anomalies = listSurfaceableTeamAnomalies(
        db,
        scope.type === 'team' ? scope.name : null,
        start,
        end,
    );

    return buildSummaryInput({
        level,
        periodLabel: period,
        start,
        end,
        scope,
        current,
        prior,
        benchmark: {
            org_avg_cost_per_pr: orgAvgCostPerPr,
            org_avg_maturity_score: computeOrgAvgMaturity(db, level, period, orgAvgCostPerPr),
        },
        anomalies,
    });
}
