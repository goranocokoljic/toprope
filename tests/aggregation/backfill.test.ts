import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import {
    runBackfill,
    resolveBackfillRange,
    type BackfillProgress,
} from '../../src/aggregation/backfill';
import {
    enumerateWeekStarts,
    enumerateMonths,
    enumerateQuarters,
    enumerateYears,
} from '../../src/aggregation/dates';
import {makeDb, addDeveloper, addGitSnapshot, addSubscription} from './helpers';

const NOW = new Date('2026-06-15T05:00:00.000Z');

/** Count rows in a table, optionally distinct on a column. */
function count(db: Database.Database, sql: string): number {
    return (db.prepare(sql).get() as {n: number}).n;
}

describe('resolveBackfillRange', () => {
    it('defaults to the trailing 12 months ending today (UTC)', () => {
        expect(resolveBackfillRange(undefined, undefined, NOW)).toEqual({
            from: '2025-06-15',
            to: '2026-06-15',
        });
    });

    it('defaults --from to 12 months before an explicit --to', () => {
        expect(resolveBackfillRange(undefined, '2026-01-31', NOW)).toEqual({
            from: '2025-01-31',
            to: '2026-01-31',
        });
    });

    it('respects an explicit --from and --to', () => {
        expect(resolveBackfillRange('2026-01-01', '2026-03-31', NOW)).toEqual({
            from: '2026-01-01',
            to: '2026-03-31',
        });
    });

    it('throws on a reversed explicit range', () => {
        expect(() => resolveBackfillRange('2026-03-31', '2026-01-01', NOW)).toThrow();
    });
});

describe('runBackfill', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });

    afterEach(() => db.close());

    /** Seed a team of two developers with git activity across Apr–Jun 2026. */
    function seedQuarter(): void {
        addDeveloper(db, 'dev-1', 'backend');
        addDeveloper(db, 'dev-2', 'backend');
        addSubscription(db, 'dev-1', {monthly_cost: 30, seat_assigned_at: '2026-01-01'});
        addSubscription(db, 'dev-2', {monthly_cost: 30, seat_assigned_at: '2026-01-01'});

        // April: lighter activity. May: heavier. June: medium. Lets deltas move.
        addGitSnapshot(db, 'dev-1', '2026-04-08', {commits: 2, prs_merged: 1, code_churn_rate: 0.3});
        addGitSnapshot(db, 'dev-2', '2026-04-09', {commits: 1, prs_merged: 1, code_churn_rate: 0.5});
        addGitSnapshot(db, 'dev-1', '2026-05-06', {commits: 8, prs_merged: 3, code_churn_rate: 0.2});
        addGitSnapshot(db, 'dev-2', '2026-05-07', {commits: 6, prs_merged: 2, code_churn_rate: 0.4});
        addGitSnapshot(db, 'dev-1', '2026-06-03', {commits: 4, prs_merged: 2, code_churn_rate: 0.25});
        addGitSnapshot(db, 'dev-2', '2026-06-04', {commits: 3, prs_merged: 1, code_churn_rate: 0.35});
    }

    it('produces aggregates at all four levels for the full range', () => {
        seedQuarter();
        const from = '2026-04-01';
        const to = '2026-06-30';

        const result = runBackfill(db, {from, to, now: NOW});

        // The result counts must match what the date enumerators say the range holds.
        expect(result.from).toBe(from);
        expect(result.to).toBe(to);
        expect(result.weeks).toBe(enumerateWeekStarts(from, to).length);
        expect(result.months).toBe(3); // Apr, May, Jun
        expect(result.quarters).toBe(1); // Q2
        expect(result.years).toBe(1); // 2026
        expect(result.periodsProcessed).toBe(result.weeks + result.months + result.quarters + result.years);

        // Rows actually landed in every aggregate table. Weekly/monthly are
        // per-developer (2 devs); quarterly/yearly per-team (1 team).
        expect(count(db, 'SELECT COUNT(*) AS n FROM weekly_aggregates')).toBe(result.weeks * 2);
        expect(count(db, 'SELECT COUNT(*) AS n FROM monthly_aggregates')).toBe(result.months * 2);
        expect(count(db, 'SELECT COUNT(*) AS n FROM quarterly_aggregates')).toBe(result.quarters * 1);
        expect(count(db, 'SELECT COUNT(*) AS n FROM yearly_aggregates')).toBe(result.years * 1);

        // rowsWritten accounts for every upsert.
        expect(result.rowsWritten).toBe(
            result.weeks * 2 + result.months * 2 + result.quarters * 1 + result.years * 1,
        );
    });

    it('spot-checks a backfilled month against the seeded snapshots', () => {
        seedQuarter();
        runBackfill(db, {from: '2026-04-01', to: '2026-06-30', now: NOW});

        const may = db
            .prepare(
                "SELECT total_commits, total_prs_merged FROM monthly_aggregates WHERE developer_id = ? AND month = ?",
            )
            .get('dev-1', '2026-05') as {total_commits: number; total_prs_merged: number};
        expect(may.total_commits).toBe(8);
        expect(may.total_prs_merged).toBe(3);
    });

    it('computes deltas chronologically: first period null, later periods comparing to prior', () => {
        seedQuarter();
        runBackfill(db, {from: '2026-04-01', to: '2026-06-30', now: NOW});

        const april = db
            .prepare(
                "SELECT commit_velocity_delta_pct FROM monthly_aggregates WHERE developer_id = ? AND month = ?",
            )
            .get('dev-1', '2026-04') as {commit_velocity_delta_pct: number | null};
        const may = db
            .prepare(
                "SELECT commit_velocity_delta_pct FROM monthly_aggregates WHERE developer_id = ? AND month = ?",
            )
            .get('dev-1', '2026-05') as {commit_velocity_delta_pct: number | null};

        // April is the first month in range → no prior month stored → null delta.
        expect(april.commit_velocity_delta_pct).toBeNull();
        // May (8 commits) vs April (2): (8-2)/2*100 = 300%. Non-null and positive
        // because May was processed after April had already been stored.
        expect(may.commit_velocity_delta_pct).toBe(300);
    });

    it('labels every maturity score git_estimate and stores it as a number', () => {
        seedQuarter();
        runBackfill(db, {from: '2026-04-01', to: '2026-06-30', now: NOW});

        const q = db
            .prepare("SELECT ai_maturity_score, ai_maturity_basis FROM quarterly_aggregates WHERE quarter = ?")
            .get('2026-Q2') as {ai_maturity_score: number | null; ai_maturity_basis: string};
        expect(q.ai_maturity_basis).toBe('git_estimate');
        expect(typeof q.ai_maturity_score).toBe('number');

        const y = db
            .prepare("SELECT ai_maturity_basis FROM yearly_aggregates WHERE year = ?")
            .get('2026') as {ai_maturity_basis: string};
        expect(y.ai_maturity_basis).toBe('git_estimate');

        // No basis row should ever be left unlabeled.
        expect(
            count(db, "SELECT COUNT(*) AS n FROM quarterly_aggregates WHERE ai_maturity_basis IS NULL"),
        ).toBe(0);
        expect(
            count(db, "SELECT COUNT(*) AS n FROM yearly_aggregates WHERE ai_maturity_basis IS NULL"),
        ).toBe(0);
    });

    it('is idempotent: re-running overwrites and never duplicates', () => {
        seedQuarter();
        const opts = {from: '2026-04-01', to: '2026-06-30', now: NOW};

        const first = runBackfill(db, opts);
        const weeklyAfterFirst = count(db, 'SELECT COUNT(*) AS n FROM weekly_aggregates');
        const mayCommitsFirst = (
            db
                .prepare("SELECT total_commits AS n FROM monthly_aggregates WHERE developer_id='dev-1' AND month='2026-05'")
                .get() as {n: number}
        ).n;

        const second = runBackfill(db, opts);

        // Same period/row counts both runs — overwrite, not append.
        expect(second.periodsProcessed).toBe(first.periodsProcessed);
        expect(second.rowsWritten).toBe(first.rowsWritten);
        expect(count(db, 'SELECT COUNT(*) AS n FROM weekly_aggregates')).toBe(weeklyAfterFirst);
        expect(count(db, 'SELECT COUNT(*) AS n FROM monthly_aggregates')).toBe(first.months * 2);

        // Values stable across the re-run.
        const mayCommitsSecond = (
            db
                .prepare("SELECT total_commits AS n FROM monthly_aggregates WHERE developer_id='dev-1' AND month='2026-05'")
                .get() as {n: number}
        ).n;
        expect(mayCommitsSecond).toBe(mayCommitsFirst);
    });

    it('emits per-period progress in chronological order, one event per period', () => {
        seedQuarter();
        const events: BackfillProgress[] = [];
        const result = runBackfill(db, {
            from: '2026-04-01',
            to: '2026-06-30',
            now: NOW,
            onProgress: (p) => events.push(p),
        });

        expect(events.length).toBe(result.periodsProcessed);
        // overallIndex is a 1..N running counter.
        expect(events.map((e) => e.overallIndex)).toEqual(
            Array.from({length: result.periodsProcessed}, (_, i) => i + 1),
        );
        // Levels run weekly → monthly → quarterly → yearly.
        expect(events.map((e) => e.level)).toEqual([
            ...Array(result.weeks).fill('weekly'),
            ...Array(result.months).fill('monthly'),
            ...Array(result.quarters).fill('quarterly'),
            ...Array(result.years).fill('yearly'),
        ]);
        // Monthly periods arrive chronologically.
        const months = events.filter((e) => e.level === 'monthly').map((e) => e.period);
        expect(months).toEqual(['2026-04', '2026-05', '2026-06']);
    });

    it('uses the trailing-12-month default range when from/to are omitted', () => {
        seedQuarter();
        const result = runBackfill(db, {now: NOW});

        expect(result.from).toBe('2025-06-15');
        expect(result.to).toBe('2026-06-15');
        expect(result.weeks).toBe(enumerateWeekStarts('2025-06-15', '2026-06-15').length);
        expect(result.months).toBe(enumerateMonths('2025-06-15', '2026-06-15').length);
        expect(result.quarters).toBe(enumerateQuarters('2025-06-15', '2026-06-15').length);
        expect(result.years).toBe(enumerateYears('2025-06-15', '2026-06-15').length);
    });

    it('handles an empty database without error (no developers, no teams)', () => {
        const result = runBackfill(db, {from: '2026-04-01', to: '2026-06-30', now: NOW});
        // Periods are still enumerated, but no developers/teams means zero rows.
        expect(result.periodsProcessed).toBeGreaterThan(0);
        expect(result.rowsWritten).toBe(0);
    });
});
