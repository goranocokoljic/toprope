/**
 * Pre-computed aggregate reads (Task 3.11 / #80).
 *
 * GET /api/aggregates/:scope/:level?period=<p> returns the already-rolled-up
 * aggregate row(s) for a period — a pure index lookup, never a recomputation, so
 * the response stays well under the 200ms read budget the acceptance criteria set
 * (the rollup jobs did the work; this only serves it).
 *
 * The shape of "row(s)" follows the storage model, not a uniform schema:
 *   - weekly / monthly are PER-DEVELOPER tables, so a team scope returns that
 *     team's developer rows and the org scope returns every developer's row.
 *   - quarterly / yearly are TEAM-LEVEL tables (one row per team per period,
 *     carrying the maturity score + basis), so a team scope returns that team's
 *     single row and the org scope returns every team's row.
 *
 * Admin-gated like the rest of the manager API (developers reach their own data
 * through /api/me/*).
 */

import type {FastifyInstance} from 'fastify';
import type Database from 'better-sqlite3';
import {isAdmin, forbidden} from './guards';
import {isoWeekStart} from '../../aggregation/dates';

/** The four aggregate levels, each mapped to its table and period column. */
type AggregateLevel = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

interface LevelSpec {
    table: string;
    periodColumn: string;
    /** Per-developer tables (weekly/monthly) vs team-level (quarterly/yearly). */
    perDeveloper: boolean;
    /** Validate the raw period token; returns the normalized stored value or null. */
    normalizePeriod: (raw: string) => string | null;
}

const WEEK_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const QUARTER_RE = /^\d{4}-Q[1-4]$/;
const YEAR_RE = /^\d{4}$/;

const LEVEL_SPECS: Record<AggregateLevel, LevelSpec> = {
    weekly: {
        table: 'weekly_aggregates',
        periodColumn: 'week_start',
        perDeveloper: true,
        // Accept any date in the target week and normalize to that week's Monday —
        // the canonical week_start the table is keyed on — so a caller need not know
        // which day is the ISO week start.
        normalizePeriod: (raw) => {
            if (!WEEK_DATE_RE.test(raw)) {
                return null;
            }
            try {
                return isoWeekStart(raw);
            } catch {
                return null;
            }
        },
    },
    monthly: {
        table: 'monthly_aggregates',
        periodColumn: 'month',
        perDeveloper: true,
        normalizePeriod: (raw) => (MONTH_RE.test(raw) ? raw : null),
    },
    quarterly: {
        table: 'quarterly_aggregates',
        periodColumn: 'quarter',
        perDeveloper: false,
        normalizePeriod: (raw) => (QUARTER_RE.test(raw) ? raw : null),
    },
    yearly: {
        table: 'yearly_aggregates',
        periodColumn: 'year',
        perDeveloper: false,
        normalizePeriod: (raw) => (YEAR_RE.test(raw) ? raw : null),
    },
};

interface ScopeFilter {
    type: 'team' | 'org';
    name: string;
}

/** Parse the :scope path param into a team/org filter, or null when malformed. */
function parseScope(raw: string): ScopeFilter | null {
    if (raw === 'org') {
        return {type: 'org', name: 'org'};
    }
    if (raw.startsWith('team:')) {
        const name = raw.slice('team:'.length).trim();
        return name.length > 0 ? {type: 'team', name} : null;
    }
    return null;
}

function isAggregateLevel(value: string): value is AggregateLevel {
    return value === 'weekly' || value === 'monthly' || value === 'quarterly' || value === 'yearly';
}

/** tools_used is stored as a JSON array string; return it parsed (or [] if unreadable). */
function parseToolsUsed(value: unknown): string[] {
    if (typeof value !== 'string') {
        return [];
    }
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
        return [];
    }
}

type AggregateRow = Record<string, unknown>;

/** Re-shape a raw row for the response: parse the JSON tools_used column. */
function shapeRow(row: AggregateRow): AggregateRow {
    if ('tools_used' in row) {
        return {...row, tools_used: parseToolsUsed(row.tools_used)};
    }
    return row;
}

function queryRows(
    db: Database.Database,
    spec: LevelSpec,
    scope: ScopeFilter,
    period: string,
): AggregateRow[] {
    const {table, periodColumn, perDeveloper} = spec;
    // Per-developer tables order by developer (and team first for org breadth);
    // team-level tables order by team. period/team are bound; table & column come
    // from the internal LEVEL_SPECS map, never user input.
    if (scope.type === 'team') {
        const order = perDeveloper ? 'ORDER BY developer_id' : '';
        return db
            .prepare(
                `SELECT * FROM ${table} WHERE team = ? AND ${periodColumn} = ? ${order}`,
            )
            .all(scope.name, period) as AggregateRow[];
    }
    const order = perDeveloper ? 'ORDER BY team, developer_id' : 'ORDER BY team';
    return db
        .prepare(`SELECT * FROM ${table} WHERE ${periodColumn} = ? ${order}`)
        .all(period) as AggregateRow[];
}

export function registerAggregateRoutes(app: FastifyInstance, db: Database.Database): void {
    app.get<{Params: {scope: string; level: string}; Querystring: {period?: string}}>(
        '/api/aggregates/:scope/:level',
        async (request, reply) => {
            if (!isAdmin(request)) {
                return forbidden(reply);
            }

            const {level: levelRaw, scope: scopeRaw} = request.params;
            if (!isAggregateLevel(levelRaw)) {
                return reply.status(400).send({
                    error: 'Bad Request',
                    message: `Unknown level '${levelRaw}' (expected weekly|monthly|quarterly|yearly)`,
                });
            }
            const spec = LEVEL_SPECS[levelRaw];

            const scope = parseScope(scopeRaw);
            if (!scope) {
                return reply.status(400).send({
                    error: 'Bad Request',
                    message: `Invalid scope '${scopeRaw}' (expected 'org' or 'team:<name>')`,
                });
            }

            const rawPeriod = request.query.period;
            if (!rawPeriod) {
                return reply.status(400).send({
                    error: 'Bad Request',
                    message: 'Query parameter "period" is required',
                });
            }
            const period = spec.normalizePeriod(rawPeriod);
            if (period === null) {
                return reply.status(400).send({
                    error: 'Bad Request',
                    message: `Invalid ${levelRaw} period '${rawPeriod}'`,
                });
            }

            if (scope.type === 'team') {
                const exists = db.prepare('SELECT 1 FROM teams WHERE name = ?').get(scope.name);
                if (!exists) {
                    return reply
                        .status(404)
                        .send({error: 'Not Found', message: `Team '${scope.name}' not found`});
                }
            }

            const rows = queryRows(db, spec, scope, period).map(shapeRow);
            return {
                data: {
                    scope: scopeRaw,
                    level: levelRaw,
                    period,
                    rows,
                },
            };
        },
    );
}
