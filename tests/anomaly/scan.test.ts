import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import {isoWeekStart, priorWeekStart} from '../../src/aggregation/dates';
import {runAnomalyScanForPeriod} from '../../src/anomaly/scan';
import {listAnomalies, setAnomalyStatus} from '../../src/anomaly/store';
import {setGlobalMetricConfig} from '../../src/anomaly/config';

// Six consecutive ISO weeks ending at a chosen Monday: weeks[0] is the oldest.
const BASE = isoWeekStart('2026-05-06');
const WEEKS: string[] = ((): string[] => {
    const desc = [BASE];
    for (let i = 0; i < 5; i++) desc.push(priorWeekStart(desc[desc.length - 1]));
    return desc.reverse(); // oldest → newest
})();
const OBSERVED = WEEKS[WEEKS.length - 1]; // the latest week (= BASE)

interface WeeklySeed {
    commits?: number;
    prs?: number;
    interactions?: number;
    churn?: number | null;
    cost?: number | null;
}

function insertDeveloper(db: Database.Database, id: string, team: string): void {
    db.prepare(
        'INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, id, `${id}@test.com`, team, '2026-01-01T00:00:00.000Z');
}

function insertWeekly(db: Database.Database, devId: string, team: string, week: string, seed: WeeklySeed): void {
    db.prepare(
        `INSERT INTO weekly_aggregates
           (id, developer_id, week_start, team, total_commits, total_prs_merged,
            total_interactions, avg_code_churn, subscription_cost, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        `${devId}-${week}`,
        devId,
        week,
        team,
        seed.commits ?? 0,
        seed.prs ?? 0,
        seed.interactions ?? 0,
        seed.churn ?? null,
        seed.cost ?? null,
        '2026-05-10T00:00:00.000Z',
    );
}

describe('runAnomalyScanForPeriod — developer scope', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        insertDeveloper(db, 'dev-1', 'frontend');
        // dev-1: a stable commits baseline then a sharp spike in the observed week.
        const commitsByWeek = [8, 12, 9, 11, 10, 40]; // last is the observed spike
        WEEKS.forEach((week, i) => {
            insertWeekly(db, 'dev-1', 'frontend', week, {commits: commitsByWeek[i]});
        });
    });

    afterEach(() => {
        db.close();
    });

    it('flags a developer commit spike (statistical) with git_estimate basis', () => {
        const result = runAnomalyScanForPeriod(db, OBSERVED);
        expect(result.period).toBe(OBSERVED);
        expect(result.flagged).toBeGreaterThanOrEqual(1);

        const commitAnomaly = listAnomalies(db, {scope: 'developer'}).find(
            (a) => a.scope_id === 'dev-1' && a.metric === 'commits',
        );
        expect(commitAnomaly).toBeDefined();
        expect(commitAnomaly?.method).toBe('statistical');
        expect(commitAnomaly?.observed_value).toBe(40);
        expect(commitAnomaly?.basis).toBe('git_estimate');
        expect(commitAnomaly?.severity).toBe('high');
        expect(commitAnomaly?.period).toBe(OBSERVED);
    });

    it('is idempotent — re-running the period does not duplicate', () => {
        runAnomalyScanForPeriod(db, OBSERVED);
        const first = listAnomalies(db).length;
        runAnomalyScanForPeriod(db, OBSERVED);
        const second = listAnomalies(db).length;
        expect(second).toBe(first);
    });

    it('preserves acknowledged status across a re-scan', () => {
        runAnomalyScanForPeriod(db, OBSERVED);
        const id = listAnomalies(db).find((a) => a.metric === 'commits')!.id;
        setAnomalyStatus(db, id, 'acknowledged');
        runAnomalyScanForPeriod(db, OBSERVED);
        expect(listAnomalies(db).find((a) => a.metric === 'commits')?.status).toBe('acknowledged');
    });

    it('respects per-metric config: raising the threshold clears the prior anomaly', () => {
        runAnomalyScanForPeriod(db, OBSERVED);
        expect(listAnomalies(db).some((a) => a.metric === 'commits')).toBe(true);

        // Threshold so high the spike no longer qualifies → re-scan clears it.
        setGlobalMetricConfig(db, 'commits', {threshold: 1000});
        const result = runAnomalyScanForPeriod(db, OBSERVED);
        expect(result.cleared).toBeGreaterThanOrEqual(1);
        expect(listAnomalies(db).some((a) => a.metric === 'commits')).toBe(false);
    });

    it('accepts any in-week date and canonicalises to the Monday', () => {
        // A Wednesday in the observed week resolves to the same week_start.
        const midWeek = new Date(Date.parse(`${OBSERVED}T00:00:00.000Z`) + 2 * 86400000)
            .toISOString()
            .slice(0, 10);
        const result = runAnomalyScanForPeriod(db, midWeek);
        expect(result.period).toBe(OBSERVED);
        expect(result.flagged).toBeGreaterThanOrEqual(1);
    });
});

describe('runAnomalyScanForPeriod — minimum-baseline guard', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        insertDeveloper(db, 'dev-new', 'frontend');
        // Only 3 weeks of history including the observed week → 2 prior periods,
        // below the default minimum of 4. Even with a wild observed value.
        const last3 = WEEKS.slice(-3);
        const commits = [10, 10, 500];
        last3.forEach((week, i) => insertWeekly(db, 'dev-new', 'frontend', week, {commits: commits[i]}));
    });

    afterEach(() => {
        db.close();
    });

    it('fires NO anomaly while still building baseline', () => {
        const result = runAnomalyScanForPeriod(db, OBSERVED);
        expect(result.buildingBaseline).toBeGreaterThanOrEqual(1);
        expect(listAnomalies(db, {scope: 'developer', scopeId: 'dev-new'})).toHaveLength(0);
    });

    it('skips a metric with no observed value for the period', () => {
        // churn/cost are null for dev-new → those series are skipped, not evaluated.
        const result = runAnomalyScanForPeriod(db, OBSERVED);
        expect(result.skipped).toBeGreaterThanOrEqual(1);
    });
});

describe('runAnomalyScanForPeriod — team scope', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        insertDeveloper(db, 'dev-1', 'frontend');
        insertWeekly(db, 'dev-1', 'frontend', OBSERVED, {commits: 5});
    });

    afterEach(() => {
        db.close();
    });

    it('runs the team path without error and evaluates team metrics', () => {
        // With no git/tool snapshots, team metrics fold to zero — the path must
        // still run cleanly and produce a well-formed result.
        const result = runAnomalyScanForPeriod(db, OBSERVED);
        expect(result.period).toBe(OBSERVED);
        expect(result.evaluated).toBeGreaterThan(0);
        // Team metrics are all-zero series → normal, nothing flagged at team scope.
        expect(listAnomalies(db, {scope: 'team'})).toHaveLength(0);
    });
});
