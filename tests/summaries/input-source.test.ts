import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import {
    buildSummaryInputForTarget,
    computeScopeAggregate,
} from '../../src/summaries/input-source';
import type {SummaryTarget} from '../../src/summaries/target';
import {computeTeamPeriodMetrics} from '../../src/aggregation/team-period';
import {makeDb, addDeveloper, addGitSnapshot, addSubscription} from '../aggregation/helpers';

describe('computeScopeAggregate', () => {
    let db: Database.Database;
    beforeEach(() => (db = makeDb()));
    afterEach(() => db.close());

    it('folds a team’s members for a monthly period from snapshots', () => {
        addDeveloper(db, 'dev-1', 'backend');
        addDeveloper(db, 'dev-2', 'backend');
        addGitSnapshot(db, 'dev-1', '2026-05-10', {commits: 5, prs_merged: 2, code_churn_rate: 0.2});
        addGitSnapshot(db, 'dev-2', '2026-05-12', {commits: 3, prs_merged: 1, code_churn_rate: 0.4});
        // Out-of-month — must be excluded.
        addGitSnapshot(db, 'dev-1', '2026-04-30', {commits: 99, prs_merged: 9});

        const metrics = computeScopeAggregate(db, {type: 'team', name: 'backend'}, 'monthly', '2026-05');
        expect(metrics.developer_count).toBe(2);
        expect(metrics.active_developer_count).toBe(2);
        expect(metrics.total_commits).toBe(8);
        expect(metrics.total_prs_merged).toBe(3);
        expect(metrics.avg_code_churn).toBeCloseTo(0.3, 5);
        expect(metrics.ai_maturity_basis).toBe('git_estimate');
        expect(metrics.data_quality).toBe('medium'); // git-only at launch
        expect(metrics.ai_maturity_score).toBeTypeOf('number');
    });

    it('returns an all-zero, low-quality, null-maturity aggregate for an unknown/empty scope', () => {
        // No developers added for this team — a mistyped or empty scope.
        const metrics = computeScopeAggregate(db, {type: 'team', name: 'ghost'}, 'monthly', '2026-05');
        expect(metrics.developer_count).toBe(0);
        expect(metrics.active_developer_count).toBe(0);
        expect(metrics.total_commits).toBe(0);
        expect(metrics.total_prs_merged).toBe(0);
        expect(metrics.data_quality).toBe('low');
        expect(metrics.ai_maturity_score).toBeNull();
    });

    it('matches computeTeamPeriodMetrics for a single team (folds may not drift)', () => {
        addDeveloper(db, 'dev-1', 'backend');
        addDeveloper(db, 'dev-2', 'backend');
        addSubscription(db, 'dev-1', {monthly_cost: 30, seat_assigned_at: '2026-05-01'});
        addGitSnapshot(db, 'dev-1', '2026-05-10', {commits: 5, prs_merged: 2, code_churn_rate: 0.2});
        addGitSnapshot(db, 'dev-2', '2026-05-12', {commits: 3, prs_merged: 1, code_churn_rate: 0.4});

        const agg = computeScopeAggregate(db, {type: 'team', name: 'backend'}, 'monthly', '2026-05');
        const tpm = computeTeamPeriodMetrics(db, 'backend', '2026-05-01', '2026-05-31');
        // The scope fold must reproduce the engine's own team rollup exactly.
        expect(agg.developer_count).toBe(tpm.developer_count);
        expect(agg.active_developer_count).toBe(tpm.active_developer_count);
        expect(agg.total_commits).toBe(tpm.total_commits);
        expect(agg.total_prs_merged).toBe(tpm.total_prs_merged);
        expect(agg.avg_code_churn).toBe(tpm.avg_code_churn);
        expect(agg.avg_ai_signature_score).toBe(tpm.avg_ai_signature_score);
        expect(agg.subscription_cost).toBe(tpm.total_subscription_cost);
        expect(agg.cost_per_pr).toBe(tpm.cost_per_pr);
    });

    it('folds every team for the org scope', () => {
        addDeveloper(db, 'dev-1', 'backend');
        addDeveloper(db, 'dev-2', 'frontend');
        addGitSnapshot(db, 'dev-1', '2026-05-10', {commits: 5, prs_merged: 2});
        addGitSnapshot(db, 'dev-2', '2026-05-11', {commits: 4, prs_merged: 1});

        const org = computeScopeAggregate(db, {type: 'org', name: 'org'}, 'monthly', '2026-05');
        expect(org.developer_count).toBe(2);
        expect(org.total_commits).toBe(9);
        expect(org.total_prs_merged).toBe(3);
    });
});

describe('buildSummaryInputForTarget', () => {
    let db: Database.Database;
    beforeEach(() => (db = makeDb()));
    afterEach(() => db.close());

    const TARGET: SummaryTarget = {
        level: 'monthly',
        period: '2026-05',
        scope: {type: 'team', name: 'backend'},
    };

    it('marks the first period and emits null deltas when there is no prior data', () => {
        addDeveloper(db, 'dev-1', 'backend');
        addGitSnapshot(db, 'dev-1', '2026-05-10', {commits: 5, prs_merged: 2});

        const payload = buildSummaryInputForTarget(db, TARGET);
        expect(payload.is_first_period).toBe(true);
        expect(payload.period.label).toBe('2026-05');
        expect(payload.period.start).toBe('2026-05-01');
        expect(payload.period.end).toBe('2026-05-31');
        expect(payload.scope).toMatchObject({type: 'team', name: 'backend'});
        expect(payload.metrics.total_commits).toBe(5);
        expect(payload.deltas.commit_velocity_delta_pct).toBeNull();
        expect(payload.deltas.prs_merged_delta_pct).toBeNull();
    });

    it('computes deltas against the prior period when prior data exists', () => {
        addDeveloper(db, 'dev-1', 'backend');
        // Prior month (April) — establishes a baseline so this is not a first period.
        addGitSnapshot(db, 'dev-1', '2026-04-10', {commits: 4, prs_merged: 1});
        // Current month (May).
        addGitSnapshot(db, 'dev-1', '2026-05-10', {commits: 8, prs_merged: 2});

        const payload = buildSummaryInputForTarget(db, TARGET);
        expect(payload.is_first_period).toBe(false);
        // +100% commits (8 vs 4) and +100% PRs (2 vs 1).
        expect(payload.deltas.commit_velocity_delta_pct).toBe(100);
        expect(payload.deltas.prs_merged_delta_pct).toBe(100);
    });

    it('passes the numbers-only privacy gate (only allowlisted strings present)', () => {
        addDeveloper(db, 'dev-1', 'backend');
        addSubscription(db, 'dev-1', {monthly_cost: 30, seat_assigned_at: '2026-05-01'});
        addGitSnapshot(db, 'dev-1', '2026-05-10', {commits: 5, prs_merged: 2});
        // buildSummaryInput runs assertNumbersOnly internally — a throw would fail here.
        expect(() => buildSummaryInputForTarget(db, TARGET)).not.toThrow();
    });
});
