import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import {
    computeQuarterlyAggregate,
    computeAllQuarterlyAggregates,
} from '../../src/aggregation/quarterly';
import {
    makeDb,
    addDeveloper,
    addGitSnapshot,
    addToolSnapshot,
    addSubscription,
} from './helpers';

const QUARTER = '2026-Q2'; // Apr–Jun 2026
const NOW = new Date('2026-07-01T05:00:00.000Z');

describe('computeQuarterlyAggregate', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });

    afterEach(() => db.close());

    it('aggregates a known fixture quarter at the team level, ignoring other quarters', () => {
        addDeveloper(db, 'dev-1', 'backend');
        addDeveloper(db, 'dev-2', 'backend');

        // In-quarter activity.
        addGitSnapshot(db, 'dev-1', '2026-04-10', {
            commits: 5,
            prs_merged: 2,
            code_churn_rate: 0.2,
        });
        addGitSnapshot(db, 'dev-1', '2026-06-20', {
            commits: 3,
            prs_merged: 1,
            code_churn_rate: 0.4,
        });
        addGitSnapshot(db, 'dev-2', '2026-05-05', {
            commits: 4,
            prs_merged: 1,
            code_churn_rate: 0.6,
        });
        // Out-of-quarter — must be excluded.
        addGitSnapshot(db, 'dev-1', '2026-03-31', {commits: 99, prs_merged: 9});
        addGitSnapshot(db, 'dev-2', '2026-07-01', {commits: 88, prs_merged: 8});

        const row = computeQuarterlyAggregate(db, 'backend', QUARTER, NOW);

        expect(row.id).toBe('quarterly:backend:2026-Q2');
        expect(row.team).toBe('backend');
        expect(row.quarter).toBe('2026-Q2');
        expect(row.developer_count).toBe(2);
        expect(row.active_developer_count).toBe(2);
        expect(row.utilization_rate).toBe(1);
        expect(row.total_prs_merged).toBe(4);
        // Team churn = mean of per-developer period means: dev-1 mean(0.2,0.4)=0.3, dev-2 0.6.
        expect(row.avg_code_churn).toBe(0.45);
        expect(row.ai_maturity_basis).toBe('git_estimate');
        expect(row.ai_maturity_score).toBeNull();
        expect(row.utilization_rate_delta).toBeNull();
        expect(row.maturity_score_delta).toBeNull();
        expect(row.computed_at).toBe(NOW.toISOString());
    });

    it('computes utilization correctly for a team with inactive members', () => {
        addDeveloper(db, 'dev-active', 'backend');
        addDeveloper(db, 'dev-idle', 'backend');
        addDeveloper(db, 'dev-also-idle', 'backend');
        addGitSnapshot(db, 'dev-active', '2026-05-10', {commits: 3});

        const row = computeQuarterlyAggregate(db, 'backend', QUARTER, NOW);

        expect(row.developer_count).toBe(3);
        expect(row.active_developer_count).toBe(1);
        expect(row.utilization_rate).toBeCloseTo(1 / 3, 4);
    });

    it('counts a developer who joined mid-quarter (partial quarter)', () => {
        addDeveloper(db, 'dev-early', 'backend'); // created 2026-01-01
        // Joined mid-quarter on 2026-05-15.
        addDeveloper(db, 'dev-late', 'backend', '2026-05-15T00:00:00.000Z');
        addGitSnapshot(db, 'dev-early', '2026-04-02', {commits: 2});
        addGitSnapshot(db, 'dev-late', '2026-06-01', {commits: 1});

        const row = computeQuarterlyAggregate(db, 'backend', QUARTER, NOW);

        // Both are in the team and existed by quarter end → both counted.
        expect(row.developer_count).toBe(2);
        expect(row.active_developer_count).toBe(2);

        // The same developer is NOT counted for a prior quarter they predate.
        const q1 = computeQuarterlyAggregate(db, 'backend', '2026-Q1', NOW);
        expect(q1.developer_count).toBe(1); // only dev-early existed in Q1
    });

    it('leaves avg_acceptance_rate null at launch (git-only, no tool data)', () => {
        addDeveloper(db, 'dev-1', 'backend');
        addGitSnapshot(db, 'dev-1', '2026-04-10', {commits: 2});

        const row = computeQuarterlyAggregate(db, 'backend', QUARTER, NOW);

        expect(row.avg_acceptance_rate).toBeNull();
        expect(row.total_estimated_api_cost).toBe(0);
    });

    it('flags cost-bearing seats with no tool activity as unused, with prorated wasted spend', () => {
        addDeveloper(db, 'dev-1', 'backend');
        // $90/mo seat held for the whole quarter (Apr–Jun = 3 full months).
        addSubscription(db, 'dev-1', {
            monthly_cost: 90,
            seat_assigned_at: '2026-01-01T00:00:00.000Z',
        });
        addGitSnapshot(db, 'dev-1', '2026-04-10', {commits: 2}); // git only, no tool use

        const row = computeQuarterlyAggregate(db, 'backend', QUARTER, NOW);

        expect(row.unused_seat_count).toBe(1);
        // Three whole calendar months held → exactly three monthly charges.
        expect(row.wasted_spend).toBe(270);
        expect(row.total_subscription_cost).toBe(270);
    });

    it('does not flag a seat with tool activity in the quarter', () => {
        addDeveloper(db, 'dev-1', 'backend');
        addSubscription(db, 'dev-1', {
            monthly_cost: 90,
            seat_assigned_at: '2026-01-01T00:00:00.000Z',
        });
        addToolSnapshot(db, 'dev-1', '2026-05-10', {is_active: 1, interaction_count: 12});

        const row = computeQuarterlyAggregate(db, 'backend', QUARTER, NOW);

        expect(row.unused_seat_count).toBe(0);
        expect(row.wasted_spend).toBe(0);
    });

    it('exempts a seat assigned within the inactivity threshold of the quarter end', () => {
        addDeveloper(db, 'dev-1', 'backend');
        // Assigned 2026-06-25 — fewer than 14 days before the 2026-06-30 quarter end.
        addSubscription(db, 'dev-1', {
            monthly_cost: 90,
            seat_assigned_at: '2026-06-25T00:00:00.000Z',
        });

        const row = computeQuarterlyAggregate(db, 'backend', QUARTER, NOW);

        expect(row.unused_seat_count).toBe(0);
    });

    it('handles a zero-activity / empty team without error', () => {
        addDeveloper(db, 'dev-1', 'backend');

        const row = computeQuarterlyAggregate(db, 'backend', QUARTER, NOW);

        expect(row.developer_count).toBe(1);
        expect(row.active_developer_count).toBe(0);
        expect(row.utilization_rate).toBe(0);
        expect(row.total_subscription_cost).toBe(0);
        expect(row.cost_per_pr).toBeNull();
        expect(row.unused_seat_count).toBe(0);
    });

    it('yields a null utilization for a team with no qualifying developers', () => {
        // No developers added for this team name.
        const row = computeQuarterlyAggregate(db, 'ghost-team', QUARTER, NOW);

        expect(row.developer_count).toBe(0);
        expect(row.utilization_rate).toBeNull();
    });

    it('is idempotent — recomputing overwrites the single row', () => {
        addDeveloper(db, 'dev-1', 'backend');
        addGitSnapshot(db, 'dev-1', '2026-04-10', {commits: 5, prs_merged: 1});
        computeQuarterlyAggregate(db, 'backend', QUARTER, NOW);
        addGitSnapshot(db, 'dev-1', '2026-05-10', {commits: 3, prs_merged: 2});
        const second = computeQuarterlyAggregate(db, 'backend', QUARTER, NOW);

        const count = (
            db
                .prepare(
                    'SELECT COUNT(*) AS c FROM quarterly_aggregates WHERE team = ? AND quarter = ?',
                )
                .get('backend', '2026-Q2') as {c: number}
        ).c;

        expect(count).toBe(1);
        expect(second.total_prs_merged).toBe(3);
    });
});

describe('computeAllQuarterlyAggregates', () => {
    it('computes one row per team for the quarter, in team order', () => {
        const db = makeDb();
        addDeveloper(db, 'dev-a', 'backend');
        addDeveloper(db, 'dev-b', 'frontend');
        addGitSnapshot(db, 'dev-a', '2026-04-02', {commits: 2});

        const rows = computeAllQuarterlyAggregates(db, QUARTER, NOW);

        expect(rows.map((r) => r.team)).toEqual(['backend', 'frontend']);
        expect(rows[0].active_developer_count).toBe(1);
        expect(rows[1].active_developer_count).toBe(0);
        expect(db.prepare('SELECT COUNT(*) AS c FROM quarterly_aggregates').get()).toEqual({c: 2});
        db.close();
    });
});
