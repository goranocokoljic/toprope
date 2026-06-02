import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import {
    computeMonthlyAggregate,
    computeAllMonthlyAggregates,
} from '../../src/aggregation/monthly';
import {
    makeDb,
    addDeveloper,
    addGitSnapshot,
    addToolSnapshot,
    addSubscription,
} from './helpers';

const MONTH = '2026-05';
const NOW = new Date('2026-06-01T04:30:00.000Z');

describe('computeMonthlyAggregate', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        addDeveloper(db, 'dev-1', 'backend');
    });

    afterEach(() => db.close());

    it('aggregates git metrics for a known fixture month, ignoring other months', () => {
        addGitSnapshot(db, 'dev-1', '2026-05-02', {
            commits: 4,
            lines_added: 120,
            prs_merged: 1,
            code_churn_rate: 0.2,
            ai_signature_score: 0.5,
        });
        addGitSnapshot(db, 'dev-1', '2026-05-20', {
            commits: 6,
            lines_added: 80,
            prs_merged: 2,
            code_churn_rate: 0.4,
            ai_signature_score: 0.7,
        });
        // Adjacent months — excluded.
        addGitSnapshot(db, 'dev-1', '2026-04-30', {commits: 50});
        addGitSnapshot(db, 'dev-1', '2026-06-01', {commits: 60});

        const row = computeMonthlyAggregate(db, 'dev-1', MONTH, NOW);

        expect(row.month).toBe('2026-05');
        expect(row.total_commits).toBe(10);
        expect(row.total_lines_added).toBe(200);
        expect(row.total_prs_merged).toBe(3);
        expect(row.avg_code_churn).toBe(0.3);
        expect(row.avg_ai_signature_score).toBe(0.6);
        expect(row.active_days).toBe(2);
        expect(row.computed_at).toBe(NOW.toISOString());
    });

    it('counts distinct active ISO weeks within the month', () => {
        // 2026-05-04 and 2026-05-20 fall in different ISO weeks.
        addGitSnapshot(db, 'dev-1', '2026-05-04', {commits: 1});
        addGitSnapshot(db, 'dev-1', '2026-05-05', {commits: 1}); // same week as the 4th
        addGitSnapshot(db, 'dev-1', '2026-05-20', {commits: 1});

        const row = computeMonthlyAggregate(db, 'dev-1', MONTH, NOW);

        expect(row.active_days).toBe(3);
        expect(row.active_weeks).toBe(2);
    });

    it('reports data_quality "medium" for a git-only month', () => {
        addGitSnapshot(db, 'dev-1', '2026-05-02', {commits: 1});

        const row = computeMonthlyAggregate(db, 'dev-1', MONTH, NOW);

        expect(row.data_quality).toBe('medium');
        expect(row.total_interactions).toBe(0);
        expect(row.avg_acceptance_rate).toBeNull();
        expect(row.tools_used).toBe('[]');
    });

    it('computes subscription_cost correctly across a mid-period plan change', () => {
        addGitSnapshot(db, 'dev-1', '2026-05-02', {commits: 1, prs_merged: 0});
        // Old $20 seat through 2026-05-14, new $50 seat from 2026-05-15 (same instant).
        addSubscription(db, 'dev-1', {
            monthly_cost: 20,
            seat_assigned_at: '2026-04-01T00:00:00.000Z',
            seat_revoked_at: '2026-05-15T00:00:00.000Z',
        });
        addSubscription(db, 'dev-1', {
            monthly_cost: 50,
            seat_assigned_at: '2026-05-15T00:00:00.000Z',
        });

        const row = computeMonthlyAggregate(db, 'dev-1', MONTH, NOW);

        // Days 1..14 at $20/31 + days 15..31 at $50/31 = (14*20 + 17*50)/31 = 36.45.
        expect(row.subscription_cost).toBe(36.45);
        // No PRs merged → cost_per_pr is null, never divide-by-zero.
        expect(row.cost_per_pr).toBeNull();
    });

    it('handles a zero-activity month without error', () => {
        const row = computeMonthlyAggregate(db, 'dev-1', MONTH, NOW);

        expect(row.active_days).toBe(0);
        expect(row.active_weeks).toBe(0);
        expect(row.is_active).toBe(0);
        expect(row.data_quality).toBe('low');
        expect(row.subscription_cost).toBe(0);
        expect(row.cost_per_pr).toBeNull();
    });

    it('is idempotent — recomputing overwrites the single row', () => {
        addGitSnapshot(db, 'dev-1', '2026-05-02', {commits: 4});
        computeMonthlyAggregate(db, 'dev-1', MONTH, NOW);
        addGitSnapshot(db, 'dev-1', '2026-05-20', {commits: 6});
        const second = computeMonthlyAggregate(db, 'dev-1', MONTH, NOW);

        const count = (
            db
                .prepare('SELECT COUNT(*) AS c FROM monthly_aggregates WHERE developer_id = ? AND month = ?')
                .get('dev-1', '2026-05') as {c: number}
        ).c;

        expect(count).toBe(1);
        expect(second.total_commits).toBe(10);
    });
});

describe('computeAllMonthlyAggregates', () => {
    it('computes a row per developer for the month', () => {
        const db = makeDb();
        addDeveloper(db, 'dev-a', 'backend');
        addDeveloper(db, 'dev-b', 'frontend');
        addGitSnapshot(db, 'dev-a', '2026-05-02', {commits: 2});
        addToolSnapshot(db, 'dev-b', '2026-05-03', {is_active: 1, interaction_count: 5});

        const rows = computeAllMonthlyAggregates(db, MONTH, NOW);

        expect(rows.map((r) => r.developer_id)).toEqual(['dev-a', 'dev-b']);
        expect(rows[0].data_quality).toBe('medium');
        expect(rows[1].data_quality).toBe('high');
        expect(db.prepare('SELECT COUNT(*) AS c FROM monthly_aggregates').get()).toEqual({c: 2});
        db.close();
    });
});
