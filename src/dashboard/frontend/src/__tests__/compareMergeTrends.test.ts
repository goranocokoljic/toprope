import {describe, it, expect} from 'vitest';
import {mergeCompareTrends} from '../compare/mergeTrends';
import type {CompareTeam} from '../api/types';

/** Minimal CompareTeam with only the fields the merge reads. */
function teamWithTrend(name: string, trend: Array<{date: string; active_developers: number}>): CompareTeam {
    return {
        name,
        department: null,
        manager: null,
        tier: 'medium',
        tier_breakdown: {high: 0, medium: 1, low: 0, none: 0},
        metrics: {
            developer_count: 1,
            active_developer_count: 1,
            utilization_rate: 1,
            total_subscription_cost: 0,
            cost_per_pr: null,
            avg_code_churn: null,
            total_prs_merged: 0,
            ai_maturity_score: null,
            ai_maturity_basis: null,
            tool_mix: [],
        },
        trend,
    };
}

describe('mergeCompareTrends', () => {
    it('builds one keyed series per team over the sorted union of dates', () => {
        const merged = mergeCompareTrends([
            teamWithTrend('alpha', [
                {date: '2026-05-02', active_developers: 3},
                {date: '2026-05-01', active_developers: 2},
            ]),
            teamWithTrend('beta', [{date: '2026-05-03', active_developers: 5}]),
        ]);

        // Series keys are namespaced (so a team can't shadow the x-key); the
        // legend label stays the bare team name.
        expect(merged.series.map((s) => s.key)).toEqual(['team:alpha', 'team:beta']);
        expect(merged.series.map((s) => s.label)).toEqual(['alpha', 'beta']);
        // Dates are the sorted union of both teams' dates.
        expect(merged.data.map((d) => d.date)).toEqual(['2026-05-01', '2026-05-02', '2026-05-03']);
    });

    it('fills a missing date with 0 for the team that has no snapshot that day', () => {
        const merged = mergeCompareTrends([
            teamWithTrend('alpha', [{date: '2026-05-01', active_developers: 2}]),
            teamWithTrend('beta', [{date: '2026-05-02', active_developers: 5}]),
        ]);

        // alpha is absent on 05-02, beta absent on 05-01 → both fill 0.
        expect(merged.data).toEqual([
            {date: '2026-05-01', 'team:alpha': 2, 'team:beta': 0},
            {date: '2026-05-02', 'team:alpha': 0, 'team:beta': 5},
        ]);
    });

    it('namespaces the series key so a team named "date" cannot shadow the x-axis', () => {
        const merged = mergeCompareTrends([
            teamWithTrend('date', [{date: '2026-05-01', active_developers: 2}]),
            teamWithTrend('beta', [{date: '2026-05-01', active_developers: 4}]),
        ]);
        // The 'date' x value survives; the team's series lands under 'team:date'.
        expect(merged.data).toEqual([{date: '2026-05-01', 'team:date': 2, 'team:beta': 4}]);
        expect(merged.series.map((s) => s.key)).toEqual(['team:date', 'team:beta']);
    });

    it('returns no rows when no team has any trend points', () => {
        const merged = mergeCompareTrends([teamWithTrend('alpha', []), teamWithTrend('beta', [])]);
        expect(merged.data).toEqual([]);
        expect(merged.series.map((s) => s.label)).toEqual(['alpha', 'beta']);
    });
});
