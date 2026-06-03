import {describe, it, expect} from 'vitest';
import {
    pctChange,
    pointDelta,
    computeDeveloperDeltas,
    computeTeamDeltas,
    type DeveloperDeltaValues,
    type TeamDeltaValues,
} from '../../src/aggregation/deltas';

describe('pctChange (percentage CHANGE)', () => {
    it('computes a normal positive change', () => {
        // (120 - 100) / max(100, 1) * 100 = 20
        expect(pctChange(120, 100, 1)).toBe(20);
    });

    it('computes a normal negative change', () => {
        // (8 - 10) / max(10, 1) * 100 = -20
        expect(pctChange(8, 10, 1)).toBe(-20);
    });

    it('guards divide-by-zero with the floor when previous is 0', () => {
        // (5 - 0) / max(0, 1) * 100 = 500 — finite, never Infinity/NaN.
        const result = pctChange(5, 0, 1);
        expect(result).toBe(500);
        expect(Number.isFinite(result as number)).toBe(true);
    });

    it('yields 0 when both sides are 0 (no change), not NaN', () => {
        expect(pctChange(0, 0, 1)).toBe(0);
    });

    it('uses a fractional floor for cost metrics', () => {
        // (1 - 0) / max(0, 0.01) * 100 = 10000
        expect(pctChange(1, 0, 0.01)).toBe(10000);
    });

    it('returns null when current is null', () => {
        expect(pctChange(null, 100, 1)).toBeNull();
    });

    it('returns null when previous is null', () => {
        expect(pctChange(120, null, 1)).toBeNull();
    });

    it('rounds to two decimal places', () => {
        // (1 - 3) / max(3, 1) * 100 = -66.666... → -66.67
        expect(pctChange(1, 3, 1)).toBe(-66.67);
    });
});

describe('pointDelta (percentage POINTS)', () => {
    it('subtracts plainly', () => {
        expect(pointDelta(0.11, 0.14)).toBe(-0.03);
    });

    it('returns null when either side is null', () => {
        expect(pointDelta(null, 0.1)).toBeNull();
        expect(pointDelta(0.1, null)).toBeNull();
    });

    it('rounds to four decimal places', () => {
        expect(pointDelta(0.12345, 0.1)).toBe(0.0235);
    });

    it('never divides — a previous of 0 is a valid baseline', () => {
        expect(pointDelta(0.5, 0)).toBe(0.5);
    });
});

const CURRENT: DeveloperDeltaValues = {
    total_interactions: 110,
    avg_acceptance_rate: 0.7,
    total_commits: 120,
    total_prs_merged: 24,
    avg_code_churn: 0.11,
    avg_ai_signature_score: 0.68,
    cost_per_pr: 7.83,
};

const PREVIOUS: DeveloperDeltaValues = {
    total_interactions: 100,
    avg_acceptance_rate: 0.66,
    total_commits: 100,
    total_prs_merged: 22,
    avg_code_churn: 0.14,
    avg_ai_signature_score: 0.64,
    cost_per_pr: 8.9,
};

describe('computeDeveloperDeltas', () => {
    it('computes every delta correctly against a known fixture', () => {
        const d = computeDeveloperDeltas(CURRENT, PREVIOUS);
        expect(d.interaction_delta_pct).toBe(10); // (110-100)/100*100
        expect(d.acceptance_rate_delta).toBe(0.04); // points
        expect(d.commit_velocity_delta_pct).toBe(20); // (120-100)/100*100
        expect(d.prs_merged_delta_pct).toBe(9.09); // (24-22)/22*100 = 9.0909
        expect(d.churn_rate_delta).toBe(-0.03); // points
        expect(d.ai_signature_delta).toBe(0.04); // points
        expect(d.cost_per_pr_delta_pct).toBe(-12.02); // (7.83-8.9)/8.9*100 = -12.022
    });

    it('returns all-null deltas for the first period (previous === null)', () => {
        const d = computeDeveloperDeltas(CURRENT, null);
        expect(d).toEqual({
            interaction_delta_pct: null,
            acceptance_rate_delta: null,
            commit_velocity_delta_pct: null,
            prs_merged_delta_pct: null,
            churn_rate_delta: null,
            ai_signature_delta: null,
            cost_per_pr_delta_pct: null,
        });
    });

    it('distinguishes a real zero-change from a missing comparison', () => {
        // Same values → 0% / 0 points, NOT null. null is reserved for "no prior".
        const d = computeDeveloperDeltas(CURRENT, CURRENT);
        expect(d.commit_velocity_delta_pct).toBe(0);
        expect(d.churn_rate_delta).toBe(0);
    });

    it('guards divide-by-zero when the prior period had zero commits/PRs', () => {
        const previousZero: DeveloperDeltaValues = {
            ...PREVIOUS,
            total_interactions: 0,
            total_commits: 0,
            total_prs_merged: 0,
            cost_per_pr: 0,
        };
        const d = computeDeveloperDeltas(CURRENT, previousZero);
        // All finite — the max(prev, floor) guard makes /0 impossible.
        expect(Number.isFinite(d.interaction_delta_pct as number)).toBe(true);
        expect(Number.isFinite(d.commit_velocity_delta_pct as number)).toBe(true);
        expect(Number.isFinite(d.prs_merged_delta_pct as number)).toBe(true);
        expect(Number.isFinite(d.cost_per_pr_delta_pct as number)).toBe(true);
        expect(d.commit_velocity_delta_pct).toBe(12000); // (120-0)/max(0,1)*100
    });

    it('returns null for a specific delta when that metric is null on either side', () => {
        // Git-only period: no acceptance rate, but commits still produce a delta.
        const currentGitOnly: DeveloperDeltaValues = {...CURRENT, avg_acceptance_rate: null};
        const d = computeDeveloperDeltas(currentGitOnly, PREVIOUS);
        expect(d.acceptance_rate_delta).toBeNull();
        expect(d.commit_velocity_delta_pct).toBe(20);
    });

    it('nulls interaction_delta_pct when neither period had tool interactions (no fabricated 0%)', () => {
        const noTool: DeveloperDeltaValues = {...CURRENT, total_interactions: 0};
        const noToolPrev: DeveloperDeltaValues = {...PREVIOUS, total_interactions: 0};
        const d = computeDeveloperDeltas(noTool, noToolPrev);
        expect(d.interaction_delta_pct).toBeNull();
        // Git metrics still delta normally — only the tool-derived count nulls out.
        expect(d.commit_velocity_delta_pct).toBe(20);
    });

    it('still deltas interactions when usage starts or stops (one side non-zero)', () => {
        const started: DeveloperDeltaValues = {...CURRENT, total_interactions: 5};
        const wasZero: DeveloperDeltaValues = {...PREVIOUS, total_interactions: 0};
        // Usage started: (5 - 0) / max(0, 1) * 100 = 500 — a real signal, not null.
        expect(computeDeveloperDeltas(started, wasZero).interaction_delta_pct).toBe(500);
        // Usage stopped: (0 - 5) / max(5, 1) * 100 = -100.
        const stopped: DeveloperDeltaValues = {...CURRENT, total_interactions: 0};
        const wasFive: DeveloperDeltaValues = {...PREVIOUS, total_interactions: 5};
        expect(computeDeveloperDeltas(stopped, wasFive).interaction_delta_pct).toBe(-100);
    });
});

describe('computeTeamDeltas', () => {
    it('computes utilization and maturity deltas as percentage points', () => {
        const current: TeamDeltaValues = {utilization_rate: 0.8, ai_maturity_score: 61};
        const previous: TeamDeltaValues = {utilization_rate: 0.6, ai_maturity_score: 48};
        const d = computeTeamDeltas(current, previous);
        expect(d.utilization_rate_delta).toBe(0.2);
        expect(d.maturity_score_delta).toBe(13);
    });

    it('returns null deltas for the first period', () => {
        const d = computeTeamDeltas({utilization_rate: 0.8, ai_maturity_score: 61}, null);
        expect(d).toEqual({utilization_rate_delta: null, maturity_score_delta: null});
    });

    it('leaves maturity_score_delta null until the score exists (Task 3.4)', () => {
        const current: TeamDeltaValues = {utilization_rate: 0.8, ai_maturity_score: null};
        const previous: TeamDeltaValues = {utilization_rate: 0.6, ai_maturity_score: null};
        const d = computeTeamDeltas(current, previous);
        expect(d.utilization_rate_delta).toBe(0.2);
        expect(d.maturity_score_delta).toBeNull();
    });
});
