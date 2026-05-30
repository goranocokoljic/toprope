import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {parseTimeRange, TimeRangeError, type TimeRangeInput} from './range';
import {isAdmin, forbidden} from './guards';

interface TrendRow {
    date: string;
    active_developers: number;
    interactions: number;
    acceptances: number;
}

const TREND_SELECT = `
    date,
    COUNT(DISTINCT CASE WHEN is_active = 1 THEN developer_id END) AS active_developers,
    COALESCE(SUM(interaction_count), 0) AS interactions,
    COALESCE(SUM(acceptance_count), 0) AS acceptances
`;

function orgTrend(db: Database.Database, from: string, to: string): TrendRow[] {
    return db
        .prepare(
            `SELECT ${TREND_SELECT}
             FROM tool_snapshots
             WHERE date >= ? AND date <= ?
             GROUP BY date
             ORDER BY date`,
        )
        .all(from, to) as TrendRow[];
}

function teamTrend(db: Database.Database, team: string, from: string, to: string): TrendRow[] {
    return db
        .prepare(
            `SELECT ts.date AS date,
                    COUNT(DISTINCT CASE WHEN ts.is_active = 1 THEN ts.developer_id END) AS active_developers,
                    COALESCE(SUM(ts.interaction_count), 0) AS interactions,
                    COALESCE(SUM(ts.acceptance_count), 0) AS acceptances
             FROM tool_snapshots ts
             JOIN developers d ON d.id = ts.developer_id
             WHERE d.team = ? AND ts.date >= ? AND ts.date <= ?
             GROUP BY ts.date
             ORDER BY ts.date`,
        )
        .all(team, from, to) as TrendRow[];
}

export function registerTrendRoutes(app: FastifyInstance, db: Database.Database): void {
    app.get<{Querystring: TimeRangeInput}>('/api/overview/trend', async (request, reply) => {
        if (!isAdmin(request)) {
            return forbidden(reply);
        }

        let range;
        try {
            range = parseTimeRange(request.query, {
                earliest: () =>
                    (db.prepare('SELECT MIN(date) AS earliest FROM tool_snapshots').get() as {
                        earliest: string | null;
                    }).earliest,
            });
        } catch (err) {
            if (err instanceof TimeRangeError) {
                return reply.status(400).send({error: 'Bad Request', message: err.message});
            }
            throw err;
        }

        return {
            data: {
                range: range.range,
                from: range.from,
                to: range.to,
                points: orgTrend(db, range.from, range.to),
            },
        };
    });

    app.get<{Params: {team: string}; Querystring: TimeRangeInput}>(
        '/api/teams/:team/trend',
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
                    earliest: () =>
                        (db
                            .prepare(
                                `SELECT MIN(ts.date) AS earliest
                                 FROM tool_snapshots ts
                                 JOIN developers d ON d.id = ts.developer_id
                                 WHERE d.team = ?`,
                            )
                            .get(team) as {earliest: string | null}).earliest,
                });
            } catch (err) {
                if (err instanceof TimeRangeError) {
                    return reply.status(400).send({error: 'Bad Request', message: err.message});
                }
                throw err;
            }

            return {
                data: {
                    team,
                    range: range.range,
                    from: range.from,
                    to: range.to,
                    points: teamTrend(db, team, range.from, range.to),
                },
            };
        },
    );
}
