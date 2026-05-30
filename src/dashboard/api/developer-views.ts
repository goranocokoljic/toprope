import type Database from 'better-sqlite3';

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

/** Midpoint date (YYYY-MM-DD) of the inclusive [from, to] window. */
function midpoint(from: string, to: string): string {
    const fromMs = Date.parse(`${from}T00:00:00.000Z`);
    const toMs = Date.parse(`${to}T00:00:00.000Z`);
    const midMs = fromMs + Math.floor((toMs - fromMs) / 2);
    return new Date(midMs).toISOString().slice(0, 10);
}

/** Add `days` to a YYYY-MM-DD date, returning YYYY-MM-DD. */
function addDays(date: string, days: number): string {
    const ms = Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000;
    return new Date(ms).toISOString().slice(0, 10);
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
                 HAVING interactions > 0
                 ORDER BY interactions DESC, tool`,
            )
            .all(developerId, from, to) as {tool: string; interactions: number}[]
    ).map((r) => r.tool);

    // Split the window into two DISJOINT halves so the midpoint day is never
    // counted in both: the first half is [from, mid], the second is the day
    // after mid through to. When the window is too short to have a distinct
    // second half (a single day), there is no trend to compute, so both halves
    // resolve to the same value and the direction reads 'flat'.
    const mid = midpoint(from, to);
    const secondHalfStart = addDays(mid, 1);
    const previous = aggregateAcceptanceRate(db, developerId, from, mid);
    const current =
        secondHalfStart > to ? previous : aggregateAcceptanceRate(db, developerId, secondHalfStart, to);

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

/**
 * Stored features_used is a JSON array string (written by the connectors as
 * JSON.stringify(string[])). Parse it back to a string array; any row that is
 * absent, unparseable, or not an array of strings contributes no features
 * rather than throwing.
 */
function parseFeatures(raw: string | null): string[] {
    if (!raw) {
        return [];
    }
    try {
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
        return [];
    }
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
 * Personal git activity over the window. `totals` are summed across every git
 * provider and are the authoritative unified numbers the developer view shows.
 *
 * The `providers` breakdown groups by the snapshot's `data_source`. Because git
 * snapshots are merged per developer per day at sync time (one row per dev/day,
 * UNIQUE(developer_id, date)), a day on which the developer was active on more
 * than one provider is stored as a single row tagged `data_source = 'multi'` —
 * so that day appears under a `'multi'` bucket here rather than split back into
 * its constituent providers (the per-provider split is not recoverable from the
 * merged row). The breakdown therefore reflects how the data is stored, while
 * `totals` always reflect the true cross-provider sum.
 *
 * Note `totals.avg_churn_rate` is a rough indicator only: it is an unweighted
 * mean of the per-day churn ratios (a 2-line day counts the same as a 2000-line
 * day), days with no churn value are excluded, and a cross-provider day's churn
 * is itself an approximation from the sync-time merge. Use it as a trend hint,
 * not an exact figure — the count fields above are the authoritative numbers.
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

// The personal activity timeline is the manager timeline scoped to a session-
// resolved id and bounded by the shared range parser, so /api/me/timeline calls
// getDeveloperTimelineWindow directly rather than wrapping it here.
