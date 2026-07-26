import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {randomUUID} from 'crypto';
import {runMigrations} from '../../src/storage/migrator';
import {addTeam} from '../../src/registry/teams';
import {addDeveloper} from '../../src/registry/developers';
import {computeAllWeeklyAggregates} from '../../src/aggregation/weekly';
import {computeAllMonthlyAggregates} from '../../src/aggregation/monthly';
import {recomputeAggregatesForRange} from '../../src/aggregation/retract';

/**
 * `recomputeAggregatesForRange` (#264 review SO-2/SEC-2).
 *
 * The defect it closes: `git_snapshots` is retractable, but the weekly/monthly/quarterly/
 * yearly rollups and `pr_review_metrics` are a SECOND projection of it — and the aggregation
 * scheduler only ever recomputes the just-closed period. So after a provider delete every
 * older period keeps the removed activity, and `/api/aggregates` serves it.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');
const NOW = new Date('2026-07-20T00:00:00.000Z');

describe('recomputeAggregatesForRange (#264)', () => {
    let db: Database.Database;
    let devId: string;

    function seedSnapshot(date: string, commits: number): void {
        db.prepare(
            `INSERT INTO git_snapshots (id, developer_id, date, commits, lines_added, is_projected)
             VALUES (?, ?, ?, ?, ?, 1)`,
        ).run(randomUUID(), devId, date, commits, commits * 10);
    }

    function weeklyCommits(weekStart: string): number {
        return (
            (
                db
                    .prepare(
                        `SELECT total_commits AS c FROM weekly_aggregates
                          WHERE developer_id = ? AND week_start = ?`,
                    )
                    .get(devId, weekStart) as {c: number} | undefined
            )?.c ?? 0
        );
    }

    function monthlyCommits(month: string): number {
        return (
            (
                db
                    .prepare(
                        `SELECT total_commits AS c FROM monthly_aggregates
                          WHERE developer_id = ? AND month = ?`,
                    )
                    .get(devId, month) as {c: number} | undefined
            )?.c ?? 0
        );
    }

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db, MIGRATIONS_DIR);
        addTeam(db, 'eng');
        devId = addDeveloper(db, 'Alice', 'eng', 'alice@example.com', undefined, {
            bitbucket: 'alice',
        }).id;
    });

    afterEach(() => db.close());

    it('rebuilds the rollups over the range so a retraction actually lands', () => {
        // Two weeks of activity, rolled up while it still existed.
        seedSnapshot('2026-06-02', 4); // ISO week starting 2026-06-01
        seedSnapshot('2026-06-10', 6); // ISO week starting 2026-06-08
        computeAllWeeklyAggregates(db, '2026-06-01', NOW);
        computeAllWeeklyAggregates(db, '2026-06-08', NOW);
        computeAllMonthlyAggregates(db, '2026-06', NOW);
        expect(weeklyCommits('2026-06-01')).toBe(4);
        expect(weeklyCommits('2026-06-08')).toBe(6);
        expect(monthlyCommits('2026-06')).toBe(10);

        // The retraction: the daily rows go (as the cascade would remove them)…
        db.prepare('DELETE FROM git_snapshots').run();
        // …and without this call the rollups above would keep reporting 4 / 6 / 10 forever.
        const result = recomputeAggregatesForRange(db, '2026-06-02', '2026-06-10', NOW);

        expect(result.error).toBeNull();
        expect(result.from).toBe('2026-06-02');
        expect(result.to).toBe('2026-06-10');
        // 2 weeks + 1 month + 1 quarter + 1 year.
        expect(result.periods).toBe(5);
        // 2 weeks + 1 month of pr_review_metrics.
        expect(result.prMetricPeriods).toBe(3);
        expect(weeklyCommits('2026-06-01')).toBe(0);
        expect(weeklyCommits('2026-06-08')).toBe(0);
        expect(monthlyCommits('2026-06')).toBe(0);
    });

    it('leaves a period OUTSIDE the range untouched', () => {
        seedSnapshot('2026-05-05', 9);
        computeAllWeeklyAggregates(db, '2026-05-04', NOW);
        expect(weeklyCommits('2026-05-04')).toBe(9);
        // The May snapshot survives; only June was retracted, so May must not be recomputed
        // (and must not change).
        seedSnapshot('2026-06-02', 4);
        recomputeAggregatesForRange(db, '2026-06-02', '2026-06-02', NOW);
        expect(weeklyCommits('2026-05-04')).toBe(9);
    });

    it('recomputes a partially-retracted day-set to the SURVIVING total, not to zero', () => {
        seedSnapshot('2026-06-02', 4);
        seedSnapshot('2026-06-03', 6);
        computeAllWeeklyAggregates(db, '2026-06-01', NOW);
        expect(weeklyCommits('2026-06-01')).toBe(10);

        // One container's day retracted, the other's survives — the shape a shared week has
        // after deleting one of two providers.
        db.prepare("DELETE FROM git_snapshots WHERE date = '2026-06-02'").run();
        recomputeAggregatesForRange(db, '2026-06-02', '2026-06-03', NOW);
        expect(weeklyCommits('2026-06-01')).toBe(6);
    });

    it('is a no-op for a null range (nothing was retracted)', () => {
        const result = recomputeAggregatesForRange(db, null, null, NOW);
        expect(result).toEqual({from: null, to: null, periods: 0, prMetricPeriods: 0, error: null});
        expect(
            (db.prepare('SELECT COUNT(*) AS n FROM weekly_aggregates').get() as {n: number}).n,
        ).toBe(0);
    });

    // The delete has already committed by the time this runs, so a failure must be REPORTED,
    // not thrown — otherwise an admin sees a 500 for a delete that actually succeeded and has
    // no idea the trend charts are stale.
    it('reports a failure instead of throwing, so the committed delete is not reported as a 500', () => {
        const result = recomputeAggregatesForRange(db, 'not-a-date', '2026-06-10', NOW);
        expect(result.error).not.toBeNull();
        expect(result.periods).toBe(0);
        expect(result.from).toBe('not-a-date');
    });
});
