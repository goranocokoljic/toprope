import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {addTeam} from '../../src/registry/teams';
import {addDeveloper} from '../../src/registry/developers';
import {
    upsertSubscription,
    switchTool,
    listSubscriptions,
    getDeveloperCostSummaries,
    getTeamCostSummaries,
    getOrgCostSummary,
    detectDuplicates,
    getDeveloperCostOnDate,
    getDeveloperCostOverTime,
    getDeveloperPlanChanges,
} from '../../src/expenses/subscription-tracker';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

interface DevIds {
    alice: string;
    bob: string;
    jane: string;
}

function seedDevelopers(db: Database.Database): DevIds {
    addTeam(db, 'engineering');
    addTeam(db, 'backend');
    const alice = addDeveloper(db, 'Alice Smith', 'engineering', 'alice@example.com');
    const bob = addDeveloper(db, 'Bob Jones', 'backend', 'bob@example.com');
    const jane = addDeveloper(db, 'Jane Doe', 'engineering', 'jane@example.com');
    return {alice: alice.id, bob: bob.id, jane: jane.id};
}

describe('upsertSubscription', () => {
    let db: Database.Database;
    let devIds: DevIds;

    beforeEach(() => {
        db = makeDb();
        devIds = seedDevelopers(db);
    });

    afterEach(() => {
        db.close();
    });

    it('creates a new subscription', () => {
        const sub = upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: 19,
            data_source: 'expense_import',
        });
        expect(sub.id).toBeTruthy();
        expect(sub.tool).toBe('copilot');
        expect(sub.plan).toBe('business');
        expect(sub.monthly_cost).toBe(19);
        expect(sub.seat_revoked_at).toBeNull();
    });

    it('updates existing active subscription on re-upsert (no duplicate rows)', () => {
        upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: 19,
            data_source: 'expense_import',
        });
        upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'copilot',
            plan: 'enterprise',
            billing_model: 'company_managed',
            monthly_cost: 39,
            data_source: 'expense_import',
        });

        const rows = db
            .prepare(
                'SELECT * FROM subscriptions WHERE developer_id = ? AND tool = ? AND seat_revoked_at IS NULL',
            )
            .all(devIds.alice, 'copilot') as {plan: string; monthly_cost: number}[];
        expect(rows).toHaveLength(1);
        expect(rows[0].plan).toBe('enterprise');
        expect(rows[0].monthly_cost).toBe(39);
    });

    it('creates separate records for different tools', () => {
        upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: 19,
            data_source: 'expense_import',
        });
        upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'claude_code',
            plan: 'max',
            billing_model: 'reimbursed',
            monthly_cost: 200,
            data_source: 'expense_import',
        });

        const rows = db
            .prepare(
                'SELECT * FROM subscriptions WHERE developer_id = ? AND seat_revoked_at IS NULL',
            )
            .all(devIds.alice);
        expect(rows).toHaveLength(2);
    });

    it('accepts null monthly_cost', () => {
        const sub = upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: null,
            data_source: 'expense_import',
        });
        expect(sub.monthly_cost).toBeNull();
    });
});

describe('listSubscriptions', () => {
    let db: Database.Database;
    let devIds: DevIds;

    beforeEach(() => {
        db = makeDb();
        devIds = seedDevelopers(db);
        upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: 19,
            data_source: 'expense_import',
        });
        upsertSubscription(db, {
            developer_id: devIds.bob,
            tool: 'cursor',
            plan: 'pro',
            billing_model: 'personal',
            monthly_cost: 20,
            data_source: 'expense_import',
        });
        upsertSubscription(db, {
            developer_id: devIds.jane,
            tool: 'windsurf',
            plan: 'pro',
            billing_model: 'reimbursed',
            monthly_cost: 20,
            data_source: 'expense_import',
        });
    });

    afterEach(() => {
        db.close();
    });

    it('returns all active subscriptions with developer info', () => {
        const subs = listSubscriptions(db);
        expect(subs).toHaveLength(3);
        expect(subs[0].developer_name).toBeTruthy();
        expect(subs[0].developer_email).toBeTruthy();
        expect(subs[0].team).toBeTruthy();
    });

    it('filters by team', () => {
        const subs = listSubscriptions(db, 'engineering');
        expect(subs.every((s) => s.team === 'engineering')).toBe(true);
        expect(subs.length).toBe(2); // alice + jane
    });

    it('excludes revoked subscriptions', () => {
        db.prepare(
            'UPDATE subscriptions SET seat_revoked_at = ? WHERE developer_id = ?',
        ).run(new Date().toISOString(), devIds.alice);

        const subs = listSubscriptions(db);
        expect(subs.every((s) => s.developer_id !== devIds.alice)).toBe(true);
    });
});

describe('cost aggregation', () => {
    let db: Database.Database;
    let devIds: DevIds;

    beforeEach(() => {
        db = makeDb();
        devIds = seedDevelopers(db);
        // alice: copilot $19 + claude_code $200 = $219
        upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: 19,
            data_source: 'expense_import',
        });
        upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'claude_code',
            plan: 'max',
            billing_model: 'reimbursed',
            monthly_cost: 200,
            data_source: 'expense_import',
        });
        // bob: cursor $20
        upsertSubscription(db, {
            developer_id: devIds.bob,
            tool: 'cursor',
            plan: 'pro',
            billing_model: 'personal',
            monthly_cost: 20,
            data_source: 'expense_import',
        });
    });

    afterEach(() => {
        db.close();
    });

    it('getDeveloperCostSummaries returns correct totals per developer', () => {
        const summaries = getDeveloperCostSummaries(db);
        const alice = summaries.find((s) => s.developer_id === devIds.alice);
        const bob = summaries.find((s) => s.developer_id === devIds.bob);
        expect(alice?.total_monthly_cost).toBe(219);
        expect(alice?.subscription_count).toBe(2);
        expect(bob?.total_monthly_cost).toBe(20);
        expect(bob?.subscription_count).toBe(1);
    });

    it('getDeveloperCostSummaries filters by team', () => {
        const summaries = getDeveloperCostSummaries(db, 'engineering');
        expect(summaries.every((s) => s.team === 'engineering')).toBe(true);
        expect(summaries.find((s) => s.developer_id === devIds.bob)).toBeUndefined();
    });

    it('getTeamCostSummaries returns correct totals per team', () => {
        const summaries = getTeamCostSummaries(db);
        const eng = summaries.find((s) => s.team === 'engineering');
        const backend = summaries.find((s) => s.team === 'backend');
        expect(eng?.total_monthly_cost).toBe(219); // alice only
        expect(backend?.total_monthly_cost).toBe(20); // bob only
    });

    it('getOrgCostSummary returns correct org-wide totals', () => {
        const summary = getOrgCostSummary(db);
        expect(summary.total_monthly_cost).toBe(239);
        expect(summary.developer_count).toBe(2);
        expect(summary.subscription_count).toBe(3);
        expect(summary.team_count).toBe(2);
    });
});

describe('detectDuplicates', () => {
    let db: Database.Database;
    let devIds: DevIds;

    beforeEach(() => {
        db = makeDb();
        devIds = seedDevelopers(db);
    });

    afterEach(() => {
        db.close();
    });

    it('detects overlapping IDE assistant subscriptions', () => {
        // Jane has both Cursor Pro and Copilot Business
        upsertSubscription(db, {
            developer_id: devIds.jane,
            tool: 'cursor',
            plan: 'pro',
            billing_model: 'reimbursed',
            monthly_cost: 20,
            data_source: 'expense_import',
        });
        upsertSubscription(db, {
            developer_id: devIds.jane,
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: 19,
            data_source: 'expense_import',
        });

        const alerts = detectDuplicates(db);
        expect(alerts).toHaveLength(1);
        expect(alerts[0].developer_id).toBe(devIds.jane);
        expect(alerts[0].developer_name).toBe('Jane Doe');
        expect(alerts[0].tools).toHaveLength(2);
        expect(alerts[0].message).toContain('Jane Doe');
        expect(alerts[0].message).toContain('cursor');
        expect(alerts[0].message).toContain('copilot');
    });

    it('does not flag tools in different categories', () => {
        // alice has copilot (ide_assistant) + claude_code (ai_agent) — different categories
        upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: 19,
            data_source: 'expense_import',
        });
        upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'claude_code',
            plan: 'max',
            billing_model: 'reimbursed',
            monthly_cost: 200,
            data_source: 'expense_import',
        });

        const alerts = detectDuplicates(db);
        expect(alerts).toHaveLength(0);
    });

    it('does not flag single subscriptions', () => {
        upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: 19,
            data_source: 'expense_import',
        });

        const alerts = detectDuplicates(db);
        expect(alerts).toHaveLength(0);
    });

    it('returns empty array when no subscriptions exist', () => {
        const alerts = detectDuplicates(db);
        expect(alerts).toHaveLength(0);
    });

    it('ignores revoked subscriptions when detecting duplicates', () => {
        upsertSubscription(db, {
            developer_id: devIds.jane,
            tool: 'cursor',
            plan: 'pro',
            billing_model: 'reimbursed',
            monthly_cost: 20,
            data_source: 'expense_import',
        });
        const copilotSub = upsertSubscription(db, {
            developer_id: devIds.jane,
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: 19,
            data_source: 'expense_import',
        });

        // Revoke the copilot subscription
        db.prepare('UPDATE subscriptions SET seat_revoked_at = ? WHERE id = ?').run(
            new Date().toISOString(),
            copilotSub.id,
        );

        const alerts = detectDuplicates(db);
        expect(alerts).toHaveLength(0);
    });
});

// ─── Subscription lifecycle handling (Task 2.14 / #49) ───────────────────────

interface ActiveSubRow {
    id: string;
    plan: string | null;
    monthly_cost: number | null;
    seat_assigned_at: string | null;
    seat_revoked_at: string | null;
}

function activeSubs(db: Database.Database, developerId: string, tool?: string): ActiveSubRow[] {
    const sql = tool
        ? 'SELECT * FROM subscriptions WHERE developer_id = ? AND tool = ? AND seat_revoked_at IS NULL'
        : 'SELECT * FROM subscriptions WHERE developer_id = ? AND seat_revoked_at IS NULL';
    const rows = tool ? db.prepare(sql).all(developerId, tool) : db.prepare(sql).all(developerId);
    return rows as ActiveSubRow[];
}

describe('subscription lifecycle — plan changes', () => {
    let db: Database.Database;
    let devIds: DevIds;

    beforeEach(() => {
        db = makeDb();
        devIds = seedDevelopers(db);
    });

    afterEach(() => {
        db.close();
    });

    it('upgrade revokes the old seat, creates a new active one, and records an event', () => {
        const before = upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'claude_code',
            plan: 'pro',
            billing_model: 'reimbursed',
            monthly_cost: 20,
            data_source: 'expense_import',
        });
        const after = upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'claude_code',
            plan: 'max',
            billing_model: 'reimbursed',
            monthly_cost: 200,
            data_source: 'expense_import',
        });

        // New active row is a distinct row with the new plan/cost.
        expect(after.id).not.toBe(before.id);
        const active = activeSubs(db, devIds.alice, 'claude_code');
        expect(active).toHaveLength(1);
        expect(active[0].plan).toBe('max');
        expect(active[0].monthly_cost).toBe(200);

        // Old row preserved with a revoke date — full history retained.
        const all = db
            .prepare('SELECT * FROM subscriptions WHERE developer_id = ? AND tool = ? ORDER BY seat_assigned_at')
            .all(devIds.alice, 'claude_code') as {id: string; plan: string; seat_revoked_at: string | null}[];
        expect(all).toHaveLength(2);
        const old = all.find((r) => r.id === before.id)!;
        expect(old.plan).toBe('pro');
        expect(old.seat_revoked_at).not.toBeNull();

        // Event captures before/after.
        const events = getDeveloperPlanChanges(db, devIds.alice);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            tool: 'claude_code',
            old_tool: null,
            old_plan: 'pro',
            new_plan: 'max',
            old_monthly_cost: 20,
            new_monthly_cost: 200,
        });
    });

    it('downgrade is handled identically (revoke + create + event)', () => {
        upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'claude_code',
            plan: 'max',
            billing_model: 'reimbursed',
            monthly_cost: 200,
            data_source: 'expense_import',
        });
        upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'claude_code',
            plan: 'pro',
            billing_model: 'reimbursed',
            monthly_cost: 20,
            data_source: 'expense_import',
        });

        const active = activeSubs(db, devIds.alice, 'claude_code');
        expect(active).toHaveLength(1);
        expect(active[0].plan).toBe('pro');
        expect(active[0].monthly_cost).toBe(20);

        const events = getDeveloperPlanChanges(db, devIds.alice);
        expect(events).toHaveLength(1);
        expect(events[0].old_monthly_cost).toBe(200);
        expect(events[0].new_monthly_cost).toBe(20);
    });

    it('re-recording identical plan + cost does not churn history or emit an event', () => {
        const first = upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: 19,
            data_source: 'expense_import',
        });
        const second = upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: 19,
            data_source: 'expense_import',
        });

        expect(second.id).toBe(first.id);
        const all = db
            .prepare('SELECT * FROM subscriptions WHERE developer_id = ? AND tool = ?')
            .all(devIds.alice, 'copilot');
        expect(all).toHaveLength(1);
        expect(getDeveloperPlanChanges(db, devIds.alice)).toHaveLength(0);
    });

    it('a billing-model-only change is patched in place without a transition', () => {
        const first = upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'copilot',
            plan: 'business',
            billing_model: 'personal',
            monthly_cost: 19,
            data_source: 'expense_import',
        });
        const second = upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: 19,
            data_source: 'expense_import',
        });

        expect(second.id).toBe(first.id);
        expect(second.billing_model).toBe('company_managed');
        expect(activeSubs(db, devIds.alice, 'copilot')).toHaveLength(1);
        expect(getDeveloperPlanChanges(db, devIds.alice)).toHaveLength(0);
    });

    it('preserves historical tool_snapshots across a transition', () => {
        db.prepare(
            `INSERT INTO tool_snapshots (id, developer_id, date, tool, data_source, data_quality, is_active, interaction_count)
             VALUES ('snap-keep', ?, '2026-01-05', 'claude_code', 'api', 'high', 1, 42)`,
        ).run(devIds.alice);

        upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'claude_code',
            plan: 'pro',
            billing_model: 'reimbursed',
            monthly_cost: 20,
            data_source: 'expense_import',
        });
        upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'claude_code',
            plan: 'max',
            billing_model: 'reimbursed',
            monthly_cost: 200,
            data_source: 'expense_import',
        });

        const snap = db
            .prepare('SELECT interaction_count, tool FROM tool_snapshots WHERE id = ?')
            .get('snap-keep') as {interaction_count: number; tool: string};
        expect(snap.interaction_count).toBe(42);
        expect(snap.tool).toBe('claude_code');
    });
});

describe('subscription lifecycle — tool switches', () => {
    let db: Database.Database;
    let devIds: DevIds;

    beforeEach(() => {
        db = makeDb();
        devIds = seedDevelopers(db);
    });

    afterEach(() => {
        db.close();
    });

    it('switchTool revokes the old tool, opens the new one, and records the switch', () => {
        upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: 19,
            data_source: 'expense_import',
        });

        const created = switchTool(db, {
            developer_id: devIds.alice,
            from_tool: 'copilot',
            to_tool: 'cursor',
            plan: 'pro',
            billing_model: 'company_managed',
            monthly_cost: 20,
            data_source: 'admin',
        });

        // copilot revoked, cursor active.
        expect(activeSubs(db, devIds.alice, 'copilot')).toHaveLength(0);
        const cursor = activeSubs(db, devIds.alice, 'cursor');
        expect(cursor).toHaveLength(1);
        expect(cursor[0].id).toBe(created.id);
        expect(cursor[0].monthly_cost).toBe(20);

        const events = getDeveloperPlanChanges(db, devIds.alice);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            tool: 'cursor',
            old_tool: 'copilot',
            old_plan: 'business',
            new_plan: 'pro',
            old_monthly_cost: 19,
            new_monthly_cost: 20,
        });
    });

    it('switching onto a tool the developer already holds leaves exactly one active seat', () => {
        // Alice already has an active cursor seat AND a copilot seat.
        upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: 19,
            data_source: 'expense_import',
        });
        upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'cursor',
            plan: 'free',
            billing_model: 'personal',
            monthly_cost: 0,
            data_source: 'expense_import',
        });

        switchTool(db, {
            developer_id: devIds.alice,
            from_tool: 'copilot',
            to_tool: 'cursor',
            plan: 'pro',
            billing_model: 'company_managed',
            monthly_cost: 20,
            data_source: 'admin',
        });

        // The pre-existing cursor seat is revoked; exactly one active cursor seat
        // remains (the new one), preserving the one-active-seat-per-tool invariant.
        const cursor = activeSubs(db, devIds.alice, 'cursor');
        expect(cursor).toHaveLength(1);
        expect(cursor[0].plan).toBe('pro');
        expect(cursor[0].monthly_cost).toBe(20);
        // The old cursor seat is preserved as history, not deleted.
        const allCursor = db
            .prepare('SELECT COUNT(*) as n FROM subscriptions WHERE developer_id = ? AND tool = ?')
            .get(devIds.alice, 'cursor') as {n: number};
        expect(allCursor.n).toBe(2);
    });
});

describe('subscription lifecycle — cost over time', () => {
    let db: Database.Database;
    let devIds: DevIds;

    beforeEach(() => {
        db = makeDb();
        devIds = seedDevelopers(db);
        // Simulate a mid-month upgrade with controlled seat dates: Pro $20 from
        // Jan 1, revoked Jan 15; Max $200 assigned Jan 15.
        db.prepare(
            `INSERT INTO subscriptions (id, developer_id, tool, plan, billing_model, monthly_cost, seat_assigned_at, seat_revoked_at, data_source)
             VALUES ('cot-pro', ?, 'claude_code', 'pro', 'reimbursed', 20, '2026-01-01T00:00:00.000Z', '2026-01-15T00:00:00.000Z', 'expense_import')`,
        ).run(devIds.alice);
        db.prepare(
            `INSERT INTO subscriptions (id, developer_id, tool, plan, billing_model, monthly_cost, seat_assigned_at, seat_revoked_at, data_source)
             VALUES ('cot-max', ?, 'claude_code', 'max', 'reimbursed', 200, '2026-01-15T00:00:00.000Z', NULL, 'expense_import')`,
        ).run(devIds.alice);
    });

    afterEach(() => {
        db.close();
    });

    it('charges the old rate before the change and the new rate after', () => {
        expect(getDeveloperCostOnDate(db, devIds.alice, '2026-01-10')).toBe(20);
        expect(getDeveloperCostOnDate(db, devIds.alice, '2026-01-20')).toBe(200);
    });

    it('does not double-count on the transition day', () => {
        // On Jan 15 the Pro seat is already revoked (revoked date not > date) and
        // the Max seat is active — exactly one seat's cost, not both.
        expect(getDeveloperCostOnDate(db, devIds.alice, '2026-01-15')).toBe(200);
    });

    it('produces a per-day series that reflects the change date', () => {
        const series = getDeveloperCostOverTime(db, devIds.alice, '2026-01-13', '2026-01-16');
        expect(series).toEqual([
            {date: '2026-01-13', monthly_cost: 20},
            {date: '2026-01-14', monthly_cost: 20},
            {date: '2026-01-15', monthly_cost: 200},
            {date: '2026-01-16', monthly_cost: 200},
        ]);
    });
});
