import fs from 'fs';
import Database from 'better-sqlite3';
import type {ExpensesConfig, SubscriptionDefaultsConfig, ColumnMappingConfig} from '../config/types';
import {upsertSubscription} from './subscription-tracker';

export interface ImportResult {
    imported: number;
    skipped: number;
    warnings: string[];
}

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
    expense: 'reimbursed',
    expensed: 'reimbursed',
    personal_reimbursement: 'reimbursed',
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

function normalizeBillingModel(value: string): string {
    const normalized = value.toLowerCase().replace(/[\s-]+/g, '_');
    if (VALID_BILLING_MODELS.has(normalized)) return normalized;
    return BILLING_MODEL_ALIASES[normalized] ?? 'unknown';
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

function buildFieldIndex(
    headers: string[],
    mapping: ColumnMappingConfig,
): Record<string, number> {
    const fieldIndex: Record<string, number> = {};
    const standardFields = [
        'developer_email',
        'tool',
        'plan',
        'monthly_cost',
        'billing_model',
    ] as const;

    for (const field of standardFields) {
        const csvColumnName = (mapping[field] ?? field).toLowerCase();
        const idx = headers.indexOf(csvColumnName);
        if (idx !== -1) {
            fieldIndex[field] = idx;
        }
    }

    return fieldIndex;
}

export function importCsv(
    db: Database.Database,
    filePath: string,
    expensesConfig: ExpensesConfig,
): ImportResult {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const nonEmptyLines = lines.filter((l) => l.trim().length > 0);

    if (nonEmptyLines.length === 0) {
        return {imported: 0, skipped: 0, warnings: ['CSV file is empty']};
    }

    const headers = parseCsvLine(nonEmptyLines[0]).map((h) => h.toLowerCase());
    const mapping = expensesConfig.column_mapping ?? {};
    const fieldIndex = buildFieldIndex(headers, mapping);

    if (fieldIndex['developer_email'] === undefined) {
        throw new Error(
            'CSV must have a developer_email column (or configure column_mapping.developer_email)',
        );
    }
    if (fieldIndex['tool'] === undefined) {
        throw new Error(
            'CSV must have a tool column (or configure column_mapping.tool)',
        );
    }

    const defaults = expensesConfig.subscription_defaults ?? {};
    const warnings: string[] = [];
    let imported = 0;
    let skipped = 0;

    const devsByEmail = new Map<string, {id: string; name: string}>();
    const devRows = db
        .prepare('SELECT id, name, email FROM developers WHERE email IS NOT NULL')
        .all() as {id: string; name: string; email: string}[];
    for (const row of devRows) {
        devsByEmail.set(row.email.toLowerCase(), {id: row.id, name: row.name});
    }

    // Track original line numbers — nonEmptyLines[0] is header, data starts at index 1
    // Map back to original line numbers using the full lines array
    let dataLineNum = 0;
    let originalLineNum = 0;

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().length === 0) continue;
        originalLineNum = i + 1;
        if (dataLineNum === 0) {
            dataLineNum++;
            continue; // skip header
        }
        dataLineNum++;

        const row = parseCsvLine(lines[i]);

        const email = (row[fieldIndex['developer_email']] ?? '').trim();
        const tool = (row[fieldIndex['tool']] ?? '').trim();

        if (!email || !tool) {
            warnings.push(
                `Line ${originalLineNum}: missing required field(s) (email='${email}', tool='${tool}'), skipping`,
            );
            skipped++;
            continue;
        }

        const dev = devsByEmail.get(email.toLowerCase());
        if (!dev) {
            warnings.push(
                `Line ${originalLineNum}: no developer with email '${email}' found, skipping`,
            );
            skipped++;
            continue;
        }

        const planRaw =
            fieldIndex['plan'] !== undefined ? (row[fieldIndex['plan']] ?? '').trim() : '';
        const plan = planRaw || null;

        let monthlyCost: number | null = null;
        if (fieldIndex['monthly_cost'] !== undefined) {
            const costStr = (row[fieldIndex['monthly_cost']] ?? '').trim();
            if (costStr) {
                const parsed = parseFloat(costStr.replace(/[$,]/g, ''));
                if (!isNaN(parsed)) {
                    monthlyCost = parsed;
                } else {
                    warnings.push(
                        `Line ${originalLineNum}: invalid monthly_cost '${costStr}', using default`,
                    );
                }
            }
        }

        if (monthlyCost === null) {
            monthlyCost = lookupDefaultCost(tool, plan ?? undefined, defaults);
        }

        let billingModel = 'unknown';
        if (fieldIndex['billing_model'] !== undefined) {
            const bmRaw = (row[fieldIndex['billing_model']] ?? '').trim();
            if (bmRaw) {
                billingModel = normalizeBillingModel(bmRaw);
            }
        }

        try {
            upsertSubscription(db, {
                developer_id: dev.id,
                tool,
                plan,
                billing_model: billingModel,
                monthly_cost: monthlyCost,
                data_source: 'expense_import',
            });
            imported++;
        } catch (err) {
            warnings.push(
                `Line ${originalLineNum}: failed to save subscription: ${err instanceof Error ? err.message : String(err)}`,
            );
            skipped++;
        }
    }

    return {imported, skipped, warnings};
}
