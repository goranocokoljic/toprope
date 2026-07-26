/**
 * Recompute the DERIVED aggregates after a retraction (#264 review SO-2/SEC-2).
 *
 * `git_snapshots` is a projection of `raw_author_daily`, so a provider delete can retract it
 * directly. Everything downstream is a *second* projection: `weekly_aggregates`,
 * `monthly_aggregates`, `quarterly_aggregates`, `yearly_aggregates` and `pr_review_metrics`
 * are all UPSERTed per period key from the daily rows. Retracting the daily rows therefore
 * leaves every already-computed period holding totals for activity that no longer exists.
 *
 * THE SCHEDULER DOES NOT FIX THIS. `runScheduledJob` recomputes exactly
 * `justCompletedPeriod(...)` — one week / one month / one quarter / one year — plus a short
 * trailing window for the coaching engines. Every period older than that window keeps the
 * deleted provider's commits, PRs and churn indefinitely, and `/api/aggregates` serves those
 * rows. So "the aggregates follow automatically" is false for exactly the periods a
 * months-of-history delete touches, and a delete that reported success while the trend charts
 * kept showing the removed activity would be the "a completion signal is not a currency
 * claim" failure applied to a destructive action.
 *
 * WHY THIS IS A SEPARATE STEP, NOT PART OF THE CASCADE TRANSACTION. Both helpers composed
 * here open their own per-period transactions on purpose: `runBackfill` releases the write
 * lock between periods rather than holding it for a whole multi-month run, and
 * `runAggregationForPeriod` deliberately runs its summary-staleness check *after* its commit
 * so a summary problem can never roll back aggregates. Folding 30+ periods into the cascade's
 * single transaction would discard both properties and hold one lock for the entire run. The
 * aggregates are a derived, idempotent projection — recomputing them after the retraction has
 * committed converges to the same result, and a failure here is reportable rather than a
 * reason to un-delete the provider.
 *
 * NO NEW PERIOD-WALKING LOGIC. `runBackfill` already resolves a range into every week /
 * month / quarter / year it touches, drives each level chronologically (so deltas resolve
 * against the prior period), and UPSERTs idempotently. This module supplies the range and
 * adds the one thing backfill does not cover — `pr_review_metrics`, whose own recompute
 * already retracts rows it will not regenerate.
 */

import type Database from 'better-sqlite3';
import {runBackfill} from './backfill.js';
import {enumerateMonths, enumerateWeekStarts, isoWeekLabel} from './dates.js';
import {computePRReviewMetricsForPeriod} from '../coaching/pr-review/compute.js';

/** What a post-retraction recompute covered, or why it could not run. */
export interface AggregateRecomputeResult {
    /** Inclusive UTC day range recomputed, or null when there was nothing to recompute. */
    from: string | null;
    to: string | null;
    /** Aggregate periods recomputed across the four levels (weeks + months + quarters + years). */
    periods: number;
    /** `pr_review_metrics` periods recomputed (weeks + months). */
    prMetricPeriods: number;
    /**
     * Non-null when the recompute FAILED. The retraction itself already committed, so this is
     * reported rather than thrown: the operator needs to know the trend aggregates are still
     * stale and that `toprope aggregate backfill` is the remedy — a swallowed error here would
     * leave the dashboard silently disagreeing with the daily snapshots.
     */
    error: string | null;
}

/**
 * Recompute every derived aggregate period covering `[from, to]`.
 *
 * `from`/`to` are the UTC day bounds of the retracted activity — for a provider delete, the
 * earliest and latest day the removed container had rows on. Pass `null` for either when
 * nothing was retracted; the result is a no-op.
 *
 * Never throws: a failure is returned on {@link AggregateRecomputeResult.error} so the caller
 * can report "the data is gone but the trend rollups are still stale" instead of turning an
 * already-committed delete into a 500.
 */
export function recomputeAggregatesForRange(
    db: Database.Database,
    from: string | null,
    to: string | null,
    now: Date = new Date(),
): AggregateRecomputeResult {
    const empty: AggregateRecomputeResult = {
        from: null,
        to: null,
        periods: 0,
        prMetricPeriods: 0,
        error: null,
    };
    if (from === null || to === null) return empty;

    try {
        const backfill = runBackfill(db, {from, to, now});
        // `pr_review_metrics` is not part of backfill's four levels, and the cascade deleted
        // `pr_records` too. Its own recompute retracts rows it will not regenerate, so
        // driving it per period is sufficient — no separate delete needed.
        let prMetricPeriods = 0;
        for (const weekStart of enumerateWeekStarts(from, to)) {
            // The rollups key weeks by their Monday `week_start`; `pr_review_metrics` keys them
            // by the `YYYY-Www` ISO label. Converted through the canonical helper, exactly as
            // the scheduler does, rather than passing the wrong key shape.
            computePRReviewMetricsForPeriod(db, 'weekly', isoWeekLabel(weekStart), now);
            prMetricPeriods++;
        }
        for (const period of enumerateMonths(from, to)) {
            computePRReviewMetricsForPeriod(db, 'monthly', period, now);
            prMetricPeriods++;
        }
        return {
            from: backfill.from,
            to: backfill.to,
            periods: backfill.periodsProcessed,
            prMetricPeriods,
            error: null,
        };
    } catch (err) {
        return {
            from,
            to,
            periods: 0,
            prMetricPeriods: 0,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
