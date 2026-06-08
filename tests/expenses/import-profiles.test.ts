import {describe, it, expect} from 'vitest';
import {
    resolveProfile,
    classifyFrequency,
    listProfileNames,
    BUILTIN_PROFILES,
} from '../../src/expenses/import-profiles';
import type {ExpensesConfig} from '../../src/config/types';

describe('resolveProfile', () => {
    it('resolves each built-in profile', () => {
        for (const name of Object.keys(BUILTIN_PROFILES)) {
            const profile = resolveProfile(name, {});
            expect(profile.name).toBe(name);
            expect(profile.column_mapping.tool).toBeDefined();
        }
    });

    it('throws on an unknown profile name and lists available ones', () => {
        expect(() => resolveProfile('nope', {})).toThrow(/Unknown import profile/);
        expect(() => resolveProfile('nope', {})).toThrow(/standard/);
    });

    it('merges the legacy top-level column_mapping into the standard profile', () => {
        const config: ExpensesConfig = {column_mapping: {developer_email: 'email', tool: 'ai_tool'}};
        const profile = resolveProfile('standard', config);
        expect(profile.column_mapping.developer_email).toBe('email');
        expect(profile.column_mapping.tool).toBe('ai_tool');
    });

    it('lets a configured profile override a built-in field-by-field', () => {
        const config: ExpensesConfig = {
            import_profiles: {
                expensify: {column_mapping: {tool: 'vendor_name'}, default_billing_model: 'company_managed'},
            },
        };
        const profile = resolveProfile('expensify', config);
        expect(profile.column_mapping.tool).toBe('vendor_name');
        // Unspecified fields keep the built-in mapping.
        expect(profile.column_mapping.developer_email).toBe('email');
        expect(profile.default_billing_model).toBe('company_managed');
    });

    it('defines an entirely new profile from config', () => {
        const config: ExpensesConfig = {
            import_profiles: {acme: {column_mapping: {developer_email: 'mail', tool: 'product'}}},
        };
        const profile = resolveProfile('acme', config);
        expect(profile.name).toBe('acme');
        expect(profile.column_mapping.developer_email).toBe('mail');
        expect(listProfileNames(config)).toContain('acme');
    });

    it('is case-insensitive on the profile name', () => {
        expect(resolveProfile('EXPENSIFY', {}).name).toBe('expensify');
    });
});

describe('classifyFrequency', () => {
    it('classifies monthly spellings', () => {
        expect(classifyFrequency('monthly')).toBe('recurring_monthly');
        expect(classifyFrequency('per month')).toBe('recurring_monthly');
        expect(classifyFrequency('recurring')).toBe('recurring_monthly');
    });

    it('classifies annual spellings', () => {
        expect(classifyFrequency('annual')).toBe('recurring_annual');
        expect(classifyFrequency('Yearly')).toBe('recurring_annual');
        expect(classifyFrequency('per year')).toBe('recurring_annual');
    });

    it('classifies one-time spellings', () => {
        expect(classifyFrequency('one-time')).toBe('one_time');
        expect(classifyFrequency('one off')).toBe('one_time');
        expect(classifyFrequency('single')).toBe('one_time');
    });

    it('falls back to the profile default then recurring_monthly', () => {
        expect(classifyFrequency('', 'annual')).toBe('recurring_annual');
        expect(classifyFrequency(undefined)).toBe('recurring_monthly');
        expect(classifyFrequency('gibberish')).toBe('recurring_monthly');
    });
});
