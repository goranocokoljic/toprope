/**
 * Summary staleness detection (Task 3.9 / #78).
 *
 * A stored summary records the input_hash of the numbers it was written from. When
 * the underlying daily snapshots change — late-arriving data, a re-sync — and the
 * period is recomputed, the metrics a fresh build produces no longer hash to the
 * stored value, so the summary is out of date. This module rebuilds the input from
 * the current snapshots, re-hashes, and raises is_stale on a mismatch.
 *
 * It deliberately reuses {@link buildSummaryInputForTarget} — the exact builder the
 * generator used — so "fresh" and "as generated" are computed the same way and a
 * mismatch means the data genuinely moved, not that two code paths drifted. The
 * check never regenerates text (that costs a model call and is the manager's
 * decision); it only flags the summary so the dashboard can offer regeneration.
 */

import type Database from 'better-sqlite3';
import {isoWeekLabel} from '../aggregation/dates';
import {buildSummaryInputForTarget} from './input-source';
import {
    hashInput,
    setSummaryStale,
    listSummariesForPeriod,
    type SummaryRecord,
} from './store';
import type {SummaryLevel} from './model-client';
import type {SummaryTarget} from './target';

/** Reconstruct the target a stored summary addresses. */
function recordToTarget(record: SummaryRecord): SummaryTarget {
    return {
        level: record.period_type,
        period: record.period_value,
        scope: {type: record.scope, name: record.scope_name},
    };
}

/**
 * Recompute a summary's input hash from current snapshots and compare to the
 * stored one. Returns whether the summary is stale (its input moved); marks
 * is_stale = 1 in the DB when it newly becomes stale. A matching hash leaves the
 * flag untouched — clearing staleness is the generator's job (a fresh write), not
 * this read-only check's.
 */
export function checkSummaryStaleness(db: Database.Database, record: SummaryRecord): boolean {
    const payload = buildSummaryInputForTarget(db, recordToTarget(record));
    const fresh = hashInput(payload);
    const stale = fresh !== record.input_hash;
    if (stale && record.is_stale !== 1) {
        setSummaryStale(db, record.id, true);
    }
    return stale;
}

/**
 * Re-check every summary stored for a just-recomputed aggregate period and mark
 * the ones whose input moved. Called after each aggregate recompute (the single
 * shared aggregation path), so a late-data recompute flags any affected summary
 * automatically.
 *
 * `aggregatePeriodKey` is the aggregation engine's key for the period. For weekly
 * that is the week_start date, whereas summaries are keyed by the ISO week label —
 * so weekly keys are converted before the lookup; the other levels' keys match the
 * summary period_value directly. Returns the count of summaries newly marked stale.
 */
export function markStaleSummariesForRecompute(
    db: Database.Database,
    level: SummaryLevel,
    aggregatePeriodKey: string,
): number {
    const periodValue = level === 'weekly' ? isoWeekLabel(aggregatePeriodKey) : aggregatePeriodKey;
    let newlyMarked = 0;
    for (const record of listSummariesForPeriod(db, level, periodValue)) {
        // One malformed/orphaned summary (e.g. a team since removed) must not break
        // the aggregation run that triggered the check.
        try {
            const wasStale = record.is_stale === 1;
            if (checkSummaryStaleness(db, record) && !wasStale) newlyMarked += 1;
        } catch {
            // Skip and continue — staleness is best-effort relative to aggregation.
        }
    }
    return newlyMarked;
}
