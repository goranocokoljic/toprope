import {describe, it, expect} from 'vitest';
import {
    buildSummaryInput,
    deriveDataBasis,
    formatSummaryInput,
    collectStringValues,
    assertNumbersOnly,
    type AggregateMetrics,
    type SummaryInputPayload,
} from '../../src/summaries/input-builder';

function metrics(overrides: Partial<AggregateMetrics> = {}): AggregateMetrics {
    return {
        developer_count: 6,
        active_developer_count: 5,
        total_commits: 142,
        total_prs_merged: 23,
        avg_code_churn: 0.11,
        avg_ai_signature_score: 68,
        subscription_cost: 180,
        cost_per_pr: 7.83,
        ai_maturity_score: 56,
        ai_maturity_basis: 'git_estimate',
        data_quality: 'medium',
        ...overrides,
    };
}

describe('deriveDataBasis', () => {
    it('states git-only basis at launch (git_estimate)', () => {
        expect(deriveDataBasis('git_estimate')).toBe('git analysis + expense data; no direct tool usage');
    });

    it('states mixed and measured bases', () => {
        expect(deriveDataBasis('mixed')).toContain('partial direct tool usage');
        expect(deriveDataBasis('measured')).toContain('direct tool usage');
    });
});

describe('buildSummaryInput', () => {
    const base = {
        level: 'weekly' as const,
        periodLabel: '2026-W21',
        start: '2026-05-19',
        end: '2026-05-25',
        scope: {type: 'team' as const, name: 'backend'},
    };

    it('assembles the payload from current metrics and scope', () => {
        const payload = buildSummaryInput({...base, current: metrics(), prior: null});
        expect(payload.period).toEqual({level: 'weekly', label: '2026-W21', start: '2026-05-19', end: '2026-05-25'});
        expect(payload.scope).toEqual({type: 'team', name: 'backend', developer_count: 6, active_developer_count: 5});
        expect(payload.metrics.total_commits).toBe(142);
        expect(payload.metrics.ai_maturity_basis).toBe('git_estimate');
    });

    it('sets the data_basis from the maturity basis (tier)', () => {
        const git = buildSummaryInput({...base, current: metrics({ai_maturity_basis: 'git_estimate'}), prior: null});
        expect(git.data_basis).toBe('git analysis + expense data; no direct tool usage');
        const mixed = buildSummaryInput({...base, current: metrics({ai_maturity_basis: 'mixed'}), prior: null});
        expect(mixed.data_basis).toContain('partial direct tool usage');
    });

    it('marks the first period and nulls all deltas when there is no prior', () => {
        const payload = buildSummaryInput({...base, current: metrics(), prior: null});
        expect(payload.is_first_period).toBe(true);
        expect(payload.deltas).toEqual({
            commit_velocity_delta_pct: null,
            prs_merged_delta_pct: null,
            churn_rate_delta: null,
            ai_signature_delta: null,
            cost_per_pr_delta_pct: null,
            maturity_score_delta: null,
        });
    });

    it('computes deltas against the prior period', () => {
        const prior = metrics({
            total_commits: 120,
            total_prs_merged: 20,
            avg_code_churn: 0.14,
            avg_ai_signature_score: 64,
            cost_per_pr: 9.0,
            ai_maturity_score: 52,
        });
        const payload = buildSummaryInput({...base, current: metrics(), prior});
        expect(payload.is_first_period).toBe(false);
        // (142-120)/120*100 = 18.33
        expect(payload.deltas.commit_velocity_delta_pct).toBeCloseTo(18.33, 1);
        // (23-20)/20*100 = 15
        expect(payload.deltas.prs_merged_delta_pct).toBe(15);
        // churn points: 0.11 - 0.14 = -0.03
        expect(payload.deltas.churn_rate_delta).toBeCloseTo(-0.03, 4);
        // signature points: 68 - 64 = 4
        expect(payload.deltas.ai_signature_delta).toBe(4);
        // maturity points: 56 - 52 = 4
        expect(payload.deltas.maturity_score_delta).toBe(4);
    });

    it('defaults the benchmark to nulls when none is provided', () => {
        const payload = buildSummaryInput({...base, current: metrics(), prior: null});
        expect(payload.benchmark).toEqual({org_avg_cost_per_pr: null, org_avg_maturity_score: null});
    });

    it('carries the supplied benchmark context', () => {
        const payload = buildSummaryInput({
            ...base,
            current: metrics(),
            prior: null,
            benchmark: {org_avg_cost_per_pr: 8.5, org_avg_maturity_score: 50},
        });
        expect(payload.benchmark).toEqual({org_avg_cost_per_pr: 8.5, org_avg_maturity_score: 50});
    });
});

describe('privacy — numbers-only payload', () => {
    const payload: SummaryInputPayload = buildSummaryInput({
        level: 'monthly',
        periodLabel: '2026-05',
        start: '2026-05-01',
        end: '2026-05-31',
        scope: {type: 'org', name: 'org'},
        current: metrics(),
        prior: metrics({total_commits: 100}),
        benchmark: {org_avg_cost_per_pr: 8.5, org_avg_maturity_score: 50},
    });

    it('contains only controlled label strings — no code, commit, or repo free text', () => {
        const strings = collectStringValues(payload);
        // Every string value is one of the controlled labels/enums.
        const allowed = new Set<string>([
            'monthly',
            '2026-05',
            '2026-05-01',
            '2026-05-31',
            'org', // scope.type and scope.name
            'git_estimate',
            'git analysis + expense data; no direct tool usage',
            'medium',
        ]);
        for (const s of strings) {
            expect(allowed.has(s)).toBe(true);
        }
    });

    it('assertNumbersOnly passes for a normal payload', () => {
        expect(() => assertNumbersOnly(payload)).not.toThrow();
    });

    it('assertNumbersOnly throws if code-like content is injected (defensive gate)', () => {
        const tampered = {
            ...payload,
            scope: {...payload.scope, name: 'function leak() { return secret; }'},
        };
        expect(() => assertNumbersOnly(tampered)).toThrow(/forbidden code-like content/);
    });

    it('detects a leaked commit message containing a comment marker', () => {
        const tampered = {...payload, data_basis: 'oops // TODO leaked commit message'};
        expect(() => assertNumbersOnly(tampered)).toThrow();
    });
});

describe('formatSummaryInput', () => {
    it('renders a numbers-only block with deltas and data basis', () => {
        const payload = buildSummaryInput({
            level: 'weekly',
            periodLabel: '2026-W21',
            start: '2026-05-19',
            end: '2026-05-25',
            scope: {type: 'team', name: 'backend'},
            current: metrics(),
            prior: metrics({total_commits: 120, total_prs_merged: 20}),
            benchmark: {org_avg_cost_per_pr: 8.5, org_avg_maturity_score: 50},
        });
        const text = formatSummaryInput(payload);
        expect(text).toContain('Period: 2026-W21');
        expect(text).toContain('Scope: backend (team)');
        expect(text).toContain('Total commits: 142');
        expect(text).toContain('PRs merged: 23');
        expect(text).toContain('Data basis: git analysis + expense data; no direct tool usage');
        // The rendered block must itself be free of code-like content.
        expect(() => assertNumbersOnly({...payload, data_basis: text})).not.toThrow();
    });

    it('notes the absence of a prior comparison on the first period', () => {
        const payload = buildSummaryInput({
            level: 'weekly',
            periodLabel: '2026-W21',
            start: '2026-05-19',
            end: '2026-05-25',
            scope: {type: 'team', name: 'backend'},
            current: metrics(),
            prior: null,
        });
        expect(formatSummaryInput(payload)).toContain('first period');
    });
});
