/**
 * Maturity-score trend (Task 3.11 / #80, org scope added in Task 3.12 / #81).
 *
 * GET /api/maturity/:team/trend?range=<range> returns a maturity score over time
 * for charting, one point per quarter. Quarterly is the trend granularity: it is
 * the finest level the maturity score is computed and stored at
 * (quarterly_aggregates / yearly_aggregates — see Task 3.4), and fine enough for
 * a leadership trend without the noise of a weekly line.
 *
 * `:team` is either a real team name or the literal `org`. A team scope reads
 * that team's stored quarterly rows directly. The `org` scope has no stored row
 * (maturity is computed per team, never as an org aggregate — see quarterly.ts),
 * so it is folded on read: each quarter's org score is the developer-count-
 * weighted mean of the teams that have a score that quarter, and the org
 * period-over-period delta is computed across the full chronological series (so
 * the first windowed point still carries a correct delta against the true prior
 * quarter, not just the first one shown). Weighting by developer_count makes the
 * org line read as "the typical developer's team maturity" rather than letting a
 * tiny team swing the org number as much as a large one.
 *
 * The window comes from the shared range parser (30d|90d|year|lifetime|custom),
 * the same one the other manager trends use, so the selector behaves identically
 * across the dashboard. A quarter is included when its calendar span overlaps the
 * resolved [from, to] window — using overlap (not "quarter start inside window")
 * so a 30d range landing mid-quarter still surfaces that quarter's point.
 *
 * Every point carries `basis` (git_estimate at launch) so the UI can honestly
 * label the line a "git-based estimate" rather than implying measured usage.
 */

import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {parseTimeRange, TimeRangeError, type TimeRangeInput} from './range';
import {isAdmin, forbidden} from './guards';
import {quarterRange} from '../../aggregation/dates';

/** The scope token that folds every team into a single org-wide line. */
const ORG_SCOPE = 'org';

interface QuarterRow {
    quarter: string;
    ai_maturity_score: number | null;
    ai_maturity_basis: string | null;
    maturity_score_delta: number | null;
}

interface TrendPoint {
    period: string;
    start: string;
    end: string;
    score: number | null;
    basis: string | null;
    score_delta: number | null;
}

/** All stored quarterly maturity rows for a team, chronological. */
function teamQuarters(db: Database.Database, team: string): QuarterRow[] {
    return db
        .prepare(
            `SELECT quarter, ai_maturity_score, ai_maturity_basis, maturity_score_delta
             FROM quarterly_aggregates
             WHERE team = ?
             ORDER BY quarter`,
        )
        .all(team) as QuarterRow[];
}

interface OrgQuarterRow {
    quarter: string;
    weighted: number | null;
    weight: number | null;
    non_git: number | null;
}

/**
 * Fold every team's stored quarterly maturity into one org row per quarter:
 * a developer-count-weighted sum + weight (so score = weighted/weight where the
 * weight is positive), and a count of contributing rows whose basis is not the
 * launch `git_estimate`. Rows with a null score contribute nothing — they are
 * neither weighted in nor counted against the basis. The per-quarter
 * `maturity_score_delta` is intentionally not summed here: an org delta is the
 * difference of org scores, which the caller derives from the series itself.
 */
function orgQuarters(db: Database.Database): OrgQuarterRow[] {
    return db
        .prepare(
            `SELECT quarter,
                    SUM(CASE WHEN ai_maturity_score IS NOT NULL
                             THEN ai_maturity_score * COALESCE(developer_count, 0) ELSE 0 END) AS weighted,
                    SUM(CASE WHEN ai_maturity_score IS NOT NULL
                             THEN COALESCE(developer_count, 0) ELSE 0 END) AS weight,
                    SUM(CASE WHEN ai_maturity_score IS NOT NULL
                             AND ai_maturity_basis IS NOT NULL
                             AND ai_maturity_basis <> 'git_estimate' THEN 1 ELSE 0 END) AS non_git
             FROM quarterly_aggregates
             GROUP BY quarter
             ORDER BY quarter`,
        )
        .all() as OrgQuarterRow[];
}

/** Round a maturity score to one decimal so weighting can't introduce float noise. */
function roundScore(value: number): number {
    return Math.round(value * 10) / 10;
}

/**
 * Collapse the per-team org fold into chronological QuarterRows: weighted mean
 * score (null when no team had a score that quarter), the period-over-period
 * delta against the previous quarter that had a score, and a basis that stays
 * `git_estimate` until a contributing team reports a stronger basis (then
 * `mixed`). A quarter with no score carries a null basis and does not become the
 * baseline for the next quarter's delta.
 *
 * A quarter whose contributing teams all had scores but a total weight of 0
 * (every developer_count 0/null) maps to a null score by design — without a
 * weight there is no honest way to combine the team scores, so the org point is
 * omitted rather than guessed. developer_count is reliably written today
 * (quarterly.ts), so this is a defensive edge, not a live path.
 */
function foldOrgQuarters(rows: OrgQuarterRow[]): QuarterRow[] {
    const result: QuarterRow[] = [];
    let prevScore: number | null = null;
    for (const row of rows) {
        const weight = row.weight ?? 0;
        const score = weight > 0 && row.weighted !== null ? roundScore(row.weighted / weight) : null;
        // Re-round the delta: 0.1 isn't exact in IEEE-754, so subtracting two
        // already-one-decimal scores (e.g. 64.3 - 64.1) can still surface binary
        // noise like 0.19999999999999998 — round it back to a clean tenth.
        const delta = score !== null && prevScore !== null ? roundScore(score - prevScore) : null;
        result.push({
            quarter: row.quarter,
            ai_maturity_score: score,
            ai_maturity_basis: score === null ? null : (row.non_git ?? 0) > 0 ? 'mixed' : 'git_estimate',
            maturity_score_delta: delta,
        });
        if (score !== null) {
            prevScore = score;
        }
    }
    return result;
}

/** The earliest stored quarter's first day for the scope, or null when none. */
function earliestQuarterStart(db: Database.Database, team: string | null): string | null {
    const row = team
        ? (db
              .prepare('SELECT MIN(quarter) AS quarter FROM quarterly_aggregates WHERE team = ?')
              .get(team) as {quarter: string | null})
        : (db.prepare('SELECT MIN(quarter) AS quarter FROM quarterly_aggregates').get() as {
              quarter: string | null;
          });
    return row.quarter ? quarterRange(row.quarter).start : null;
}

/** Keep the quarters whose calendar span overlaps the resolved window. */
function windowQuarters(quarters: QuarterRow[], from: string, to: string): TrendPoint[] {
    const points: TrendPoint[] = [];
    for (const row of quarters) {
        const span = quarterRange(row.quarter);
        // A quarter belongs in the series when its calendar span overlaps the
        // resolved window: quarter.start <= to AND quarter.end >= from.
        if (span.start <= to && span.end >= from) {
            points.push({
                period: row.quarter,
                start: span.start,
                end: span.end,
                score: row.ai_maturity_score,
                basis: row.ai_maturity_basis,
                score_delta: row.maturity_score_delta,
            });
        }
    }
    return points;
}

export function registerMaturityRoutes(app: FastifyInstance, db: Database.Database): void {
    app.get<{Params: {team: string}; Querystring: TimeRangeInput}>(
        '/api/maturity/:team/trend',
        async (request, reply) => {
            if (!isAdmin(request)) {
                return forbidden(reply);
            }

            const {team} = request.params;
            const isOrg = team === ORG_SCOPE;
            if (!isOrg) {
                const exists = db.prepare('SELECT 1 FROM teams WHERE name = ?').get(team);
                if (!exists) {
                    return reply
                        .status(404)
                        .send({error: 'Not Found', message: `Team '${team}' not found`});
                }
            }

            let range;
            try {
                range = parseTimeRange(request.query, {
                    earliest: () => earliestQuarterStart(db, isOrg ? null : team),
                });
            } catch (err) {
                if (err instanceof TimeRangeError) {
                    return reply.status(400).send({error: 'Bad Request', message: err.message});
                }
                throw err;
            }

            const quarters = isOrg ? foldOrgQuarters(orgQuarters(db)) : teamQuarters(db, team);
            const points = windowQuarters(quarters, range.from, range.to);

            return {
                data: {
                    team,
                    range: range.range,
                    from: range.from,
                    to: range.to,
                    points,
                },
            };
        },
    );
}
