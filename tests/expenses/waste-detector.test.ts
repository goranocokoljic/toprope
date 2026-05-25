import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {addTeam} from '../../src/registry/teams';
import {addDeveloper} from '../../src/registry/developers';
import {upsertSubscription} from '../../src/expenses/subscription-tracker';
import {
    runWasteDetection,
    listActiveAlerts,
    getWasteSummaryByTeam,
    resolveAlert,
} from '../../src/expenses/waste-detector';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function daysAgo(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
}

interface DevIds {
    alice: string;
    bob: string;
    jane: string;
}

function seedTeamsAndDevs(db: Database.Database): DevIds {
    addTeam(db, 'engineering');
    addTeam(db, 'backend');
    const alice = addDeveloper(db, 'Alice Smith', 'engineering', 'alice@example.com');
    const bob = addDeveloper(db, 'Bob Jones', 'engineering', 'bob@example.com');
    const jane = addDeveloper(db, 'Jane Doe', 'backend', 'jane@example.com');
    return {alice: alice.id, bob: bob.id, jane: jane.id};
}

function insertToolSnapshot(
    db: Database.Database,
    developerId: string,
    date: string,
    tool: string,
    isActive: boolean,
    interactionCount = 10,
): void {
    db.prepare(
        `INSERT INTO tool_snapshots (id, developer_id, date, tool, data_source, data_quality, is_active, interaction_count)
         VALUES (?, ?, ?, ?, 'test', 'high', ?, ?)
         ON CONFLICT(developer_id, date, tool) DO NOTHING`,
    ).run(
        `${developerId}-${date}-${tool}`,
        developerId,
        date,
        tool,
        isActive ? 1 : 0,
        interactionCount,
    );
}

function insertGitSnapshot(
    db: Database.Database,
    developerId: string,
    date: string,
    prs: number,
): void {
    db.prepare(
        `INSERT INTO git_snapshots (id, developer_id, date, prs_merged)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(developer_id, date) DO NOTHING`,
    ).run(`${developerId}-${date}`, developerId, date, prs);
}

// ─── Unused seat tests ───────────────────────────────────────────────────────

describe('unused seat detection', () => {
    let db: Database.Database;
    let devIds: DevIds;

    beforeEach(() => {
        db = makeDb();
        devIds = seedTeamsAndDevs(db);
    });

    afterEach(() => {
        db.close();
    });

    it('flags developer with Copilot subscription and zero activity for 14 days', () => {
        upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: 19,
            data_source: 'expense_import',
        });
        // No tool_snapshots at all

        const result = runWasteDetection(db, {inactivity_threshold_days: 14});
        expect(result.created).toBe(1);

        const alerts = listActiveAlerts(db);
        expect(alerts).toHaveLength(1);
        expect(alerts[0].alert_type).toBe('unused_seat');
        expect(alerts[0].tool).toBe('copilot');
        expect(alerts[0].monthly_waste).toBe(19);
        expect(alerts[0].developer_id).toBe(devIds.alice);
    });

    it('flags developer with Claude Code subscription and zero activity for 14 days', () => {
        upsertSubscription(db, {
            developer_id: devIds.bob,
            tool: 'claude_code',
            plan: 'pro',
            billing_model: 'reimbursed',
            monthly_cost: 100,
            data_source: 'expense_import',
        });

        const result = runWasteDetection(db, {inactivity_threshold_days: 14});
        expect(result.created).toBe(1);

        const alerts = listActiveAlerts(db);
        expect(alerts[0].alert_type).toBe('unused_seat');
        expect(alerts[0].tool).toBe('claude_code');
        expect(alerts[0].monthly_waste).toBe(100);
    });

    it('flags developer with Windsurf subscription and zero activity for 14 days', () => {
        upsertSubscription(db, {
            developer_id: devIds.jane,
            tool: 'windsurf',
            plan: 'pro',
            billing_model: 'company_managed',
            monthly_cost: 40,
            data_source: 'expense_import',
        });

        const result = runWasteDetection(db, {inactivity_threshold_days: 14});
        expect(result.created).toBe(1);

        const alerts = listActiveAlerts(db);
        expect(alerts[0].alert_type).toBe('unused_seat');
        expect(alerts[0].tool).toBe('windsurf');
        expect(alerts[0].monthly_waste).toBe(40);
    });

    it('does not flag developer with recent activity within threshold', () => {
        upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: 19,
            data_source: 'expense_import',
        });
        // Active 5 days ago — within 14-day window
        insertToolSnapshot(db, devIds.alice, daysAgo(5), 'copilot', true);

        const result = runWasteDetection(db, {inactivity_threshold_days: 14});
        expect(result.created).toBe(0);
    });

    it('flags developer with only old activity (beyond threshold)', () => {
        upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: 19,
            data_source: 'expense_import',
        });
        // Active 20 days ago — outside 14-day window
        insertToolSnapshot(db, devIds.alice, daysAgo(20), 'copilot', true);

        const result = runWasteDetection(db, {inactivity_threshold_days: 14});
        expect(result.created).toBe(1);
        expect(listActiveAlerts(db)[0].alert_type).toBe('unused_seat');
    });

    it('does not flag inactive snapshots within threshold (is_active=false)', () => {
        upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: 19,
            data_source: 'expense_import',
        });
        // Snapshot exists but is_active=0
        insertToolSnapshot(db, devIds.alice, daysAgo(3), 'copilot', false);

        const result = runWasteDetection(db, {inactivity_threshold_days: 14});
        expect(result.created).toBe(1); // should still flag — not *active*
    });
});

// ─── Duplicate tool tests ────────────────────────────────────────────────────

describe('duplicate tool detection', () => {
    let db: Database.Database;
    let devIds: DevIds;

    beforeEach(() => {
        db = makeDb();
        devIds = seedTeamsAndDevs(db);
    });

    afterEach(() => {
        db.close();
    });

    it('flags developer with both Copilot and Windsurf (duplicate IDE-based)', () => {
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
            tool: 'windsurf',
            plan: 'pro',
            billing_model: 'reimbursed',
            monthly_cost: 40,
            data_source: 'expense_import',
        });

        const result = runWasteDetection(db);
        expect(result.created).toBeGreaterThanOrEqual(1);

        const alerts = listActiveAlerts(db).filter((a) => a.alert_type === 'duplicate_tool');
        expect(alerts).toHaveLength(1);
        expect(alerts[0].tool).toBe('ide_assistant');
        expect(alerts[0].developer_id).toBe(devIds.alice);
        const details = alerts[0].details;
        expect(Array.isArray(details.tools)).toBe(true);
        expect((details.tools as unknown[]).length).toBe(2);
    });

    it('flags developer with Copilot and Cursor (duplicate IDE-based)', () => {
        upsertSubscription(db, {
            developer_id: devIds.bob,
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

        runWasteDetection(db);
        const alerts = listActiveAlerts(db).filter((a) => a.alert_type === 'duplicate_tool');
        expect(alerts).toHaveLength(1);
        // Smaller cost is wasted (copilot $19)
        expect(alerts[0].monthly_waste).toBe(19);
    });

    it('does not flag tools in different categories', () => {
        // Copilot (ide_assistant) + claude_code (ai_agent) — different
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
            plan: 'pro',
            billing_model: 'reimbursed',
            monthly_cost: 100,
            data_source: 'expense_import',
        });

        runWasteDetection(db);
        const alerts = listActiveAlerts(db).filter((a) => a.alert_type === 'duplicate_tool');
        expect(alerts).toHaveLength(0);
    });
});

// ─── Underutilized seat tests ────────────────────────────────────────────────

describe('underutilized seat detection', () => {
    let db: Database.Database;
    let devIds: DevIds;

    beforeEach(() => {
        db = makeDb();
        devIds = seedTeamsAndDevs(db);
    });

    afterEach(() => {
        db.close();
    });

    it('flags developer with usage below 20% of team average', () => {
        // Both alice and bob are on same team "engineering", using copilot
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
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: 19,
            data_source: 'expense_import',
        });

        // alice: 2 interactions/day (very low)
        // bob: 100 interactions/day (high)
        // team avg ≈ 51 — alice at 2/51 ≈ 4% < 20%
        for (let i = 1; i <= 7; i++) {
            insertToolSnapshot(db, devIds.alice, daysAgo(i), 'copilot', true, 2);
            insertToolSnapshot(db, devIds.bob, daysAgo(i), 'copilot', true, 100);
        }

        runWasteDetection(db, {underutilized_threshold_pct: 20, lookback_days: 30});
        const alerts = listActiveAlerts(db).filter((a) => a.alert_type === 'underutilized');
        expect(alerts).toHaveLength(1);
        expect(alerts[0].developer_id).toBe(devIds.alice);
        expect(alerts[0].tool).toBe('copilot');
        expect(alerts[0].monthly_waste).toBe(19);
    });

    it('does not flag developer with usage at or above 20% of team average', () => {
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
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: 19,
            data_source: 'expense_import',
        });

        // alice: 30, bob: 100 → avg 65 → alice at 30/65 ≈ 46% — above 20%
        for (let i = 1; i <= 7; i++) {
            insertToolSnapshot(db, devIds.alice, daysAgo(i), 'copilot', true, 30);
            insertToolSnapshot(db, devIds.bob, daysAgo(i), 'copilot', true, 100);
        }

        runWasteDetection(db, {underutilized_threshold_pct: 20, lookback_days: 30});
        const alerts = listActiveAlerts(db).filter((a) => a.alert_type === 'underutilized');
        expect(alerts).toHaveLength(0);
    });

    it('does not flag developer without subscription for tool', () => {
        // alice uses the tool but has no subscription
        upsertSubscription(db, {
            developer_id: devIds.bob,
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: 19,
            data_source: 'expense_import',
        });

        for (let i = 1; i <= 7; i++) {
            insertToolSnapshot(db, devIds.alice, daysAgo(i), 'copilot', true, 2);
            insertToolSnapshot(db, devIds.bob, daysAgo(i), 'copilot', true, 100);
        }

        runWasteDetection(db, {underutilized_threshold_pct: 20, lookback_days: 30});
        const alerts = listActiveAlerts(db).filter((a) => a.alert_type === 'underutilized');
        expect(alerts).toHaveLength(0);
    });
});

// ─── Cost outlier tests ──────────────────────────────────────────────────────

describe('cost outlier detection', () => {
    let db: Database.Database;
    let devIds: DevIds;

    beforeEach(() => {
        db = makeDb();
        devIds = seedTeamsAndDevs(db);
    });

    afterEach(() => {
        db.close();
    });

    it('flags developer with cost-per-PR > 3x team average', () => {
        // alice: $200/mo, 1 PR/month → $200/PR
        // bob: $19/mo, 10 PR/month → $1.9/PR
        // team avg ≈ $101/PR → alice at 200 > 3 * 101 (no), let me recalculate
        // avg = (200 + 1.9) / 2 = 100.95 → alice 200 > 3 * 100.95 = 302.85 → No
        // Let's use: alice $200/mo, 1 PR; bob $19/mo, 20 PRs
        // alice cost_per_pr = 200/1 = 200, bob = 19/20 = 0.95
        // avg = 100.475, alice > 3 * 100.475 = 301.4 → No
        // Let me use: alice $400/mo, 1 PR; bob $20/mo, 20 PRs
        // alice = 400, bob = 1, avg = 200.5, alice > 3 * 200.5 = 601.5 → No
        //
        // Need alice to be > 3x the *team* average (including herself).
        // alice = 400, bob = 1, avg = 200.5, alice > 3*200.5 doesn't work.
        //
        // Better: 3 developers. alice $300/mo, 1 PR → $300/PR.
        // bob $30/mo, 30 PR → $1/PR. jane $20/mo, 20 PR → $1/PR.
        // avg = (300 + 1 + 1) / 3 = 100.67
        // alice: 300 > 3 * 100.67 = 302 → barely no
        //
        // With alice $400: avg = (400 + 1 + 1)/3 = 134. alice > 3*134 = 402 → barely no.
        //
        // I need alice to be > 3x. Let me try: 4 devs.
        // alice $200, 1 PR → $200/PR. bob/jane/extra: $10, 50 PR each → $0.2/PR
        // avg = (200 + 0.2 + 0.2) / 3 = 66.8 (3 people in same team)
        // alice: 200 > 3 * 66.8 = 200.4 → barely no
        //
        // Let me just make alice have very high cost and very few PRs vs team:
        // alice: $500/mo, 1 PR → $500/PR. bob: $20/mo, 100 PRs → $0.2/PR.
        // avg with 2 devs: (500 + 0.2)/2 = 250.1
        // alice: 500 > 3 * 250.1 = 750.3 → no
        //
        // Hmm, with only 2 developers, the outlier is diluted by the outlier itself.
        // I need more developers with low cost-per-PR.
        // Let's add 3 more engineers.

        addDeveloper(db, 'Charlie Green', 'engineering', 'charlie@example.com');
        addDeveloper(db, 'Dave White', 'engineering', 'dave@example.com');

        const devs = db
            .prepare("SELECT id, name FROM developers WHERE team = 'engineering'")
            .all() as {id: string; name: string}[];

        // alice: $500/mo, 0 PRs → will be skipped (prs_per_month=0)
        // Actually we need alice to have PRs but still be expensive.
        // alice: $500/mo, 1 PR/month → $500/PR
        // others: $20/mo, 20 PRs each → $1/PR
        // With 4 total: avg = (500 + 1 + 1 + 1) / 4 = 125.75
        // alice: 500 > 3 * 125.75 = 377.25 → YES!

        const aliceDev = devs.find((d) => d.name === 'Alice Smith')!;
        const others = devs.filter((d) => d.name !== 'Alice Smith');

        upsertSubscription(db, {
            developer_id: aliceDev.id,
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: 500,
            data_source: 'expense_import',
        });

        for (const dev of others) {
            upsertSubscription(db, {
                developer_id: dev.id,
                tool: 'copilot',
                plan: 'business',
                billing_model: 'company_managed',
                monthly_cost: 20,
                data_source: 'expense_import',
            });
        }

        // alice: 1 PR in 30 days
        insertGitSnapshot(db, aliceDev.id, daysAgo(5), 1);
        // others: 20 PRs each
        for (const dev of others) {
            insertGitSnapshot(db, dev.id, daysAgo(5), 20);
        }

        runWasteDetection(db, {cost_outlier_multiplier: 3, lookback_days: 30});
        const alerts = listActiveAlerts(db).filter((a) => a.alert_type === 'cost_outlier');
        expect(alerts).toHaveLength(1);
        expect(alerts[0].developer_id).toBe(aliceDev.id);
    });

    it('does not flag with only one developer in team', () => {
        upsertSubscription(db, {
            developer_id: devIds.jane,
            tool: 'windsurf',
            plan: 'pro',
            billing_model: 'company_managed',
            monthly_cost: 500,
            data_source: 'expense_import',
        });
        insertGitSnapshot(db, devIds.jane, daysAgo(5), 1);

        runWasteDetection(db, {cost_outlier_multiplier: 3, lookback_days: 30});
        const alerts = listActiveAlerts(db).filter((a) => a.alert_type === 'cost_outlier');
        expect(alerts).toHaveLength(0);
    });
});

// ─── No-duplicate tests ──────────────────────────────────────────────────────

describe('deduplication', () => {
    let db: Database.Database;
    let devIds: DevIds;

    beforeEach(() => {
        db = makeDb();
        devIds = seedTeamsAndDevs(db);
    });

    afterEach(() => {
        db.close();
    });

    it('does not create duplicate alerts on re-run', () => {
        upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: 19,
            data_source: 'expense_import',
        });

        const first = runWasteDetection(db, {inactivity_threshold_days: 14});
        expect(first.created).toBe(1);

        const second = runWasteDetection(db, {inactivity_threshold_days: 14});
        expect(second.created).toBe(0);
        expect(second.skipped).toBe(1);

        expect(listActiveAlerts(db)).toHaveLength(1);
    });

    it('resolved alert stays resolved — same condition does not reappear', () => {
        upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: 19,
            data_source: 'expense_import',
        });

        runWasteDetection(db, {inactivity_threshold_days: 14});
        const alerts = listActiveAlerts(db);
        expect(alerts).toHaveLength(1);

        const resolved = resolveAlert(db, alerts[0].id, 'Developer on leave');
        expect(resolved).toBe(true);

        expect(listActiveAlerts(db)).toHaveLength(0);

        // Re-run detection — same condition should not reappear
        const third = runWasteDetection(db, {inactivity_threshold_days: 14});
        expect(third.created).toBe(0);
        expect(listActiveAlerts(db)).toHaveLength(0);
    });
});

// ─── Monthly waste calculation tests ─────────────────────────────────────────

describe('monthly waste calculation', () => {
    let db: Database.Database;
    let devIds: DevIds;

    beforeEach(() => {
        db = makeDb();
        devIds = seedTeamsAndDevs(db);
    });

    afterEach(() => {
        db.close();
    });

    it('unused $40/mo seat = $40/mo waste', () => {
        upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'windsurf',
            plan: 'pro',
            billing_model: 'company_managed',
            monthly_cost: 40,
            data_source: 'expense_import',
        });

        runWasteDetection(db, {inactivity_threshold_days: 14});
        const alerts = listActiveAlerts(db);
        expect(alerts[0].monthly_waste).toBe(40);
    });
});

// ─── listActiveAlerts tests ──────────────────────────────────────────────────

describe('listActiveAlerts', () => {
    let db: Database.Database;
    let devIds: DevIds;

    beforeEach(() => {
        db = makeDb();
        devIds = seedTeamsAndDevs(db);
    });

    afterEach(() => {
        db.close();
    });

    it('returns empty array when no alerts', () => {
        expect(listActiveAlerts(db)).toHaveLength(0);
    });

    it('excludes resolved alerts', () => {
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
            tool: 'claude_code',
            plan: 'pro',
            billing_model: 'reimbursed',
            monthly_cost: 100,
            data_source: 'expense_import',
        });

        runWasteDetection(db, {inactivity_threshold_days: 14});
        const alerts = listActiveAlerts(db);
        expect(alerts).toHaveLength(2);

        resolveAlert(db, alerts[0].id, 'justified');
        expect(listActiveAlerts(db)).toHaveLength(1);
    });
});

// ─── getWasteSummaryByTeam tests ─────────────────────────────────────────────

describe('getWasteSummaryByTeam', () => {
    let db: Database.Database;
    let devIds: DevIds;

    beforeEach(() => {
        db = makeDb();
        devIds = seedTeamsAndDevs(db);
    });

    afterEach(() => {
        db.close();
    });

    it('returns correct per-team breakdown', () => {
        // engineering: alice (copilot $19), bob (claude_code $100)
        // backend: jane (windsurf $40)
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
            tool: 'claude_code',
            plan: 'pro',
            billing_model: 'reimbursed',
            monthly_cost: 100,
            data_source: 'expense_import',
        });
        upsertSubscription(db, {
            developer_id: devIds.jane,
            tool: 'windsurf',
            plan: 'pro',
            billing_model: 'company_managed',
            monthly_cost: 40,
            data_source: 'expense_import',
        });

        runWasteDetection(db, {inactivity_threshold_days: 14});

        const summary = getWasteSummaryByTeam(db);
        const eng = summary.find((s) => s.team === 'engineering');
        const backend = summary.find((s) => s.team === 'backend');

        expect(eng).toBeDefined();
        expect(backend).toBeDefined();
        expect(eng!.alert_count).toBe(2);
        expect(eng!.total_monthly_waste).toBe(119); // 19 + 100
        expect(backend!.alert_count).toBe(1);
        expect(backend!.total_monthly_waste).toBe(40);
    });

    it('returns empty array when no alerts', () => {
        expect(getWasteSummaryByTeam(db)).toHaveLength(0);
    });
});

// ─── resolveAlert tests ──────────────────────────────────────────────────────

describe('resolveAlert', () => {
    let db: Database.Database;
    let devIds: DevIds;

    beforeEach(() => {
        db = makeDb();
        devIds = seedTeamsAndDevs(db);
    });

    afterEach(() => {
        db.close();
    });

    it('resolves an alert with reason', () => {
        upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: 19,
            data_source: 'expense_import',
        });

        runWasteDetection(db, {inactivity_threshold_days: 14});
        const [alert] = listActiveAlerts(db);

        const ok = resolveAlert(db, alert.id, 'Developer on sabbatical');
        expect(ok).toBe(true);
        expect(listActiveAlerts(db)).toHaveLength(0);
    });

    it('returns false for non-existent alert id', () => {
        expect(resolveAlert(db, 'not-a-real-id', 'test')).toBe(false);
    });

    it('returns false when already resolved', () => {
        upsertSubscription(db, {
            developer_id: devIds.alice,
            tool: 'copilot',
            plan: 'business',
            billing_model: 'company_managed',
            monthly_cost: 19,
            data_source: 'expense_import',
        });

        runWasteDetection(db, {inactivity_threshold_days: 14});
        const [alert] = listActiveAlerts(db);

        resolveAlert(db, alert.id, 'first reason');
        expect(resolveAlert(db, alert.id, 'second reason')).toBe(false);
    });
});
