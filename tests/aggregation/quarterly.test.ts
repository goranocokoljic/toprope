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
        // Maturity is now computed (Task 3.4) — an in-range git estimate, not null.
        expect(row.ai_maturity_score).toBeTypeOf('number');
        expect(row.ai_maturity_score!).toBeGreaterThanOrEqual(0);
        expect(row.ai_maturity_score!).toBeLessThanOrEqual(100);
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

    it('does not let tool use on a later re-assignment mark an already-revoked seat as used (held-window scoping)', () => {
        addDeveloper(db, 'dev-1', 'backend');
        // Seat held all of Q2 but with no tool activity *while held* → unused.
        addSubscription(db, 'dev-1', {
            monthly_cost: 30,
            seat_assigned_at: '2026-04-01T00:00:00.000Z',
            seat_revoked_at: '2026-05-01T00:00:00.000Z',
        });
        // Activity in June — after this seat was revoked. Must NOT clear the seat.
        addToolSnapshot(db, 'dev-1', '2026-06-15', {is_active: 1, interaction_count: 9});

        const row = computeQuarterlyAggregate(db, 'backend', QUARTER, NOW);

        // Held Apr 1..30 (30 days ≥ threshold), no activity in that window → unused.
        expect(row.unused_seat_count).toBe(1);
        // 30 of 30 April days at $30/mo → $30.
        expect(row.wasted_spend).toBe(30);
    });

    it('counts a revoke+reassign transition of the same tool as one logical seat', () => {
        addDeveloper(db, 'dev-1', 'backend');
        // Plan change mid-quarter: $20 seat revoked 2026-05-15, $50 seat assigned
        // the same instant. One logical (dev, tool) seat, not two.
        addSubscription(db, 'dev-1', {
            tool: 'copilot',
            monthly_cost: 20,
            seat_assigned_at: '2026-04-01T00:00:00.000Z',
            seat_revoked_at: '2026-05-15T00:00:00.000Z',
        });
        addSubscription(db, 'dev-1', {
            tool: 'copilot',
            monthly_cost: 50,
            seat_assigned_at: '2026-05-15T00:00:00.000Z',
        });
        addGitSnapshot(db, 'dev-1', '2026-04-10', {commits: 2}); // git only, no tool use

        const row = computeQuarterlyAggregate(db, 'backend', QUARTER, NOW);

        expect(row.unused_seat_count).toBe(1); // one logical seat, not two
        // Apr 1..May 14 at $20/mo + May 15..Jun 30 at $50/mo, prorated per month.
        // Apr: 30/30*20=20; May 1..14: 14/31*20=9.03; May 15..31: 17/31*50=27.42;
        // Jun: 30/30*50=50 → 20+9.03+27.42+50 = 106.45.
        expect(row.wasted_spend).toBeCloseTo(106.45, 2);
    });

    it('treats a disjoint re-grant of the same tool as one logical seat spanning the gap', () => {
        // Documents the held-span approximation: a seat revoked early then
        // re-assigned later in the quarter is one logical (dev, tool) seat, and
        // its held span covers the gap. wasted_spend stays exact (per-row).
        addDeveloper(db, 'dev-1', 'backend');
        addSubscription(db, 'dev-1', {
            tool: 'copilot',
            monthly_cost: 30,
            seat_assigned_at: '2026-01-01T00:00:00.000Z',
            seat_revoked_at: '2026-04-10T00:00:00.000Z',
        });
        addSubscription(db, 'dev-1', {
            tool: 'copilot',
            monthly_cost: 30,
            seat_assigned_at: '2026-06-20T00:00:00.000Z',
        });

        const row = computeQuarterlyAggregate(db, 'backend', QUARTER, NOW);

        expect(row.unused_seat_count).toBe(1); // one logical seat, not two
        // Only truly-held days are billed: Apr 1..9 (9 days) + Jun 20..30 (11 days)
        // at $30/mo → 9 + 11 = $20. The gap is not charged.
        expect(row.wasted_spend).toBe(20);
    });

    it('excludes seats of developers who joined the team after the period end', () => {
        // dev-future joined in Q3 but holds a seat assigned before the Q2 end.
        // They are not in Q2's head-count, so their seat must not appear in waste.
        addDeveloper(db, 'dev-future', 'backend', '2026-08-01T00:00:00.000Z');
        addSubscription(db, 'dev-future', {
            monthly_cost: 90,
            seat_assigned_at: '2026-01-01T00:00:00.000Z',
        });

        const row = computeQuarterlyAggregate(db, 'backend', QUARTER, NOW);

        expect(row.developer_count).toBe(0);
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
