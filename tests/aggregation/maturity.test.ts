import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import {
    computeMaturityScore,
    computeOrgAvgCostPerPr,
    computeTeamMaturity,
    COMPONENT_WEIGHTS,
    type MaturityInputs,
} from '../../src/aggregation/maturity';
import {computeTeamPeriodMetrics} from '../../src/aggregation/team-period';
import {quarterRange} from '../../src/aggregation/dates';
import {makeDb, addDeveloper, addGitSnapshot, addSubscription} from './helpers';

/**
 * A fully-neutral input baseline: one developer, no activity signal either way.
 * Each test overrides only the fields it exercises so the component under test is
 * isolated from the others.
 */
function baseInputs(overrides: Partial<MaturityInputs> = {}): MaturityInputs {
    return {
        developer_count: 1,
        active_developer_count: 0,
        member_active_days: [0],
        possible_days: 90,
        prs_merged_delta_pct: null,
        avg_code_churn: null,
        cost_per_pr: null,
        org_avg_cost_per_pr: null,
        ...overrides,
    };
}

describe('computeMaturityScore — pure formula', () => {
    it('the component weights sum to exactly 1.0 (score stays in 0–100 by construction)', () => {
        const sum = Object.values(COMPONENT_WEIGHTS).reduce((a, b) => a + b, 0);
        expect(sum).toBeCloseTo(1, 10);
    });

    it('scores a fully-mature team high (full adoption + low churn + good cost efficiency)', () => {
        const result = computeMaturityScore({
            developer_count: 5,
            active_developer_count: 5, // breadth = 1
            member_active_days: [90, 90, 90, 90, 90], // consistency = 1
            possible_days: 90,
            prs_merged_delta_pct: 100, // output_health = clamp(0.5 + 0.5) = 1
            avg_code_churn: 0.05, // churn_quality = 0.95
            cost_per_pr: 5,
            org_avg_cost_per_pr: 20, // cheaper than org → high efficiency
        });
        expect(result.ai_maturity_score!).toBeGreaterThan(90);
        expect(result.ai_maturity_score!).toBeLessThanOrEqual(100);
    });

    it('scores a low-adoption team low even when churn is good (breadth weight dominates)', () => {
        // 1 of 10 active, one member carries all the activity. Churn is excellent,
        // but the 0.30+0.25 breadth/consistency weight holds the score down.
        const lowAdoption = computeMaturityScore({
            developer_count: 10,
            active_developer_count: 1, // breadth = 0.1
            member_active_days: [90, 0, 0, 0, 0, 0, 0, 0, 0, 0], // consistency ≈ 0.1
            possible_days: 90,
            prs_merged_delta_pct: 0,
            avg_code_churn: 0.05, // churn_quality = 0.95 (good)
            cost_per_pr: 5,
            org_avg_cost_per_pr: 20,
        });
        expect(lowAdoption.ai_maturity_score!).toBeLessThan(50);

        // And it must score below a high-adoption team with the *same* good churn.
        const highAdoption = computeMaturityScore({
            developer_count: 10,
            active_developer_count: 10,
            member_active_days: Array(10).fill(90),
            possible_days: 90,
            prs_merged_delta_pct: 0,
            avg_code_churn: 0.05,
            cost_per_pr: 5,
            org_avg_cost_per_pr: 20,
        });
        expect(lowAdoption.ai_maturity_score!).toBeLessThan(highAdoption.ai_maturity_score!);
    });

    it('cost_efficiency is ~0.5 when the team is exactly at the org average', () => {
        const atBenchmark = computeMaturityScore(
            baseInputs({cost_per_pr: 12, org_avg_cost_per_pr: 12}),
        );
        expect(atBenchmark.components.cost_efficiency).toBeCloseTo(0.5, 4);

        const cheaper = computeMaturityScore(
            baseInputs({cost_per_pr: 6, org_avg_cost_per_pr: 12}),
        );
        expect(cheaper.components.cost_efficiency).toBeGreaterThan(0.5);

        const pricier = computeMaturityScore(
            baseInputs({cost_per_pr: 24, org_avg_cost_per_pr: 12}),
        );
        expect(pricier.components.cost_efficiency).toBeLessThan(0.5);
    });

    it('cost_efficiency falls back to neutral 0.5 with no benchmark or no team ratio', () => {
        expect(computeMaturityScore(baseInputs({cost_per_pr: null, org_avg_cost_per_pr: 12})).components.cost_efficiency).toBe(0.5);
        expect(computeMaturityScore(baseInputs({cost_per_pr: 10, org_avg_cost_per_pr: null})).components.cost_efficiency).toBe(0.5);
        // A zero org average must not divide-by-zero — it falls back to neutral.
        expect(computeMaturityScore(baseInputs({cost_per_pr: 10, org_avg_cost_per_pr: 0})).components.cost_efficiency).toBe(0.5);
    });

    it('output_health reflects PR-trend direction (and is neutral with no prior period)', () => {
        const up = computeMaturityScore(baseInputs({prs_merged_delta_pct: 50}));
        const flat = computeMaturityScore(baseInputs({prs_merged_delta_pct: 0}));
        const down = computeMaturityScore(baseInputs({prs_merged_delta_pct: -50}));
        const none = computeMaturityScore(baseInputs({prs_merged_delta_pct: null}));

        expect(up.components.output_health).toBeGreaterThan(0.5);
        expect(down.components.output_health).toBeLessThan(0.5);
        expect(flat.components.output_health).toBe(0.5);
        expect(none.components.output_health).toBe(0.5); // null trend = neutral
        expect(up.components.output_health).toBeGreaterThan(down.components.output_health);
    });

    it('churn_quality inverts churn and is neutral when churn is unknown', () => {
        expect(computeMaturityScore(baseInputs({avg_code_churn: 0})).components.churn_quality).toBe(1);
        expect(computeMaturityScore(baseInputs({avg_code_churn: 1})).components.churn_quality).toBe(0);
        expect(computeMaturityScore(baseInputs({avg_code_churn: 0.3})).components.churn_quality).toBeCloseTo(0.7, 4);
        expect(computeMaturityScore(baseInputs({avg_code_churn: null})).components.churn_quality).toBe(0.5);
    });

    it('clamps every component to [0,1] and the score to [0,100] at the extremes', () => {
        // All signals maxed, plus out-of-band inputs that must clamp.
        const max = computeMaturityScore({
            developer_count: 3,
            active_developer_count: 3, // breadth = 1
            member_active_days: [120, 120, 120], // > possible_days → clamps to 1 each
            possible_days: 90,
            prs_merged_delta_pct: 5000, // huge positive → output_health clamps to 1
            avg_code_churn: -0.5, // below 0 → churn_quality clamps to 1
            cost_per_pr: 0, // free per PR → cost_efficiency = 1
            org_avg_cost_per_pr: 20,
        });
        expect(max.ai_maturity_score).toBe(100);
        for (const v of Object.values(max.components)) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
        }

        // All signals at their worst.
        const min = computeMaturityScore({
            developer_count: 3,
            active_developer_count: 0, // breadth = 0
            member_active_days: [0, 0, 0], // consistency = 0
            possible_days: 90,
            prs_merged_delta_pct: -5000, // huge negative → output_health clamps to 0
            avg_code_churn: 5, // above 1 → churn_quality clamps to 0
            cost_per_pr: 100000,
            org_avg_cost_per_pr: 1, // far pricier → cost_efficiency ≈ 0
        });
        expect(min.ai_maturity_score).toBe(0);
        for (const v of Object.values(min.components)) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
        }
    });

    it('labels every score git_estimate at launch', () => {
        expect(computeMaturityScore(baseInputs()).ai_maturity_basis).toBe('git_estimate');
        expect(
            computeMaturityScore(baseInputs({developer_count: 0})).ai_maturity_basis,
        ).toBe('git_estimate');
    });

    it('returns a null score (but still git_estimate basis) for a team with no developers', () => {
        const empty = computeMaturityScore(baseInputs({developer_count: 0, active_developer_count: 0, member_active_days: []}));
        expect(empty.ai_maturity_score).toBeNull();
        expect(empty.ai_maturity_basis).toBe('git_estimate');
    });

    it('produces an integer-valued score', () => {
        const result = computeMaturityScore(
            baseInputs({active_developer_count: 1, member_active_days: [37], possible_days: 91, avg_code_churn: 0.234}),
        );
        expect(Number.isInteger(result.ai_maturity_score)).toBe(true);
    });
});

const QUARTER = '2026-Q2';
const NOW = new Date('2026-07-01T05:00:00.000Z');

describe('computeOrgAvgCostPerPr', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });

    afterEach(() => db.close());

    it('averages each team cost_per_pr for the period, excluding teams with no PRs', () => {
        // backend: $90/mo seat held all of Q2 (= $270) over 2 merged PRs → 135.
        addDeveloper(db, 'dev-backend', 'backend');
        addSubscription(db, 'dev-backend', {
            monthly_cost: 90,
            seat_assigned_at: '2026-01-01T00:00:00.000Z',
        });
        addGitSnapshot(db, 'dev-backend', '2026-05-10', {commits: 4, prs_merged: 2});

        // platform: PRs but no subscription → cost_per_pr 0.
        addDeveloper(db, 'dev-platform', 'platform');
        addGitSnapshot(db, 'dev-platform', '2026-05-11', {commits: 3, prs_merged: 3});

        // frontend: no merged PRs → cost_per_pr null → excluded from the benchmark.
        addDeveloper(db, 'dev-frontend', 'frontend');
        addGitSnapshot(db, 'dev-frontend', '2026-05-12', {commits: 9, prs_merged: 0});

        const {start, end} = quarterRange(QUARTER);
        const orgAvg = computeOrgAvgCostPerPr(db, start, end);

        // mean(135, 0) = 67.5 — frontend (null) does not count.
        expect(orgAvg).toBe(67.5);
    });

    it('is null when no team merged any PR in the period', () => {
        addDeveloper(db, 'dev-1', 'backend');
        addGitSnapshot(db, 'dev-1', '2026-05-10', {commits: 4, prs_merged: 0});
        const {start, end} = quarterRange(QUARTER);
        expect(computeOrgAvgCostPerPr(db, start, end)).toBeNull();
    });
});

describe('computeTeamMaturity — DB glue', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });

    afterEach(() => db.close());

    it('derives the PR trend from the prior stored quarter and feeds it into output_health', () => {
        // Q1 stored with 10 merged PRs; Q2 has 15 → +50% trend → output_health 0.75.
        addDeveloper(db, 'dev-1', 'backend');
        db.prepare(
            `INSERT INTO quarterly_aggregates (id, team, quarter, total_prs_merged, ai_maturity_basis, computed_at)
             VALUES ('quarterly:backend:2026-Q1', 'backend', '2026-Q1', 10, 'git_estimate', ?)`,
        ).run(NOW.toISOString());
        addGitSnapshot(db, 'dev-1', '2026-05-10', {commits: 5, prs_merged: 15});

        const {start, end} = quarterRange(QUARTER);
        const metrics = computeTeamPeriodMetrics(db, 'backend', start, end);
        const result = computeTeamMaturity(db, {
            table: 'quarterly_aggregates',
            periodColumn: 'quarter',
            team: 'backend',
            previousPeriod: '2026-Q1',
            start,
            end,
            metrics,
            orgAvgCostPerPr: null,
        });

        expect(result.components.output_health).toBeCloseTo(0.75, 4); // 0.5 + 50/200
        expect(result.ai_maturity_basis).toBe('git_estimate');
    });

    it('uses a neutral PR trend when there is no prior stored period', () => {
        addDeveloper(db, 'dev-1', 'backend');
        addGitSnapshot(db, 'dev-1', '2026-05-10', {commits: 5, prs_merged: 15});

        const {start, end} = quarterRange(QUARTER);
        const metrics = computeTeamPeriodMetrics(db, 'backend', start, end);
        const result = computeTeamMaturity(db, {
            table: 'quarterly_aggregates',
            periodColumn: 'quarter',
            team: 'backend',
            previousPeriod: '2026-Q1',
            start,
            end,
            metrics,
            orgAvgCostPerPr: null,
        });

        expect(result.components.output_health).toBe(0.5);
    });
});
