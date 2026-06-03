import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import {computeYearlyAggregate, computeAllYearlyAggregates} from '../../src/aggregation/yearly';
import {makeDb, addDeveloper, addGitSnapshot, addToolSnapshot, addSubscription} from './helpers';

const YEAR = '2026';
const NOW = new Date('2027-01-01T05:00:00.000Z');

describe('computeYearlyAggregate', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });

    afterEach(() => db.close());

    it('aggregates a known fixture year at the team level, ignoring other years', () => {
        addDeveloper(db, 'dev-1', 'backend');
        addDeveloper(db, 'dev-2', 'backend');

        addGitSnapshot(db, 'dev-1', '2026-02-10', {
            commits: 10,
            prs_merged: 3,
            code_churn_rate: 0.2,
            ai_signature_score: 0.5,
        });
        addGitSnapshot(db, 'dev-1', '2026-11-20', {
            commits: 5,
            prs_merged: 2,
            code_churn_rate: 0.4,
            ai_signature_score: 0.7,
        });
        addGitSnapshot(db, 'dev-2', '2026-07-04', {
            commits: 8,
            prs_merged: 1,
            code_churn_rate: 0.6,
            ai_signature_score: 0.9,
        });
        // Adjacent years — excluded.
        addGitSnapshot(db, 'dev-1', '2025-12-31', {commits: 99, prs_merged: 9});
        addGitSnapshot(db, 'dev-2', '2027-01-01', {commits: 88, prs_merged: 8});

        const row = computeYearlyAggregate(db, 'backend', YEAR, NOW);

        expect(row.id).toBe('yearly:backend:2026');
        expect(row.year).toBe('2026');
        expect(row.developer_count).toBe(2);
        expect(row.active_developer_count).toBe(2);
        expect(row.utilization_rate).toBe(1);
        expect(row.total_commits).toBe(23);
        expect(row.total_prs_merged).toBe(6);
        // Churn team mean: dev-1 mean(0.2,0.4)=0.3, dev-2 0.6 → mean(0.3,0.6)=0.45.
        expect(row.avg_code_churn).toBe(0.45);
        // Signature team mean: dev-1 mean(0.5,0.7)=0.6, dev-2 0.9 → mean(0.6,0.9)=0.75.
        expect(row.avg_ai_signature_score).toBe(0.75);
        expect(row.ai_maturity_basis).toBe('git_estimate');
        expect(row.ai_maturity_score).toBeNull();
        expect(row.utilization_rate_delta).toBeNull();
        expect(row.computed_at).toBe(NOW.toISOString());
    });

    it('attributes a developer who changed teams to their current team for the whole year', () => {
        // dev-mover now belongs to platform; their full-year git activity rolls
        // into platform (the schema tracks current team only — documented limit).
        addDeveloper(db, 'dev-stay', 'backend');
        addDeveloper(db, 'dev-mover', 'platform');
        addGitSnapshot(db, 'dev-stay', '2026-03-01', {commits: 4, prs_merged: 1});
        // Activity from early in the year (when they were nominally elsewhere) and late.
        addGitSnapshot(db, 'dev-mover', '2026-02-01', {commits: 6, prs_merged: 2});
        addGitSnapshot(db, 'dev-mover', '2026-10-01', {commits: 3, prs_merged: 1});

        const backend = computeYearlyAggregate(db, 'backend', YEAR, NOW);
        const platform = computeYearlyAggregate(db, 'platform', YEAR, NOW);

        expect(backend.developer_count).toBe(1);
        expect(backend.total_commits).toBe(4);
        expect(platform.developer_count).toBe(1);
        expect(platform.total_commits).toBe(9); // both of dev-mover's snapshots
        expect(platform.total_prs_merged).toBe(3);
    });

    it('computes utilization correctly for a team with inactive members', () => {
        addDeveloper(db, 'dev-active', 'backend');
        addDeveloper(db, 'dev-idle', 'backend');
        addGitSnapshot(db, 'dev-active', '2026-06-10', {commits: 3});

        const row = computeYearlyAggregate(db, 'backend', YEAR, NOW);

        expect(row.developer_count).toBe(2);
        expect(row.active_developer_count).toBe(1);
        expect(row.utilization_rate).toBe(0.5);
    });

    it('computes subscription cost and cost_per_pr across the year', () => {
        addDeveloper(db, 'dev-1', 'backend');
        // $100/mo for all 12 months of 2026 = $1200.
        addSubscription(db, 'dev-1', {
            monthly_cost: 100,
            seat_assigned_at: '2026-01-01T00:00:00.000Z',
        });
        addGitSnapshot(db, 'dev-1', '2026-05-10', {commits: 4, prs_merged: 4});

        const row = computeYearlyAggregate(db, 'backend', YEAR, NOW);

        expect(row.total_subscription_cost).toBe(1200);
        expect(row.cost_per_pr).toBe(300); // 1200 / 4
    });

    it('handles a zero-activity year and an empty team without error', () => {
        addDeveloper(db, 'dev-1', 'backend');
        const row = computeYearlyAggregate(db, 'backend', YEAR, NOW);
        expect(row.active_developer_count).toBe(0);
        expect(row.utilization_rate).toBe(0);
        expect(row.cost_per_pr).toBeNull();
        expect(row.avg_ai_signature_score).toBeNull();

        const ghost = computeYearlyAggregate(db, 'ghost', YEAR, NOW);
        expect(ghost.developer_count).toBe(0);
        expect(ghost.utilization_rate).toBeNull();
    });

    it('is idempotent — recomputing overwrites the single row', () => {
        addDeveloper(db, 'dev-1', 'backend');
        addGitSnapshot(db, 'dev-1', '2026-04-10', {commits: 5});
        computeYearlyAggregate(db, 'backend', YEAR, NOW);
        addGitSnapshot(db, 'dev-1', '2026-09-10', {commits: 7});
        const second = computeYearlyAggregate(db, 'backend', YEAR, NOW);

        const count = (
            db
                .prepare('SELECT COUNT(*) AS c FROM yearly_aggregates WHERE team = ? AND year = ?')
                .get('backend', '2026') as {c: number}
        ).c;

        expect(count).toBe(1);
        expect(second.total_commits).toBe(12);
    });

    it('reports tool activity as is_active without fabricating an acceptance rate column', () => {
        // Yearly has no avg_acceptance_rate column; a tool-active developer still
        // counts toward utilization.
        addDeveloper(db, 'dev-1', 'backend');
        addToolSnapshot(db, 'dev-1', '2026-05-10', {is_active: 1, interaction_count: 5});

        const row = computeYearlyAggregate(db, 'backend', YEAR, NOW);
        expect(row.active_developer_count).toBe(1);
    });
});

describe('computeAllYearlyAggregates', () => {
    it('computes one row per team for the year, in team order', () => {
        const db = makeDb();
        addDeveloper(db, 'dev-a', 'backend');
        addDeveloper(db, 'dev-b', 'frontend');
        addGitSnapshot(db, 'dev-a', '2026-04-02', {commits: 2});

        const rows = computeAllYearlyAggregates(db, YEAR, NOW);

        expect(rows.map((r) => r.team)).toEqual(['backend', 'frontend']);
        expect(db.prepare('SELECT COUNT(*) AS c FROM yearly_aggregates').get()).toEqual({c: 2});
        db.close();
    });
});
