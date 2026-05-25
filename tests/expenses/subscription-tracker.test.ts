import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {addTeam} from '../../src/registry/teams';
import {addDeveloper} from '../../src/registry/developers';
import {
    upsertSubscription,
    listSubscriptions,
    getDeveloperCostSummaries,
    getTeamCostSummaries,
    getOrgCostSummary,
    detectDuplicates,
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
