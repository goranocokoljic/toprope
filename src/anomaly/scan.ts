/**
 * Anomaly scan orchestration (Task 4.7 / #102).
 *
 * Glues the pure engine (engine.ts) to the data: for one weekly period it builds
 * each metric's baseline series per scope, evaluates it, and persists the result.
 * Weekly is the period unit — developer series come from weekly_aggregates;
 * team series are folded on the fly from daily snapshots via
 * computeTeamPeriodMetrics (there is no weekly team aggregate table), the same
 * source the quarterly/yearly team rollups use, so the numbers stay consistent.
 *
 * Baseline construction is per metric: the prior periods' values, NULLs dropped
 * (a period where the metric had no data — a git-only week has no acceptance
 * rate), most recent `baselineWindow` kept, in chronological order. Dropping
 * NULLs is what makes the engine tier-aware for free: a tool metric with no
 * measured history yet has an empty baseline → the minimum-baseline guard keeps
 * it silent until real data accumulates.
 *
 * Idempotency flows from the store: a flagged metric UPSERTs its one row, and a
 * metric that scans clean clears any stale OPEN row for that coordinate. Re-running
 * a period with the same data reproduces the same set of anomalies exactly.
 */

import type Database from 'better-sqlite3';
import {isoWeekStart, priorWeekStart, weekRange} from '../aggregation/dates';
import {computeTeamPeriodMetrics, listTeams, type TeamPeriodMetrics} from '../aggregation/team-period';
import {evaluateMetric} from './engine';
import {METRIC_DEFS, metricsForScope, resolveEngineParams, resolveMetricConfig} from './config';
import {clearOpenAnomaly, upsertAnomaly} from './store';
import type {AnomalyMetric, AnomalyScope} from './types';

export interface AnomalyScanResult {
    /** The canonical week_start (Monday) actually evaluated. */
    period: string;
    /** (scope, scope_id, metric) series that had an observed value to test. */
    evaluated: number;
    /** Anomalies upserted (flagged). */
    flagged: number;
    /** Open anomalies cleared because the metric scanned clean this run. */
    cleared: number;
    /** Series skipped by the minimum-baseline guard (building baseline). */
    buildingBaseline: number;
    /** Series with no observed value for the period (nothing to test). */
    skipped: number;
}

/** Per-developer weekly_aggregates row, only the columns the metrics map to. */
interface WeeklyRow {
    week_start: string;
    total_commits: number;
    total_prs_merged: number;
    avg_code_churn: number | null;
    avg_ai_signature_score: number | null;
    total_interactions: number;
    avg_acceptance_rate: number | null;
    subscription_cost: number | null;
}

function developerMetricValue(row: WeeklyRow, metric: AnomalyMetric): number | null {
    switch (metric) {
        case 'commits':
            return row.total_commits;
        case 'prs_merged':
            return row.total_prs_merged;
        case 'churn':
            return row.avg_code_churn;
        case 'ai_signature':
            return row.avg_ai_signature_score;
        case 'interactions':
            return row.total_interactions;
        case 'acceptance_rate':
            return row.avg_acceptance_rate;
        case 'cost':
            // Subscription (seat) cost — the same quantity the team scope reads
            // (total_subscription_cost), so a developer-vs-team cost anomaly is
            // comparable, and it carries a real value at launch. estimated_total_cost
            // (tool/API spend) is null until a connector emits it, which would leave
            // the developer cost metric dead. basis stays git_estimate per the
            // issue's "git-derived + cost metrics → git_estimate" grouping.
            return row.subscription_cost;
        default:
            return null;
    }
}

function teamMetricValue(tpm: TeamPeriodMetrics, metric: AnomalyMetric): number | null {
    switch (metric) {
        case 'commits':
            return tpm.total_commits;
        case 'prs_merged':
            return tpm.total_prs_merged;
        case 'churn':
            return tpm.avg_code_churn;
        case 'ai_signature':
            return tpm.avg_ai_signature_score;
        case 'acceptance_rate':
            return tpm.avg_acceptance_rate;
        case 'cost':
            return tpm.total_subscription_cost;
        // interactions is developer-only (not exposed by the team rollup).
        default:
            return null;
    }
}

/**
 * Take the most recent `window` non-null prior values and return them in
 * chronological order (oldest → newest), as the engine expects. `priorDesc` is
 * the prior-period values ordered newest → oldest.
 */
function buildBaseline(priorDesc: (number | null)[], window: number): number[] {
    const kept: number[] = [];
    for (const v of priorDesc) {
        if (v !== null && Number.isFinite(v)) {
            kept.push(v);
            if (kept.length >= window) break;
        }
    }
    return kept.reverse();
}

const EMPTY_RESULT = (period: string): AnomalyScanResult => ({
    period,
    evaluated: 0,
    flagged: 0,
    cleared: 0,
    buildingBaseline: 0,
    skipped: 0,
});

/**
 * One metric evaluation against a prepared observed value + prior series. Mutates
 * the running tally and persists the outcome. Shared by both scopes so the
 * flagged/cleared/guard accounting can't drift between developer and team.
 */
function evaluateAndPersist(
    db: Database.Database,
    scope: AnomalyScope,
    scopeId: string,
    metric: AnomalyMetric,
    period: string,
    team: string | null,
    observed: number,
    priorDesc: (number | null)[],
    tally: AnomalyScanResult,
): void {
    const config = resolveMetricConfig(db, metric, team);
    const params = resolveEngineParams(db, team);
    const baseline = buildBaseline(priorDesc, config.baselineWindow);
    const result = evaluateMetric(observed, baseline, config, params);
    tally.evaluated += 1;

    if (result.kind === 'building_baseline') {
        tally.buildingBaseline += 1;
        return;
    }
    if (result.kind === 'anomaly') {
        upsertAnomaly(db, {
            scope,
            scopeId,
            metric,
            period,
            method: result.method,
            observedValue: result.observed,
            expectedValue: result.expected,
            deviation: result.deviation,
            severity: result.severity,
            basis: METRIC_DEFS[metric].basis,
        });
        tally.flagged += 1;
        return;
    }
    // normal — clear any stale open row for this coordinate.
    if (clearOpenAnomaly(db, scope, scopeId, metric, period)) {
        tally.cleared += 1;
    }
}

interface DeveloperRow {
    id: string;
    team: string;
}

/** Scan every developer's metrics for the period against weekly_aggregates. */
function scanDevelopers(db: Database.Database, period: string, tally: AnomalyScanResult): void {
    const developers = db
        .prepare('SELECT id, team FROM developers ORDER BY id')
        .all() as DeveloperRow[];
    const devMetrics = metricsForScope('developer').map((d) => d.metric);

    for (const dev of developers) {
        // All of this developer's weekly rows up to and including the period,
        // newest first. Volume is bounded by weeks-of-history, so reading them
        // all and slicing in JS keeps the NULL-dropping baseline logic simple.
        const rows = db
            .prepare(
                `SELECT week_start, total_commits, total_prs_merged, avg_code_churn,
                        avg_ai_signature_score, total_interactions, avg_acceptance_rate,
                        subscription_cost
                 FROM weekly_aggregates
                 WHERE developer_id = ? AND week_start <= ?
                 ORDER BY week_start DESC`,
            )
            .all(dev.id, period) as WeeklyRow[];

        // No aggregate row exactly at the period → nothing observed to test.
        if (rows.length === 0 || rows[0].week_start !== period) {
            continue;
        }
        const observedRow = rows[0];
        const priorRows = rows.slice(1);

        for (const metric of devMetrics) {
            const observed = developerMetricValue(observedRow, metric);
            if (observed === null || !Number.isFinite(observed)) {
                tally.skipped += 1;
                continue;
            }
            const priorDesc = priorRows.map((r) => developerMetricValue(r, metric));
            evaluateAndPersist(db, 'developer', dev.id, metric, period, dev.team, observed, priorDesc, tally);
        }
    }
}

/** Scan every team's metrics for the period, folding team metrics per week. */
function scanTeams(db: Database.Database, period: string, tally: AnomalyScanResult): void {
    const teamMetricDefs = metricsForScope('team');
    if (teamMetricDefs.length === 0) return;

    for (const team of listTeams(db)) {
        // The longest baseline window any of this team's metrics asks for decides
        // how many prior weeks to fold. Each metric then slices its own window
        // from the shared series, so the per-week team rollup runs once per week,
        // not once per metric.
        const maxWindow = Math.max(
            ...teamMetricDefs.map((d) => resolveMetricConfig(db, d.metric, team).baselineWindow),
        );
        // weeks newest → oldest: the period, then maxWindow prior weeks.
        const weekStarts: string[] = [period];
        for (let i = 0; i < maxWindow; i++) {
            weekStarts.push(priorWeekStart(weekStarts[weekStarts.length - 1]));
        }
        const seriesDesc = weekStarts.map((ws) => {
            const {start, end} = weekRange(ws);
            return computeTeamPeriodMetrics(db, team, start, end);
        });

        const observedMetrics = seriesDesc[0];
        const priorMetrics = seriesDesc.slice(1);

        for (const def of teamMetricDefs) {
            const observed = teamMetricValue(observedMetrics, def.metric);
            if (observed === null || !Number.isFinite(observed)) {
                tally.skipped += 1;
                continue;
            }
            const priorDesc = priorMetrics.map((m) => teamMetricValue(m, def.metric));
            evaluateAndPersist(db, 'team', team, def.metric, period, team, observed, priorDesc, tally);
        }
    }
}

/**
 * Run an anomaly scan for one period (any date in the target ISO week; it is
 * canonicalised to the week's Monday — the weekly_aggregates key). Evaluates
 * every developer and team metric for that period and persists the outcome.
 * Idempotent: re-running with unchanged data yields the same anomaly set.
 */
export function runAnomalyScanForPeriod(db: Database.Database, period: string): AnomalyScanResult {
    const weekStart = isoWeekStart(period);
    const tally = EMPTY_RESULT(weekStart);
    // One transaction per scan: the period's upserts/clears commit as a unit, so
    // a mid-scan failure rolls back cleanly rather than leaving a half-scanned period.
    db.transaction(() => {
        scanDevelopers(db, weekStart, tally);
        scanTeams(db, weekStart, tally);
    })();
    return tally;
}
