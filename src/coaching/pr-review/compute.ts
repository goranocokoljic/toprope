/**
 * PR/Review outcome metrics — DB integration (Task 5.2 / #123).
 *
 * Reads pr_records (per-PR facts written by the git sync) + git_snapshots
 * (churn, AI signature, review reciprocity) for one period and persists both
 * scope variants per developer into pr_review_metrics. Pure computation lives
 * in engine.ts; this module owns period arithmetic, the within-developer
 * baseline, the AI-signature annotation, and the idempotent UPSERT.
 *
 * Attribution: a PR belongs to the period containing its created_at day. This
 * keeps recomputes stable (a PR never migrates between periods when it merges
 * later) — a re-run updates the same row in place with the PR's latest verdict.
 *
 * Approximations, by design (documented in the issue as inference-tier data):
 *   - A PR's AI signature is the mean of the developer's daily
 *     ai_signature_score over the PR's active window (created → merged/closed)
 *     — commits are not linked to PRs by the provider layer.
 *   - avg_churn is the developer's mean daily churn over the period, not the
 *     churn of exactly these PRs' commits, for the same reason.
 */

import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import {isoWeekRange, monthRange, priorIsoWeek, priorMonth, type DateRange} from '../../aggregation/dates';
import {resolvePRReviewThresholds} from './config';
import {commentDensity, computeVariantMetrics, selectAiAssistedPRs} from './engine';
import type {PRData, PRReviewPeriodUnit, PRReviewThresholds, VariantMetrics} from './types';

export interface PRReviewComputeResult {
    periodUnit: PRReviewPeriodUnit;
    /** The period key computed (YYYY-Www or YYYY-MM). */
    period: string;
    /** Developers that had at least one PR in the period. */
    developers: number;
    /** Metric rows written (two variants per developer). */
    rowsWritten: number;
}

/** Inclusive day range for a period key (YYYY-Www → ISO week; YYYY-MM → month). */
function periodRange(unit: PRReviewPeriodUnit, period: string): DateRange {
    return unit === 'weekly' ? isoWeekRange(period) : monthRange(period);
}

function priorPeriod(unit: PRReviewPeriodUnit, period: string): string {
    return unit === 'weekly' ? priorIsoWeek(period) : priorMonth(period);
}

interface PRRecordRow {
    pr_id: string;
    state: string;
    created_at: string;
    merged_at: string | null;
    closed_at: string | null;
    review_comment_count: number;
    review_rounds: number;
    changes_requested_count: number;
    time_to_merge_hours: number | null;
}

interface Statements {
    prsInRange: Database.Statement;
    aiSignature: Database.Statement;
    churn: Database.Statement;
    commentsGiven: Database.Statement;
    upsert: Database.Statement;
}

function prepareStatements(db: Database.Database): Statements {
    return {
        // Day-range filters compare the ISO timestamp's date part; YYYY-MM-DD
        // substrings order lexicographically = chronologically.
        prsInRange: db.prepare(
            `SELECT pr_id, state, created_at, merged_at, closed_at,
                    review_comment_count, review_rounds, changes_requested_count, time_to_merge_hours
             FROM pr_records
             WHERE developer_id = ? AND substr(created_at, 1, 10) BETWEEN ? AND ?`,
        ),
        aiSignature: db.prepare(
            `SELECT AVG(ai_signature_score) AS score
             FROM git_snapshots
             WHERE developer_id = ? AND date BETWEEN ? AND ?
               AND commits > 0 AND ai_signature_score IS NOT NULL`,
        ),
        churn: db.prepare(
            `SELECT AVG(code_churn_rate) AS churn
             FROM git_snapshots
             WHERE developer_id = ? AND date BETWEEN ? AND ?
               AND commits > 0 AND code_churn_rate IS NOT NULL`,
        ),
        commentsGiven: db.prepare(
            `SELECT COALESCE(SUM(review_comments_given), 0) AS given
             FROM git_snapshots
             WHERE developer_id = ? AND date BETWEEN ? AND ?`,
        ),
        upsert: db.prepare(
            `INSERT INTO pr_review_metrics
             (id, developer_id, period, scope_variant, prs_total, prs_merged, rework_rate,
              avg_review_rounds, review_rejection_rate, avg_comment_density,
              comment_density_vs_baseline, avg_time_to_merge_hours, review_comments_given,
              avg_churn, combined_signal, basis, computed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(developer_id, period, scope_variant) DO UPDATE SET
               prs_total = excluded.prs_total,
               prs_merged = excluded.prs_merged,
               rework_rate = excluded.rework_rate,
               avg_review_rounds = excluded.avg_review_rounds,
               review_rejection_rate = excluded.review_rejection_rate,
               avg_comment_density = excluded.avg_comment_density,
               comment_density_vs_baseline = excluded.comment_density_vs_baseline,
               avg_time_to_merge_hours = excluded.avg_time_to_merge_hours,
               review_comments_given = excluded.review_comments_given,
               avg_churn = excluded.avg_churn,
               combined_signal = excluded.combined_signal,
               basis = excluded.basis,
               computed_at = excluded.computed_at`,
        ),
    };
}

/**
 * Load a developer's PRs for a day range, annotated with the per-PR AI
 * signature estimate (mean daily ai_signature_score over the PR's active
 * window; null when the window has no scored git activity). The window is
 * created → merged/closed; for a still-open PR it extends to `today` so the
 * estimate covers the work actually done so far, not just the creation day.
 */
function loadAnnotatedPRs(
    stmts: Statements,
    developerId: string,
    range: DateRange,
    today: string,
): PRData[] {
    const rows = stmts.prsInRange.all(developerId, range.start, range.end) as PRRecordRow[];
    return rows.map((row) => {
        const windowStart = row.created_at.slice(0, 10);
        const closedDay = row.merged_at ?? row.closed_at;
        const windowEnd = closedDay ? closedDay.slice(0, 10) : today;
        const ai = stmts.aiSignature.get(
            developerId,
            windowStart,
            // A malformed/earlier close date can't invert the window.
            windowEnd >= windowStart ? windowEnd : windowStart,
        ) as {score: number | null};
        return {
            prId: row.pr_id,
            state: row.state,
            createdAt: row.created_at,
            mergedAt: row.merged_at,
            closedAt: row.closed_at,
            reviewCommentCount: row.review_comment_count,
            reviewRounds: row.review_rounds,
            changesRequestedCount: row.changes_requested_count,
            timeToMergeHours: row.time_to_merge_hours,
            aiSignatureScore: ai.score,
        };
    });
}

interface BaselineDensities {
    allPr: number | null;
    aiAssisted: number | null;
}

function meanOrNull(values: number[]): number | null {
    if (values.length === 0) return null;
    return values.reduce((s, d) => s + d, 0) / values.length;
}

/**
 * The developer's OWN trailing comment densities (within-developer baseline),
 * for both variants in one walk: the mean of the per-period densities over the
 * prior `baselinePeriods` periods, counting only periods where the developer
 * actually had PRs in that variant's scope (an idle week is no evidence about
 * density). Recomputed live from pr_records so the result is deterministic
 * regardless of which metric rows already exist. Null when no prior period has
 * any PRs — the first period has no baseline.
 */
function trailingBaselineDensities(
    stmts: Statements,
    developerId: string,
    unit: PRReviewPeriodUnit,
    period: string,
    thresholds: PRReviewThresholds,
    today: string,
): BaselineDensities {
    const allDensities: number[] = [];
    const aiDensities: number[] = [];
    let key = period;
    for (let i = 0; i < thresholds.baselinePeriods; i++) {
        key = priorPeriod(unit, key);
        const prs = loadAnnotatedPRs(stmts, developerId, periodRange(unit, key), today);
        const all = commentDensity(prs);
        if (all !== null) allDensities.push(all);
        const ai = commentDensity(selectAiAssistedPRs(prs, thresholds.aiSignatureThreshold));
        if (ai !== null) aiDensities.push(ai);
    }
    return {allPr: meanOrNull(allDensities), aiAssisted: meanOrNull(aiDensities)};
}

function writeMetrics(
    stmts: Statements,
    developerId: string,
    period: string,
    metrics: VariantMetrics,
    reviewCommentsGiven: number,
    computedAt: string,
): void {
    stmts.upsert.run(
        randomUUID(),
        developerId,
        period,
        metrics.scopeVariant,
        metrics.prsTotal,
        metrics.prsMerged,
        metrics.reworkRate,
        metrics.avgReviewRounds,
        metrics.reviewRejectionRate,
        metrics.avgCommentDensity,
        metrics.commentDensityVsBaseline,
        metrics.avgTimeToMergeHours,
        reviewCommentsGiven,
        metrics.avgChurn,
        metrics.combinedSignal,
        metrics.basis,
        computedAt,
    );
}

/**
 * Compute and persist both scope variants for every developer with at least
 * one PR created in the period. Developers with no PRs get no rows (no false
 * coaching on no data); a developer whose PRs are all non-AI still gets an
 * ai_assisted_pr row (prs_total 0 → insufficient_data) so the variant pair
 * stays complete and the separation explicit. Idempotent: re-running a period
 * recomputes and overwrites via the (developer, period, scope_variant) key,
 * and deletes rows for developers who no longer have PRs in the period (e.g.
 * after a registry correction re-attributed their PRs) so a recompute never
 * leaves another developer's numbers behind.
 */
export function computePRReviewMetricsForPeriod(
    db: Database.Database,
    unit: PRReviewPeriodUnit,
    period: string,
    now: Date = new Date(),
): PRReviewComputeResult {
    const range = periodRange(unit, period); // validates the period key shape
    const thresholds = resolvePRReviewThresholds(db);
    const stmts = prepareStatements(db);
    const computedAt = now.toISOString();
    const today = computedAt.slice(0, 10);

    const developerRows = db
        .prepare(
            `SELECT DISTINCT developer_id AS id FROM pr_records
             WHERE substr(created_at, 1, 10) BETWEEN ? AND ?`,
        )
        .all(range.start, range.end) as Array<{id: string}>;

    let rowsWritten = 0;
    const run = db.transaction(() => {
        // Retract rows the recompute will not regenerate: a developer whose
        // PRs were re-attributed out of this period must not keep metrics
        // derived from PRs that are no longer theirs.
        const ids = developerRows.map((r) => r.id);
        const placeholders = ids.map(() => '?').join(', ');
        db.prepare(
            ids.length === 0
                ? 'DELETE FROM pr_review_metrics WHERE period = ?'
                : `DELETE FROM pr_review_metrics WHERE period = ? AND developer_id NOT IN (${placeholders})`,
        ).run(period, ...ids);

        for (const {id: developerId} of developerRows) {
            const allPRs = loadAnnotatedPRs(stmts, developerId, range, today);
            if (allPRs.length === 0) continue;
            const aiPRs = selectAiAssistedPRs(allPRs, thresholds.aiSignatureThreshold);

            const churnRow = stmts.churn.get(developerId, range.start, range.end) as {
                churn: number | null;
            };
            const givenRow = stmts.commentsGiven.get(developerId, range.start, range.end) as {
                given: number;
            };

            const baselines = trailingBaselineDensities(
                stmts, developerId, unit, period, thresholds, today,
            );

            const allMetrics = computeVariantMetrics(
                'all_pr', allPRs, churnRow.churn, baselines.allPr, thresholds,
            );
            const aiMetrics = computeVariantMetrics(
                'ai_assisted_pr', aiPRs, churnRow.churn, baselines.aiAssisted, thresholds,
            );

            writeMetrics(stmts, developerId, period, allMetrics, givenRow.given, computedAt);
            writeMetrics(stmts, developerId, period, aiMetrics, givenRow.given, computedAt);
            rowsWritten += 2;
        }
    });
    run();

    return {periodUnit: unit, period, developers: developerRows.length, rowsWritten};
}
