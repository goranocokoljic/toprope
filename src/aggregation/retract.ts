/**
 * Recompute the DERIVED projections after a retraction (#264 review SO-2/SEC-2).
 *
 * `git_snapshots` is a projection of `raw_author_daily`, so a provider delete can retract it
 * directly. Everything downstream is a *second* projection: `weekly_aggregates`,
 * `monthly_aggregates`, `quarterly_aggregates`, `yearly_aggregates`, `pr_review_metrics` and
 * `coaching_signals` are all rebuilt per period key from the daily rows. Retracting the daily
 * rows therefore leaves every already-computed period holding totals for activity that no
 * longer exists.
 *
 * THE SCHEDULER DOES NOT FIX THIS. `runScheduledJob` recomputes exactly
 * `justCompletedPeriod(...)` — one week / one month / one quarter / one year — plus a short
 * trailing window for the coaching engines. Every period older than that window keeps the
 * deleted provider's commits, PRs and churn indefinitely, and `/api/aggregates` serves those
 * rows. So "the aggregates follow automatically" is false for exactly the periods a
 * months-of-history delete touches.
 *
 * WHAT THIS COVERS, AND WHAT IT DELIBERATELY DOES NOT. Composed here: the four rollup levels
 * (via `runBackfill`), `pr_review_metrics`, `coaching_signals`, and marking in-range narrative
 * summaries stale. All four are *idempotent per period* and retract what they will not
 * regenerate, so re-running them over a retracted span converges on the truth.
 *
 * `anomalies` are deliberately NOT re-scanned. `runAnomalyScanForPeriod` compares a period
 * against its predecessors, so re-scanning a span whose activity was just removed would
 * MANUFACTURE anomalies ("commits fell to zero") for the retraction itself — and the notifier
 * sweeps every open, unannounced team anomaly, so those inventions would be announced to Slack.
 * Existing anomaly rows for the span therefore survive, still describing removed activity.
 * {@link AggregateRecomputeResult.anomaliesNotRescanned} reports that boundary rather than
 * letting an unqualified "recomputed" imply it — the same "a completion signal is not a
 * currency claim" rule this module exists to satisfy, applied to its own limits.
 *
 * WHY THIS IS A SEPARATE STEP, NOT PART OF THE CASCADE TRANSACTION. Every helper composed here
 * opens its own per-period transaction on purpose: `runBackfill` releases the write lock between
 * periods rather than holding it for a whole multi-month run, and `computePRReviewMetricsForPeriod`
 * retracts its stale rows inside that same per-period unit. Folding 30+ periods into the
 * cascade's single transaction would discard both properties and hold one lock for the entire
 * run. These are derived, idempotent projections — recomputing them after the retraction has
 * committed converges to the same result, and a failure here is reportable rather than a reason
 * to un-delete the provider.
 *
 * NO NEW PERIOD-WALKING LOGIC. `runBackfill` already resolves a range into every week / month /
 * quarter / year it touches, drives each level chronologically (so deltas resolve against the
 * prior period), and UPSERTs idempotently.
 */

import type Database from 'better-sqlite3';
import {runBackfill} from './backfill.js';
import {enumerateMonths, enumerateWeekStarts, isoWeekLabel} from './dates.js';
import {computePRReviewMetricsForPeriod} from '../coaching/pr-review/compute.js';
import {generateCoachingSignalsForPeriod} from '../coaching/available/generator.js';
import {markStaleSummariesForRecompute} from '../summaries/staleness.js';

/**
 * Hard ceiling on how far back a single retraction recompute reaches, in calendar months.
 *
 * The span is derived from `raw_author_daily.date`, which comes from the provider's **author**
 * date — a value the committer sets (`git commit --date=…`) and that nothing downstream clamps:
 * the write boundary and the schema CHECK pin the *shape* (`YYYY-MM-DD`) only, so any four-digit
 * year is accepted. Without a cap, one commit dated `9999-01-01` in the deleted container turns
 * a delete into ~414,000 weekly periods — each in its own transaction, each iterating every
 * developer — on the synchronous better-sqlite3 connection, i.e. a process-wide hang that no
 * timeout can interrupt, after the cascade has already committed.
 *
 * 36 months comfortably exceeds any real retention window this product reports on (the
 * first-sync history window caps at 60 months but the trend surfaces read far less), and the
 * cap is REPORTED rather than silently applied — see {@link AggregateRecomputeResult.truncated}.
 */
export const RETRACTION_RECOMPUTE_MAX_MONTHS = 36;

/** Anchored UTC-day shape — the same pin `raw_author_daily.date` enforces at its write boundary. */
const UTC_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** What a post-retraction recompute covered, what it deliberately skipped, and why. */
export interface AggregateRecomputeResult {
    /** Inclusive UTC day range actually recomputed, or null when there was nothing to do. */
    from: string | null;
    to: string | null;
    /** Aggregate periods recomputed across the four levels (weeks + months + quarters + years). */
    periods: number;
    /** `pr_review_metrics` periods recomputed (weeks + months). */
    prMetricPeriods: number;
    /** `coaching_signals` periods recomputed (weeks + months). */
    coachingPeriods: number;
    /**
     * True when the requested span was CLAMPED — a future-dated day pulled back to today, or a
     * span longer than {@link RETRACTION_RECOMPUTE_MAX_MONTHS} cut to that ceiling. Periods
     * outside the clamped range were NOT recomputed and still hold the removed activity, so the
     * caller must say so rather than report a clean sweep.
     */
    truncated: boolean;
    /**
     * Always true when anything was recomputed: `anomalies` rows for the span are intentionally
     * left alone (see the module doc), so they still describe retracted activity.
     */
    anomaliesNotRescanned: boolean;
    /**
     * Non-null when the recompute FAILED. The retraction itself already committed, so this is
     * reported rather than thrown. `periods`/`prMetricPeriods`/`coachingPeriods` still carry what
     * DID commit before the failure — `runBackfill` commits one transaction per period, so
     * reporting 0 would claim nothing happened when half the span may already be correct.
     */
    error: string | null;
}

/** Today as a YYYY-MM-DD UTC key, matching the daily-snapshot keying. */
function todayUtc(now: Date): string {
    return now.toISOString().slice(0, 10);
}

/** `date` shifted back `months` calendar months as YYYY-MM-DD (UTC), via Date normalization. */
function subtractMonths(date: string, months: number): string {
    const [year, mon, day] = date.split('-').map(Number);
    return new Date(Date.UTC(year, mon - 1 - months, day)).toISOString().slice(0, 10);
}

/**
 * Recompute every derived period covering `[from, to]`, clamped to a bounded, non-future span.
 *
 * `from`/`to` are the UTC day bounds of the retracted activity — for a provider delete, the
 * earliest and latest day the removed container had rows on. Pass `null` for either when nothing
 * was retracted; the result is a no-op.
 *
 * Never throws: a failure is returned on {@link AggregateRecomputeResult.error} so the caller can
 * report "the data is gone but some rollups are still stale" instead of turning an
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
        coachingPeriods: 0,
        truncated: false,
        anomaliesNotRescanned: false,
        error: null,
    };
    if (from === null || to === null) return empty;

    // SHAPE-PIN BOTH BOUNDS BEFORE COMPARING THEM. The clamping below uses string comparison
    // (sound only for `YYYY-MM-DD`), so a malformed bound must be rejected here rather than
    // silently ordering somewhere arbitrary — `'not-a-date'` byte-sorts above every real date and
    // would otherwise be read as "entirely in the future" and skipped with no error at all.
    if (!UTC_DAY_RE.test(from) || !UTC_DAY_RE.test(to)) {
        return {
            ...empty,
            from,
            to,
            error: `Refusing to recompute a malformed range: ${from} → ${to} (expected YYYY-MM-DD)`,
        };
    }

    // CLAMP BOTH ENDS before anything walks the range (see RETRACTION_RECOMPUTE_MAX_MONTHS).
    // Upper edge to today: a future-dated commit must not enumerate periods that cannot have
    // aggregates. Lower edge to the ceiling: a legitimately-ancient floor is bounded too.
    const today = todayUtc(now);
    const clampedTo = to > today ? today : to;
    const floor = subtractMonths(clampedTo, RETRACTION_RECOMPUTE_MAX_MONTHS);
    const clampedFrom = from < floor ? floor : from;
    const truncated = clampedTo !== to || clampedFrom !== from;
    // Everything retracted is in the future, so no period the rollups cover was affected.
    if (clampedFrom > clampedTo) return {...empty, truncated: true};

    // Counted as they commit, so a mid-walk failure reports what actually landed.
    let periods = 0;
    let prMetricPeriods = 0;
    let coachingPeriods = 0;
    try {
        const backfill = runBackfill(db, {
            from: clampedFrom,
            to: clampedTo,
            now,
            onProgress: () => {
                periods++;
            },
        });
        // Keys differ by level: the rollups key weeks by their Monday `week_start`, the coaching
        // engines by the `YYYY-Www` ISO label. Converted through the canonical helper, exactly as
        // the scheduler does, rather than passing the wrong key shape.
        for (const weekStart of enumerateWeekStarts(clampedFrom, clampedTo)) {
            const label = isoWeekLabel(weekStart);
            computePRReviewMetricsForPeriod(db, 'weekly', label, now);
            prMetricPeriods++;
            generateCoachingSignalsForPeriod(db, 'weekly', label, now);
            coachingPeriods++;
        }
        for (const month of enumerateMonths(clampedFrom, clampedTo)) {
            computePRReviewMetricsForPeriod(db, 'monthly', month, now);
            prMetricPeriods++;
            generateCoachingSignalsForPeriod(db, 'monthly', month, now);
            coachingPeriods++;
            // Narrative summaries are not recomputed here (they cost model calls) but they DO
            // name commit counts that no longer exist — flag them so the next generation run
            // rebuilds them instead of serving a stale story. Idempotent and read-only against
            // snapshots.
            markStaleSummariesForRecompute(db, 'monthly', month);
        }
        return {
            from: backfill.from,
            to: backfill.to,
            periods,
            prMetricPeriods,
            coachingPeriods,
            truncated,
            anomaliesNotRescanned: true,
            error: null,
        };
    } catch (err) {
        return {
            from: clampedFrom,
            to: clampedTo,
            periods,
            prMetricPeriods,
            coachingPeriods,
            truncated,
            anomaliesNotRescanned: true,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
