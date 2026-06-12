/**
 * Available-data coaching — read layer (Task 5.1 / #122).
 *
 * Turns the stored coaching_signals rows (written by generator.ts) into the two
 * surfaces, kept rigorously separate:
 *   - getDeveloperCoaching — ONE developer's PRIVATE signals, observation text
 *     included. The caller passes a developer id resolved STRICTLY from the
 *     session, so this can only ever return the caller's own coaching.
 *   - getTeamCoaching / getOrgCoaching — a manager-facing AGGREGATE: per period,
 *     per signal type, only a contributor count and a category breakdown, with a
 *     k-anonymity floor. It never reads or returns the `observation` column, and
 *     no developer id appears in the output — there is deliberately no function
 *     here that returns one developer's coaching to a manager.
 *
 * The privacy boundary is structural: the manager query below does not even
 * SELECT the observation text, so a coaching sentence cannot leak through this
 * path regardless of how the result is later serialized.
 */

import type Database from 'better-sqlite3';
import {isoWeekLabel, monthOf, priorIsoWeek, priorMonth} from '../../aggregation/dates';
// The k-anonymity floor is a privacy invariant with a single home — reuse the
// pr-review definition so the two coaching aggregates can never drift apart.
import {MIN_TEAM_COHORT} from '../pr-review/guidance';
import type {
    CoachingMetricContext,
    CoachingPeriodUnit,
    CoachingSignalType,
    DeveloperCoaching,
    DeveloperCoachingSignal,
    TeamCoaching,
    TeamCoachingPoint,
    TeamCoachingSeries,
} from './types';

/** Default trajectory window per unit — enough history to read a trend. */
const DEFAULT_WINDOW: Record<CoachingPeriodUnit, number> = {weekly: 12, monthly: 6};

/** Stable display order for the four signal types within a period / across series. */
const SIGNAL_TYPE_ORDER: CoachingSignalType[] = [
    'churn_reflection',
    'acceptance_trend',
    'journey_coaching',
    'personal_insight',
];

/**
 * The `count` period keys ending at `refDate`, oldest first — walking back with
 * the same prior-period helpers the generator uses so the key shape matches what
 * is stored (and the IN-clause lookups hit).
 */
export function periodKeysEndingAt(
    unit: CoachingPeriodUnit,
    refDate: string,
    count: number,
): string[] {
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

function placeholders(n: number): string {
    return new Array(n).fill('?').join(', ');
}

function parseContext(raw: string | null): CoachingMetricContext | null {
    if (raw === null) return null;
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const obj = parsed as Record<string, unknown>;
            const category = typeof obj.category === 'string' ? obj.category : 'unknown';
            return {...obj, category};
        }
    } catch {
        // fall through to null on malformed JSON
    }
    return null;
}

interface DeveloperRow {
    period: string;
    signal_type: CoachingSignalType;
    basis: DeveloperCoachingSignal['basis'];
    observation: string;
    metric_context: string | null;
    created_at: string;
}

/**
 * One developer's PRIVATE available-data coaching: their stored signals over the
 * window, newest period first and in a stable signal-type order within a period
 * so the panel renders deterministically. Includes the observation text — only
 * ever reachable through the session-scoped /api/me path.
 */
export function getDeveloperCoaching(
    db: Database.Database,
    developerId: string,
    unit: CoachingPeriodUnit,
    now: Date = new Date(),
): DeveloperCoaching {
    const keys = periodKeysEndingAt(unit, now.toISOString().slice(0, 10), DEFAULT_WINDOW[unit]);
    const rows = db
        .prepare(
            `SELECT period, signal_type, basis, observation, metric_context, created_at
             FROM coaching_signals
             WHERE developer_id = ? AND period IN (${placeholders(keys.length)})`,
        )
        .all(developerId, ...keys) as DeveloperRow[];

    const order = new Map(SIGNAL_TYPE_ORDER.map((t, i) => [t, i]));
    const signals: DeveloperCoachingSignal[] = rows
        .map((r) => ({
            period: r.period,
            signal_type: r.signal_type,
            basis: r.basis,
            observation: r.observation,
            metric_context: parseContext(r.metric_context),
            created_at: r.created_at,
        }))
        .sort((a, b) => {
            // Newest period first; within a period, the canonical type order.
            if (a.period !== b.period) return a.period < b.period ? 1 : -1;
            return (order.get(a.signal_type) ?? 99) - (order.get(b.signal_type) ?? 99);
        });

    return {period_unit: unit, signals};
}

interface TeamRow {
    developer_id: string;
    period: string;
    signal_type: CoachingSignalType;
    metric_context: string | null;
}

/** A suppressed team point — the marker and nothing else (no counts leak). */
function suppressedPoint(period: string): TeamCoachingPoint {
    return {period, suppressed: true, developers: null, categories: null};
}

/**
 * Aggregate a manager-facing coaching view over an already-resolved set of
 * developer ids. The caller owns scoping (org = all developers, team = the
 * team's members). Every (period, signal type) cell is pooled across these
 * developers and suppressed when fewer than MIN_TEAM_COHORT contributed — and
 * the query never selects the observation text, so no individual sentence and no
 * individual number can leak. Only contributor counts and category tallies cross
 * the boundary.
 */
function aggregateForDeveloperIds(
    db: Database.Database,
    scopeLabel: string,
    devIds: string[],
    unit: CoachingPeriodUnit,
    now: Date,
): TeamCoaching {
    const keys = periodKeysEndingAt(unit, now.toISOString().slice(0, 10), DEFAULT_WINDOW[unit]);

    const rows =
        devIds.length === 0
            ? []
            : (db
                  .prepare(
                      `SELECT developer_id, period, signal_type, metric_context
                       FROM coaching_signals
                       WHERE developer_id IN (${placeholders(devIds.length)})
                         AND period IN (${placeholders(keys.length)})`,
                  )
                  .all(...devIds, ...keys) as TeamRow[]);

    // (signal_type | period) -> contributors + category tallies.
    interface Cell {
        developers: Set<string>;
        categories: Map<string, number>;
    }
    const cells = new Map<string, Cell>();
    for (const row of rows) {
        const key = `${row.signal_type}|${row.period}`;
        let cell = cells.get(key);
        if (!cell) {
            cell = {developers: new Set(), categories: new Map()};
            cells.set(key, cell);
        }
        cell.developers.add(row.developer_id);
        const category = parseContext(row.metric_context)?.category ?? 'unknown';
        cell.categories.set(category, (cell.categories.get(category) ?? 0) + 1);
    }

    const buildPoint = (signalType: CoachingSignalType, period: string): TeamCoachingPoint => {
        const cell = cells.get(`${signalType}|${period}`);
        if (!cell || cell.developers.size < MIN_TEAM_COHORT) {
            return suppressedPoint(period);
        }
        return {
            period,
            suppressed: false,
            developers: cell.developers.size,
            categories: Object.fromEntries(cell.categories),
        };
    };

    const series: TeamCoachingSeries[] = SIGNAL_TYPE_ORDER.map((signalType) => ({
        signal_type: signalType,
        points: keys.map((period) => buildPoint(signalType, period)),
    }));

    return {scope: scopeLabel, period_unit: unit, series};
}

/** Org-wide manager aggregate — every developer pooled. */
export function getOrgCoaching(
    db: Database.Database,
    unit: CoachingPeriodUnit,
    now: Date = new Date(),
): TeamCoaching {
    const devIds = (db.prepare('SELECT id FROM developers').all() as Array<{id: string}>).map(
        (r) => r.id,
    );
    return aggregateForDeveloperIds(db, 'org', devIds, unit, now);
}

/**
 * One team's manager aggregate. Scopes strictly by the team's CURRENT members —
 * a team literally named 'org' is still just that team, never the whole org.
 */
export function getTeamCoaching(
    db: Database.Database,
    team: string,
    unit: CoachingPeriodUnit,
    now: Date = new Date(),
): TeamCoaching {
    const devIds = (
        db.prepare('SELECT id FROM developers WHERE team = ?').all(team) as Array<{id: string}>
    ).map((r) => r.id);
    return aggregateForDeveloperIds(db, team, devIds, unit, now);
}
