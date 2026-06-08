import Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import type {ChargeType} from './import-profiles';
import {upsertSubscription} from './subscription-tracker';

// One row of the expense_charges ledger (Task 4.5). The importer appends a row
// per unique charge; this module reads the queue and resolves unmatched rows.
export interface ExpenseCharge {
    id: string;
    dedup_key: string;
    developer_id: string | null;
    raw_email: string | null;
    raw_name: string | null;
    tool: string;
    plan: string | null;
    amount: number | null;
    currency: string | null;
    period: string | null;
    charge_type: ChargeType;
    monthly_cost: number | null;
    billing_model: string;
    billing_model_inferred: number;
    match_status: 'matched' | 'unmatched';
    match_method: string | null;
    source_profile: string;
    source_file: string | null;
    resolved_at: string | null;
    created_at: string;
}

// What the importer hands to the ledger for a single unique charge.
export interface NewCharge {
    dedup_key: string;
    developer_id: string | null;
    raw_email: string | null;
    raw_name: string | null;
    tool: string;
    plan: string | null;
    amount: number | null;
    currency: string | null;
    period: string | null;
    charge_type: ChargeType;
    monthly_cost: number | null;
    billing_model: string;
    billing_model_inferred: boolean;
    match_status: 'matched' | 'unmatched';
    match_method: string | null;
    source_profile: string;
    source_file: string | null;
}

/** True when a charge with this dedup_key already exists in the ledger. */
export function chargeExists(db: Database.Database, dedupKey: string): boolean {
    const row = db
        .prepare('SELECT 1 FROM expense_charges WHERE dedup_key = ? LIMIT 1')
        .get(dedupKey);
    return row !== undefined;
}

/** Append a charge to the ledger. Returns the generated charge id. */
export function insertCharge(db: Database.Database, charge: NewCharge): string {
    const id = randomUUID();
    db.prepare(
        `INSERT INTO expense_charges
           (id, dedup_key, developer_id, raw_email, raw_name, tool, plan, amount, currency,
            period, charge_type, monthly_cost, billing_model, billing_model_inferred,
            match_status, match_method, source_profile, source_file, resolved_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
        id,
        charge.dedup_key,
        charge.developer_id,
        charge.raw_email,
        charge.raw_name,
        charge.tool,
        charge.plan,
        charge.amount,
        charge.currency,
        charge.period,
        charge.charge_type,
        charge.monthly_cost,
        charge.billing_model,
        charge.billing_model_inferred ? 1 : 0,
        charge.match_status,
        charge.match_method,
        charge.source_profile,
        charge.source_file,
        new Date().toISOString(),
    );
    return id;
}

/**
 * Unmatched charges awaiting manual resolution, oldest first. These are rows
 * whose developer could not be matched during import — kept here rather than
 * dropped, so cost data stays complete.
 */
export function listUnmatchedCharges(db: Database.Database): ExpenseCharge[] {
    return db
        .prepare(
            `SELECT * FROM expense_charges
             WHERE match_status = 'unmatched' AND resolved_at IS NULL
             ORDER BY created_at, id`,
        )
        .all() as ExpenseCharge[];
}

export function getChargeById(db: Database.Database, id: string): ExpenseCharge | null {
    const row = db.prepare('SELECT * FROM expense_charges WHERE id = ?').get(id) as
        | ExpenseCharge
        | undefined;
    return row ?? null;
}

export interface ResolveResult {
    charge: ExpenseCharge;
    subscriptionCreated: boolean;
}

/**
 * Resolve a queued unmatched charge by assigning it to a developer. Marks the
 * ledger row matched (method = manual) and, for a recurring charge, creates/updates
 * the developer's subscription from the stored charge data. A one-time charge is
 * recorded as resolved but does not open a subscription.
 *
 * Throws when the charge is unknown, already resolved, or already matched, so a
 * bad id or double-resolve fails loudly rather than silently re-attributing cost.
 */
export function resolveCharge(
    db: Database.Database,
    chargeId: string,
    developerId: string,
): ResolveResult {
    return db.transaction((): ResolveResult => {
        const charge = getChargeById(db, chargeId);
        if (!charge) {
            throw new Error(`No charge found with id '${chargeId}'.`);
        }
        if (charge.resolved_at !== null || charge.match_status === 'matched') {
            throw new Error(`Charge '${chargeId}' is already resolved.`);
        }

        const dev = db
            .prepare('SELECT id FROM developers WHERE id = ?')
            .get(developerId) as {id: string} | undefined;
        if (!dev) {
            throw new Error(`No developer found with id '${developerId}'.`);
        }

        const now = new Date().toISOString();
        db.prepare(
            `UPDATE expense_charges
             SET developer_id = ?, match_status = 'matched', match_method = 'manual', resolved_at = ?
             WHERE id = ?`,
        ).run(developerId, now, chargeId);

        let subscriptionCreated = false;
        if (charge.charge_type !== 'one_time') {
            upsertSubscription(db, {
                developer_id: developerId,
                tool: charge.tool,
                plan: charge.plan,
                billing_model: charge.billing_model,
                billing_model_inferred: charge.billing_model_inferred === 1,
                monthly_cost: charge.monthly_cost,
                data_source: 'expense_import',
            });
            subscriptionCreated = true;
        }

        return {
            charge: {...charge, developer_id: developerId, match_status: 'matched', match_method: 'manual', resolved_at: now},
            subscriptionCreated,
        };
    })();
}
