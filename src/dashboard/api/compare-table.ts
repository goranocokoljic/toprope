/**
 * Sortable all-teams comparison table (Task 4.10 / #105).
 *
 * GET /api/teams/compare-table?period=<quarter> returns one row per team the
 * manager oversees for a single period, carrying the columns the large-org
 * ranking case needs: utilization, active/total developers, total cost,
 * cost-per-PR, churn, AI maturity score (honestly labeled by its basis), waste,
 * and each team's data-quality tier.
 *
 * The numbers are READ from the pre-computed `quarterly_aggregates` table — the
 * team-level rollup the quarterly job already writes — never recomputed here.
 * That is the whole point of the issue's "handles 12+ teams without performance
 * issues (pre-computed aggregates)" requirement: serving a period is a single
 * indexed LEFT JOIN of the team registry against that period's rows, so the cost
 * is bounded by team count, not by headcount × period-days. Sorting is left to
 * the client (the row set is small — one row per team), matching the Phase 2
 * Teams List, which sorts the same way.
 *
 * Quarterly is the source level because it is the finest team-level grain that
 * carries every required column — crucially `wasted_spend`/`unused_seat_count`
 * (the waste column) and `ai_maturity_score`/`_basis`, which the per-developer
 * weekly/monthly tables and the team-level yearly table do not all carry. The
 * `period` selector therefore picks a quarter (YYYY-Qn); `available_periods`
 * lists the quarters that have been rolled up (most recent first) so the UI can
 * populate the selector and default to the latest.
 *
 * Every overseen team is listed even when it has no aggregate row for the chosen
 * period (created after that quarter ran, or the rollup has not covered it): such
 * a team comes back with `metrics: null` so the UI shows an honest "—" row rather
 * than dropping the team. The data-quality tier is a CURRENT (all-time) property
 * of the team — reused verbatim from the rich-compare endpoint's
 * `computeTeamTiers` — so it is present regardless of the selected period.
 *
 * Admin-gated like the rest of the manager API.
 */

import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {isAdmin, forbidden} from './guards';
import {computeTeamTiers, type DataQualityTier} from './compare';
import {validatePeriod} from '../../summaries/target';

interface TierBreakdown {
    high: number;
    medium: number;
    low: number;
    none: number;
}

/** The period's pre-computed metrics for one team (a quarterly_aggregates row). */
interface CompareTableMetrics {
    developer_count: number;
    active_developer_count: number;
    /** active / total; null when the team had no members in the period. */
    utilization_rate: number | null;
    total_subscription_cost: number | null;
    cost_per_pr: number | null;
    avg_code_churn: number | null;
    total_prs_merged: number | null;
    /** Latest period maturity score; null when none computed. */
    ai_maturity_score: number | null;
    /** Basis for that score — 'git_estimate' at launch (honesty label). */
    ai_maturity_basis: string | null;
    /** Estimated monthly spend wasted on unused/underused seats this period. */
    wasted_spend: number | null;
    /** Count of seats flagged unused this period. */
    unused_seat_count: number | null;
}

interface CompareTableTeam {
    name: string;
    department: string | null;
    manager: string | null;
    /**
     * The team's CURRENT data-quality tier (weakest best-signal among its
     * data-bearing developers — see `computeTeamTiers`). All-time, not scoped to
     * the selected period, so a team is never visually equated with a
     * better-connected one regardless of which period is shown.
     */
    tier: DataQualityTier;
    tier_breakdown: TierBreakdown;
    /** The period's pre-computed metrics, or null when no row exists for it. */
    metrics: CompareTableMetrics | null;
}

/** A quarterly_aggregates row joined to its team, as read from SQLite. */
interface JoinedRow {
    name: string;
    department: string | null;
    manager: string | null;
    /** 1 when a quarterly_aggregates row exists for (team, period); 0 otherwise. */
    has_row: number;
    developer_count: number | null;
    active_developer_count: number | null;
    utilization_rate: number | null;
    total_subscription_cost: number | null;
    cost_per_pr: number | null;
    avg_code_churn: number | null;
    total_prs_merged: number | null;
    ai_maturity_score: number | null;
    ai_maturity_basis: string | null;
    wasted_spend: number | null;
    unused_seat_count: number | null;
}

/** Quarters that have been rolled up, most recent first (YYYY-Qn sorts lexically). */
function availablePeriods(db: Database.Database): string[] {
    const rows = db
        .prepare('SELECT DISTINCT quarter FROM quarterly_aggregates ORDER BY quarter DESC')
        .all() as {quarter: string}[];
    return rows.map((r) => r.quarter);
}

/**
 * Every overseen team joined to its quarterly_aggregates row for `period` (null
 * fields where no row exists), in team-name order — the same team set and order
 * as the Phase 2 Teams List. The period is bound; columns are fixed.
 */
function joinTeamsToPeriod(db: Database.Database, period: string): JoinedRow[] {
    return db
        .prepare(
            `SELECT t.name AS name, t.department AS department, t.manager AS manager,
                    CASE WHEN q.id IS NULL THEN 0 ELSE 1 END AS has_row,
                    q.developer_count AS developer_count,
                    q.active_developer_count AS active_developer_count,
                    q.utilization_rate AS utilization_rate,
                    q.total_subscription_cost AS total_subscription_cost,
                    q.cost_per_pr AS cost_per_pr,
                    q.avg_code_churn AS avg_code_churn,
                    q.total_prs_merged AS total_prs_merged,
                    q.ai_maturity_score AS ai_maturity_score,
                    q.ai_maturity_basis AS ai_maturity_basis,
                    q.wasted_spend AS wasted_spend,
                    q.unused_seat_count AS unused_seat_count
             FROM teams t
             LEFT JOIN quarterly_aggregates q ON q.team = t.name AND q.quarter = ?
             ORDER BY t.name`,
        )
        .all(period) as JoinedRow[];
}

/** All overseen teams in name order (used when no period has been rolled up yet). */
function listTeamMeta(db: Database.Database): {name: string; department: string | null; manager: string | null}[] {
    return db
        .prepare('SELECT name, department, manager FROM teams ORDER BY name')
        .all() as {name: string; department: string | null; manager: string | null}[];
}

/** Project a joined row's metric columns into the response metrics, or null when absent. */
function metricsFromRow(row: JoinedRow): CompareTableMetrics | null {
    if (!row.has_row) {
        return null;
    }
    return {
        developer_count: row.developer_count ?? 0,
        active_developer_count: row.active_developer_count ?? 0,
        utilization_rate: row.utilization_rate,
        total_subscription_cost: row.total_subscription_cost,
        cost_per_pr: row.cost_per_pr,
        avg_code_churn: row.avg_code_churn,
        total_prs_merged: row.total_prs_merged,
        ai_maturity_score: row.ai_maturity_score,
        ai_maturity_basis: row.ai_maturity_basis,
        wasted_spend: row.wasted_spend,
        unused_seat_count: row.unused_seat_count,
    };
}

export function registerCompareTableRoutes(app: FastifyInstance, db: Database.Database): void {
    app.get<{Querystring: {period?: string}}>('/api/teams/compare-table', async (request, reply) => {
        if (!isAdmin(request)) {
            return forbidden(reply);
        }

        const periods = availablePeriods(db);

        // Resolve the period: an explicit (validated) quarter, else the latest
        // rolled-up one. A malformed period is a 400 before any DB work.
        let period: string | null;
        const raw = request.query.period;
        if (raw !== undefined) {
            try {
                period = validatePeriod('quarterly', raw);
            } catch {
                return reply.status(400).send({
                    error: 'Bad Request',
                    message: `Invalid quarterly period '${raw}' (expected YYYY-Qn, e.g. 2026-Q2)`,
                });
            }
        } else {
            period = periods[0] ?? null;
        }

        // List every overseen team. The tier is all-time, so it is attached even
        // for a period with no rows (or before any rollup has run).
        const meta = period !== null ? joinTeamsToPeriod(db, period) : listTeamMeta(db).map((m) => ({
            ...m,
            has_row: 0,
            developer_count: null,
            active_developer_count: null,
            utilization_rate: null,
            total_subscription_cost: null,
            cost_per_pr: null,
            avg_code_churn: null,
            total_prs_merged: null,
            ai_maturity_score: null,
            ai_maturity_basis: null,
            wasted_spend: null,
            unused_seat_count: null,
        } as JoinedRow));

        const tiers = computeTeamTiers(db, meta.map((m) => m.name));

        const teams: CompareTableTeam[] = meta.map((row) => {
            const tierInfo = tiers.get(row.name) ?? {
                tier: 'none' as DataQualityTier,
                breakdown: {high: 0, medium: 0, low: 0, none: 0},
            };
            return {
                name: row.name,
                department: row.department,
                manager: row.manager,
                tier: tierInfo.tier,
                tier_breakdown: tierInfo.breakdown,
                metrics: metricsFromRow(row),
            };
        });

        return {
            data: {
                period,
                available_periods: periods,
                teams,
            },
        };
    });
}
