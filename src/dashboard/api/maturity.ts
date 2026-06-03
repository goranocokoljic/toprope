/**
 * Maturity-score trend (Task 3.11 / #80).
 *
 * GET /api/maturity/:team/trend?range=<range> returns the team's AI maturity
 * score over time for charting, one point per quarter. Quarterly is the trend
 * granularity: it is the finest level the maturity score is computed and stored
 * at (quarterly_aggregates / yearly_aggregates — see Task 3.4), and fine enough
 * for a leadership trend without the noise of a weekly line.
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

/** The earliest stored quarter's first day for the team, or null when none. */
function earliestQuarterStart(db: Database.Database, team: string): string | null {
    const row = db
        .prepare('SELECT MIN(quarter) AS quarter FROM quarterly_aggregates WHERE team = ?')
        .get(team) as {quarter: string | null};
    return row.quarter ? quarterRange(row.quarter).start : null;
}

export function registerMaturityRoutes(app: FastifyInstance, db: Database.Database): void {
    app.get<{Params: {team: string}; Querystring: TimeRangeInput}>(
        '/api/maturity/:team/trend',
        async (request, reply) => {
            if (!isAdmin(request)) {
                return forbidden(reply);
            }

            const {team} = request.params;
            const exists = db.prepare('SELECT 1 FROM teams WHERE name = ?').get(team);
            if (!exists) {
                return reply.status(404).send({error: 'Not Found', message: `Team '${team}' not found`});
            }

            let range;
            try {
                range = parseTimeRange(request.query, {
                    earliest: () => earliestQuarterStart(db, team),
                });
            } catch (err) {
                if (err instanceof TimeRangeError) {
                    return reply.status(400).send({error: 'Bad Request', message: err.message});
                }
                throw err;
            }

            // A quarter belongs in the series when its calendar span overlaps the
            // resolved window: quarter.start <= to AND quarter.end >= from.
            const points: TrendPoint[] = [];
            for (const row of teamQuarters(db, team)) {
                const span = quarterRange(row.quarter);
                if (span.start <= range.to && span.end >= range.from) {
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
