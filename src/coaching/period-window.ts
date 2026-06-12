/**
 * Shared period-window helpers for the coaching read layers.
 *
 * The pr-review and available-data coaching surfaces both present a trajectory
 * over the last N comparable periods, so the period unit, the default window, and
 * the "enumerate the keys ending at a date" walk live here once rather than being
 * duplicated in each module's coaching.ts.
 */

import {isoWeekLabel, monthOf, priorIsoWeek, priorMonth} from '../aggregation/dates';

/** The two period units the coaching surfaces compute (period TEXT: YYYY-Www or YYYY-MM). */
export type PeriodUnit = 'weekly' | 'monthly';

/**
 * Default trajectory window per unit — enough history to read a trend, not so
 * long it drags in ancient periods. Monthly reads as "the last half-year".
 */
export const DEFAULT_WINDOW: Record<PeriodUnit, number> = {weekly: 12, monthly: 6};

/**
 * The `count` period keys ending at `refDate`, oldest first. Walking back with
 * the same prior-period helpers the engines use keeps the key shape identical to
 * what is stored, so the IN-clause lookups hit.
 */
export function periodKeysEndingAt(unit: PeriodUnit, refDate: string, count: number): string[] {
    const current = unit === 'weekly' ? isoWeekLabel(refDate) : monthOf(refDate);
    const prior = unit === 'weekly' ? priorIsoWeek : priorMonth;
    const keys: string[] = [current];
    let key = current;
    for (let i = 1; i < count; i++) {
        key = prior(key);
        keys.push(key);
    }
    return keys.reverse();
}
