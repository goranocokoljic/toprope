import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {runMigrations} from '../../src/storage/migrator';
import {addTeam} from '../../src/registry/teams';
import {addDeveloper} from '../../src/registry/developers';
import {importCsv} from '../../src/expenses/importer';
import {
    listUnmatchedCharges,
    resolveCharge,
    getChargeById,
} from '../../src/expenses/resolution-queue';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');
const FIXTURES_DIR = path.resolve(__dirname, '../fixtures/expenses');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function seedDevelopers(db: Database.Database): {alice: string; bob: string; jane: string} {
    addTeam(db, 'engineering');
    addTeam(db, 'backend');
    const alice = addDeveloper(db, 'Alice Smith', 'engineering', 'alice@example.com');
    const bob = addDeveloper(db, 'Bob Jones', 'backend', 'bob@example.com');
    const jane = addDeveloper(db, 'Jane Doe', 'engineering', 'jane@example.com');
    return {alice: alice.id, bob: bob.id, jane: jane.id};
}

function activeSub(
    db: Database.Database,
    developerId: string,
    tool: string,
): {plan: string | null; monthly_cost: number | null; billing_model: string; billing_model_inferred: number} | undefined {
    return db
        .prepare(
            'SELECT plan, monthly_cost, billing_model, billing_model_inferred FROM subscriptions WHERE developer_id = ? AND tool = ? AND seat_revoked_at IS NULL',
        )
        .get(developerId, tool) as
        | {plan: string | null; monthly_cost: number | null; billing_model: string; billing_model_inferred: number}
        | undefined;
}

describe('importCsv — import profiles (≥3 distinct)', () => {
    let db: Database.Database;
    let ids: {alice: string; bob: string; jane: string};

    beforeEach(() => {
        db = makeDb();
        ids = seedDevelopers(db);
    });
    afterEach(() => db.close());

    it('imports the standard profile by default', () => {
        const result = importCsv(db, path.join(FIXTURES_DIR, 'standard.csv'), {});
        expect(result.profile).toBe('standard');
        expect(result.imported).toBe(4);
        expect(result.matched).toBe(4);
    });

    it('imports the expensify profile (annual normalized to monthly, billing inferred)', () => {
        const result = importCsv(db, path.join(FIXTURES_DIR, 'expensify.csv'), {}, {profile: 'expensify'});
        expect(result.profile).toBe('expensify');
        expect(result.imported).toBe(2);
        expect(result.recurring).toBe(2);

        // alice cursor monthly 20
        const cursor = activeSub(db, ids.alice, 'cursor');
        expect(cursor?.monthly_cost).toBe(20);
        // bob copilot annual 228 → 19/mo, no billing column → inferred reimbursed
        const copilot = activeSub(db, ids.bob, 'copilot');
        expect(copilot?.monthly_cost).toBe(19);
        expect(copilot?.billing_model).toBe('reimbursed');
        expect(copilot?.billing_model_inferred).toBe(1);
        expect(result.inferredBillingModel).toBe(2);
    });

    it('imports the concur profile with spaced column names', () => {
        const result = importCsv(db, path.join(FIXTURES_DIR, 'concur.csv'), {}, {profile: 'concur'});
        expect(result.profile).toBe('concur');
        expect(result.imported).toBe(2);
        const windsurf = activeSub(db, ids.jane, 'windsurf');
        expect(windsurf?.monthly_cost).toBe(20);
        expect(windsurf?.billing_model).toBe('reimbursed'); // concur default, inferred
        expect(windsurf?.billing_model_inferred).toBe(1);
    });

    it('throws on an unknown profile', () => {
        expect(() => importCsv(db, path.join(FIXTURES_DIR, 'standard.csv'), {}, {profile: 'bogus'})).toThrow(
            /Unknown import profile/,
        );
    });
});

describe('importCsv — recurring vs one-time classification', () => {
    let db: Database.Database;
    let ids: {alice: string; bob: string; jane: string};

    beforeEach(() => {
        db = makeDb();
        ids = seedDevelopers(db);
    });
    afterEach(() => db.close());

    it('classifies monthly, annual, and one-time charges correctly', () => {
        const result = importCsv(db, path.join(FIXTURES_DIR, 'frequencies.csv'), {});
        expect(result.recurring).toBe(2);
        expect(result.oneTime).toBe(1);
        expect(result.imported).toBe(2); // one-time does not create a subscription
        expect(result.matched).toBe(3);

        // monthly: full amount
        expect(activeSub(db, ids.alice, 'cursor')?.monthly_cost).toBe(20);
        // annual: amount / 12 = 468 / 12 = 39
        expect(activeSub(db, ids.bob, 'copilot')?.monthly_cost).toBe(39);
        // one-time: no subscription opened
        expect(activeSub(db, ids.jane, 'claude_code')).toBeUndefined();

        // The one-time charge is still recorded in the ledger.
        const oneTime = db
            .prepare("SELECT charge_type FROM expense_charges WHERE tool = 'claude_code'")
            .get() as {charge_type: string};
        expect(oneTime.charge_type).toBe('one_time');
    });
});

describe('importCsv — duplicate detection', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        seedDevelopers(db);
    });
    afterEach(() => db.close());

    it('detects and skips a charge re-imported with the same dev+tool+period+amount', () => {
        const first = importCsv(db, path.join(FIXTURES_DIR, 'standard.csv'), {});
        expect(first.duplicates).toBe(0);
        expect(first.imported).toBe(4);

        const second = importCsv(db, path.join(FIXTURES_DIR, 'standard.csv'), {});
        expect(second.duplicates).toBe(4);
        expect(second.imported).toBe(0);
        expect(second.warnings.some((w) => w.includes('duplicate charge'))).toBe(true);

        // Still only one ledger row per unique charge.
        const ledgerCount = (
            db.prepare('SELECT COUNT(*) as n FROM expense_charges').get() as {n: number}
        ).n;
        expect(ledgerCount).toBe(4);
    });

    it('dedups matching charges across imports while accepting genuinely new ones', () => {
        // First import: alice has copilot business 19 (standard.csv).
        importCsv(db, path.join(FIXTURES_DIR, 'standard.csv'), {subscription_defaults: {}});
        // Re-import the same alice/copilot/19 charge (duplicate) plus a new one.
        const result = importCsvInline(
            db,
            'developer_email,tool,plan,monthly_cost,billing_model\n' +
                'alice@example.com,copilot,business,19,company_managed\n' +
                'alice@example.com,windsurf,pro,20,company_managed\n',
        );
        expect(result.duplicates).toBe(1); // copilot 19 already imported
        expect(result.imported).toBe(1); // windsurf 20 is new
    });

    it('does not warn about duplicates when there is nothing duplicated', () => {
        const result = importCsv(db, path.join(FIXTURES_DIR, 'standard.csv'), {});
        expect(result.duplicates).toBe(0);
        expect(result.warnings.some((w) => w.includes('no period column'))).toBe(false);
    });

    it('explains the no-period duplicate behavior on a re-import', () => {
        importCsv(db, path.join(FIXTURES_DIR, 'standard.csv'), {});
        const second = importCsv(db, path.join(FIXTURES_DIR, 'standard.csv'), {});
        expect(second.duplicates).toBe(4);
        expect(second.warnings.some((w) => w.includes('no period column'))).toBe(true);
    });
});

describe('importCsv — developer matching', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });
    afterEach(() => db.close());

    it('matches by a git commit email (multiple emails per developer)', () => {
        addTeam(db, 'engineering');
        const alice = addDeveloper(db, 'Alice Smith', 'engineering', 'alice@example.com', undefined, {
            gitEmails: ['alice.personal@gmail.com'],
        });
        // Import a row using the secondary (git) email.
        const result = importCsvInline(
            db,
            'developer_email,tool,plan,monthly_cost,billing_model\nalice.personal@gmail.com,copilot,business,19,company_managed\n',
        );
        expect(result.imported).toBe(1);
        expect(result.matched).toBe(1);
        const sub = activeSub(db, alice.id, 'copilot');
        expect(sub?.monthly_cost).toBe(19);
        const method = db
            .prepare('SELECT match_method FROM expense_charges LIMIT 1')
            .get() as {match_method: string};
        expect(method.match_method).toBe('git_email');
    });

    it('matches by name variant when there is no email column', () => {
        const ids = seedDevelopers(db);
        const result = importCsv(db, path.join(FIXTURES_DIR, 'name-variant.csv'), {});
        // "Doe, Jane" → Jane Doe; "Alice   Smith" → Alice Smith
        expect(result.matched).toBe(2);
        expect(result.imported).toBe(2);
        expect(activeSub(db, ids.jane, 'windsurf')?.monthly_cost).toBe(20);
        expect(activeSub(db, ids.alice, 'copilot')?.monthly_cost).toBe(19);
        const methods = db
            .prepare('SELECT DISTINCT match_method FROM expense_charges')
            .all() as {match_method: string}[];
        expect(methods.map((m) => m.match_method)).toContain('name');
    });
});

// Helper: write a CSV string to a temp file and import it with the standard profile.
function importCsvInline(db: Database.Database, csv: string): ReturnType<typeof importCsv> {
    const tmp = path.join(os.tmpdir(), `govproxy-richer-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
    fs.writeFileSync(tmp, csv);
    try {
        return importCsv(db, tmp, {subscription_defaults: {}});
    } finally {
        fs.unlinkSync(tmp);
    }
}

describe('importCsv — unmatched resolution queue', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        addTeam(db, 'engineering');
        // Only Alice exists.
        addDeveloper(db, 'Alice Smith', 'engineering', 'alice@example.com');
    });
    afterEach(() => db.close());

    it('queues unmatched rows instead of dropping them', () => {
        const result = importCsv(db, path.join(FIXTURES_DIR, 'standard.csv'), {});
        // alice matched; bob + jane (×2) unmatched.
        expect(result.matched).toBe(1);
        expect(result.unmatched).toBe(3);
        expect(result.warnings.some((w) => w.includes('queued for resolution'))).toBe(true);

        const queue = listUnmatchedCharges(db);
        expect(queue).toHaveLength(3);
        expect(queue.every((c) => c.developer_id === null)).toBe(true);
    });

    it('resolves a queued charge to a developer and opens its subscription', () => {
        importCsv(db, path.join(FIXTURES_DIR, 'standard.csv'), {});
        addTeam(db, 'backend');
        const bob = addDeveloper(db, 'Bob Jones', 'backend', 'bob@example.com');

        const queue = listUnmatchedCharges(db);
        const bobCharge = queue.find((c) => c.raw_email === 'bob@example.com' && c.tool === 'cursor');
        expect(bobCharge).toBeDefined();

        const res = resolveCharge(db, bobCharge!.id, bob.id);
        expect(res.subscriptionCreated).toBe(true);

        const sub = activeSub(db, bob.id, 'cursor');
        expect(sub?.monthly_cost).toBe(20);

        // The charge is now matched and out of the queue.
        const reloaded = getChargeById(db, bobCharge!.id);
        expect(reloaded?.match_status).toBe('matched');
        expect(reloaded?.resolved_at).not.toBeNull();
        expect(listUnmatchedCharges(db)).toHaveLength(2);
    });

    it('rejects resolving an unknown or already-resolved charge', () => {
        importCsv(db, path.join(FIXTURES_DIR, 'standard.csv'), {});
        addTeam(db, 'backend');
        const bob = addDeveloper(db, 'Bob Jones', 'backend', 'bob@example.com');

        expect(() => resolveCharge(db, 'no-such-id', bob.id)).toThrow(/No charge found/);

        const charge = listUnmatchedCharges(db)[0];
        resolveCharge(db, charge.id, bob.id);
        expect(() => resolveCharge(db, charge.id, bob.id)).toThrow(/already resolved/);
    });

    it('rejects resolving to a non-existent developer', () => {
        importCsv(db, path.join(FIXTURES_DIR, 'standard.csv'), {});
        const charge = listUnmatchedCharges(db)[0];
        expect(() => resolveCharge(db, charge.id, 'ghost-dev')).toThrow(/No developer found/);
    });
});

describe('importCsv — billing model inference flag', () => {
    let db: Database.Database;
    let ids: {alice: string; bob: string; jane: string};

    beforeEach(() => {
        db = makeDb();
        ids = seedDevelopers(db);
    });
    afterEach(() => db.close());

    it('marks explicit billing models as not inferred', () => {
        importCsv(db, path.join(FIXTURES_DIR, 'standard.csv'), {});
        const sub = activeSub(db, ids.alice, 'copilot');
        expect(sub?.billing_model).toBe('company_managed');
        expect(sub?.billing_model_inferred).toBe(0);
    });

    it('infers billing model from a profile default and flags it', () => {
        const result = importCsv(db, path.join(FIXTURES_DIR, 'expensify.csv'), {}, {profile: 'expensify'});
        expect(result.inferredBillingModel).toBe(2);
        expect(activeSub(db, ids.alice, 'cursor')?.billing_model_inferred).toBe(1);
    });

    it('flags an explicit-but-unrecognized billing model as inferred and warns', () => {
        const result = importCsvInline(
            db,
            'developer_email,tool,plan,monthly_cost,billing_model\n' +
                'alice@example.com,copilot,business,19,corp-card-2\n',
        );
        expect(result.inferredBillingModel).toBe(1);
        expect(result.warnings.some((w) => w.includes('unrecognized billing_model'))).toBe(true);
        const sub = activeSub(db, ids.alice, 'copilot');
        expect(sub?.billing_model).toBe('unknown');
        expect(sub?.billing_model_inferred).toBe(1);
    });
});
