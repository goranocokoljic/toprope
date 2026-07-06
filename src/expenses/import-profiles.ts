import type {ColumnMappingConfig, ExpensesConfig} from '../config/types';

// A fully-resolved import profile the importer works against. Unlike the config
// shape, column_mapping is always present (possibly empty) and the profile has a
// name for reporting/dedup provenance.
export interface ImportProfile {
    name: string;
    column_mapping: ColumnMappingConfig;
    default_billing_model?: string;
    default_frequency?: string;
}

// How a charge recurs — drives whether (and how) it becomes a subscription.
export type ChargeType = 'recurring_monthly' | 'recurring_annual' | 'one_time';

// Built-in profiles so three distinct expense systems import out-of-the-box with
// no config. Config `import_profiles` can override these or add new ones.
//
// - standard: Toprope's own canonical columns (the Phase 1 format).
// - expensify: a typical Expensify report export. Reimbursement system → charges
//   default to `reimbursed` when the row carries no explicit billing model.
// - concur: a typical SAP Concur export. Also a reimbursement system.
export const BUILTIN_PROFILES: Record<string, ImportProfile> = {
    // The canonical Toprope format: every column already uses the standard field
    // name, so an empty mapping is correct — buildFieldIndex falls back to the
    // field's own name when it isn't remapped. The legacy top-level
    // `expenses.column_mapping` is layered over this in resolveProfile.
    standard: {
        name: 'standard',
        column_mapping: {},
    },
    expensify: {
        name: 'expensify',
        column_mapping: {
            developer_email: 'email',
            developer_name: 'employee',
            tool: 'merchant',
            plan: 'category',
            amount: 'amount',
            frequency: 'frequency',
            period: 'date',
        },
        default_billing_model: 'reimbursed',
    },
    concur: {
        name: 'concur',
        column_mapping: {
            developer_email: 'employee email',
            developer_name: 'employee name',
            tool: 'vendor',
            plan: 'expense type',
            amount: 'approved amount',
            frequency: 'frequency',
            period: 'transaction date',
        },
        default_billing_model: 'reimbursed',
    },
};

/**
 * Resolve a profile by name, layering config over the built-ins:
 *
 * - The legacy top-level `column_mapping` is merged into the `standard` profile's
 *   mapping (back-compat: existing configs keep working with no `--profile`).
 * - `import_profiles[name]` overrides a built-in of the same name field-by-field,
 *   or defines an entirely new profile.
 *
 * Throws when `name` matches neither a built-in nor a configured profile, so a
 * typo'd `--profile` fails loudly instead of silently importing nothing.
 */
export function resolveProfile(name: string, config: ExpensesConfig): ImportProfile {
    const key = name.trim().toLowerCase();
    const builtin = BUILTIN_PROFILES[key];
    const configured = config.import_profiles?.[key];

    if (!builtin && !configured) {
        const available = listProfileNames(config).join(', ');
        throw new Error(`Unknown import profile '${name}'. Available profiles: ${available}.`);
    }

    let columnMapping: ColumnMappingConfig = {...(builtin?.column_mapping ?? {})};
    let defaultBillingModel = builtin?.default_billing_model;
    let defaultFrequency = builtin?.default_frequency;

    // The legacy single mapping customizes the standard profile.
    if (key === 'standard' && config.column_mapping) {
        columnMapping = {...columnMapping, ...config.column_mapping};
    }

    if (configured) {
        if (configured.column_mapping) {
            columnMapping = {...columnMapping, ...configured.column_mapping};
        }
        if (configured.default_billing_model !== undefined) {
            defaultBillingModel = configured.default_billing_model;
        }
        if (configured.default_frequency !== undefined) {
            defaultFrequency = configured.default_frequency;
        }
    }

    return {name: key, column_mapping: columnMapping, default_billing_model: defaultBillingModel, default_frequency: defaultFrequency};
}

/** All profile names known for the given config (built-ins + configured), deduped. */
export function listProfileNames(config: ExpensesConfig): string[] {
    const names = new Set<string>(Object.keys(BUILTIN_PROFILES));
    for (const k of Object.keys(config.import_profiles ?? {})) {
        names.add(k.toLowerCase());
    }
    return [...names].sort();
}

/**
 * Classify a charge frequency string into a ChargeType. Recognizes common
 * monthly / annual / one-time spellings; falls back to the provided default
 * (then recurring_monthly) when blank or unrecognized — most SaaS expense lines
 * are monthly subscriptions.
 */
export function classifyFrequency(raw: string | undefined, profileDefault?: string): ChargeType {
    const value = (raw ?? '').trim().toLowerCase();
    const resolved = value || (profileDefault ?? '').trim().toLowerCase();
    if (!resolved) return 'recurring_monthly';

    if (/(one[\s_-]?time|one[\s_-]?off|once|single|setup)/.test(resolved)) return 'one_time';
    if (/(annual|annually|yearly|year|\/yr|per year)/.test(resolved)) return 'recurring_annual';
    if (/(monthly|month|recurring|\/mo|per month)/.test(resolved)) return 'recurring_monthly';
    return 'recurring_monthly';
}
