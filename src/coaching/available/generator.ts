/**
 * Available-data coaching — generator / DB integration (Task 5.1 / #122).
 *
 * Reads the data the platform already has (git_snapshots churn + activity,
 * tool_snapshots acceptance + activity, the Phase 4 adoption journey) for one
 * period and persists the produced coaching signals per developer into
 * coaching_signals. The pure signal logic lives in engine.ts; this module owns
 * period arithmetic, the within-developer baseline, the journey/tier lookup, and
 * the idempotent rewrite.
 *
 * Every signal is within-developer-over-time: the churn and acceptance signals
 * compare the period against the developer's OWN trailing baseline, the journey
 * signal interprets the developer's OWN adoption journey, and the personal
 * insight speaks only to the developer's own data and tier. Nothing here reads
 * another developer to frame a signal.
 *
 * Idempotent: a period's signals are fully replaced on every run, so the trailing
 * recompute window in the scheduler converges signals as more history lands and a
 * developer who lost their activity in a period (e.g. after a registry
 * re-attribution) has their now-stale signals retracted.
 *
 * Cost note: building each developer's journey re-derives the org-wide
 * data-quality rank map (developerTier) — O(developers) per call, so the whole
 * pass is ~O(active_developers × (1 + baselinePeriods)) snapshot scans plus a
 * journey assembly per developer. Trivial at launch scale; if an org's sync gets
 * slow this is the place to precompute a per-developer tier map once per run,
 * mirroring the same note on the pr-review metrics engine.
 */

import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import {isoWeekRange, monthRange, priorIsoWeek, priorMonth, type DateRange} from '../../aggregation/dates';
import {getDeveloperJourney} from '../../dashboard/api/journey';
import {resolveAvailableCoachingThresholds} from './config';
import {
    buildAcceptanceTrend,
    buildChurnReflection,
    buildJourneyCoaching,
    buildPersonalInsight,
} from './engine';
import type {
    AvailableCoachingThresholds,
    CoachingPeriodUnit,
    CoachingSignalDraft,
} from './types';

export interface CoachingGenerateResult {
    periodUnit: CoachingPeriodUnit;
    /** The period key generated (YYYY-Www or YYYY-MM). */
    period: string;
    /** Developers that had activity in the period (and so were considered). */
    developers: number;
    /** Total signal rows written across all developers. */
    signalsWritten: number;
}

/** Inclusive day range for a period key (YYYY-Www → ISO week; YYYY-MM → month). */
function periodRange(unit: CoachingPeriodUnit, period: string): DateRange {
    return unit === 'weekly' ? isoWeekRange(period) : monthRange(period);
}

function priorPeriod(unit: CoachingPeriodUnit, period: string): string {
    return unit === 'weekly' ? priorIsoWeek(period) : priorMonth(period);
}

interface Statements {
    activeDevs: Database.Statement;
    churn: Database.Statement;
    acceptance: Database.Statement;
    activeDays: Database.Statement;
    commits: Database.Statement;
    interactions: Database.Statement;
    deletePeriod: Database.Statement;
    insert: Database.Statement;
}

function prepareStatements(db: Database.Database): Statements {
    return {
        // Developers with ANY activity (a git snapshot or a tool snapshot) in the
        // period — the only ones we coach, so no false coaching on no data.
        activeDevs: db.prepare(
            `SELECT DISTINCT developer_id AS id FROM (
                 SELECT developer_id FROM git_snapshots WHERE date BETWEEN ? AND ?
                 UNION
                 SELECT developer_id FROM tool_snapshots WHERE date BETWEEN ? AND ?
             )`,
        ),
        churn: db.prepare(
            `SELECT AVG(code_churn_rate) AS v
             FROM git_snapshots
             WHERE developer_id = ? AND date BETWEEN ? AND ?
               AND commits > 0 AND code_churn_rate IS NOT NULL`,
        ),
        acceptance: db.prepare(
            `SELECT AVG(acceptance_rate) AS v
             FROM tool_snapshots
             WHERE developer_id = ? AND date BETWEEN ? AND ?
               AND acceptance_rate IS NOT NULL`,
        ),
        activeDays: db.prepare(
            `SELECT COUNT(DISTINCT date) AS n FROM (
                 SELECT date FROM git_snapshots
                   WHERE developer_id = ? AND date BETWEEN ? AND ? AND commits > 0
                 UNION
                 SELECT date FROM tool_snapshots
                   WHERE developer_id = ? AND date BETWEEN ? AND ? AND is_active = 1
             )`,
        ),
        commits: db.prepare(
            `SELECT COALESCE(SUM(commits), 0) AS n
             FROM git_snapshots WHERE developer_id = ? AND date BETWEEN ? AND ?`,
        ),
        interactions: db.prepare(
            `SELECT COALESCE(SUM(interaction_count), 0) AS n
             FROM tool_snapshots WHERE developer_id = ? AND date BETWEEN ? AND ?`,
        ),
        deletePeriod: db.prepare('DELETE FROM coaching_signals WHERE period = ?'),
        insert: db.prepare(
            `INSERT INTO coaching_signals
             (id, developer_id, period, signal_type, basis, observation, metric_context, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ),
    };
}

/** A single AVG cell, mapping SQLite's NULL (no rows) to a JS null. */
function avgCell(stmt: Database.Statement, devId: string, range: DateRange): number | null {
    const row = stmt.get(devId, range.start, range.end) as {v: number | null};
    return row.v;
}

/**
 * The developer's OWN trailing mean of a per-period AVG (within-developer
 * baseline): the mean of each prior period's value over `baselinePeriods`
 * periods, counting only periods that had a value. Null when no prior period had
 * any — the first period has no baseline, so no trend signal fires yet.
 */
function trailingBaseline(
    stmt: Database.Statement,
    devId: string,
    unit: CoachingPeriodUnit,
    period: string,
    thresholds: AvailableCoachingThresholds,
): number | null {
    const values: number[] = [];
    let key = period;
    for (let i = 0; i < thresholds.baselinePeriods; i++) {
        key = priorPeriod(unit, key);
        const v = avgCell(stmt, devId, periodRange(unit, key));
        if (v !== null) values.push(v);
    }
    if (values.length === 0) return null;
    return values.reduce((s, x) => s + x, 0) / values.length;
}

function scalar(stmt: Database.Statement, devId: string, range: DateRange): number {
    return (stmt.get(devId, range.start, range.end) as {n: number}).n;
}

/**
 * The journey "now" anchor for a period: the period's last day, but never beyond
 * the real clock. A recompute of a past period then interprets the journey as it
 * stood at that period's close — it does not fold in annotations that only emerge
 * later — while the current period uses the real present.
 */
function journeyAsOf(range: DateRange, now: Date): Date {
    const periodEnd = new Date(`${range.end}T23:59:59.999Z`);
    return periodEnd.getTime() < now.getTime() ? periodEnd : now;
}

/**
 * Compute and persist every developer's available-data coaching signals for one
 * period. Developers with no activity in the period get nothing. The whole
 * period is rewritten in one transaction (delete-then-insert) so the result is
 * deterministic regardless of what was stored before.
 */
export function generateCoachingSignalsForPeriod(
    db: Database.Database,
    unit: CoachingPeriodUnit,
    period: string,
    now: Date = new Date(),
): CoachingGenerateResult {
    const range = periodRange(unit, period); // validates the period key shape
    const thresholds = resolveAvailableCoachingThresholds(db);
    const stmts = prepareStatements(db);
    const createdAt = now.toISOString();
    const asOf = journeyAsOf(range, now);

    const devs = stmts.activeDevs.all(
        range.start,
        range.end,
        range.start,
        range.end,
    ) as Array<{id: string}>;

    let signalsWritten = 0;
    const run = db.transaction(() => {
        // Wipe the whole period first: re-inserting for every currently-active
        // developer below both updates them and retracts any developer who no
        // longer has activity in the period.
        stmts.deletePeriod.run(period);

        for (const {id: devId} of devs) {
            const currentChurn = avgCell(stmts.churn, devId, range);
            const baselineChurn = trailingBaseline(stmts.churn, devId, unit, period, thresholds);
            const currentAcceptance = avgCell(stmts.acceptance, devId, range);
            const baselineAcceptance = trailingBaseline(
                stmts.acceptance, devId, unit, period, thresholds,
            );

            const activeDays = (
                stmts.activeDays.get(
                    devId, range.start, range.end, devId, range.start, range.end,
                ) as {n: number}
            ).n;
            const commits = scalar(stmts.commits, devId, range);
            const interactions = scalar(stmts.interactions, devId, range);

            // One journey assembly per developer — its annotations drive the
            // journey signal and its tier drives the tier-aware basis/insight.
            const journey = getDeveloperJourney(db, devId, asOf);

            const drafts: Array<CoachingSignalDraft | null> = [
                buildChurnReflection(currentChurn, baselineChurn, activeDays, thresholds),
                buildAcceptanceTrend(currentAcceptance, baselineAcceptance, thresholds),
                buildJourneyCoaching(journey.annotations, journey.tier),
                buildPersonalInsight(
                    journey.tier,
                    {activeDays, commits, interactions},
                    thresholds,
                ),
            ];

            for (const draft of drafts) {
                if (!draft) continue;
                stmts.insert.run(
                    randomUUID(),
                    devId,
                    period,
                    draft.signalType,
                    draft.basis,
                    draft.observation,
                    JSON.stringify(draft.metricContext),
                    createdAt,
                );
                signalsWritten += 1;
            }
        }
    });
    run();

    return {periodUnit: unit, period, developers: devs.length, signalsWritten};
}
