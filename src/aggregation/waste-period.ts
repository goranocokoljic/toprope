/**
 * Period-scoped waste detection for the quarterly rollup (Task 3.2 / #71).
 *
 * The quarterly aggregate stores unused_seat_count and wasted_spend for the
 * team over the quarter. This reuses the Phase 1 waste-detection *definition* — a
 * cost-bearing seat with zero tool activity is unused — but scopes it to the
 * aggregate's [start, end] window instead of "the last N days from now", so a
 * historical quarter is valued from what was true during that quarter.
 *
 * Faithful to the Phase 1 detector, a brand-new seat is exempt: a seat held for
 * fewer than the inactivity threshold within the period can't be "unused for N
 * days" and is not flagged. Per-seat spend routes through
 * getSeatProratedCost so the money figure uses the same active-on-date proration
 * as the rest of the cost engine.
 *
 * At git-only launch there is no tool data, so every cost-bearing seat held for
 * the period reads as unused — the honest state when tool usage can't be
 * measured, matching how the Phase 1 detector behaves with no tool snapshots.
 */

import type Database from 'better-sqlite3';
import {addDays, assertDateRange} from './dates';
import {getSeatProratedCost, type CostedSubscription} from '../expenses/subscription-tracker';

/** Default inactivity window, matching the Phase 1 waste detector (14 days). */
export const DEFAULT_INACTIVITY_THRESHOLD_DAYS = 14;

export interface PeriodWaste {
    unused_seat_count: number;
    wasted_spend: number;
}

interface SeatRow extends CostedSubscription {
    developer_id: string;
    tool: string;
    seat_assigned_at: string | null;
    seat_revoked_at: string | null;
    monthly_cost: number;
}

/** Round to 2 decimals; strips float artifacts from the prorated sum. */
function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

/**
 * Compute unused-seat count and wasted spend for a team over [start, end].
 *
 * A seat is counted when it bears a cost, overlapped the period, was held long
 * enough to qualify (see the threshold guard), and had no active tool day for
 * its developer+tool within the period. Each counted seat contributes its
 * prorated spend for the period to wasted_spend.
 */
export function computePeriodWaste(
    db: Database.Database,
    team: string,
    start: string,
    end: string,
    thresholdDays: number = DEFAULT_INACTIVITY_THRESHOLD_DAYS,
): PeriodWaste {
    assertDateRange(start, end);

    // Cost-bearing seats for this team that overlapped the period: assigned on or
    // before the period end and not revoked before it began. (A null
    // seat_assigned_at never bears prorated cost — getSeatProratedCost yields 0 —
    // so such rows can't inflate wasted_spend even if selected.)
    const seats = db
        .prepare(
            `SELECT s.developer_id, s.tool, s.monthly_cost,
                    s.seat_assigned_at, s.seat_revoked_at
             FROM subscriptions s
             JOIN developers d ON d.id = s.developer_id
             WHERE d.team = ?
               AND s.monthly_cost IS NOT NULL
               AND (s.seat_assigned_at IS NULL OR substr(s.seat_assigned_at, 1, 10) <= ?)
               AND (s.seat_revoked_at IS NULL OR substr(s.seat_revoked_at, 1, 10) > ?)`,
        )
        .all(team, end, start) as SeatRow[];

    const hasActiveDay = db.prepare(
        `SELECT 1 FROM tool_snapshots
         WHERE developer_id = ? AND tool = ? AND is_active = 1
           AND date >= ? AND date <= ?
         LIMIT 1`,
    );

    // A seat must have been held for at least the threshold within the period to
    // be flagged — i.e. assigned on or before (end - thresholdDays). A seat
    // assigned earlier (or before the period) clears this; only seats that
    // appeared in the final threshold-day window of the period are exempt.
    const newestEligibleAssign = addDays(end, -thresholdDays);

    let unusedSeatCount = 0;
    let wastedSpend = 0;

    for (const seat of seats) {
        const assigned = seat.seat_assigned_at?.slice(0, 10) ?? null;
        if (assigned !== null && assigned > newestEligibleAssign) {
            continue; // too freshly assigned to count as unused for the period
        }

        const active = hasActiveDay.get(seat.developer_id, seat.tool, start, end);
        if (active) {
            continue; // the seat was used during the period
        }

        unusedSeatCount += 1;
        wastedSpend += getSeatProratedCost(seat, start, end);
    }

    return {unused_seat_count: unusedSeatCount, wasted_spend: round2(wastedSpend)};
}
