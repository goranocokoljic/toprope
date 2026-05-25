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

export function upsertSubscription(db: Database.Database, data: UpsertData): Subscription {
    const now = new Date().toISOString();

    return db.transaction((): Subscription => {
        const existing = db
            .prepare(
                'SELECT * FROM subscriptions WHERE developer_id = ? AND tool = ? AND seat_revoked_at IS NULL',
            )
            .get(data.developer_id, data.tool) as Subscription | undefined;

        if (existing) {
            db.prepare(
                'UPDATE subscriptions SET plan = ?, billing_model = ?, monthly_cost = ?, data_source = ? WHERE id = ?',
            ).run(data.plan, data.billing_model, data.monthly_cost, data.data_source, existing.id);
            return {
                ...existing,
                plan: data.plan,
                billing_model: data.billing_model,
                monthly_cost: data.monthly_cost,
                data_source: data.data_source,
            };
        }

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
            now,
            data.data_source,
        );

        return {
            id,
            developer_id: data.developer_id,
            tool: data.tool,
            plan: data.plan,
            billing_model: data.billing_model,
            monthly_cost: data.monthly_cost,
            seat_assigned_at: now,
            seat_revoked_at: null,
            data_source: data.data_source,
        };
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
