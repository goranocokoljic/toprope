/**
 * Loop/nudge pattern manager aggregate — Pillar 3 (Task 5.11 / #132).
 *
 * The NEW manager surface this task adds: anonymized loop/nudge PATTERNS pooled
 * across a team or the org, built ONLY from opted-in developers' synced metadata.
 * It exists so a manager can see "several developers hit loops" or "missing-context
 * nudges are common" as a team coaching opportunity — without ever reaching, or
 * reconstructing, any one developer's coaching.
 *
 * Two privacy guarantees, both enforced here and tested:
 *   1. OPTED-IN ONLY. The read layer pools only developers whose capture opt-in
 *      resolves true (opt-in.ts), so a developer who never chose in — or whose org
 *      forbids capture — contributes nothing.
 *   2. MIN-GROUP-SIZE PER CELL. Every count cell (loops, each nudge type) is
 *      suppressed unless at least MIN_TEAM_COHORT distinct opted-in developers
 *      contributed to it, so no thin pattern can de-anonymize an individual.
 *
 * Pure aggregation (the flooring + distinct-developer counting) lives in
 * `aggregateLoopNudge` so every privacy rule is unit-testable without a database;
 * the read functions only resolve scope, the opted-in cohort, and the time window.
 */

import type Database from 'better-sqlite3';
import {isoWeekRange, monthRange} from '../../aggregation/dates';
import {DEFAULT_WINDOW, periodKeysEndingAt, type PeriodUnit} from '../period-window';
// The min-group-size floor is a single privacy invariant shared across every
// coaching aggregate — reuse the pr-review definition so they can never drift.
import {MIN_TEAM_COHORT} from '../pr-review/guidance';
import {NUDGE_TYPES, type NudgeType} from '../realtime/types';
import {resolveOptedInDeveloperIds} from './opt-in';
import type {LoopNudgeAggregate, LoopNudgeCell, LoopNudgeTypeCell} from './types';

/** One opted-in developer's contribution to the loop pool (one row per loop event). */
export interface LoopContribution {
    developerId: string;
}

/** One opted-in developer's contribution to the nudge pool (one row per nudge event). */
export interface NudgeContribution {
    developerId: string;
    nudgeType: NudgeType;
}

function placeholders(n: number): string {
    return new Array(n).fill('?').join(', ');
}

/** A suppressed cell — the marker and nothing else, so no count leaks. */
function suppressedCell(): LoopNudgeCell {
    return {suppressed: true, developers: null, total: null};
}

/**
 * Reduce a list of per-event contributions into one floored cell: distinct
 * contributing developers and total events, suppressed when the distinct-developer
 * count is below the floor. Counting DISTINCT developers (not events) for the
 * floor is the point — ten loops from one developer is still one developer, and
 * must stay suppressed.
 */
function buildCell(developerIds: string[], minCohort: number): LoopNudgeCell {
    const distinct = new Set(developerIds);
    if (distinct.size < minCohort) {
        return suppressedCell();
    }
    return {suppressed: false, developers: distinct.size, total: developerIds.length};
}

/**
 * Floor the opted-in eligibility count: report the exact value ONLY when it is at
 * least the cohort floor; anything below (including 0) is suppressed to null.
 *
 * Collapsing 0 into null — rather than reporting an explicit zero — is deliberate:
 * the org count is the sum over teams, so an explicit 0 on one team plus null (1–2)
 * on others lets a manager who knows the roster difference the org panel against the
 * team panels to isolate a team with a single opted-in developer (an opt-in choice
 * is itself private). Without the explicit-0 anchor, a below-floor scope is
 * indistinguishable from an empty one, so no individual's opt-in can be read off.
 */
function flooredOptInCount(optedInCount: number, minCohort: number): number | null {
    return optedInCount >= minCohort ? optedInCount : null;
}

/**
 * Pure aggregation of opted-in loop/nudge contributions into the manager
 * aggregate. `optedInCount` is the eligibility figure, floored the same way as
 * every count cell (see {@link flooredOptInCount}). Every count cell is
 * independently floored at `minCohort` on DISTINCT contributing developers.
 */
export function aggregateLoopNudge(
    scope: string,
    unit: PeriodUnit,
    optedInCount: number,
    loops: LoopContribution[],
    nudges: NudgeContribution[],
    minCohort: number = MIN_TEAM_COHORT,
): LoopNudgeAggregate {
    const loopCell = buildCell(
        loops.map((l) => l.developerId),
        minCohort,
    );

    const nudgeCells: LoopNudgeTypeCell[] = NUDGE_TYPES.map((nudgeType) => {
        const forType = nudges.filter((n) => n.nudgeType === nudgeType).map((n) => n.developerId);
        return {nudge_type: nudgeType, ...buildCell(forType, minCohort)};
    });

    return {
        scope,
        period_unit: unit,
        opted_in_developers: flooredOptInCount(optedInCount, minCohort),
        loops: loopCell,
        nudges: nudgeCells,
    };
}

/**
 * The trajectory window as a `[start, end)` pair of ISO bounds. loop/nudge events
 * are stored as ISO timestamps, not per period, so the read layer filters them by
 * this range. `start` is the first day of the oldest period in the window (a
 * 'YYYY-MM-DD' date). `end` is `now` as a full ISO timestamp — the UPPER bound
 * matters: without it a clock-skewed local agent could sync a future-dated event
 * that would inflate a contributor count and push a thin cell over the floor.
 * ISO-8601 timestamps sort lexicographically against both bounds, so
 * `detected_at >= start AND detected_at <= end` is a correct inclusive window.
 */
function windowBounds(unit: PeriodUnit, now: Date): {start: string; end: string} {
    const keys = periodKeysEndingAt(unit, now.toISOString().slice(0, 10), DEFAULT_WINDOW[unit]);
    const oldest = keys[0];
    const start = unit === 'weekly' ? isoWeekRange(oldest).start : monthRange(oldest).start;
    return {start, end: now.toISOString()};
}

/**
 * Build the loop/nudge aggregate for an already-resolved set of developer ids.
 * The opted-in filter is applied HERE (not by the caller) so no read path can
 * skip it: the pool is strictly the opted-in subset of `devIds`, within the
 * trajectory window. When nobody is opted in, the aggregate is fully suppressed
 * with `opted_in_developers: 0`, which the panel renders as "not enough opted-in
 * developers" rather than an empty-but-misleading zero.
 */
function aggregateForDeveloperIds(
    db: Database.Database,
    scopeLabel: string,
    devIds: string[],
    unit: PeriodUnit,
    now: Date,
): LoopNudgeAggregate {
    const optedIn = resolveOptedInDeveloperIds(db, devIds);
    if (optedIn.length === 0) {
        return aggregateLoopNudge(scopeLabel, unit, 0, [], []);
    }

    const {start, end} = windowBounds(unit, now);
    const inClause = placeholders(optedIn.length);

    const loopRows = db
        .prepare(
            `SELECT developer_id FROM loop_events
             WHERE developer_id IN (${inClause}) AND detected_at >= ? AND detected_at <= ?`,
        )
        .all(...optedIn, start, end) as Array<{developer_id: string}>;

    const nudgeRows = db
        .prepare(
            `SELECT developer_id, nudge_type FROM nudge_events
             WHERE developer_id IN (${inClause}) AND delivered_at >= ? AND delivered_at <= ?`,
        )
        .all(...optedIn, start, end) as Array<{developer_id: string; nudge_type: string}>;

    const loops: LoopContribution[] = loopRows.map((r) => ({developerId: r.developer_id}));
    const nudges: NudgeContribution[] = nudgeRows
        // A nudge_type outside the closed set means corruption / a future enum;
        // drop it rather than crash the manager view (the CHECK constraint makes
        // this practically unreachable, but the manager surface must never throw).
        // Warn on the way out, mirroring the realtime store's decodeNudgeType, so a
        // genuinely corrupt row is discoverable rather than silently vanishing.
        .filter((r): r is {developer_id: string; nudge_type: NudgeType} => {
            if ((NUDGE_TYPES as readonly string[]).includes(r.nudge_type)) {
                return true;
            }
            console.warn(`[manager-aggregate] unrecognized nudge_type '${r.nudge_type}' in nudge_events; excluding from aggregate`);
            return false;
        })
        .map((r) => ({developerId: r.developer_id, nudgeType: r.nudge_type}));

    return aggregateLoopNudge(scopeLabel, unit, optedIn.length, loops, nudges);
}

/** Org-wide loop/nudge aggregate — every developer's id pooled, then opt-in filtered. */
export function getOrgLoopNudgeAggregate(
    db: Database.Database,
    unit: PeriodUnit,
    now: Date = new Date(),
): LoopNudgeAggregate {
    const devIds = (db.prepare('SELECT id FROM developers').all() as Array<{id: string}>).map((r) => r.id);
    return aggregateForDeveloperIds(db, 'org', devIds, unit, now);
}

/**
 * One team's loop/nudge aggregate. Scopes strictly by the team's CURRENT members
 * (same as every team-scoped query in the app), then applies the opt-in and
 * min-group-size floors — so a team named 'org' is still just that team.
 */
export function getTeamLoopNudgeAggregate(
    db: Database.Database,
    team: string,
    unit: PeriodUnit,
    now: Date = new Date(),
): LoopNudgeAggregate {
    const devIds = (
        db.prepare('SELECT id FROM developers WHERE team = ?').all(team) as Array<{id: string}>
    ).map((r) => r.id);
    return aggregateForDeveloperIds(db, team, devIds, unit, now);
}
