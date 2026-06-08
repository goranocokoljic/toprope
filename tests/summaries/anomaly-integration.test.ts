import {describe, it, expect} from 'vitest';
import {
    buildSummaryInput,
    formatSummaryInput,
    collectStringValues,
    type AggregateMetrics,
    type SummaryInputPayload,
    type SummaryScope,
} from '../../src/summaries/input-builder';
import {buildSummaryPrompt, FABRICATED_USAGE_TERMS} from '../../src/summaries/prompts';
import type {AnomalyRecord} from '../../src/anomaly/types';

const gitMetrics = (overrides: Partial<AggregateMetrics> = {}): AggregateMetrics => ({
    developer_count: 5,
    active_developer_count: 4,
    total_commits: 120,
    total_prs_merged: 30,
    avg_code_churn: 0.3,
    avg_ai_signature_score: 0.5,
    subscription_cost: 400,
    cost_per_pr: 13.33,
    ai_maturity_score: 62,
    ai_maturity_basis: 'git_estimate',
    data_quality: 'medium',
    ...overrides,
});

const scope: SummaryScope = {type: 'team', name: 'frontend'};

const anomaly = (overrides: Partial<AnomalyRecord> = {}): AnomalyRecord => ({
    id: 'a1',
    scope: 'team',
    scope_id: 'frontend',
    metric: 'commits',
    period: '2026-05-04',
    method: 'statistical',
    observed_value: 4,
    expected_value: 10,
    deviation: -3.1,
    severity: 'high',
    basis: 'git_estimate',
    status: 'open',
    detected_at: '2026-05-11T00:00:00.000Z',
    notified_at: null,
    ...overrides,
});

function build(anomalies: AnomalyRecord[]): SummaryInputPayload {
    return buildSummaryInput({
        level: 'weekly',
        periodLabel: '2026-W19',
        start: '2026-05-04',
        end: '2026-05-10',
        scope,
        current: gitMetrics(),
        prior: null,
        anomalies,
    });
}

describe('summary anomaly integration', () => {
    it('folds notable/high anomalies into the numbers-only payload (passing the privacy gate)', () => {
        // buildSummaryInput runs assertNumbersOnly internally; a throw would fail here.
        const payload = build([
            anomaly({metric: 'commits', severity: 'high'}),
            anomaly({id: 'a2', metric: 'cost', severity: 'notable', method: 'percentage_change', observed_value: 580, expected_value: 400}),
        ]);
        expect(payload.anomalies).toHaveLength(2);
        expect(payload.anomalies[0]).toMatchObject({metric: 'commits', severity: 'high', direction: 'decrease', change_pct: -60});
        expect(payload.anomalies[1]).toMatchObject({metric: 'cost', severity: 'notable', direction: 'increase', change_pct: 45});
    });

    it('drops info-severity anomalies (only notable/high surface)', () => {
        const payload = build([anomaly({severity: 'info'}), anomaly({id: 'a2', severity: 'notable'})]);
        expect(payload.anomalies).toHaveLength(1);
        expect(payload.anomalies[0].severity).toBe('notable');
    });

    it('renders anomalies in the input block in plain, honest language', () => {
        const payload = build([anomaly({metric: 'commits', severity: 'high'})]);
        const text = formatSummaryInput(payload);
        expect(text).toContain('Anomalies flagged this period:');
        expect(text).toContain('Commit activity dropped 60% (high, git-based estimate)');
    });

    it('ADVERSARIAL: git-only anomaly text contains NO fabricated tool-usage terms', () => {
        // Every git-derived metric, the kind a launch (git-only) period produces.
        const payload = build([
            anomaly({metric: 'commits', severity: 'high'}),
            anomaly({id: 'a2', metric: 'prs_merged', severity: 'notable', observed_value: 2, expected_value: 30}),
            anomaly({id: 'a3', metric: 'churn', severity: 'notable', observed_value: 0.8, expected_value: 0.3}),
            anomaly({id: 'a4', metric: 'ai_signature', severity: 'notable', observed_value: 0.1, expected_value: 0.5}),
            anomaly({id: 'a5', metric: 'cost', severity: 'high', method: 'percentage_change', observed_value: 900, expected_value: 400}),
        ]);
        // Reuse the Phase 3 forbidden-terms catalogue against the rendered block
        // AND the full prompt — the model is told to echo this honest wording.
        const block = formatSummaryInput(payload).toLowerCase();
        const prompt = buildSummaryPrompt(payload).toLowerCase();
        for (const term of FABRICATED_USAGE_TERMS) {
            expect(block).not.toContain(term);
            // The prompt's preamble references the banned terms by name in its
            // instruction, so only assert the rendered INPUT block (the data the
            // model narrates) is clean — checked above. The prompt instruction is
            // expected to mention them.
        }
        // Sanity: the honest git wording is present.
        expect(block).toContain('commit activity dropped');
        expect(block).toContain('subscription cost rose');
        void prompt;
    });

    it('every string in the anomaly payload is a validated enum (no free text leaks)', () => {
        const payload = build([anomaly({metric: 'commits', severity: 'high'})]);
        // The team name is the only operator-supplied label; everything on an
        // anomaly is a closed enum. Confirm no anomaly carries a stray string.
        const anomalyStrings = collectStringValues(payload.anomalies);
        const allowed = new Set(['commits', 'high', 'git_estimate', 'statistical', 'decrease']);
        for (const s of anomalyStrings) {
            expect(allowed.has(s)).toBe(true);
        }
    });
});
