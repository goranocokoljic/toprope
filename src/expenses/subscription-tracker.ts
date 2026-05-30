import Database from 'better-sqlite3';
import {randomUUID} from 'crypto';

export interface Subscription {
    id: string;
    developer_id: string;
    tool: string;
    plan: string | null;
    billing_model: string;
    monthly_cost: number | null;
    seat_assigned_at: string | null;
    seat_revoked_at: string | null;
    data_source: string;
}

export interface UpsertData {
    developer_id: string;
    tool: string;
    plan: string | null;
    billing_model: string;
    monthly_cost: number | null;
    data_source: string;
}

export interface SwitchToolData {
    developer_id: string;
    from_tool: string;
    to_tool: string;
    plan: string | null;
    billing_model: string;
    monthly_cost: number | null;
    data_source: string;
}

export interface PlanChangeEvent {
    id: string;
    developer_id: string;
    tool: string;
    old_tool: string | null;
    old_plan: string | null;
    new_plan: string | null;
    old_monthly_cost: number | null;
    new_monthly_cost: number | null;
    changed_at: string;
}

/** Per-date cost point for cost-over-time accounting. */
export interface CostPoint {
    date: string;
    monthly_cost: number;
}

export interface SubscriptionWithDeveloper extends Subscription {
    developer_name: string;
    developer_email: string | null;
    team: string;
}

export interface DeveloperCostSummary {
    developer_id: string;
    developer_name: string;
    developer_email: string | null;
    team: string;
    total_monthly_cost: number;
    subscription_count: number;
}

export interface TeamCostSummary {
    team: string;
    total_monthly_cost: number;
    developer_count: number;
    subscription_count: number;
}

export interface OrgCostSummary {
    total_monthly_cost: number;
    team_count: number;
    developer_count: number;
    subscription_count: number;
}

export interface DuplicateAlert {
    developer_id: string;
    developer_name: string;
    developer_email: string | null;
    tools: Array<{tool: string; plan: string | null; monthly_cost: number | null}>;
    message: string;
}

// Tools in the same category = potential duplicates
const TOOL_CATEGORIES: Record<string, string> = {
    copilot: 'ide_assistant',
    cursor: 'ide_assistant',
    windsurf: 'ide_assistant',
    codeium: 'ide_assistant',
    tabnine: 'ide_assistant',
    claude_code: 'ai_agent',
    codex: 'ai_agent',
    aider: 'ai_agent',
};

function insertSubscription(
    db: Database.Database,
    data: UpsertData,
    assignedAt: string,
): Subscription {
    const id = randomUUID();
    db.prepare(
        'INSERT INTO subscriptions (id, developer_id, tool, plan, billing_model, monthly_cost, seat_assigned_at, seat_revoked_at, data_source) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)',
    ).run(
        id,
        data.developer_id,
        data.tool,
        data.plan,
        data.billing_model,
        data.monthly_cost,
        assignedAt,
        data.data_source,
    );

    return {
        id,
        developer_id: data.developer_id,
        tool: data.tool,
        plan: data.plan,
        billing_model: data.billing_model,
        monthly_cost: data.monthly_cost,
        seat_assigned_at: assignedAt,
        seat_revoked_at: null,
        data_source: data.data_source,
    };
}

function recordPlanChangeEvent(
    db: Database.Database,
    event: {
        developer_id: string;
        tool: string;
        old_tool: string | null;
        old_plan: string | null;
        new_plan: string | null;
        old_monthly_cost: number | null;
        new_monthly_cost: number | null;
        changed_at: string;
    },
): void {
    db.prepare(
        `INSERT INTO plan_change_events
           (id, developer_id, tool, old_tool, old_plan, new_plan, old_monthly_cost, new_monthly_cost, changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        randomUUID(),
        event.developer_id,
        event.tool,
        event.old_tool,
        event.old_plan,
        event.new_plan,
        event.old_monthly_cost,
        event.new_monthly_cost,
        event.changed_at,
    );
}

/**
 * A change is "material" — i.e. a genuine plan upgrade/downgrade that must
 * preserve history — when the plan or the monthly cost differs. A billing-model
 * or data-source-only difference is bookkeeping metadata, not a lifecycle
 * transition, so it is applied in place rather than spawning a revoke+create
 * (and is never recorded as a plan-change event, to keep the ROI signal clean).
 *
 * The monthly_cost comparison is exact (`!==`). This is safe for the only
 * caller that flows real data — the expense importer parses costs with
 * parseFloat over identical CSV strings on re-import, so an unchanged row
 * yields a bit-identical float and does not trip a spurious transition. If a
 * future caller feeds a *computed* rate (e.g. proration), switch to an epsilon
 * compare here so floating-point noise (19.99 vs 19.990000001) isn't read as a
 * downgrade-then-upgrade.
 */
function isMaterialChange(existing: Subscription, data: UpsertData): boolean {
    return existing.plan !== data.plan || existing.monthly_cost !== data.monthly_cost;
}

/**
 * Record the desired state of a developer's subscription for a tool, preserving
 * history across changes (Task 2.14).
 *
 * - No existing active seat → create a new one (no plan-change event: there is
 *   no "before").
 * - Existing active seat, same plan AND cost → idempotent. If only the
 *   billing_model / data_source differ, those are patched in place; otherwise
 *   nothing happens. No new row, no event — so re-importing unchanged expense
 *   data never churns the history.
 * - Existing active seat, plan or cost changed → revoke the old row
 *   (seat_revoked_at = now), create a new active row with a fresh
 *   seat_assigned_at, and record a plan_change_event capturing before/after.
 *   The old row is never overwritten, so cost-over-time stays accurate.
 */
export function upsertSubscription(db: Database.Database, data: UpsertData): Subscription {
    const now = new Date().toISOString();

    return db.transaction((): Subscription => {
        const existing = db
            .prepare(
                'SELECT * FROM subscriptions WHERE developer_id = ? AND tool = ? AND seat_revoked_at IS NULL',
            )
            .get(data.developer_id, data.tool) as Subscription | undefined;

        if (!existing) {
            return insertSubscription(db, data, now);
        }

        if (!isMaterialChange(existing, data)) {
            // Same plan + cost. Patch only metadata if it drifted; otherwise no-op.
            if (
                existing.billing_model !== data.billing_model ||
                existing.data_source !== data.data_source
            ) {
                db.prepare(
                    'UPDATE subscriptions SET billing_model = ?, data_source = ? WHERE id = ?',
                ).run(data.billing_model, data.data_source, existing.id);
                return {
                    ...existing,
                    billing_model: data.billing_model,
                    data_source: data.data_source,
                };
            }
            return existing;
        }

        // Material change: revoke the old seat and open a new one.
        db.prepare('UPDATE subscriptions SET seat_revoked_at = ? WHERE id = ?').run(now, existing.id);
        const created = insertSubscription(db, data, now);
        recordPlanChangeEvent(db, {
            developer_id: data.developer_id,
            tool: data.tool,
            old_tool: null,
            old_plan: existing.plan,
            new_plan: data.plan,
            old_monthly_cost: existing.monthly_cost,
            new_monthly_cost: data.monthly_cost,
            changed_at: now,
        });
        return created;
    })();
}

/**
 * Move a developer from one tool to another (Task 2.14). Revokes the active seat
 * on `from_tool` (if any) and opens a new active seat on `to_tool`, recording a
 * plan_change_event that captures the tool switch (old_tool set). Like
 * upsertSubscription this never overwrites history.
 *
 * If there is no active seat on from_tool, this still opens the new seat and
 * records the switch with null old_* fields — the destination is what matters.
 */
export function switchTool(db: Database.Database, data: SwitchToolData): Subscription {
    const now = new Date().toISOString();

    return db.transaction((): Subscription => {
        const old = db
            .prepare(
                'SELECT * FROM subscriptions WHERE developer_id = ? AND tool = ? AND seat_revoked_at IS NULL',
            )
            .get(data.developer_id, data.from_tool) as Subscription | undefined;

        if (old) {
            db.prepare('UPDATE subscriptions SET seat_revoked_at = ? WHERE id = ?').run(now, old.id);
        }

        const created = insertSubscription(
            db,
            {
                developer_id: data.developer_id,
                tool: data.to_tool,
                plan: data.plan,
                billing_model: data.billing_model,
                monthly_cost: data.monthly_cost,
                data_source: data.data_source,
            },
            now,
        );

        recordPlanChangeEvent(db, {
            developer_id: data.developer_id,
            tool: data.to_tool,
            old_tool: data.from_tool,
            old_plan: old?.plan ?? null,
            new_plan: data.plan,
            old_monthly_cost: old?.monthly_cost ?? null,
            new_monthly_cost: data.monthly_cost,
            changed_at: now,
        });

        return created;
    })();
}

export function listSubscriptions(
    db: Database.Database,
    teamFilter?: string,
): SubscriptionWithDeveloper[] {
    const sql = `
        SELECT s.*, d.name as developer_name, d.email as developer_email, d.team
        FROM subscriptions s
        JOIN developers d ON s.developer_id = d.id
        WHERE s.seat_revoked_at IS NULL${teamFilter ? ' AND d.team = ?' : ''}
        ORDER BY d.name, s.tool
    `;
    return (
        teamFilter
            ? db.prepare(sql).all(teamFilter)
            : db.prepare(sql).all()
    ) as SubscriptionWithDeveloper[];
}

export function getDeveloperCostSummaries(
    db: Database.Database,
    teamFilter?: string,
): DeveloperCostSummary[] {
    const sql = `
        SELECT
            d.id as developer_id,
            d.name as developer_name,
            d.email as developer_email,
            d.team,
            COALESCE(SUM(s.monthly_cost), 0) as total_monthly_cost,
            COUNT(s.id) as subscription_count
        FROM developers d
        LEFT JOIN subscriptions s ON s.developer_id = d.id AND s.seat_revoked_at IS NULL
        ${teamFilter ? 'WHERE d.team = ?' : ''}
        GROUP BY d.id
        HAVING subscription_count > 0
        ORDER BY d.name
    `;
    return (
        teamFilter ? db.prepare(sql).all(teamFilter) : db.prepare(sql).all()
    ) as DeveloperCostSummary[];
}

export function getTeamCostSummaries(db: Database.Database): TeamCostSummary[] {
    return db
        .prepare(
            `
        SELECT
            d.team,
            COALESCE(SUM(s.monthly_cost), 0) as total_monthly_cost,
            COUNT(DISTINCT d.id) as developer_count,
            COUNT(s.id) as subscription_count
        FROM developers d
        JOIN subscriptions s ON s.developer_id = d.id AND s.seat_revoked_at IS NULL
        GROUP BY d.team
        ORDER BY d.team
    `,
        )
        .all() as TeamCostSummary[];
}

export function getOrgCostSummary(db: Database.Database): OrgCostSummary {
    const row = db
        .prepare(
            `
        SELECT
            COALESCE(SUM(s.monthly_cost), 0) as total_monthly_cost,
            COUNT(DISTINCT d.team) as team_count,
            COUNT(DISTINCT d.id) as developer_count,
            COUNT(s.id) as subscription_count
        FROM developers d
        JOIN subscriptions s ON s.developer_id = d.id AND s.seat_revoked_at IS NULL
    `,
        )
        .get() as OrgCostSummary;
    return row;
}

export function detectDuplicates(db: Database.Database): DuplicateAlert[] {
    const subscriptions = listSubscriptions(db);

    const byDeveloper = new Map<string, SubscriptionWithDeveloper[]>();
    for (const sub of subscriptions) {
        const list = byDeveloper.get(sub.developer_id) ?? [];
        list.push(sub);
        byDeveloper.set(sub.developer_id, list);
    }

    const alerts: DuplicateAlert[] = [];

    for (const subs of byDeveloper.values()) {
        if (subs.length < 2) continue;

        const byCategory = new Map<string, SubscriptionWithDeveloper[]>();
        for (const sub of subs) {
            const category = TOOL_CATEGORIES[sub.tool.toLowerCase()];
            if (!category) continue;
            const list = byCategory.get(category) ?? [];
            list.push(sub);
            byCategory.set(category, list);
        }

        for (const catSubs of byCategory.values()) {
            if (catSubs.length < 2) continue;

            const first = catSubs[0];
            const toolDescriptions = catSubs.map((s) => {
                const parts = [s.tool];
                if (s.plan) parts.push(s.plan);
                if (s.monthly_cost != null) parts.push(`($${s.monthly_cost}/mo)`);
                return parts.join(' ');
            });

            alerts.push({
                developer_id: first.developer_id,
                developer_name: first.developer_name,
                developer_email: first.developer_email,
                tools: catSubs.map((s) => ({
                    tool: s.tool,
                    plan: s.plan,
                    monthly_cost: s.monthly_cost,
                })),
                message: `${first.developer_name} has overlapping subscriptions: ${toolDescriptions.join(' and ')}`,
            });
        }
    }

    return alerts;
}

/**
 * A subscription is active on a given date (YYYY-MM-DD) when its seat was
 * assigned on or before that date and not yet revoked as of the *end* of that
 * date. Comparing on the date portion means the day a seat is revoked and its
 * replacement assigned does not double-count: the revoked seat's last active day
 * is the day before its revoke date, and the new seat is active from its assign
 * date onward.
 *
 * `date(...)` is applied to the stored full-ISO timestamps so a same-day
 * revoke+create (the lifecycle transition pattern) lands cleanly on the date
 * boundary regardless of the time-of-day component.
 *
 * INVARIANT: the revoke and create of a transition share an identical `now`
 * timestamp, so old.seat_revoked_at == new.seat_assigned_at to the millisecond.
 * Any seat-active-on-date test MUST therefore compare on `date(...)`, never the
 * raw timestamps — a raw `<`/`>` comparison would see a zero-width overlap on
 * the transition instant and either double-count or drop the seat. Reuse this
 * clause (or `isActiveOnDate` below) rather than hand-rolling the comparison.
 */
const ACTIVE_ON_DATE_CLAUSE =
    "date(seat_assigned_at) <= ? AND (seat_revoked_at IS NULL OR date(seat_revoked_at) > ?)";

/** Date-granularity active test mirroring ACTIVE_ON_DATE_CLAUSE for in-memory rows. */
function isActiveOnDate(
    sub: {seat_assigned_at: string | null; seat_revoked_at: string | null},
    date: string,
): boolean {
    const assigned = sub.seat_assigned_at?.slice(0, 10);
    if (assigned === undefined || assigned > date) {
        return false;
    }
    if (sub.seat_revoked_at === null) {
        return true;
    }
    return sub.seat_revoked_at.slice(0, 10) > date;
}

/**
 * Total monthly cost of a developer's subscriptions that were active on a single
 * date — the cost the org was paying for that developer on that day. Used by
 * cost-over-time accounting so a mid-month upgrade is billed at the old rate
 * before the change and the new rate after.
 */
export function getDeveloperCostOnDate(
    db: Database.Database,
    developerId: string,
    date: string,
): number {
    const row = db
        .prepare(
            `SELECT COALESCE(SUM(monthly_cost), 0) AS cost
             FROM subscriptions
             WHERE developer_id = ? AND ${ACTIVE_ON_DATE_CLAUSE}`,
        )
        .get(developerId, date, date) as {cost: number};
    return row.cost;
}

/** Add `days` to a YYYY-MM-DD date, returning YYYY-MM-DD (UTC). */
function addDays(date: string, days: number): string {
    const ms = Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000;
    return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Per-day active monthly cost for a developer across an inclusive [from, to]
 * window. Each point is the rate in effect on that date, so summing or charting
 * the series reflects plan changes at the exact date they took effect rather
 * than retroactively applying the current plan to past dates.
 *
 * The developer's subscriptions are fetched once and the per-day cost is folded
 * in memory — O(days × subs) arithmetic with a single DB round-trip — rather
 * than one query per day, so a wide range stays cheap.
 */
export function getDeveloperCostOverTime(
    db: Database.Database,
    developerId: string,
    from: string,
    to: string,
): CostPoint[] {
    const subs = db
        .prepare(
            `SELECT monthly_cost, seat_assigned_at, seat_revoked_at
             FROM subscriptions
             WHERE developer_id = ? AND monthly_cost IS NOT NULL`,
        )
        .all(developerId) as {
        monthly_cost: number;
        seat_assigned_at: string | null;
        seat_revoked_at: string | null;
    }[];

    const points: CostPoint[] = [];
    for (let date = from; date <= to; date = addDays(date, 1)) {
        let cost = 0;
        for (const sub of subs) {
            if (isActiveOnDate(sub, date)) {
                cost += sub.monthly_cost;
            }
        }
        points.push({date, monthly_cost: cost});
    }
    return points;
}

/**
 * All plan-change events for a developer in chronological order — the data
 * behind the developer "adoption journey" transition narrative and the feed for
 * Plan-ROI detection (Task 2.15).
 */
export function getDeveloperPlanChanges(
    db: Database.Database,
    developerId: string,
): PlanChangeEvent[] {
    return db
        .prepare(
            `SELECT id, developer_id, tool, old_tool, old_plan, new_plan,
                    old_monthly_cost, new_monthly_cost, changed_at
             FROM plan_change_events
             WHERE developer_id = ?
             ORDER BY changed_at, id`,
        )
        .all(developerId) as PlanChangeEvent[];
}
