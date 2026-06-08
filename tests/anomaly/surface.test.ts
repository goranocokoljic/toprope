import {describe, it, expect} from 'vitest';
import {
    anomalyDirection,
    basisLabel,
    changePercent,
    describeAnomaly,
    isSurfaceable,
    metricLabel,
} from '../../src/anomaly/surface';
import {FABRICATED_USAGE_TERMS} from '../../src/summaries/prompts';
import type {AnomalyMetric} from '../../src/anomaly/types';

describe('anomaly surface — labels', () => {
    it('labels every git/cost metric honestly (no fabricated tool-usage wording)', () => {
        const gitMetrics: AnomalyMetric[] = ['commits', 'prs_merged', 'churn', 'ai_signature', 'cost'];
        for (const metric of gitMetrics) {
            const label = metricLabel(metric).toLowerCase();
            for (const term of FABRICATED_USAGE_TERMS) {
                expect(label).not.toContain(term);
            }
        }
    });

    it('basis label is the honest "git-based estimate" at launch', () => {
        expect(basisLabel('git_estimate')).toBe('git-based estimate');
        expect(basisLabel('measured')).toBe('measured tool data');
    });
});

describe('anomaly surface — severity gating', () => {
    it('surfaces notable/high but never info', () => {
        expect(isSurfaceable('high')).toBe(true);
        expect(isSurfaceable('notable')).toBe(true);
        expect(isSurfaceable('info')).toBe(false);
    });
});

describe('anomaly surface — direction + percentage', () => {
    it('reads direction from observed vs expected', () => {
        expect(anomalyDirection(4, 10)).toBe('decrease');
        expect(anomalyDirection(15, 10)).toBe('increase');
        expect(anomalyDirection(10, 10)).toBe('increase');
    });

    it('computes a whole-percent change, null when no baseline', () => {
        expect(changePercent(4, 10)).toBe(-60);
        expect(changePercent(14.5, 10)).toBe(45);
        expect(changePercent(5, 0)).toBeNull();
    });
});

describe('anomaly surface — describeAnomaly (tier-honest phrasing)', () => {
    it('describes a git-metric drop in plain language, no fabricated terms', () => {
        const text = describeAnomaly({metric: 'commits', observed_value: 4, expected_value: 10});
        expect(text).toBe('Commit activity dropped 60%');
        for (const term of FABRICATED_USAGE_TERMS) {
            expect(text.toLowerCase()).not.toContain(term);
        }
    });

    it('describes a cost rise as subscription cost', () => {
        expect(describeAnomaly({metric: 'cost', observed_value: 145, expected_value: 100})).toBe(
            'Subscription cost rose 45%',
        );
    });

    it('falls back to absolute values when there is no usable baseline', () => {
        expect(describeAnomaly({metric: 'commits', observed_value: 8, expected_value: 0})).toBe(
            'Commit activity rose to 8 from 0',
        );
    });
});
