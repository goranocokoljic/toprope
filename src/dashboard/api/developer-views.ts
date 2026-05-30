import type Database from 'better-sqlite3';
import type {TimelinePoint} from './developer-detail';

/**
 * Data layer for the self-service developer view (Task 2.4 / #39).
 *
 * Every function here takes an already-resolved developer id (the caller pulls
 * it STRICTLY from the authenticated session) plus a resolved [from, to] date
 * window, and returns only that developer's data. Nothing here reads a request
 * parameter — scoping is the route layer's job and is done from the session, so
 * a developer can never widen the query to someone else.
 *
 * The [from, to] window is the same inclusive YYYY-MM-DD pair the manager
 * endpoints feed into `date >= ? AND date <= ?`, produced by the shared
 * `parseTimeRange` helper — so range behaviour is identical to the manager side.
 */

export type TrendDirection = 'up' | 'down' | 'flat';

export interface MeOverview {
    active_days: number;
    primary_tools: string[];
    acceptance_rate: {
        current: number | null;
        previous: number | null;
        trend: TrendDirection;
    };
    estimated_monthly_cost: number;
}

export interface MeToolBreakdown {
    tool: string;
    active_days: number;
    interactions: number;
    acceptances: number;
    acceptance_rate: number | null;
    features_used: string[];
    estimated_monthly_cost: number;
}

export interface MeProviderActivity {
    provider: string;
    commits: number;
    lines_added: number;
    lines_removed: number;
    files_changed: number;
    prs_opened: number;
    prs_merged: number;
}

export interface MeActivity {
    totals: {
        commits: number;
        lines_added: number;
        lines_removed: number;
        files_changed: number;
        prs_opened: number;
        prs_merged: number;
        avg_churn_rate: number | null;
    };
    providers: MeProviderActivity[];
}

/**
 * Earliest date with any activity (tool or git) for a developer, used to resolve
 * the "lifetime" range exactly as the manager endpoints resolve theirs.
 */
export function earliestDeveloperDate(db: Database.Database, developerId: string): string | null {
    const row = db
        .prepare(
            `SELECT MIN(d) AS earliest FROM (
               SELECT MIN(date) AS d FROM tool_snapshots WHERE developer_id = ?
               UNION ALL
               SELECT MIN(date) AS d FROM git_snapshots WHERE developer_id = ?
             ) WHERE d IS NOT NULL`,
        )
        .get(developerId, developerId) as {earliest: string | null};
    return row.earliest;
}

/** Inclusive count of days from `from` to the midpoint, used to split a range in half. */
function midpoint(from: string, to: string): string {
    const fromMs = Date.parse(`${from}T00:00:00.000Z`);
    const toMs = Date.parse(`${to}T00:00:00.000Z`);
    const midMs = fromMs + Math.floor((toMs - fromMs) / 2);
    return new Date(midMs).toISOString().slice(0, 10);
}

function aggregateAcceptanceRate(
    db: Database.Database,
    developerId: string,
    from: string,
    to: string,
): number | null {
    const row = db
        .prepare(
            `SELECT COALESCE(SUM(interaction_count), 0) AS interactions,
                    COALESCE(SUM(acceptance_count), 0) AS acceptances
             FROM tool_snapshots
             WHERE developer_id = ? AND date >= ? AND date <= ?`,
        )
        .get(developerId, from, to) as {interactions: number; acceptances: number};
    if (row.interactions <= 0) {
        return null;
    }
    return row.acceptances / row.interactions;
}

/**
 * Personal stat summary: active days, the tools used most, the direction the
 * acceptance rate is trending (first half of the range vs second half), and the
 * developer's estimated monthly cost from their active subscriptions.
 */
export function getMeOverview(
    db: Database.Database,
    developerId: string,
    from: string,
    to: string,
): MeOverview {
    // A day counts as active if there was tool activity or git activity on it.
    const activeDays = (
        db
            .prepare(
                `SELECT COUNT(*) AS cnt FROM (
                   SELECT date FROM tool_snapshots
                     WHERE developer_id = ? AND is_active = 1 AND date >= ? AND date <= ?
                   UNION
                   SELECT date FROM git_snapshots
                     WHERE developer_id = ? AND commits > 0 AND date >= ? AND date <= ?
                 )`,
            )
            .get(developerId, from, to, developerId, from, to) as {cnt: number}
    ).cnt;

    const primaryTools = (
        db
            .prepare(
                `SELECT tool, COALESCE(SUM(interaction_count), 0) AS interactions
                 FROM tool_snapshots
                 WHERE developer_id = ? AND is_active = 1 AND date >= ? AND date <= ?
                 GROUP BY tool
                 HAVING interactions > 0 OR COUNT(*) > 0
                 ORDER BY interactions DESC, tool`,
            )
            .all(developerId, from, to) as {tool: string; interactions: number}[]
    ).map((r) => r.tool);

    const mid = midpoint(from, to);
    const previous = aggregateAcceptanceRate(db, developerId, from, mid);
    const current = aggregateAcceptanceRate(db, developerId, mid, to);

    let trend: TrendDirection = 'flat';
    if (current !== null && previous !== null) {
        const delta = current - previous;
        // 0.5pp dead-band so floating-point noise doesn't read as a real move.
        if (delta > 0.005) trend = 'up';
        else if (delta < -0.005) trend = 'down';
    } else if (current !== null && previous === null) {
        trend = 'up';
    } else if (current === null && previous !== null) {
        trend = 'down';
    }

    const estimatedCost = (
        db
            .prepare(
                `SELECT COALESCE(SUM(monthly_cost), 0) AS cost
                 FROM subscriptions
                 WHERE developer_id = ? AND seat_revoked_at IS NULL`,
            )
            .get(developerId) as {cost: number}
    ).cost;

    return {
        active_days: activeDays,
        primary_tools: primaryTools,
        acceptance_rate: {current, previous, trend},
        estimated_monthly_cost: estimatedCost,
    };
}

/** Stored features_used is a JSON array string; parse defensively. */
function parseFeatures(raw: string | null): string[] {
    if (!raw) {
        return [];
    }
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
            return parsed.filter((v): v is string => typeof v === 'string');
        }
    } catch {
        // Not JSON — fall back to a comma-separated list.
        return raw.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return [];
}

/**
 * Per-tool breakdown for the developer: activity, acceptance rate, the union of
 * features touched, and the monthly cost of the matching active subscription.
 */
export function getMeTools(
    db: Database.Database,
    developerId: string,
    from: string,
    to: string,
): MeToolBreakdown[] {
    const rows = db
        .prepare(
            `SELECT tool,
                    COUNT(DISTINCT CASE WHEN is_active = 1 THEN date END) AS active_days,
                    COALESCE(SUM(interaction_count), 0) AS interactions,
                    COALESCE(SUM(acceptance_count), 0) AS acceptances
             FROM tool_snapshots
             WHERE developer_id = ? AND date >= ? AND date <= ?
             GROUP BY tool
             ORDER BY interactions DESC, tool`,
        )
        .all(developerId, from, to) as {
        tool: string;
        active_days: number;
        interactions: number;
        acceptances: number;
    }[];

    // Per-tool active subscription cost, summed so multiple seats on one tool
    // are reflected. Revoked seats are excluded.
    const costRows = db
        .prepare(
            `SELECT tool, COALESCE(SUM(monthly_cost), 0) AS cost
             FROM subscriptions
             WHERE developer_id = ? AND seat_revoked_at IS NULL
             GROUP BY tool`,
        )
        .all(developerId) as {tool: string; cost: number}[];
    const costByTool = new Map(costRows.map((r) => [r.tool, r.cost]));

    // Feature union per tool over the window.
    const featureRows = db
        .prepare(
            `SELECT tool, features_used
             FROM tool_snapshots
             WHERE developer_id = ? AND date >= ? AND date <= ? AND features_used IS NOT NULL`,
        )
        .all(developerId, from, to) as {tool: string; features_used: string | null}[];
    const featuresByTool = new Map<string, Set<string>>();
    for (const r of featureRows) {
        const set = featuresByTool.get(r.tool) ?? new Set<string>();
        for (const f of parseFeatures(r.features_used)) {
            set.add(f);
        }
        featuresByTool.set(r.tool, set);
    }

    return rows.map((r) => ({
        tool: r.tool,
        active_days: r.active_days,
        interactions: r.interactions,
        acceptances: r.acceptances,
        acceptance_rate: r.interactions > 0 ? r.acceptances / r.interactions : null,
        features_used: Array.from(featuresByTool.get(r.tool) ?? []).sort(),
        estimated_monthly_cost: costByTool.get(r.tool) ?? 0,
    }));
}

/**
 * Personal git activity over the window. Totals are summed across every git
 * provider (the snapshots are already merged per day at sync time, so a day
 * with both Bitbucket and GitHub commits is one row tagged data_source='multi');
 * the per-provider breakdown reports the contribution recorded under each
 * data_source so the unification is visible.
 */
export function getMeActivity(
    db: Database.Database,
    developerId: string,
    from: string,
    to: string,
): MeActivity {
    const totalsRow = db
        .prepare(
            `SELECT COALESCE(SUM(commits), 0) AS commits,
                    COALESCE(SUM(lines_added), 0) AS lines_added,
                    COALESCE(SUM(lines_removed), 0) AS lines_removed,
                    COALESCE(SUM(files_changed), 0) AS files_changed,
                    COALESCE(SUM(prs_opened), 0) AS prs_opened,
                    COALESCE(SUM(prs_merged), 0) AS prs_merged,
                    AVG(code_churn_rate) AS avg_churn_rate
             FROM git_snapshots
             WHERE developer_id = ? AND date >= ? AND date <= ?`,
        )
        .get(developerId, from, to) as {
        commits: number;
        lines_added: number;
        lines_removed: number;
        files_changed: number;
        prs_opened: number;
        prs_merged: number;
        avg_churn_rate: number | null;
    };

    const providers = db
        .prepare(
            `SELECT COALESCE(data_source, 'git') AS provider,
                    COALESCE(SUM(commits), 0) AS commits,
                    COALESCE(SUM(lines_added), 0) AS lines_added,
                    COALESCE(SUM(lines_removed), 0) AS lines_removed,
                    COALESCE(SUM(files_changed), 0) AS files_changed,
                    COALESCE(SUM(prs_opened), 0) AS prs_opened,
                    COALESCE(SUM(prs_merged), 0) AS prs_merged
             FROM git_snapshots
             WHERE developer_id = ? AND date >= ? AND date <= ?
             GROUP BY COALESCE(data_source, 'git')
             ORDER BY provider`,
        )
        .all(developerId, from, to) as MeProviderActivity[];

    return {
        totals: {
            commits: totalsRow.commits,
            lines_added: totalsRow.lines_added,
            lines_removed: totalsRow.lines_removed,
            files_changed: totalsRow.files_changed,
            prs_opened: totalsRow.prs_opened,
            prs_merged: totalsRow.prs_merged,
            avg_churn_rate: totalsRow.avg_churn_rate,
        },
        providers,
    };
}

/**
 * Personal activity timeline over the window: per-day tool interactions and git
 * activity. Same point shape as the admin developer timeline, but bounded by the
 * shared range parser rather than a fixed 90-day window.
 */
export function getMeTimeline(
    db: Database.Database,
    developerId: string,
    from: string,
    to: string,
): TimelinePoint[] {
    const toolRows = db
        .prepare(
            `SELECT date,
                    MAX(is_active) as is_active,
                    COALESCE(SUM(interaction_count), 0) as interaction_count,
                    GROUP_CONCAT(DISTINCT CASE WHEN is_active = 1 THEN tool END) as tools
             FROM tool_snapshots
             WHERE developer_id = ? AND date >= ? AND date <= ?
             GROUP BY date
             ORDER BY date`,
        )
        .all(developerId, from, to) as {
        date: string;
        is_active: number;
        interaction_count: number;
        tools: string | null;
    }[];

    const gitRows = db
        .prepare(
            `SELECT date, commits, lines_added, lines_removed, ai_signature_score
             FROM git_snapshots
             WHERE developer_id = ? AND date >= ? AND date <= ?
             ORDER BY date`,
        )
        .all(developerId, from, to) as {
        date: string;
        commits: number;
        lines_added: number;
        lines_removed: number;
        ai_signature_score: number | null;
    }[];

    const gitByDate = new Map(gitRows.map((r) => [r.date, r]));
    const toolByDate = new Map(toolRows.map((r) => [r.date, r]));

    const allDates = new Set([...toolByDate.keys(), ...gitByDate.keys()]);
    const sortedDates = Array.from(allDates).sort();

    return sortedDates.map((date) => {
        const t = toolByDate.get(date);
        const g = gitByDate.get(date);
        return {
            date,
            tool_activity: {
                is_active: (t?.is_active ?? 0) === 1,
                interaction_count: t?.interaction_count ?? 0,
                tools: t?.tools ? t.tools.split(',').filter(Boolean) : [],
            },
            git_activity: {
                commits: g?.commits ?? 0,
                lines_added: g?.lines_added ?? 0,
                lines_removed: g?.lines_removed ?? 0,
                ai_signature_score: g?.ai_signature_score ?? null,
            },
        };
    });
}
