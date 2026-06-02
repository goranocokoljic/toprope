import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import {
    computeWeeklyAggregate,
    computeAllWeeklyAggregates,
} from '../../src/aggregation/weekly';
import {
    makeDb,
    addDeveloper,
    addGitSnapshot,
    addToolSnapshot,
    addSubscription,
} from './helpers';

// ISO week under test: Monday 2026-05-04 .. Sunday 2026-05-10.
const WEEK = '2026-05-06'; // any day inside the week
const NOW = new Date('2026-05-11T04:00:00.000Z');

describe('computeWeeklyAggregate', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        addDeveloper(db, 'dev-1', 'backend');
    });

    afterEach(() => db.close());

    it('sums git metrics for a known fixture week and ignores out-of-week days', () => {
        addGitSnapshot(db, 'dev-1', '2026-05-04', {
            commits: 5,
            lines_added: 200,
            prs_merged: 1,
            code_churn_rate: 0.2,
            ai_signature_score: 0.8,
        });
        addGitSnapshot(db, 'dev-1', '2026-05-06', {
            commits: 3,
            lines_added: 100,
            prs_merged: 1,
            code_churn_rate: 0.4,
            ai_signature_score: 0.6,
        });
        // Next ISO week — must be excluded.
        addGitSnapshot(db, 'dev-1', '2026-05-11', {commits: 99, lines_added: 9999, prs_merged: 9});

        const row = computeWeeklyAggregate(db, 'dev-1', WEEK, NOW);

        expect(row.week_start).toBe('2026-05-04');
        expect(row.team).toBe('backend');
        expect(row.total_commits).toBe(8);
        expect(row.total_lines_added).toBe(300);
        expect(row.total_prs_merged).toBe(2);
        expect(row.avg_code_churn).toBe(0.3);
        expect(row.avg_ai_signature_score).toBe(0.7);
        expect(row.active_days).toBe(2);
        expect(row.is_active).toBe(1);
        expect(row.computed_at).toBe(NOW.toISOString());
    });

    it('reports data_quality "medium" and null/zero tool fields for a git-only week', () => {
        addGitSnapshot(db, 'dev-1', '2026-05-04', {commits: 2, code_churn_rate: 0.1});

        const row = computeWeeklyAggregate(db, 'dev-1', WEEK, NOW);

        expect(row.data_quality).toBe('medium');
        expect(row.total_interactions).toBe(0);
        expect(row.total_acceptances).toBe(0);
        expect(row.avg_acceptance_rate).toBeNull();
        expect(row.estimated_total_cost).toBeNull();
        expect(row.tools_used).toBe('[]');
    });

    it('reports data_quality "high" and tool metrics when tool data exists', () => {
        addGitSnapshot(db, 'dev-1', '2026-05-04', {commits: 2});
        addToolSnapshot(db, 'dev-1', '2026-05-04', {
            tool: 'copilot',
            is_active: 1,
            interaction_count: 40,
            acceptance_count: 30,
            acceptance_rate: 0.75,
            estimated_cost: 1.5,
        });
        addToolSnapshot(db, 'dev-1', '2026-05-05', {
            tool: 'claude_code',
            is_active: 1,
            interaction_count: 10,
            acceptance_count: 8,
            acceptance_rate: 0.8,
            estimated_cost: 0.5,
        });

        const row = computeWeeklyAggregate(db, 'dev-1', WEEK, NOW);

        expect(row.data_quality).toBe('high');
        expect(row.total_interactions).toBe(50);
        expect(row.total_acceptances).toBe(38);
        // Interaction-weighted: 38 accepted / 50 offered, not the flat mean (0.775).
        expect(row.avg_acceptance_rate).toBe(0.76);
        expect(row.estimated_total_cost).toBe(2);
        expect(JSON.parse(row.tools_used)).toEqual(['claude_code', 'copilot']);
    });

    it('does not upgrade to "high" for a dormant (unused) seat snapshot', () => {
        addGitSnapshot(db, 'dev-1', '2026-05-04', {commits: 2});
        // A connector wrote a "seat exists, unused today" row: no usage signal.
        addToolSnapshot(db, 'dev-1', '2026-05-04', {
            tool: 'copilot',
            is_active: 0,
            interaction_count: 0,
            acceptance_count: 0,
        });

        const row = computeWeeklyAggregate(db, 'dev-1', WEEK, NOW);

        // The git signal is the real evidence here — quality stays medium.
        expect(row.data_quality).toBe('medium');
        expect(row.avg_acceptance_rate).toBeNull();
        expect(row.tools_used).toBe('[]');
        // active_days still counts the git day, not the dormant tool row.
        expect(row.active_days).toBe(1);
    });

    it('counts distinct active days, not total events (git + tool on the same day)', () => {
        addGitSnapshot(db, 'dev-1', '2026-05-04', {commits: 2});
        addToolSnapshot(db, 'dev-1', '2026-05-04', {is_active: 1, interaction_count: 5});
        addGitSnapshot(db, 'dev-1', '2026-05-06', {commits: 1});

        const row = computeWeeklyAggregate(db, 'dev-1', WEEK, NOW);

        // Two calendar days had activity even though there were three snapshots.
        expect(row.active_days).toBe(2);
    });

    it('prorates subscription cost and divides by PRs', () => {
        addGitSnapshot(db, 'dev-1', '2026-05-04', {commits: 5, prs_merged: 2});
        // $31/mo held across the whole week of a 31-day month → 7 days × 31/31 = $7.
        addSubscription(db, 'dev-1', {monthly_cost: 31, seat_assigned_at: '2026-04-01T00:00:00.000Z'});

        const row = computeWeeklyAggregate(db, 'dev-1', WEEK, NOW);

        expect(row.subscription_cost).toBe(7);
        expect(row.cost_per_pr).toBe(3.5);
    });

    it('returns null cost_per_pr (not divide-by-zero) when no PRs merged', () => {
        addGitSnapshot(db, 'dev-1', '2026-05-04', {commits: 5, prs_merged: 0});
        addSubscription(db, 'dev-1', {monthly_cost: 31, seat_assigned_at: '2026-04-01T00:00:00.000Z'});

        const row = computeWeeklyAggregate(db, 'dev-1', WEEK, NOW);

        expect(row.subscription_cost).toBe(7);
        expect(row.cost_per_pr).toBeNull();
    });

    it('handles a zero-activity week without error', () => {
        const row = computeWeeklyAggregate(db, 'dev-1', WEEK, NOW);

        expect(row.active_days).toBe(0);
        expect(row.is_active).toBe(0);
        expect(row.data_quality).toBe('low');
        expect(row.total_commits).toBe(0);
        expect(row.avg_code_churn).toBeNull();
        expect(row.avg_ai_signature_score).toBeNull();
        expect(row.subscription_cost).toBe(0);
        expect(row.cost_per_pr).toBeNull();
        expect(row.tools_used).toBe('[]');
    });

    it('rounds means and costs without float artifacts', () => {
        addGitSnapshot(db, 'dev-1', '2026-05-04', {
            commits: 1,
            code_churn_rate: 0.1,
            ai_signature_score: 0.1,
        });
        addGitSnapshot(db, 'dev-1', '2026-05-05', {
            commits: 1,
            code_churn_rate: 0.2,
            ai_signature_score: 0.2,
        });
        addToolSnapshot(db, 'dev-1', '2026-05-04', {estimated_cost: 0.1, interaction_count: 1});
        addToolSnapshot(db, 'dev-1', '2026-05-05', {estimated_cost: 0.2, interaction_count: 1});

        const row = computeWeeklyAggregate(db, 'dev-1', WEEK, NOW);

        // (0.1 + 0.2) / 2 is 0.15000000000000002 in IEEE-754; must round clean.
        expect(row.avg_code_churn).toBe(0.15);
        expect(row.avg_ai_signature_score).toBe(0.15);
        // 0.1 + 0.2 is 0.30000000000000004 in IEEE-754.
        expect(row.estimated_total_cost).toBe(0.3);
    });

    it('is idempotent — recomputing overwrites the single row', () => {
        addGitSnapshot(db, 'dev-1', '2026-05-04', {commits: 5, prs_merged: 1});

        const first = computeWeeklyAggregate(db, 'dev-1', WEEK, NOW);
        // Mutate the underlying data, then recompute the same week.
        addGitSnapshot(db, 'dev-1', '2026-05-06', {commits: 3, prs_merged: 1});
        const second = computeWeeklyAggregate(db, 'dev-1', WEEK, NOW);

        const count = (
            db
                .prepare(
                    'SELECT COUNT(*) AS c FROM weekly_aggregates WHERE developer_id = ? AND week_start = ?',
                )
                .get('dev-1', '2026-05-04') as {c: number}
        ).c;

        expect(count).toBe(1);
        expect(first.total_commits).toBe(5);
        expect(second.total_commits).toBe(8);

        const stored = db
            .prepare('SELECT total_commits FROM weekly_aggregates WHERE developer_id = ? AND week_start = ?')
            .get('dev-1', '2026-05-04') as {total_commits: number};
        expect(stored.total_commits).toBe(8);
    });

    it('throws for an unknown developer', () => {
        expect(() => computeWeeklyAggregate(db, 'ghost', WEEK, NOW)).toThrow(/Unknown developer/);
    });
});

describe('computeAllWeeklyAggregates', () => {
    it('computes a row per developer for the week', () => {
        const db = makeDb();
        addDeveloper(db, 'dev-a', 'backend');
        addDeveloper(db, 'dev-b', 'frontend');
        addGitSnapshot(db, 'dev-a', '2026-05-04', {commits: 2});

        const rows = computeAllWeeklyAggregates(db, WEEK, NOW);

        expect(rows.map((r) => r.developer_id)).toEqual(['dev-a', 'dev-b']);
        expect(rows[0].is_active).toBe(1);
        expect(rows[1].is_active).toBe(0);
        expect(db.prepare('SELECT COUNT(*) AS c FROM weekly_aggregates').get()).toEqual({c: 2});
        db.close();
    });
});
