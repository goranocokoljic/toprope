import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import {computeWeeklyAggregate} from '../../src/aggregation/weekly';
import {computeMonthlyAggregate} from '../../src/aggregation/monthly';
import {computeQuarterlyAggregate} from '../../src/aggregation/quarterly';
import {makeDb, addDeveloper, addGitSnapshot} from './helpers';

const NOW = new Date('2026-06-01T04:30:00.000Z');

describe('weekly delta wiring', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        addDeveloper(db, 'dev-1', 'backend');
    });

    afterEach(() => db.close());

    it('yields null deltas for the very first week (no prior period)', () => {
        addGitSnapshot(db, 'dev-1', '2026-05-04', {commits: 10, prs_merged: 2});
        const row = computeWeeklyAggregate(db, 'dev-1', '2026-05-04', NOW);

        expect(row.commit_velocity_delta_pct).toBeNull();
        expect(row.prs_merged_delta_pct).toBeNull();
        expect(row.churn_rate_delta).toBeNull();
        expect(row.ai_signature_delta).toBeNull();
        expect(row.cost_per_pr_delta_pct).toBeNull();
    });

    it('computes deltas against the prior week once both are rolled up', () => {
        // Prior week (Mon 2026-04-27): 10 commits, churn 0.20, signature 0.50.
        addGitSnapshot(db, 'dev-1', '2026-04-27', {
            commits: 10,
            prs_merged: 2,
            code_churn_rate: 0.2,
            ai_signature_score: 0.5,
        });
        // Current week (Mon 2026-05-04): 12 commits, churn 0.11, signature 0.54.
        addGitSnapshot(db, 'dev-1', '2026-05-04', {
            commits: 12,
            prs_merged: 3,
            code_churn_rate: 0.11,
            ai_signature_score: 0.54,
        });

        computeWeeklyAggregate(db, 'dev-1', '2026-04-27', NOW); // prior first
        const current = computeWeeklyAggregate(db, 'dev-1', '2026-05-04', NOW);

        expect(current.commit_velocity_delta_pct).toBe(20); // (12-10)/10*100
        expect(current.prs_merged_delta_pct).toBe(50); // (3-2)/2*100
        expect(current.churn_rate_delta).toBe(-0.09); // 0.11 - 0.20, points
        expect(current.ai_signature_delta).toBe(0.04); // 0.54 - 0.50, points
    });

    it('recomputes deltas correctly when late data changes the current period', () => {
        addGitSnapshot(db, 'dev-1', '2026-04-27', {commits: 10});
        addGitSnapshot(db, 'dev-1', '2026-05-04', {commits: 12});
        computeWeeklyAggregate(db, 'dev-1', '2026-04-27', NOW);
        const first = computeWeeklyAggregate(db, 'dev-1', '2026-05-04', NOW);
        expect(first.commit_velocity_delta_pct).toBe(20); // (12-10)/10*100

        // Late data lands in the current week → re-run recomputes the delta.
        addGitSnapshot(db, 'dev-1', '2026-05-06', {commits: 8});
        const second = computeWeeklyAggregate(db, 'dev-1', '2026-05-04', NOW);
        expect(second.total_commits).toBe(20);
        expect(second.commit_velocity_delta_pct).toBe(100); // (20-10)/10*100

        // And exactly one row remains — recompute overwrote, not appended.
        const count = (
            db
                .prepare('SELECT COUNT(*) AS c FROM weekly_aggregates WHERE developer_id = ?')
                .get('dev-1') as {c: number}
        ).c;
        expect(count).toBe(2); // prior week + current week
    });

    it('guards divide-by-zero when the prior week had zero commits', () => {
        addGitSnapshot(db, 'dev-1', '2026-04-27', {prs_merged: 1}); // active, but 0 commits
        addGitSnapshot(db, 'dev-1', '2026-05-04', {commits: 5, prs_merged: 1});
        computeWeeklyAggregate(db, 'dev-1', '2026-04-27', NOW);
        const current = computeWeeklyAggregate(db, 'dev-1', '2026-05-04', NOW);

        expect(current.commit_velocity_delta_pct).toBe(500); // (5-0)/max(0,1)*100
        expect(Number.isFinite(current.commit_velocity_delta_pct as number)).toBe(true);
    });
});

describe('monthly delta wiring', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        addDeveloper(db, 'dev-1', 'backend');
    });

    afterEach(() => db.close());

    it('computes deltas against the prior month', () => {
        addGitSnapshot(db, 'dev-1', '2026-04-10', {commits: 100, prs_merged: 20});
        addGitSnapshot(db, 'dev-1', '2026-05-10', {commits: 120, prs_merged: 22});
        computeMonthlyAggregate(db, 'dev-1', '2026-04', NOW);
        const may = computeMonthlyAggregate(db, 'dev-1', '2026-05', NOW);

        expect(may.commit_velocity_delta_pct).toBe(20); // (120-100)/100*100
        expect(may.prs_merged_delta_pct).toBe(10); // (22-20)/20*100
    });

    it('first month has null deltas', () => {
        addGitSnapshot(db, 'dev-1', '2026-05-10', {commits: 120});
        const may = computeMonthlyAggregate(db, 'dev-1', '2026-05', NOW);
        expect(may.commit_velocity_delta_pct).toBeNull();
        expect(may.prs_merged_delta_pct).toBeNull();
        expect(may.cost_per_pr_delta_pct).toBeNull();
    });
});

describe('quarterly delta wiring', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        addDeveloper(db, 'dev-1', 'backend');
    });

    afterEach(() => db.close());

    it('computes utilization_rate_delta against the prior quarter, maturity stays null', () => {
        // Q1: developer inactive (0 active / 1 dev → utilization 0).
        // Q2: developer active (1/1 → utilization 1). Delta = +1.0 points.
        addGitSnapshot(db, 'dev-1', '2026-04-10', {commits: 5});
        computeQuarterlyAggregate(db, 'backend', '2026-Q1', NOW);
        const q2 = computeQuarterlyAggregate(db, 'backend', '2026-Q2', NOW);

        expect(q2.utilization_rate).toBe(1);
        expect(q2.utilization_rate_delta).toBe(1); // 1 - 0 points
        expect(q2.maturity_score_delta).toBeNull(); // no maturity score until Task 3.4
    });

    it('first quarter has null utilization delta', () => {
        addGitSnapshot(db, 'dev-1', '2026-04-10', {commits: 5});
        const q2 = computeQuarterlyAggregate(db, 'backend', '2026-Q2', NOW);
        expect(q2.utilization_rate_delta).toBeNull();
        expect(q2.maturity_score_delta).toBeNull();
    });
});
