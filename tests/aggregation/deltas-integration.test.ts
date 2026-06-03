import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import {computeWeeklyAggregate} from '../../src/aggregation/weekly';
import {computeMonthlyAggregate} from '../../src/aggregation/monthly';
import {computeQuarterlyAggregate} from '../../src/aggregation/quarterly';
import {makeDb, addDeveloper, addGitSnapshot, addToolSnapshot, addSubscription} from './helpers';

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

    it('compares against the immediately-preceding week only — a gap yields null deltas', () => {
        // Data in week N-2 (2026-04-20) and week N (2026-05-04); week N-1 skipped.
        addGitSnapshot(db, 'dev-1', '2026-04-20', {commits: 10});
        addGitSnapshot(db, 'dev-1', '2026-05-04', {commits: 12});
        computeWeeklyAggregate(db, 'dev-1', '2026-04-20', NOW); // N-2 rolled up
        // N-1 (2026-04-27) is never computed → no stored row to compare against.
        const current = computeWeeklyAggregate(db, 'dev-1', '2026-05-04', NOW);

        // Delta is "vs last week," not "vs the most recent week with data," so the
        // missing N-1 row makes it null rather than silently comparing to N-2.
        expect(current.commit_velocity_delta_pct).toBeNull();
    });

    it('re-running the prior week does NOT cascade into the current week\'s stored delta', () => {
        addGitSnapshot(db, 'dev-1', '2026-04-27', {commits: 10});
        addGitSnapshot(db, 'dev-1', '2026-05-04', {commits: 12});
        computeWeeklyAggregate(db, 'dev-1', '2026-04-27', NOW);
        const current = computeWeeklyAggregate(db, 'dev-1', '2026-05-04', NOW);
        expect(current.commit_velocity_delta_pct).toBe(20); // (12-10)/10*100

        // Late data lands in the PRIOR week and it is recomputed. The current
        // week's stored delta is intentionally left stale until it is itself
        // re-run — the documented non-cascade contract.
        addGitSnapshot(db, 'dev-1', '2026-04-28', {commits: 10}); // prior week now 20
        computeWeeklyAggregate(db, 'dev-1', '2026-04-27', NOW);

        const storedCurrentDelta = (
            db
                .prepare(
                    'SELECT commit_velocity_delta_pct AS d FROM weekly_aggregates WHERE developer_id = ? AND week_start = ?',
                )
                .get('dev-1', '2026-05-04') as {d: number | null}
        ).d;
        expect(storedCurrentDelta).toBe(20); // unchanged — no cascade

        // Re-running the current week refreshes it against the prior week's new value.
        const refreshed = computeWeeklyAggregate(db, 'dev-1', '2026-05-04', NOW);
        expect(refreshed.commit_velocity_delta_pct).toBe(-40); // (12-20)/20*100
    });

    it('computes tool & cost deltas through the DB round-trip (interaction/acceptance/cost columns)', () => {
        // Two adjacent weeks both fully inside May (so the prorated per-day seat
        // rate and 7-day window match exactly, isolating the delta to the metrics).
        // Prior week (Mon 2026-05-04): 100 interactions, 70 accepted (rate 0.70), 4 PRs.
        addToolSnapshot(db, 'dev-1', '2026-05-04', {
            is_active: 1,
            interaction_count: 100,
            acceptance_count: 70,
        });
        addGitSnapshot(db, 'dev-1', '2026-05-04', {prs_merged: 4});
        // Current week (Mon 2026-05-11): 200 interactions, 160 accepted (rate 0.80), 4 PRs.
        addToolSnapshot(db, 'dev-1', '2026-05-11', {
            is_active: 1,
            interaction_count: 200,
            acceptance_count: 160,
        });
        addGitSnapshot(db, 'dev-1', '2026-05-11', {prs_merged: 4});
        addSubscription(db, 'dev-1', {
            monthly_cost: 30,
            seat_assigned_at: '2026-01-01T00:00:00.000Z',
        });

        computeWeeklyAggregate(db, 'dev-1', '2026-05-04', NOW);
        const current = computeWeeklyAggregate(db, 'dev-1', '2026-05-11', NOW);

        // These three columns are added by migration 016 and read back via the
        // DEVELOPER_VALUE_COLUMNS SELECT — exercise that round-trip, not just the
        // pure formula.
        expect(current.interaction_delta_pct).toBe(100); // (200-100)/100*100
        expect(current.acceptance_rate_delta).toBe(0.1); // 0.80 - 0.70 points
        // Identical prorated weekly cost and same 4 PRs both weeks → 0% change.
        expect(current.cost_per_pr_delta_pct).toBe(0);
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
