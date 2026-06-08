/**
 * Rich side-by-side team comparison (Task 4.9 / #104).
 *
 * GET /api/compare?teams=a,b,c&range=<range> assembles a 2–4 team comparison: a
 * per-metric row set (utilization, active developers, total cost, cost-per-PR,
 * churn, AI maturity score, tool mix), each team's data-quality tier, and an
 * overlaid adoption trend (one active-developer series per team) over the shared
 * time-range window. The dashboard renders the side-by-side rows + overlaid
 * chart from this single payload.
 *
 * The metric block reuses the already-tested `computeTeamPeriodMetrics` fold
 * (the same per-developer → team rollup the quarterly/yearly jobs use), so the
 * comparison numbers are computed identically to the rest of the engine and
 * cannot drift. Maturity is read from the stored quarterly aggregates (the
 * finest grain it is computed at) and stays honestly labeled by its basis —
 * `git_estimate` at launch — never implying measured usage.
 *
 * Capped at 4 teams BY DESIGN (per-metric rows and overlaid lines get unreadable
 * beyond that — the large-org case is the sortable all-teams table in 4.10). The
 * cap is enforced here as well as in the UI: >4 (or <2) teams is a 400.
 *
 * Admin-gated like the rest of the manager API. The work is bounded by ≤4 teams
 * over a single window, so it stays well under the 2s budget the issue sets.
 */

import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {parseTimeRange, TimeRangeError, type TimeRangeInput} from './range';
import {isAdmin, forbidden} from './guards';
import {computeTeamPeriodMetrics} from '../../aggregation/team-period';
import {quarterRange} from '../../aggregation/dates';

/** A comparison holds at least 2 and at most 4 teams (see module header). */
export const MIN_COMPARE_TEAMS = 2;
export const MAX_COMPARE_TEAMS = 4;

export type DataQualityTier = 'high' | 'medium' | 'low' | 'none';

interface TierBreakdown {
    high: number;
    medium: number;
    low: number;
    none: number;
}

interface CompareTeamMetrics {
    developer_count: number;
    active_developer_count: number;
    /** active / total; null when the team had no members in the window. */
    utilization_rate: number | null;
    total_subscription_cost: number;
    cost_per_pr: number | null;
    avg_code_churn: number | null;
    total_prs_merged: number;
    /** Latest maturity score overlapping the window; null when none computed. */
    ai_maturity_score: number | null;
    /** Basis for that score — 'git_estimate' at launch (honesty label). */
    ai_maturity_basis: string | null;
    /** Distinct tools the team was active on during the window. */
    tool_mix: string[];
}

interface CompareTrendPoint {
    date: string;
    active_developers: number;
}

interface CompareTeam {
    name: string;
    department: string | null;
    manager: string | null;
    /**
     * The team's data-quality tier — the WEAKEST best-signal among its
     * data-bearing developers, so a team reads `high` only when every
     * contributing developer has API-grade data. This keeps a partly-git team
     * from being visually equated with a fully-connected one (the issue's
     * tier-labeling requirement). `tier_breakdown` carries the full mix.
     */
    tier: DataQualityTier;
    tier_breakdown: TierBreakdown;
    metrics: CompareTeamMetrics;
    trend: CompareTrendPoint[];
}

const RANK_TO_TIER: Record<number, DataQualityTier> = {3: 'high', 2: 'medium', 1: 'low', 0: 'none'};

/**
 * Each team's data-quality tier and the per-developer breakdown behind it.
 *
 * A developer's tier is their BEST available signal — API tool data = high
 * (tool_snapshots.data_quality), git activity = medium, an expense-only
 * subscription = low, nothing = none — exactly as /api/coverage classifies the
 * org. The team tier is then the MINIMUM best-signal across the developers that
 * have any data (rank > 0): the team's combined metrics are only as trustworthy
 * as their weakest contributing source, so `high` means fully connected. A team
 * whose developers all have no data reads `none`.
 *
 * Computed all-time (not windowed): "is this team connected" is a current
 * property of the team, the same posture as the coverage snapshot.
 */
export function computeTeamTiers(
    db: Database.Database,
    teams: string[],
): Map<string, {tier: DataQualityTier; breakdown: TierBreakdown}> {
    const result = new Map<string, {tier: DataQualityTier; breakdown: TierBreakdown}>();
    if (teams.length === 0) {
        return result;
    }
    const placeholders = teams.map(() => '?').join(',');

    const devs = db
        .prepare(`SELECT id, team FROM developers WHERE team IN (${placeholders})`)
        .all(...teams) as {id: string; team: string}[];

    const toolRows = db
        .prepare(
            `SELECT developer_id,
                    MAX(CASE data_quality
                            WHEN 'high' THEN 3
                            WHEN 'medium' THEN 2
                            WHEN 'low' THEN 1
                            ELSE 0 END) AS rank
             FROM tool_snapshots
             GROUP BY developer_id`,
        )
        .all() as {developer_id: string; rank: number}[];
    const toolRank = new Map(toolRows.map((r) => [r.developer_id, r.rank]));

    const gitDevs = new Set(
        (db.prepare('SELECT DISTINCT developer_id FROM git_snapshots').all() as {developer_id: string}[]).map(
            (r) => r.developer_id,
        ),
    );
    const expenseDevs = new Set(
        (
            db
                .prepare(
                    `SELECT DISTINCT developer_id FROM subscriptions
                     WHERE developer_id IS NOT NULL AND seat_revoked_at IS NULL`,
                )
                .all() as {developer_id: string}[]
        ).map((r) => r.developer_id),
    );

    // Seed every requested team so one with no developers still gets a row.
    for (const team of teams) {
        result.set(team, {tier: 'none', breakdown: {high: 0, medium: 0, low: 0, none: 0}});
    }

    // Track the minimum data-bearing rank per team (Infinity = no data yet).
    const minRank = new Map<string, number>(teams.map((t) => [t, Number.POSITIVE_INFINITY]));

    for (const dev of devs) {
        const rank = Math.max(
            toolRank.get(dev.id) ?? 0,
            gitDevs.has(dev.id) ? 2 : 0,
            expenseDevs.has(dev.id) ? 1 : 0,
        );
        const entry = result.get(dev.team);
        if (!entry) continue;
        entry.breakdown[RANK_TO_TIER[rank]] += 1;
        if (rank > 0) {
            minRank.set(dev.team, Math.min(minRank.get(dev.team) ?? Number.POSITIVE_INFINITY, rank));
        }
    }

    for (const team of teams) {
        const min = minRank.get(team) ?? Number.POSITIVE_INFINITY;
        const entry = result.get(team);
        if (entry) {
            entry.tier = Number.isFinite(min) ? RANK_TO_TIER[min] : 'none';
        }
    }
    return result;
}

/** Distinct tools the team was active on during [from, to], in name order. */
function teamToolMix(db: Database.Database, team: string, from: string, to: string): string[] {
    const rows = db
        .prepare(
            `SELECT DISTINCT ts.tool AS tool
             FROM tool_snapshots ts
             JOIN developers d ON d.id = ts.developer_id
             WHERE d.team = ? AND ts.is_active = 1 AND ts.date >= ? AND ts.date <= ?
             ORDER BY ts.tool`,
        )
        .all(team, from, to) as {tool: string}[];
    return rows.map((r) => r.tool);
}

/** Per-team active-developer series over [from, to], ascending by date. */
function teamTrend(db: Database.Database, team: string, from: string, to: string): CompareTrendPoint[] {
    return db
        .prepare(
            `SELECT ts.date AS date,
                    COUNT(DISTINCT CASE WHEN ts.is_active = 1 THEN ts.developer_id END) AS active_developers
             FROM tool_snapshots ts
             JOIN developers d ON d.id = ts.developer_id
             WHERE d.team = ? AND ts.date >= ? AND ts.date <= ?
             GROUP BY ts.date
             ORDER BY ts.date`,
        )
        .all(team, from, to) as CompareTrendPoint[];
}

interface QuarterRow {
    quarter: string;
    ai_maturity_score: number | null;
    ai_maturity_basis: string | null;
}

/**
 * The team's maturity score for the window: the most recent stored quarter
 * whose calendar span overlaps [from, to]. Maturity is stored per quarter (the
 * finest grain it is computed at), so a window is represented by its latest
 * overlapping quarter; null when no quarter overlaps or none has a score.
 */
function teamMaturity(
    db: Database.Database,
    team: string,
    from: string,
    to: string,
): {score: number | null; basis: string | null} {
    const rows = db
        .prepare(
            `SELECT quarter, ai_maturity_score, ai_maturity_basis
             FROM quarterly_aggregates
             WHERE team = ?
             ORDER BY quarter`,
        )
        .all(team) as QuarterRow[];

    let chosen: QuarterRow | null = null;
    for (const row of rows) {
        const span = quarterRange(row.quarter);
        // Overlap: quarter.start <= to AND quarter.end >= from. Rows are
        // chronological, so the last overlapping row wins (most recent).
        if (span.start <= to && span.end >= from) {
            chosen = row;
        }
    }
    return {score: chosen?.ai_maturity_score ?? null, basis: chosen?.ai_maturity_basis ?? null};
}

/**
 * Earliest snapshot date (git OR tool) across the requested teams' developers,
 * used to resolve a `lifetime` window. Git is included so the git-only launch
 * case still spans real history (tool snapshots may not exist yet).
 */
function earliestSnapshot(db: Database.Database, teams: string[]): string | null {
    if (teams.length === 0) {
        return null;
    }
    const placeholders = teams.map(() => '?').join(',');
    const row = db
        .prepare(
            `SELECT MIN(d) AS earliest FROM (
                 SELECT MIN(ts.date) AS d
                 FROM tool_snapshots ts JOIN developers dev ON dev.id = ts.developer_id
                 WHERE dev.team IN (${placeholders})
                 UNION ALL
                 SELECT MIN(gs.date) AS d
                 FROM git_snapshots gs JOIN developers dev ON dev.id = gs.developer_id
                 WHERE dev.team IN (${placeholders})
             )`,
        )
        .get(...teams, ...teams) as {earliest: string | null};
    return row.earliest;
}

/** Parse, trim, and de-duplicate the comma-separated `teams` query (order kept). */
function parseTeamsParam(raw: string | undefined): string[] {
    if (!raw) {
        return [];
    }
    const seen = new Set<string>();
    const teams: string[] = [];
    for (const part of raw.split(',')) {
        const name = part.trim();
        if (name && !seen.has(name)) {
            seen.add(name);
            teams.push(name);
        }
    }
    return teams;
}

export function registerCompareRoutes(app: FastifyInstance, db: Database.Database): void {
    app.get<{Querystring: {teams?: string} & TimeRangeInput}>('/api/compare', async (request, reply) => {
        if (!isAdmin(request)) {
            return forbidden(reply);
        }

        const teams = parseTeamsParam(request.query.teams);
        if (teams.length < MIN_COMPARE_TEAMS) {
            return reply.status(400).send({
                error: 'Bad Request',
                message: `Comparison requires at least ${MIN_COMPARE_TEAMS} teams`,
            });
        }
        if (teams.length > MAX_COMPARE_TEAMS) {
            return reply.status(400).send({
                error: 'Bad Request',
                message: `Comparison allows at most ${MAX_COMPARE_TEAMS} teams`,
            });
        }

        // Every requested team must exist; report the first unknown by name.
        const known = new Set(
            (
                db
                    .prepare(`SELECT name FROM teams WHERE name IN (${teams.map(() => '?').join(',')})`)
                    .all(...teams) as {name: string}[]
            ).map((r) => r.name),
        );
        const missing = teams.find((t) => !known.has(t));
        if (missing) {
            return reply.status(404).send({error: 'Not Found', message: `Team '${missing}' not found`});
        }

        let range;
        try {
            range = parseTimeRange(request.query, {earliest: () => earliestSnapshot(db, teams)});
        } catch (err) {
            if (err instanceof TimeRangeError) {
                return reply.status(400).send({error: 'Bad Request', message: err.message});
            }
            throw err;
        }

        const tiers = computeTeamTiers(db, teams);
        const meta = db
            .prepare(`SELECT name, department, manager FROM teams WHERE name IN (${teams.map(() => '?').join(',')})`)
            .all(...teams) as {name: string; department: string | null; manager: string | null}[];
        const metaByName = new Map(meta.map((m) => [m.name, m]));

        const result: CompareTeam[] = teams.map((team) => {
            const metrics = computeTeamPeriodMetrics(db, team, range.from, range.to);
            const maturity = teamMaturity(db, team, range.from, range.to);
            const tierInfo = tiers.get(team) ?? {
                tier: 'none' as DataQualityTier,
                breakdown: {high: 0, medium: 0, low: 0, none: 0},
            };
            const info = metaByName.get(team);
            return {
                name: team,
                department: info?.department ?? null,
                manager: info?.manager ?? null,
                tier: tierInfo.tier,
                tier_breakdown: tierInfo.breakdown,
                metrics: {
                    developer_count: metrics.developer_count,
                    active_developer_count: metrics.active_developer_count,
                    utilization_rate: metrics.utilization_rate,
                    total_subscription_cost: metrics.total_subscription_cost,
                    cost_per_pr: metrics.cost_per_pr,
                    avg_code_churn: metrics.avg_code_churn,
                    total_prs_merged: metrics.total_prs_merged,
                    ai_maturity_score: maturity.score,
                    ai_maturity_basis: maturity.basis,
                    tool_mix: teamToolMix(db, team, range.from, range.to),
                },
                trend: teamTrend(db, team, range.from, range.to),
            };
        });

        return {
            data: {
                range: range.range,
                from: range.from,
                to: range.to,
                teams: result,
            },
        };
    });
}
