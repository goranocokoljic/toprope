import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import type Database from 'better-sqlite3';
import {getGlobalSetting, isLeaderboardEnabledForTeam} from '../../settings/store';
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
 *    The gate is evaluated BEFORE the team-existence check so a denied caller
 *    cannot use the 404-vs-403 distinction as a team-existence oracle.
 *
 * Both sit behind the session middleware, which already confines the only
 * non-admin role (`developer`) to /api/me and /api/auth — so a request reaching
 * here is an admin. The gate is still evaluated per request as defense-in-depth
 * and the seam where a future dedicated manager role plugs in.
 *
 * Ranking metrics: `activity` (total tool interactions), `acceptance` (accepted
 * suggestions / interactions), or `output` (git commits). All three are computed
 * for every developer so the UI can switch metric without a different shape; the
 * chosen metric drives the sort and the `value` field. The window is the last 30
 * days, matching the other team views (e.g. /api/teams).
 */

const METRICS = ['activity', 'acceptance', 'output'] as const;
type LeaderboardMetric = (typeof METRICS)[number];

/** Rolling window length (days) for the ranked aggregates — matches /api/teams. */
const WINDOW_DAYS = 30;

/**
 * Minimum interactions for a developer's acceptance RATE to be ranked on its own
 * merit. Below this, the rate is statistically meaningless (1/1 = 100% would
 * otherwise top a 900/1000 developer), so such developers sort to the bottom of
 * the acceptance board. Their true rate is still reported in the row; only the
 * sort value is floored. Activity/output metrics are counts and need no floor.
 */
const MIN_ACCEPTANCE_SAMPLE = 10;

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
            // Floor low-sample developers so a fluke rate can't top the board.
            return entry.interactions >= MIN_ACCEPTANCE_SAMPLE ? entry.acceptance_rate : 0;
        case 'output':
            return entry.commits;
    }
}

/**
 * The role the gate should evaluate for this request. Today the middleware only
 * ever lets `admin` reach these routes; `developer` is mapped through so the
 * defense-in-depth gate denies it explicitly rather than relying on the route
 * never being hit.
 *
 * SEAM — wiring a future dedicated `manager` role: this is the one place that
 * decides the gate role, but it is NOT sufficient on its own. To make managers
 * able to reach leaderboards you must ALSO (1) return `'manager'` here for that
 * role, (2) relax the developer-confinement in src/auth/middleware.ts so the
 * manager role is admitted to /api/leaderboard/:team, and (3) make /availability
 * resolve a manager's PER-TEAM answer — it currently hardcodes `teamEnabled:
 * true` because it takes no team, which is correct for admins (who ignore the
 * team value) but would over-report availability for a manager whose team has
 * opted out. A manager-aware probe must take a team (or scan "any team enabled?")
 * rather than assume true. Miss any of the three and the manager path is
 * half-connected.
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

/** The window [from, to] (inclusive, YYYY-MM-DD) used for the ranked aggregates. */
function rankingWindow(now = new Date()): {from: string; to: string} {
    const to = now.toISOString().slice(0, 10);
    const fromDate = new Date(now.getTime());
    fromDate.setUTCDate(fromDate.getUTCDate() - (WINDOW_DAYS - 1));
    return {from: fromDate.toISOString().slice(0, 10), to};
}

export function registerLeaderboardRoutes(app: FastifyInstance, db: Database.Database): void {
    // Capability probe for the dashboard nav. Returns whether the current
    // principal may view any leaderboard, so the nav can hide the entry point
    // entirely when disabled. Routed through the same gate as the data endpoint
    // with a team-independent `teamEnabled: true`. This is admin-accurate (admin
    // access ignores the per-team value); for the future `manager` role it is
    // intentionally optimistic — see the gateRole SEAM note. The data endpoint
    // always re-resolves per-team, so an over-optimistic probe can only show a
    // nav entry, never leak data.
    app.get('/api/leaderboard/availability', async (request) => {
        const globalEnabled = getGlobalSetting(db, 'leaderboard_enabled') === true;
        const managersCanEnable = getGlobalSetting(db, 'leaderboard_managers_can_enable') === true;
        const available = canAccessLeaderboard({
            role: gateRole(request),
            globalEnabled,
            managersCanEnable,
            teamEnabled: true,
        });
        return {data: {available}};
    });

    app.get<{Params: {team: string}; Querystring: {metric?: string}}>(
        '/api/leaderboard/:team',
        async (request, reply) => {
            const {team} = request.params;

            // Gate FIRST — before any team-existence check — so a denied caller
            // gets a uniform 403 whether or not the team exists (no existence
            // oracle). resolveSetting tolerates an unknown team (returns global).
            const globalEnabled = getGlobalSetting(db, 'leaderboard_enabled') === true;
            const managersCanEnable = getGlobalSetting(db, 'leaderboard_managers_can_enable') === true;
            const teamEnabled = isLeaderboardEnabledForTeam(db, team);
            const allowed = canAccessLeaderboard({
                role: gateRole(request),
                globalEnabled,
                managersCanEnable,
                teamEnabled,
            });
            if (!allowed) {
                return forbidden(reply);
            }

            const teamRow = db.prepare('SELECT name FROM teams WHERE name = ?').get(team) as
                | {name: string}
                | undefined;
            if (!teamRow) {
                return reply.status(404).send({error: 'Not Found', message: `Team '${team}' not found`});
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

            const window = rankingWindow();
            const entries = rankDevelopers(db, developers, window, metric);
            return {
                data: {
                    team,
                    metric,
                    from: window.from,
                    to: window.to,
                    entries,
                },
            };
        },
    );
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
    window: {from: string; to: string},
    metric: LeaderboardMetric,
): LeaderboardEntry[] {
    if (developers.length === 0) {
        return [];
    }
    const ids = developers.map((d) => d.id);
    const placeholders = ids.map(() => '?').join(',');

    // `is_active = 1` mirrors every other tool-snapshot aggregation
    // (overview.ts, developer-views.ts, developer-detail.ts), so the
    // leaderboard's interaction totals can't diverge from the rest of the
    // product when a connector writes an inactive-but-nonzero row.
    const toolRows = db
        .prepare(
            `SELECT developer_id,
                    COALESCE(SUM(interaction_count), 0) AS interactions,
                    COALESCE(SUM(acceptance_count), 0) AS acceptances
             FROM tool_snapshots
             WHERE developer_id IN (${placeholders}) AND is_active = 1 AND date >= ? AND date <= ?
             GROUP BY developer_id`,
        )
        .all(...ids, window.from, window.to) as {developer_id: string; interactions: number; acceptances: number}[];

    const gitRows = db
        .prepare(
            `SELECT developer_id,
                    COALESCE(SUM(commits), 0) AS commits,
                    COALESCE(SUM(lines_added), 0) AS lines_added
             FROM git_snapshots
             WHERE developer_id IN (${placeholders}) AND date >= ? AND date <= ?
             GROUP BY developer_id`,
        )
        .all(...ids, window.from, window.to) as {developer_id: string; commits: number; lines_added: number}[];

    const toolMap = new Map(toolRows.map((r) => [r.developer_id, r]));
    const gitMap = new Map(gitRows.map((r) => [r.developer_id, r]));

    const entries: LeaderboardEntry[] = developers.map((dev) => {
        const tool = toolMap.get(dev.id);
        const git = gitMap.get(dev.id);
        const interactions = tool?.interactions ?? 0;
        const acceptances = tool?.acceptances ?? 0;
        // Clamp to [0,1]: a malformed upstream row with acceptances > interactions
        // must not produce a >100% rate that outranks honest entries.
        const rate = interactions > 0 ? Math.min(1, acceptances / interactions) : 0;
        return {
            rank: 0,
            developer_id: dev.id,
            name: dev.name,
            value: 0,
            interactions,
            acceptances,
            acceptance_rate: rate,
            commits: git?.commits ?? 0,
            lines_added: git?.lines_added ?? 0,
        };
    });

    for (const entry of entries) {
        entry.value = metricValue(entry, metric);
    }

    entries.sort((a, b) => (b.value !== a.value ? b.value - a.value : a.name.localeCompare(b.name)));

    let lastValue: number | null = null;
    entries.forEach((entry, index) => {
        // Competition ranking: a new value takes its 1-based position; a tie
        // reuses the rank of the first element in the value-group (its index+1).
        if (lastValue === null || entry.value !== lastValue) {
            entry.rank = index + 1;
            lastValue = entry.value;
        } else {
            entry.rank = entries[index - 1].rank;
        }
    });

    return entries;
}
