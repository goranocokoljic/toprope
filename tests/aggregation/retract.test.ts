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
import {computePRReviewMetricsForPeriod} from '../../src/coaching/pr-review/compute';
import {generateCoachingSignalsForPeriod} from '../../src/coaching/available/generator';

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
        expect(result.coachingPeriods).toBe(3);
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
        expect(result).toEqual({
            from: null,
            to: null,
            periods: 0,
            coachingPeriods: 0,
            truncated: false,
            anomaliesNotRescanned: false,
            error: null,
        });
        expect(
            (db.prepare('SELECT COUNT(*) AS n FROM weekly_aggregates').get() as {n: number}).n,
        ).toBe(0);
    });

    // The delete has already committed by the time this runs, so a failure must be REPORTED,
    // not thrown — otherwise an admin sees a 500 for a delete that actually succeeded and has
    // no idea the trend charts are stale.
    it('reports a failure instead of throwing, so the committed delete is not reported as a 500', () => {
        const result = recomputeAggregatesForRange(db, 'not-a-date', '2026-06-10', NOW);
        expect(result.error).toMatch(/malformed range/);
        expect(result.periods).toBe(0);
    });

    // A malformed bound must not be SILENTLY skipped. It byte-sorts above every real date, so a
    // clamp that compared it as a date would read it as "entirely in the future" and return a
    // clean no-op — reporting success for a recompute that never happened.
    it('refuses a malformed bound loudly rather than treating it as a future date', () => {
        seedSnapshot('2026-06-02', 4);
        computeAllWeeklyAggregates(db, '2026-06-01', NOW);
        db.prepare('DELETE FROM git_snapshots').run();

        const result = recomputeAggregatesForRange(db, '2026-6-2', '2026-06-10', NOW);
        expect(result.error).toMatch(/malformed range/);
        expect(result.truncated).toBe(false);
        // And nothing was recomputed, which is exactly why it has to be reported.
        expect(weeklyCommits('2026-06-01')).toBe(4);
    });

    // #264 review TST-4: a failure MID-WALK must report the periods that already committed.
    // `runBackfill` commits one transaction per period, so reporting 0 would tell the operator
    // nothing happened when half the span may already be correct.
    it('reports the periods that DID commit when the walk fails part-way', () => {
        seedSnapshot('2026-06-02', 4);
        seedSnapshot('2026-07-02', 6);
        // Abort the monthly level, which runs AFTER every weekly period has committed.
        db.exec(
            `CREATE TRIGGER boom BEFORE INSERT ON monthly_aggregates
             BEGIN SELECT RAISE(ABORT, 'boom'); END`,
        );

        const result = recomputeAggregatesForRange(db, '2026-06-02', '2026-07-02', NOW);

        expect(result.error).toMatch(/boom/);
        // The weekly periods landed and are reported, not zeroed — which is the whole point: a
        // `periods: 0` here would tell the operator nothing happened when the weekly half of the
        // span is already correct.
        expect(result.periods).toBeGreaterThan(0);
        expect(
            (db.prepare('SELECT COUNT(*) AS n FROM weekly_aggregates').get() as {n: number}).n,
        ).toBeGreaterThan(0);
    });

    // #264 review SEC-1/SO-1: the span comes from `raw_author_daily.date`, which is the
    // provider's client-set AUTHOR date — nothing downstream clamps it. Without a bound, one
    // `git commit --date=9999-01-01` turns a delete into ~400k period transactions on the
    // synchronous connection: a process-wide hang after the cascade already committed.
    describe('range clamping', () => {
        it('clamps a FUTURE upper bound to today and reports the truncation', () => {
            const result = recomputeAggregatesForRange(db, '2026-07-01', '9999-01-01', NOW);
            expect(result.truncated).toBe(true);
            expect(result.to).toBe('2026-07-20'); // NOW
            // Bounded: a handful of periods, not hundreds of thousands.
            expect(result.periods).toBeLessThan(20);
            expect(result.error).toBeNull();
        });

        it('clamps an ANCIENT lower bound to the ceiling and reports the truncation', () => {
            const result = recomputeAggregatesForRange(db, '0001-01-01', '2026-07-02', NOW);
            expect(result.truncated).toBe(true);
            expect(result.from).toBe(
                new Date(Date.UTC(2026 - 3, 6, 2)).toISOString().slice(0, 10),
            );
            expect(result.periods).toBeGreaterThan(0);
            expect(result.error).toBeNull();
        });

        it('does not report truncation for an ordinary in-window span', () => {
            const result = recomputeAggregatesForRange(db, '2026-06-02', '2026-06-10', NOW);
            expect(result.truncated).toBe(false);
        });

        it('is a truncated no-op when the ENTIRE retracted span is in the future', () => {
            const result = recomputeAggregatesForRange(db, '2099-01-01', '2099-02-01', NOW);
            expect(result.truncated).toBe(true);
            expect(result.periods).toBe(0);
            expect(result.error).toBeNull();
            // Reports the CLAMPED bounds, not nulls — the banner renders them as "capped at X → Y",
            // and "capped at null → null" would be incoherent.
            expect(result.from).not.toBeNull();
            expect(result.to).toBe('2026-07-20');
        });

        // The contract is "never throws" because the cascade has already committed by the time
        // this runs — an exception here would turn a successful delete into a 500 with no report.
        // `now.toISOString()` on an Invalid Date is the one throw that happens before the walk.
        it('reports rather than throws when `now` is an Invalid Date', () => {
            const result = recomputeAggregatesForRange(db, '2026-06-02', '2026-06-10', new Date(NaN));
            expect(result.error).toMatch(/Could not resolve the recompute range/);
            expect(result.periods).toBe(0);
        });
    });

    // #264 review TST-3: `pr_review_metrics` is the one thing this module adds over
    // `runBackfill`, and a loop counter proves nothing — an off-by-one `isoWeekLabel` would
    // recompute the WRONG week while the count stayed right.
    describe('pr_review_metrics and coaching_signals are actually retracted', () => {
        function seedPR(date: string): void {
            db.prepare(
                `INSERT INTO pr_records
                 (id, developer_id, provider, container, repo, pr_id, state, created_at, merged_at,
                  closed_at, review_comment_count, review_rounds, changes_requested_count,
                  time_to_merge_hours, synced_at)
                 VALUES (?, ?, 'github', 'acme', 'repo1', ?, 'merged', ?, ?, NULL, 2, 1, 0, 5, ?)`,
            ).run(randomUUID(), devId, `pr-${date}`, `${date}T08:00:00.000Z`, `${date}T13:00:00.000Z`, `${date}T14:00:00.000Z`);
        }
        function prMetricRows(period: string): number {
            return (
                db
                    .prepare(
                        `SELECT COUNT(*) AS n FROM pr_review_metrics
                          WHERE developer_id = ? AND period = ?`,
                    )
                    .get(devId, period) as {n: number}
            ).n;
        }

        it('removes a stale pr_review_metrics row for the exact retracted week', () => {
            seedPR('2026-06-02'); // ISO week 2026-W23
            computePRReviewMetricsForPeriod(db, 'weekly', '2026-W23', NOW);
            expect(prMetricRows('2026-W23')).toBeGreaterThan(0);

            // Retract the PR (as the cascade would) and recompute the span it fell in.
            db.prepare('DELETE FROM pr_records').run();
            const result = recomputeAggregatesForRange(db, '2026-06-02', '2026-06-02', NOW);

            expect(result.error).toBeNull();
            // The RIGHT week was recomputed — a wrong label would leave this row behind.
            expect(prMetricRows('2026-W23')).toBe(0);
        });

        // The week/month label conversion is the fragile part; a year-boundary span is where a
        // hand-rolled ISO-week computation is most likely to be off by one.
        it('handles a span that crosses an ISO-year boundary', () => {
            seedPR('2025-12-30'); // ISO week 2026-W01
            computePRReviewMetricsForPeriod(db, 'weekly', '2026-W01', NOW);
            expect(prMetricRows('2026-W01')).toBeGreaterThan(0);

            db.prepare('DELETE FROM pr_records').run();
            const result = recomputeAggregatesForRange(db, '2025-12-29', '2026-01-04', NOW);

            expect(result.error).toBeNull();
            expect(prMetricRows('2026-W01')).toBe(0);
        });

        // #264 review TST-1: `coachingPeriods` is a bare counter incremented NEXT TO the call, so
        // asserting it proves nothing — the reviewer verified that deleting both
        // `generateCoachingSignalsForPeriod` calls left 51 tests green. This asserts the EFFECT:
        // the engine is delete-then-insert per period, so a signal derived from a retracted day
        // must be gone afterwards.
        it('actually retracts coaching_signals for the recomputed period', () => {
            seedSnapshot('2026-06-02', 12); // ISO week 2026-W23
            generateCoachingSignalsForPeriod(db, 'weekly', '2026-W23', NOW);
            const signalsFor = (period: string): number =>
                (
                    db
                        .prepare('SELECT COUNT(*) AS n FROM coaching_signals WHERE period = ?')
                        .get(period) as {n: number}
                ).n;
            expect(signalsFor('2026-W23')).toBeGreaterThan(0);

            // Retract the day (as the cascade would) and recompute the span it fell in.
            db.prepare('DELETE FROM git_snapshots').run();
            const result = recomputeAggregatesForRange(db, '2026-06-02', '2026-06-02', NOW);

            expect(result.error).toBeNull();
            expect(result.coachingPeriods).toBeGreaterThan(0);
            // The RIGHT week was recomputed — a wrong ISO label would leave this row behind, and
            // a missing call would leave it behind too.
            expect(signalsFor('2026-W23')).toBe(0);
            // And says plainly that anomaly alerts were NOT re-scanned.
            expect(result.anomaliesNotRescanned).toBe(true);
        });

        // #264 review TST-2 / SO-4: the staleness marking is new wiring in the retraction path and
        // was asserted nowhere — and only the MONTHLY arm was wired, so a weekly narrative kept
        // naming retracted commits and was never flagged.
        it('marks in-range narrative summaries stale, at BOTH period units', () => {
            const seedSummary = (periodType: string, periodValue: string): string => {
                const id = randomUUID();
                db.prepare(
                    `INSERT INTO summaries
                     (id, scope, scope_name, period_type, period_value, summary_text, model_used,
                      data_hash, input_hash, generated_at, is_stale)
                     VALUES (?, 'org', 'org', ?, ?, 'Commits rose sharply.', 'test-model',
                             'stale-hash', 'stale-hash', ?, 0)`,
                ).run(id, periodType, periodValue, NOW.toISOString());
                return id;
            };
            const isStale = (id: string): number =>
                (db.prepare('SELECT is_stale FROM summaries WHERE id = ?').get(id) as {is_stale: number})
                    .is_stale;

            seedSnapshot('2026-06-02', 5);
            const weekly = seedSummary('weekly', '2026-W23');
            const monthly = seedSummary('monthly', '2026-06');
            expect(isStale(weekly)).toBe(0);
            expect(isStale(monthly)).toBe(0);

            db.prepare('DELETE FROM git_snapshots').run();
            expect(recomputeAggregatesForRange(db, '2026-06-02', '2026-06-02', NOW).error).toBeNull();

            expect(isStale(weekly)).toBe(1);
            expect(isStale(monthly)).toBe(1);
        });
    });
});
