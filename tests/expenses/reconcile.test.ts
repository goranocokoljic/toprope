import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {randomUUID} from 'crypto';
import {runMigrations} from '../../src/storage/migrator';
import {addTeam} from '../../src/registry/teams';
import {addDeveloper} from '../../src/registry/developers';
import {
    reconcilePeriod,
    listReconciliationResults,
    getReconciliationResultById,
    resolveReconciliationResult,
    ignoreReconciliationResult,
    latestExpensePeriod,
    DEFAULT_COST_TOLERANCE,
} from '../../src/expenses/reconcile';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');
const PERIOD = '2026-06';

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

interface ChargeOpts {
    developerId?: string | null;
    tool: string;
    period?: string | null;
    monthlyCost?: number | null;
    chargeType?: 'recurring_monthly' | 'recurring_annual' | 'one_time';
    billingModel?: string;
}

function insertCharge(db: Database.Database, opts: ChargeOpts): string {
    const id = randomUUID();
    db.prepare(
        `INSERT INTO expense_charges
           (id, dedup_key, developer_id, tool, plan, amount, period, charge_type,
            monthly_cost, billing_model, match_status, source_profile, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'standard', ?)`,
    ).run(
        id,
        id, // dedup_key — unique per row here
        opts.developerId ?? null,
        opts.tool,
        opts.monthlyCost ?? null,
        opts.period === undefined ? PERIOD : opts.period,
        opts.chargeType ?? 'recurring_monthly',
        opts.monthlyCost ?? null,
        opts.billingModel ?? 'reimbursed',
        opts.developerId ? 'matched' : 'unmatched',
        '2026-06-15T00:00:00.000Z',
    );
    return id;
}

interface SubOpts {
    developerId: string;
    tool: string;
    monthlyCost?: number | null;
    billingModel?: string;
    assignedAt?: string | null;
    revokedAt?: string | null;
}

function insertSub(db: Database.Database, opts: SubOpts): string {
    const id = randomUUID();
    db.prepare(
        `INSERT INTO subscriptions
           (id, developer_id, tool, plan, billing_model, monthly_cost, seat_assigned_at, seat_revoked_at, data_source)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'csv')`,
    ).run(
        id,
        opts.developerId,
        opts.tool,
        opts.billingModel ?? 'reimbursed',
        opts.monthlyCost ?? null,
        opts.assignedAt === undefined ? '2026-06-01T00:00:00.000Z' : opts.assignedAt,
        opts.revokedAt ?? null,
    );
    return id;
}

describe('reconcilePeriod', () => {
    let db: Database.Database;
    let alice: string;
    let bob: string;

    beforeEach(() => {
        db = makeDb();
        addTeam(db, 'engineering');
        alice = addDeveloper(db, 'Alice', 'engineering', 'alice@example.com').id;
        bob = addDeveloper(db, 'Bob', 'engineering', 'bob@example.com').id;
    });

    afterEach(() => db.close());

    it('rejects a malformed period', () => {
        expect(() => reconcilePeriod(db, '2026-6')).toThrow(/Expected YYYY-MM/);
        expect(() => reconcilePeriod(db, 'June')).toThrow();
        // Impossible months are rejected at the boundary.
        expect(() => reconcilePeriod(db, '2026-13')).toThrow();
        expect(() => reconcilePeriod(db, '2026-00')).toThrow();
    });

    it('flags an expense with no matching subscription', () => {
        insertCharge(db, {developerId: alice, tool: 'cursor', monthlyCost: 20});
        const summary = reconcilePeriod(db, PERIOD);
        expect(summary.created).toBe(1);
        expect(summary.byType.expense_no_subscription).toBe(1);

        const results = listReconciliationResults(db);
        expect(results).toHaveLength(1);
        expect(results[0].result_type).toBe('expense_no_subscription');
        expect(results[0].developer_id).toBe(alice);
        expect(results[0].tool).toBe('cursor');
        expect(results[0].expense_amount).toBe(20);
        expect(results[0].registry_amount).toBeNull();
        expect(results[0].developer_name).toBe('Alice');
    });

    it('flags a reimbursed subscription with no matching expense', () => {
        insertSub(db, {developerId: alice, tool: 'copilot', monthlyCost: 19, billingModel: 'reimbursed'});
        const summary = reconcilePeriod(db, PERIOD);
        expect(summary.byType.subscription_no_expense).toBe(1);

        const results = listReconciliationResults(db);
        expect(results[0].result_type).toBe('subscription_no_expense');
        expect(results[0].registry_amount).toBe(19);
        expect(results[0].expense_amount).toBeNull();
    });

    it('does NOT flag a company-managed subscription with no matching expense', () => {
        insertSub(db, {developerId: alice, tool: 'copilot', monthlyCost: 19, billingModel: 'company_managed'});
        const summary = reconcilePeriod(db, PERIOD);
        expect(summary.created).toBe(0);
        expect(listReconciliationResults(db)).toHaveLength(0);
    });

    it('flags a cost discrepancy beyond tolerance but not within it', () => {
        // Within tolerance: expense 19.50 vs registry 19 (diff 0.50 < $1).
        insertSub(db, {developerId: alice, tool: 'copilot', monthlyCost: 19});
        insertCharge(db, {developerId: alice, tool: 'copilot', monthlyCost: 19.5});
        // Beyond tolerance: expense 40 vs registry 20 (diff 20 > $1).
        insertSub(db, {developerId: bob, tool: 'cursor', monthlyCost: 20});
        insertCharge(db, {developerId: bob, tool: 'cursor', monthlyCost: 40});

        const summary = reconcilePeriod(db, PERIOD);
        expect(summary.byType.cost_discrepancy).toBe(1);

        const results = listReconciliationResults(db);
        expect(results).toHaveLength(1);
        expect(results[0].result_type).toBe('cost_discrepancy');
        expect(results[0].developer_id).toBe(bob);
        expect(results[0].expense_amount).toBe(40);
        expect(results[0].registry_amount).toBe(20);
        const details = JSON.parse(results[0].details ?? '{}');
        expect(details.difference).toBe(20);
    });

    it('honors a custom tolerance', () => {
        insertSub(db, {developerId: alice, tool: 'copilot', monthlyCost: 19});
        insertCharge(db, {developerId: alice, tool: 'copilot', monthlyCost: 24});
        // diff = 5; with a $10 tolerance it is within bounds and not flagged.
        const summary = reconcilePeriod(db, PERIOD, {tolerance: 10});
        expect(summary.byType.cost_discrepancy).toBe(0);
    });

    it('ignores one-time charges (not subscriptions)', () => {
        insertCharge(db, {developerId: alice, tool: 'cursor', monthlyCost: 20, chargeType: 'one_time'});
        const summary = reconcilePeriod(db, PERIOD);
        expect(summary.created).toBe(0);
    });

    it('ignores unmatched charges (developer not resolved)', () => {
        insertCharge(db, {developerId: null, tool: 'cursor', monthlyCost: 20});
        const summary = reconcilePeriod(db, PERIOD);
        expect(summary.created).toBe(0);
    });

    it('only reconciles the requested period', () => {
        insertCharge(db, {developerId: alice, tool: 'cursor', monthlyCost: 20, period: '2026-05'});
        const summary = reconcilePeriod(db, PERIOD);
        expect(summary.created).toBe(0);
    });

    it('excludes subscriptions revoked before the period', () => {
        insertSub(db, {
            developerId: alice,
            tool: 'copilot',
            monthlyCost: 19,
            assignedAt: '2026-01-01T00:00:00.000Z',
            revokedAt: '2026-03-01T00:00:00.000Z',
        });
        const summary = reconcilePeriod(db, PERIOD);
        expect(summary.created).toBe(0);
    });

    it('produces all three result types together against fixtures', () => {
        // expense_no_subscription
        insertCharge(db, {developerId: alice, tool: 'cursor', monthlyCost: 20});
        // subscription_no_expense (reimbursed)
        insertSub(db, {developerId: bob, tool: 'windsurf', monthlyCost: 15, billingModel: 'reimbursed'});
        // cost_discrepancy
        insertSub(db, {developerId: alice, tool: 'copilot', monthlyCost: 19});
        insertCharge(db, {developerId: alice, tool: 'copilot', monthlyCost: 39});

        const summary = reconcilePeriod(db, PERIOD);
        expect(summary.byType.expense_no_subscription).toBe(1);
        expect(summary.byType.subscription_no_expense).toBe(1);
        expect(summary.byType.cost_discrepancy).toBe(1);
        expect(summary.created).toBe(3);
    });

    it('picks the latest-assigned seat on a mid-period plan change (no phantom discrepancy)', () => {
        // Plan change inside June: old $19 seat revoked, new $39 seat assigned the
        // same day. Both rows overlap the month; SUM-ing them would be $58 and
        // manufacture a discrepancy against the single $39 expense charge.
        insertSub(db, {
            developerId: alice,
            tool: 'copilot',
            monthlyCost: 19,
            assignedAt: '2026-05-01T00:00:00.000Z',
            revokedAt: '2026-06-15T00:00:00.000Z',
        });
        insertSub(db, {
            developerId: alice,
            tool: 'copilot',
            monthlyCost: 39,
            assignedAt: '2026-06-15T00:00:00.000Z',
        });
        insertCharge(db, {developerId: alice, tool: 'copilot', monthlyCost: 39});

        const summary = reconcilePeriod(db, PERIOD);
        expect(summary.created).toBe(0);
        expect(summary.byType.cost_discrepancy).toBe(0);
    });

    it('uses the period-end seat billing model (not MIN) for the no-expense check', () => {
        // Earlier company_managed seat, later reimbursed seat, both overlap June.
        // MIN(billing_model) would pick 'company_managed' and wrongly suppress.
        insertSub(db, {
            developerId: alice,
            tool: 'copilot',
            monthlyCost: 19,
            billingModel: 'company_managed',
            assignedAt: '2026-05-01T00:00:00.000Z',
            revokedAt: '2026-06-10T00:00:00.000Z',
        });
        insertSub(db, {
            developerId: alice,
            tool: 'copilot',
            monthlyCost: 19,
            billingModel: 'reimbursed',
            assignedAt: '2026-06-10T00:00:00.000Z',
        });
        const summary = reconcilePeriod(db, PERIOD);
        expect(summary.byType.subscription_no_expense).toBe(1);
    });

    it('does not flag when the period-end seat is company-managed (earlier seat reimbursed)', () => {
        insertSub(db, {
            developerId: alice,
            tool: 'copilot',
            monthlyCost: 19,
            billingModel: 'reimbursed',
            assignedAt: '2026-05-01T00:00:00.000Z',
            revokedAt: '2026-06-10T00:00:00.000Z',
        });
        insertSub(db, {
            developerId: alice,
            tool: 'copilot',
            monthlyCost: 19,
            billingModel: 'company_managed',
            assignedAt: '2026-06-10T00:00:00.000Z',
        });
        const summary = reconcilePeriod(db, PERIOD);
        expect(summary.created).toBe(0);
    });

    it('does not flag an annually-billed seat in a later month within the coverage window', () => {
        insertSub(db, {
            developerId: alice,
            tool: 'copilot',
            monthlyCost: 20,
            billingModel: 'reimbursed',
            assignedAt: '2026-01-01T00:00:00.000Z',
        });
        // Annual charge billed in January (monthly_cost = amount/12) covers June.
        insertCharge(db, {
            developerId: alice,
            tool: 'copilot',
            monthlyCost: 20,
            chargeType: 'recurring_annual',
            period: '2026-01',
        });
        const summary = reconcilePeriod(db, PERIOD);
        expect(summary.created).toBe(0);
    });

    it('flags subscription_no_expense once the annual coverage window has lapsed', () => {
        insertSub(db, {
            developerId: alice,
            tool: 'copilot',
            monthlyCost: 20,
            billingModel: 'reimbursed',
            assignedAt: '2025-01-01T00:00:00.000Z',
        });
        // A 2025-01 annual charge does NOT cover 2026-06 (more than 12 months on).
        insertCharge(db, {
            developerId: alice,
            tool: 'copilot',
            monthlyCost: 20,
            chargeType: 'recurring_annual',
            period: '2025-01',
        });
        const summary = reconcilePeriod(db, PERIOD);
        expect(summary.byType.subscription_no_expense).toBe(1);
    });

    it('surfaces a cost_discrepancy with cost_unknown when one side has no cost', () => {
        insertSub(db, {developerId: alice, tool: 'copilot', monthlyCost: null, billingModel: 'reimbursed'});
        insertCharge(db, {developerId: alice, tool: 'copilot', monthlyCost: 20});

        const summary = reconcilePeriod(db, PERIOD);
        expect(summary.byType.cost_discrepancy).toBe(1);
        const [r] = listReconciliationResults(db);
        expect(r.expense_amount).toBe(20);
        expect(r.registry_amount).toBeNull();
        const details = JSON.parse(r.details ?? '{}');
        expect(details.cost_unknown).toBe(true);
    });

    it('does not flag when both sides lack a cost', () => {
        insertSub(db, {developerId: alice, tool: 'copilot', monthlyCost: null, billingModel: 'reimbursed'});
        insertCharge(db, {developerId: alice, tool: 'copilot', monthlyCost: null});
        const summary = reconcilePeriod(db, PERIOD);
        expect(summary.created).toBe(0);
    });

    it('does not double-count when a monthly and an annual charge coexist for the same dev/tool', () => {
        insertSub(db, {
            developerId: alice,
            tool: 'copilot',
            monthlyCost: 20,
            billingModel: 'reimbursed',
            assignedAt: '2026-01-01T00:00:00.000Z',
        });
        // Annual charge billed in January (covers June) AND a June monthly charge.
        insertCharge(db, {
            developerId: alice,
            tool: 'copilot',
            monthlyCost: 20,
            chargeType: 'recurring_annual',
            period: '2026-01',
        });
        insertCharge(db, {developerId: alice, tool: 'copilot', monthlyCost: 20, period: PERIOD});

        // Expense must resolve to the monthly $20 (not $40 = monthly + annual),
        // so it matches the $20 seat and produces no phantom discrepancy.
        const summary = reconcilePeriod(db, PERIOD);
        expect(summary.created).toBe(0);
    });

    it('picks the active seat over a same-day-revoked seat (deterministic tiebreak)', () => {
        // Two seats share seat_assigned_at; one is revoked, one active. The active
        // one (reimbursed) must win, not an id-order accident.
        insertSub(db, {
            developerId: alice,
            tool: 'copilot',
            monthlyCost: 19,
            billingModel: 'company_managed',
            assignedAt: '2026-06-10T00:00:00.000Z',
            revokedAt: '2026-06-10T00:00:00.000Z',
        });
        insertSub(db, {
            developerId: alice,
            tool: 'copilot',
            monthlyCost: 39,
            billingModel: 'reimbursed',
            assignedAt: '2026-06-10T00:00:00.000Z',
        });
        const summary = reconcilePeriod(db, PERIOD);
        expect(summary.byType.subscription_no_expense).toBe(1);
    });

    it('an ignored cost_unknown result does not suppress a later real discrepancy', () => {
        // Seat with no cost + a real charge → cost_unknown discrepancy; ignore it.
        insertSub(db, {
            developerId: alice,
            tool: 'copilot',
            monthlyCost: null,
            billingModel: 'reimbursed',
            assignedAt: '2026-06-01T00:00:00.000Z',
        });
        insertCharge(db, {developerId: alice, tool: 'copilot', monthlyCost: 20});
        reconcilePeriod(db, PERIOD);
        const [unknown] = listReconciliationResults(db);
        expect(JSON.parse(unknown.details ?? '{}').cost_unknown).toBe(true);
        ignoreReconciliationResult(db, unknown.id, 'cost not loaded yet');

        // Registry cost is later filled in with a value that genuinely diverges.
        insertSub(db, {
            developerId: alice,
            tool: 'copilot',
            monthlyCost: 50,
            billingModel: 'reimbursed',
            assignedAt: '2026-06-20T00:00:00.000Z',
        });
        const second = reconcilePeriod(db, PERIOD);
        // The real ($20 vs $50) discrepancy is NOT masked by the ignored unknown.
        expect(second.byType.cost_discrepancy).toBe(1);
        const open = listReconciliationResults(db, {status: 'open'});
        expect(open).toHaveLength(1);
        expect(JSON.parse(open[0].details ?? '{}').cost_unknown).toBeUndefined();
    });

    it('is idempotent: re-running does not duplicate open results', () => {
        insertCharge(db, {developerId: alice, tool: 'cursor', monthlyCost: 20});
        const first = reconcilePeriod(db, PERIOD);
        expect(first.created).toBe(1);

        const second = reconcilePeriod(db, PERIOD);
        expect(second.created).toBe(0);
        expect(second.skipped).toBe(1);
        expect(listReconciliationResults(db, {status: 'open'})).toHaveLength(1);
    });

    it('keeps an ignored condition suppressed on re-run', () => {
        insertCharge(db, {developerId: alice, tool: 'cursor', monthlyCost: 20});
        reconcilePeriod(db, PERIOD);
        const [result] = listReconciliationResults(db);
        ignoreReconciliationResult(db, result.id, 'known untracked tool');

        const second = reconcilePeriod(db, PERIOD);
        expect(second.created).toBe(0);
        expect(second.skipped).toBe(1);
        // Still exactly one row total — no new open duplicate.
        expect(listReconciliationResults(db, {status: 'all'})).toHaveLength(1);
    });

    it('re-opens a condition that recurs after being resolved', () => {
        insertCharge(db, {developerId: alice, tool: 'cursor', monthlyCost: 20});
        reconcilePeriod(db, PERIOD);
        const [result] = listReconciliationResults(db);
        resolveReconciliationResult(db, result.id, 'registered the seat');

        const second = reconcilePeriod(db, PERIOD);
        expect(second.created).toBe(1);
        expect(listReconciliationResults(db, {status: 'open'})).toHaveLength(1);
    });

    it('uses the default tolerance when none is provided', () => {
        insertSub(db, {developerId: alice, tool: 'copilot', monthlyCost: 19});
        insertCharge(db, {developerId: alice, tool: 'copilot', monthlyCost: 19 + DEFAULT_COST_TOLERANCE});
        // diff == tolerance → not beyond → not flagged.
        const summary = reconcilePeriod(db, PERIOD);
        expect(summary.byType.cost_discrepancy).toBe(0);
    });
});

describe('resolve / ignore workflow', () => {
    let db: Database.Database;
    let alice: string;

    beforeEach(() => {
        db = makeDb();
        addTeam(db, 'engineering');
        alice = addDeveloper(db, 'Alice', 'engineering', 'alice@example.com').id;
        insertCharge(db, {developerId: alice, tool: 'cursor', monthlyCost: 20});
        reconcilePeriod(db, PERIOD);
    });

    afterEach(() => db.close());

    it('resolve updates status and persists the note', () => {
        const [r] = listReconciliationResults(db);
        const updated = resolveReconciliationResult(db, r.id, '  registered the seat  ');
        expect(updated.status).toBe('resolved');
        expect(updated.resolution).toBe('registered the seat');
        expect(updated.resolved_at).not.toBeNull();

        const reloaded = getReconciliationResultById(db, r.id);
        expect(reloaded?.status).toBe('resolved');
        expect(reloaded?.resolution).toBe('registered the seat');
    });

    it('ignore updates status and persists the optional note', () => {
        const [r] = listReconciliationResults(db);
        const updated = ignoreReconciliationResult(db, r.id, 'expected');
        expect(updated.status).toBe('ignored');
        expect(updated.resolution).toBe('expected');
    });

    it('rejects resolving without a note', () => {
        const [r] = listReconciliationResults(db);
        expect(() => resolveReconciliationResult(db, r.id, '   ')).toThrow(/note is required/);
    });

    it('rejects resolving an unknown id', () => {
        expect(() => resolveReconciliationResult(db, 'nope', 'x')).toThrow(/No reconciliation result/);
    });

    it('rejects acting on an already-terminal result', () => {
        const [r] = listReconciliationResults(db);
        resolveReconciliationResult(db, r.id, 'done');
        expect(() => resolveReconciliationResult(db, r.id, 'again')).toThrow(/already resolved/);
        expect(() => ignoreReconciliationResult(db, r.id)).toThrow(/already resolved/);
    });

    it('list defaults to open and can filter by status', () => {
        const [r] = listReconciliationResults(db);
        resolveReconciliationResult(db, r.id, 'done');
        expect(listReconciliationResults(db, {status: 'open'})).toHaveLength(0);
        expect(listReconciliationResults(db, {status: 'resolved'})).toHaveLength(1);
        expect(listReconciliationResults(db, {status: 'all'})).toHaveLength(1);
    });
});

describe('latestExpensePeriod', () => {
    it('returns null with no charges and the max period otherwise', () => {
        const db = makeDb();
        addTeam(db, 'engineering');
        const alice = addDeveloper(db, 'Alice', 'engineering', 'alice@example.com').id;
        expect(latestExpensePeriod(db)).toBeNull();

        insertCharge(db, {developerId: alice, tool: 'cursor', monthlyCost: 20, period: '2026-04'});
        insertCharge(db, {developerId: alice, tool: 'cursor', monthlyCost: 20, period: '2026-06'});
        insertCharge(db, {developerId: alice, tool: 'cursor', monthlyCost: 20, period: '2026-05'});
        expect(latestExpensePeriod(db)).toBe('2026-06');
        db.close();
    });
});
