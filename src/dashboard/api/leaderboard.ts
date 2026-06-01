import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import type Database from 'better-sqlite3';
import {parseTimeRange, TimeRangeError, type TimeRange} from './range';
import {getGlobalSetting, resolveSetting} from '../../settings/store';
import {canAccessLeaderboard, type LeaderboardRole} from './leaderboard-gate';

/**
 * Optional leaderboard endpoints (Task 2.17 / #52).
 *
 * A ranked team leaderboard, shipped OFF by default and gated entirely by
 * settings (decision #2). Two routes live under /api/leaderboard:
 *  - GET /api/leaderboard/availability — a cheap capability probe the dashboard
 *    nav uses to decide whether to render the leaderboard entry point AT ALL, so
 *    that when disabled there is no trace of it (not merely a blocked link).
 *  - GET /api/leaderboard/:team — the ranked view itself; returns 403 whenever
 *    the gate denies access, including the default (leaderboard disabled) state.
 *
 * Both sit behind the session middleware, which already confines the only
 * non-admin role (`developer`) to /api/me and /api/auth — so a request reaching
 * here is an admin. The gate is still evaluated per request as defense-in-depth
 * and the seam where a future dedicated manager role plugs in.
 *
 * Ranking metrics: `activity` (total tool interactions), `acceptance` (accepted
 * suggestions / interactions), or `output` (git commits). All three are computed
 * for every developer so the UI can switch metric without a different shape; the
 * chosen metric drives the sort and the `value` field.
 */

const METRICS = ['activity', 'acceptance', 'output'] as const;
type LeaderboardMetric = (typeof METRICS)[number];

function parseMetric(raw: unknown): LeaderboardMetric | null {
    if (raw === undefined) {
        return 'activity';
    }
    return (METRICS as readonly string[]).includes(String(raw)) ? (String(raw) as LeaderboardMetric) : null;
}

interface LeaderboardEntry {
    rank: number;
    developer_id: string;
    name: string;
    /** The value of the selected metric — interactions, a 0..1 rate, or commits. */
    value: number;
    interactions: number;
    acceptances: number;
    acceptance_rate: number;
    commits: number;
    lines_added: number;
}

/** The metric value used for sorting/ranking a single entry. */
function metricValue(entry: LeaderboardEntry, metric: LeaderboardMetric): number {
    switch (metric) {
        case 'activity':
            return entry.interactions;
        case 'acceptance':
            return entry.acceptance_rate;
        case 'output':
            return entry.commits;
    }
}

/**
 * The role the gate should evaluate for this request. Today the middleware only
 * ever lets `admin` reach these routes; `developer` is mapped through so the
 * defense-in-depth gate denies it explicitly rather than relying on the route
 * never being hit. A future dedicated manager role would map to `'manager'`.
 */
function gateRole(request: FastifyRequest): LeaderboardRole {
    return request.authUser?.role === 'admin' ? 'admin' : 'developer';
}

function forbidden(reply: FastifyReply): void {
    reply.status(403).send({
        error: 'Forbidden',
        code: 'leaderboard_disabled',
        message: 'The leaderboard is not enabled.',
    });
}

export function registerLeaderboardRoutes(app: FastifyInstance, db: Database.Database): void {
    // Capability probe for the dashboard nav. Returns whether the current
    // principal may view any leaderboard, so the nav can hide the entry point
    // entirely when disabled. Cheap: reads only the two global flags.
    app.get('/api/leaderboard/availability', async (request) => {
        const globalEnabled = getGlobalSetting(db, 'leaderboard_enabled') === true;
        const managersCanEnable = getGlobalSetting(db, 'leaderboard_managers_can_enable') === true;
        // Availability is the team-independent question "could this principal see
        // a leaderboard for some team?". For an admin that is exactly the global
        // master switch; for a manager it additionally needs the managers flag on
        // (a specific team is still gated per request at the :team route).
        const role = gateRole(request);
        const available =
            role === 'admin'
                ? globalEnabled
                : canAccessLeaderboard({role, globalEnabled, managersCanEnable, teamEnabled: true});
        return {data: {available, leaderboard_enabled: globalEnabled, managers_can_enable: managersCanEnable}};
    });

    app.get<{Params: {team: string}; Querystring: {metric?: string; range?: string; from?: string; to?: string}}>(
        '/api/leaderboard/:team',
        async (request, reply) => {
            const {team} = request.params;

            const teamRow = db.prepare('SELECT name FROM teams WHERE name = ?').get(team) as
                | {name: string}
                | undefined;
            if (!teamRow) {
                return reply.status(404).send({error: 'Not Found', message: `Team '${team}' not found`});
            }

            // --- Gate: global master switch + role + resolved per-team value ---
            const globalEnabled = getGlobalSetting(db, 'leaderboard_enabled') === true;
            const managersCanEnable = getGlobalSetting(db, 'leaderboard_managers_can_enable') === true;
            const teamEnabled = resolveSetting(db, 'leaderboard_enabled', team) === true;
            const allowed = canAccessLeaderboard({
                role: gateRole(request),
                globalEnabled,
                managersCanEnable,
                teamEnabled,
            });
            if (!allowed) {
                return forbidden(reply);
            }

            const metric = parseMetric(request.query.metric);
            if (!metric) {
                return reply.status(400).send({
                    error: 'Bad Request',
                    message: `metric must be one of: ${METRICS.join(', ')}`,
                });
            }

            const developers = db
                .prepare('SELECT id, name FROM developers WHERE team = ? ORDER BY name')
                .all(team) as {id: string; name: string}[];

            let range: TimeRange;
            try {
                range = parseTimeRange(request.query, {
                    earliest: () => earliestTeamDate(db, team),
                });
            } catch (err) {
                if (err instanceof TimeRangeError) {
                    return reply.status(400).send({error: 'Bad Request', message: err.message});
                }
                throw err;
            }

            const entries = rankDevelopers(db, developers, range, metric);
            return {
                data: {
                    team,
                    metric,
                    range: range.range,
                    from: range.from,
                    to: range.to,
                    entries,
                },
            };
        },
    );
}

/** Earliest snapshot date (tool or git) across a team's developers, for lifetime. */
function earliestTeamDate(db: Database.Database, team: string): string | null {
    const row = db
        .prepare(
            `SELECT MIN(d) AS earliest FROM (
                SELECT MIN(ts.date) AS d FROM tool_snapshots ts
                  JOIN developers dv ON dv.id = ts.developer_id WHERE dv.team = ?
                UNION ALL
                SELECT MIN(gs.date) AS d FROM git_snapshots gs
                  JOIN developers dv ON dv.id = gs.developer_id WHERE dv.team = ?
             )`,
        )
        .get(team, team) as {earliest: string | null};
    return row.earliest;
}

/**
 * Aggregate each developer's metrics over the window and rank by the chosen
 * metric. Every team member appears (zero-activity included, value 0), so the
 * board honestly reflects the whole team rather than only active developers.
 * Sort is metric desc, name asc as a stable tiebreak; ties share a rank
 * (standard competition ranking: 1,2,2,4).
 */
function rankDevelopers(
    db: Database.Database,
    developers: {id: string; name: string}[],
    range: TimeRange,
    metric: LeaderboardMetric,
): LeaderboardEntry[] {
    if (developers.length === 0) {
        return [];
    }
    const ids = developers.map((d) => d.id);
    const placeholders = ids.map(() => '?').join(',');

    const toolRows = db
        .prepare(
            `SELECT developer_id,
                    COALESCE(SUM(interaction_count), 0) AS interactions,
                    COALESCE(SUM(acceptance_count), 0) AS acceptances
             FROM tool_snapshots
             WHERE developer_id IN (${placeholders}) AND date >= ? AND date <= ?
             GROUP BY developer_id`,
        )
        .all(...ids, range.from, range.to) as {developer_id: string; interactions: number; acceptances: number}[];

    const gitRows = db
        .prepare(
            `SELECT developer_id,
                    COALESCE(SUM(commits), 0) AS commits,
                    COALESCE(SUM(lines_added), 0) AS lines_added
             FROM git_snapshots
             WHERE developer_id IN (${placeholders}) AND date >= ? AND date <= ?
             GROUP BY developer_id`,
        )
        .all(...ids, range.from, range.to) as {developer_id: string; commits: number; lines_added: number}[];

    const toolMap = new Map(toolRows.map((r) => [r.developer_id, r]));
    const gitMap = new Map(gitRows.map((r) => [r.developer_id, r]));

    const entries: LeaderboardEntry[] = developers.map((dev) => {
        const tool = toolMap.get(dev.id);
        const git = gitMap.get(dev.id);
        const interactions = tool?.interactions ?? 0;
        const acceptances = tool?.acceptances ?? 0;
        return {
            rank: 0,
            developer_id: dev.id,
            name: dev.name,
            value: 0,
            interactions,
            acceptances,
            acceptance_rate: interactions > 0 ? acceptances / interactions : 0,
            commits: git?.commits ?? 0,
            lines_added: git?.lines_added ?? 0,
        };
    });

    for (const entry of entries) {
        entry.value = metricValue(entry, metric);
    }

    entries.sort((a, b) => (b.value !== a.value ? b.value - a.value : a.name.localeCompare(b.name)));

    let lastValue: number | null = null;
    let lastRank = 0;
    entries.forEach((entry, index) => {
        if (lastValue === null || entry.value !== lastValue) {
            entry.rank = index + 1;
            lastRank = entry.rank;
            lastValue = entry.value;
        } else {
            entry.rank = lastRank;
        }
    });

    return entries;
}
