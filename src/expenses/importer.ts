import fs from 'fs';
import Database from 'better-sqlite3';
import type {ExpensesConfig, SubscriptionDefaultsConfig, ColumnMappingConfig} from '../config/types';
import {upsertSubscription} from './subscription-tracker';
import {listDevelopers} from '../registry/developers';
import {
    resolveProfile,
    classifyFrequency,
    type ImportProfile,
    type ChargeType,
} from './import-profiles';
import {chargeExists, insertCharge} from './resolution-queue';

export interface ImportResult {
    // Subscriptions written (matched + recurring + not a duplicate).
    imported: number;
    // Rows not turned into a subscription: errors + unmatched + duplicates + one-time.
    skipped: number;
    // Rows matched to a developer (excludes duplicates).
    matched: number;
    // Rows queued for manual resolution because no developer matched.
    unmatched: number;
    // Charges already seen (developer+tool+period+amount) and skipped.
    duplicates: number;
    // Charge classification counts (excludes duplicates).
    recurring: number;
    oneTime: number;
    // Rows whose billing model was inferred rather than read explicitly.
    inferredBillingModel: number;
    // Profile used for the import.
    profile: string;
    warnings: string[];
}

const STANDARD_FIELDS = [
    'developer_email',
    'developer_name',
    'tool',
    'plan',
    'monthly_cost',
    'amount',
    'billing_model',
    'frequency',
    'period',
] as const;

type StandardField = (typeof STANDARD_FIELDS)[number];

const VALID_BILLING_MODELS = new Set([
    'company_managed',
    'reimbursed',
    'personal',
    'unknown',
]);

const BILLING_MODEL_ALIASES: Record<string, string> = {
    company: 'company_managed',
    employer: 'company_managed',
    employer_paid: 'company_managed',
    corporate: 'company_managed',
    corporate_card: 'company_managed',
    expense: 'reimbursed',
    expensed: 'reimbursed',
    personal_reimbursement: 'reimbursed',
    personal_card: 'reimbursed',
    reimbursement: 'reimbursed',
};

export function parseCsvLine(line: string): string[] {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (ch === ',' && !inQuotes) {
            fields.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    fields.push(current.trim());
    return fields;
}

/** Normalize a billing model to a canonical value, or null if unrecognized. */
function normalizeBillingModel(value: string): string | null {
    const normalized = value.toLowerCase().replace(/[\s-]+/g, '_');
    if (VALID_BILLING_MODELS.has(normalized)) return normalized;
    return BILLING_MODEL_ALIASES[normalized] ?? null;
}

/**
 * Normalize a developer name for variant matching: lowercased, whitespace
 * collapsed, and "Last, First" reordered to "First Last". This lets an expense
 * row that spells the name differently (extra spaces, comma-reversed) still match
 * a registered developer without exact-string equality.
 */
function normalizeName(value: string): string {
    let v = value.trim().toLowerCase();
    const comma = v.indexOf(',');
    if (comma !== -1) {
        const last = v.slice(0, comma).trim();
        const first = v.slice(comma + 1).trim();
        if (first && last) v = `${first} ${last}`;
    }
    return v.replace(/\s+/g, ' ').trim();
}

function lookupDefaultCost(
    tool: string,
    plan: string | undefined,
    defaults: SubscriptionDefaultsConfig,
): number | null {
    if (!plan) return null;
    const key = `${tool}_${plan}` as keyof SubscriptionDefaultsConfig;
    return defaults[key] ?? null;
}

/**
 * Map each standard field to its column index in the CSV header, using the
 * profile's column_mapping (falling back to the field's own name). Only fields
 * whose mapped column is actually present in the header get an index.
 */
function buildFieldIndex(
    headers: string[],
    mapping: ColumnMappingConfig,
): Partial<Record<StandardField, number>> {
    const fieldIndex: Partial<Record<StandardField, number>> = {};
    for (const field of STANDARD_FIELDS) {
        const csvColumnName = (mapping[field] ?? field).toLowerCase();
        const idx = headers.indexOf(csvColumnName);
        if (idx !== -1) {
            fieldIndex[field] = idx;
        }
    }
    return fieldIndex;
}

interface MatchTarget {
    id: string;
    name: string;
}

interface DeveloperMatcher {
    match(email: string, name: string): {dev: MatchTarget; method: string} | null;
}

/**
 * Build an in-memory matcher over the registry, loaded once per import. Matching
 * order is: primary email → git commit email → name variant. A name that maps to
 * more than one developer is treated as ambiguous and not matched (we never guess
 * which person a shared name belongs to).
 */
function buildMatcher(db: Database.Database): DeveloperMatcher {
    const primaryEmail = new Map<string, MatchTarget>();
    const gitEmail = new Map<string, MatchTarget>();
    const byName = new Map<string, MatchTarget | null>(); // null = ambiguous

    for (const dev of listDevelopers(db)) {
        const target: MatchTarget = {id: dev.id, name: dev.name};
        if (dev.email) {
            primaryEmail.set(dev.email.trim().toLowerCase(), target);
        }
        const gitEmails = dev.external_ids.git_emails;
        if (gitEmails) {
            for (const e of gitEmails.split(',')) {
                const trimmed = e.trim().toLowerCase();
                if (trimmed) gitEmail.set(trimmed, target);
            }
        }
        const normName = normalizeName(dev.name);
        if (normName) {
            byName.set(normName, byName.has(normName) ? null : target);
        }
    }

    return {
        match(email: string, name: string): {dev: MatchTarget; method: string} | null {
            const e = email.trim().toLowerCase();
            if (e) {
                const primary = primaryEmail.get(e);
                if (primary) return {dev: primary, method: 'email'};
                const git = gitEmail.get(e);
                if (git) return {dev: git, method: 'git_email'};
            }
            const n = normalizeName(name);
            if (n) {
                const byNameHit = byName.get(n);
                if (byNameHit) return {dev: byNameHit, method: 'name'};
            }
            return null;
        },
    };
}

/**
 * Parse a money string ("$1,234.50") to a non-negative number, or null if not
 * parseable or negative. Negative values (refunds/credits) are rejected rather
 * than opening a subscription with a negative monthly cost — the caller decides
 * how to surface that. Only `$` and thousands `,` are stripped; locale formats
 * that use `,` as the decimal separator are not supported.
 */
function parseMoney(raw: string): number | null {
    const cleaned = raw.replace(/[$,]/g, '').trim();
    if (!cleaned) return null;
    const parsed = parseFloat(cleaned);
    if (isNaN(parsed) || parsed < 0) return null;
    return parsed;
}

/**
 * Normalize a period/charge-date cell into a dedup-stable key. A date collapses
 * to its YYYY-MM month — so the same monthly charge keys identically regardless
 * of which day it posted. Both ISO (YYYY-MM-DD) and US (MM/DD/YYYY) formats are
 * recognized, since the built-in vendor profiles map a transaction-date column
 * straight into the period. Anything else is used trimmed/lowercased as-is.
 * Empty when no period column is mapped/present.
 */
function normalizePeriod(raw: string): string {
    const v = raw.trim();
    const iso = /^(\d{4})-(\d{2})-\d{2}/.exec(v);
    if (iso) return `${iso[1]}-${iso[2]}`;
    const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v);
    if (us) return `${us[3]}-${us[1].padStart(2, '0')}`;
    return v.toLowerCase();
}

interface BillingDecision {
    model: string;
    inferred: boolean;
    // True when an explicit cell value was present but did not map to a known
    // billing model — so the caller can warn that the value was dropped to unknown.
    unrecognized: boolean;
}

/**
 * Determine a charge's billing model:
 * - An explicit cell that maps to a known model is authoritative (inferred = false).
 * - An explicit cell that does NOT map (e.g. "corp-card-2") is neither known nor a
 *   deliberate inference — it becomes 'unknown', flagged inferred = true AND
 *   unrecognized = true so the caller can surface that the value was dropped.
 * - No explicit cell → inferred from the profile's default_billing_model (or
 *   'unknown' when there is nothing to go on); inferred = true.
 */
function decideBillingModel(rawBillingModel: string | undefined, profile: ImportProfile): BillingDecision {
    if (rawBillingModel !== undefined && rawBillingModel.trim()) {
        const normalized = normalizeBillingModel(rawBillingModel);
        if (normalized) return {model: normalized, inferred: false, unrecognized: false};
        return {model: 'unknown', inferred: true, unrecognized: true};
    }
    if (profile.default_billing_model && profile.default_billing_model.trim()) {
        return {
            model: normalizeBillingModel(profile.default_billing_model) ?? 'unknown',
            inferred: true,
            unrecognized: false,
        };
    }
    return {model: 'unknown', inferred: true, unrecognized: false};
}

/** Monthly cost for a recurring charge given its explicit cost/amount and type. */
function deriveMonthlyCost(
    chargeType: ChargeType,
    explicitMonthly: number | null,
    amount: number | null,
): number | null {
    if (chargeType === 'one_time') return null;
    if (explicitMonthly !== null) return explicitMonthly;
    if (amount === null) return null;
    return chargeType === 'recurring_annual' ? amount / 12 : amount;
}

export interface ImportOptions {
    // Named import profile to use (built-in: standard | expensify | concur, plus
    // any configured). Defaults to 'standard'.
    profile?: string;
}

export function importCsv(
    db: Database.Database,
    filePath: string,
    expensesConfig: ExpensesConfig,
    options: ImportOptions = {},
): ImportResult {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    const profile = resolveProfile(options.profile ?? 'standard', expensesConfig);

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const nonEmptyLines = lines.filter((l) => l.trim().length > 0);

    const result: ImportResult = {
        imported: 0,
        skipped: 0,
        matched: 0,
        unmatched: 0,
        duplicates: 0,
        recurring: 0,
        oneTime: 0,
        inferredBillingModel: 0,
        profile: profile.name,
        warnings: [],
    };

    if (nonEmptyLines.length === 0) {
        result.warnings.push('CSV file is empty');
        return result;
    }

    const headers = parseCsvLine(nonEmptyLines[0]).map((h) => h.toLowerCase());
    const fieldIndex = buildFieldIndex(headers, profile.column_mapping);

    if (fieldIndex.developer_email === undefined && fieldIndex.developer_name === undefined) {
        throw new Error(
            `CSV must have a developer_email or developer_name column for profile '${profile.name}' ` +
                '(or configure the profile\'s column_mapping).',
        );
    }
    if (fieldIndex.tool === undefined) {
        throw new Error(
            `CSV must have a tool column for profile '${profile.name}' ` +
                '(or configure the profile\'s column_mapping).',
        );
    }

    const defaults = expensesConfig.subscription_defaults ?? {};
    const matcher = buildMatcher(db);

    const cell = (row: string[], field: StandardField): string => {
        const idx = fieldIndex[field];
        return idx !== undefined ? (row[idx] ?? '').trim() : '';
    };

    // Wrap the whole import in one transaction so dedup sees this run's own
    // inserts and the import is atomic.
    db.transaction(() => {
        let dataLineNum = 0;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim().length === 0) continue;
            const originalLineNum = i + 1;
            if (dataLineNum === 0) {
                dataLineNum++;
                continue; // header
            }
            dataLineNum++;

            const row = parseCsvLine(lines[i]);
            const email = cell(row, 'developer_email');
            const name = cell(row, 'developer_name');
            const tool = cell(row, 'tool');

            if (!tool || (!email && !name)) {
                result.warnings.push(
                    `Line ${originalLineNum}: missing required field(s) ` +
                        `(developer='${email || name}', tool='${tool}'), skipping`,
                );
                result.skipped++;
                continue;
            }

            const plan = cell(row, 'plan') || null;
            const period = normalizePeriod(cell(row, 'period'));
            const chargeType = classifyFrequency(cell(row, 'frequency'), profile.default_frequency);

            // Raw amount (charge ledger / dedup) and explicit monthly cost.
            const amount = fieldIndex.amount !== undefined ? parseMoney(cell(row, 'amount')) : null;
            let explicitMonthly: number | null = null;
            if (fieldIndex.monthly_cost !== undefined) {
                const costStr = cell(row, 'monthly_cost');
                if (costStr) {
                    explicitMonthly = parseMoney(costStr);
                    if (explicitMonthly === null) {
                        result.warnings.push(
                            `Line ${originalLineNum}: invalid monthly_cost '${costStr}', ignoring`,
                        );
                    }
                }
            }

            let monthlyCost = deriveMonthlyCost(chargeType, explicitMonthly, amount);
            if (monthlyCost === null && chargeType !== 'one_time') {
                monthlyCost = lookupDefaultCost(tool, plan ?? undefined, defaults);
            }

            const billing = decideBillingModel(
                fieldIndex.billing_model !== undefined ? cell(row, 'billing_model') : undefined,
                profile,
            );
            if (billing.unrecognized) {
                result.warnings.push(
                    `Line ${originalLineNum}: unrecognized billing_model '${cell(row, 'billing_model')}' ` +
                        '— stored as unknown (inferred)',
                );
            }

            const matchResult = matcher.match(email, name);

            // Dedup key: raw row identity + tool + period + amount. Keyed on the
            // RAW email/name as it appears in the row (not the matched developer
            // id) so the key is stable whether or not the row matched — otherwise
            // a charge imported while unmatched, then re-imported after the
            // developer is registered, would key differently and double-count.
            //
            // NOTE: one-time charges have monthly_cost = null, and a source with
            // no amount column has amount = null, so amountForKey is empty. Two
            // distinct amount-less one-time charges for the same dev+tool+period
            // therefore collapse to one key and the second is treated as a
            // duplicate. This is an accepted limitation — without an amount or a
            // finer period there is nothing to tell them apart.
            const amountForKey = amount ?? monthlyCost;
            const devKey = email
                ? `email:${email.toLowerCase()}`
                : `name:${normalizeName(name)}`;
            const dedupKey = `${devKey}|${tool.toLowerCase()}|${period}|${amountForKey ?? ''}`;

            if (chargeExists(db, dedupKey)) {
                result.warnings.push(
                    `Line ${originalLineNum}: duplicate charge (${tool}` +
                        `${period ? `, ${period}` : ''}${amountForKey != null ? `, ${amountForKey}` : ''}), skipping`,
                );
                result.duplicates++;
                result.skipped++;
                continue;
            }

            insertCharge(db, {
                dedup_key: dedupKey,
                developer_id: matchResult ? matchResult.dev.id : null,
                raw_email: email || null,
                raw_name: name || null,
                tool,
                plan,
                amount,
                period: period || null,
                charge_type: chargeType,
                monthly_cost: monthlyCost,
                billing_model: billing.model,
                billing_model_inferred: billing.inferred,
                match_status: matchResult ? 'matched' : 'unmatched',
                match_method: matchResult ? matchResult.method : null,
                source_profile: profile.name,
                source_file: filePath,
            });

            if (billing.inferred) result.inferredBillingModel++;
            if (chargeType === 'one_time') result.oneTime++;
            else result.recurring++;

            if (!matchResult) {
                result.warnings.push(
                    `Line ${originalLineNum}: no developer matches ` +
                        `'${email || name}' — queued for resolution`,
                );
                result.unmatched++;
                result.skipped++;
                continue;
            }

            result.matched++;

            // Name-only matches are lower confidence than an email match (two
            // people can share a display name). Surface it so the attribution can
            // be verified — the ambiguous case is already refused by the matcher.
            if (matchResult.method === 'name') {
                result.warnings.push(
                    `Line ${originalLineNum}: matched '${name}' to developer by name — verify attribution`,
                );
            }

            // One-time charges are recorded in the ledger but do not open a
            // recurring subscription.
            if (chargeType === 'one_time') {
                result.skipped++;
                continue;
            }

            // A recurring charge with no resolvable cost opens a seat that
            // contributes $0 to cost-over-time — flag it rather than let it slip
            // in silently.
            if (monthlyCost === null) {
                result.warnings.push(
                    `Line ${originalLineNum}: recurring ${tool} charge has no resolvable cost ` +
                        '(no amount/monthly_cost/default) — subscription created with no cost',
                );
            }

            try {
                upsertSubscription(db, {
                    developer_id: matchResult.dev.id,
                    tool,
                    plan,
                    billing_model: billing.model,
                    billing_model_inferred: billing.inferred,
                    monthly_cost: monthlyCost,
                    data_source: 'expense_import',
                });
                result.imported++;
            } catch (err) {
                result.warnings.push(
                    `Line ${originalLineNum}: failed to save subscription: ${err instanceof Error ? err.message : String(err)}`,
                );
                result.skipped++;
            }
        }
    })();

    // Without a period column the dedup key collapses to developer+tool+amount, so
    // a re-import of unchanged rows looks identical to the first import and every
    // row is reported as a duplicate. This is safe (the subscription upsert is
    // idempotent) but surprising — explain it, but only when it actually bit.
    if (result.duplicates > 0 && fieldIndex.period === undefined) {
        result.warnings.push(
            `Profile '${profile.name}' has no period column, so re-imported rows can't be ` +
                'distinguished from new monthly charges and are treated as duplicates. ' +
                'Map a period/date column to track recurring charges by month.',
        );
    }

    return result;
}
