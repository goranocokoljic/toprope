import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb, seedFixtures} from '../dashboard/fixtures';
import {
    DEFAULT_ENGINE_PARAMS,
    METRIC_DEFS,
    metricsForScope,
    resolveEngineParams,
    resolveMetricConfig,
    setGlobalEngineParams,
    setGlobalMetricConfig,
    setTeamEngineParams,
    setTeamMetricConfig,
} from '../../src/anomaly/config';

describe('anomaly config', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        seedFixtures(db); // gives us teams 'frontend' / 'backend'
    });

    afterEach(() => {
        db.close();
    });

    describe('metric registry', () => {
        it('marks tool metrics measured and git/cost metrics git_estimate', () => {
            expect(METRIC_DEFS.commits.basis).toBe('git_estimate');
            expect(METRIC_DEFS.cost.basis).toBe('git_estimate');
            expect(METRIC_DEFS.interactions.basis).toBe('measured');
            expect(METRIC_DEFS.acceptance_rate.basis).toBe('measured');
        });

        it('cost defaults to percentage_change; commits to statistical', () => {
            expect(METRIC_DEFS.commits.defaults.method).toBe('statistical');
            expect(METRIC_DEFS.cost.defaults.method).toBe('percentage_change');
        });

        it('interactions is developer-only; teams skip it', () => {
            const teamMetrics = metricsForScope('team').map((d) => d.metric);
            const devMetrics = metricsForScope('developer').map((d) => d.metric);
            expect(devMetrics).toContain('interactions');
            expect(teamMetrics).not.toContain('interactions');
        });
    });

    describe('resolveMetricConfig', () => {
        it('returns hardcoded defaults when nothing is stored', () => {
            expect(resolveMetricConfig(db, 'commits')).toMatchObject({
                method: 'statistical',
                threshold: 2.0,
                baselineWindow: 8,
            });
        });

        it('applies a global override field-by-field', () => {
            setGlobalMetricConfig(db, 'commits', {threshold: 3.0});
            expect(resolveMetricConfig(db, 'commits')).toMatchObject({
                method: 'statistical', // inherited
                threshold: 3.0, // overridden
                baselineWindow: 8, // inherited
            });
        });

        it('a team override wins over global; other teams keep global', () => {
            setGlobalMetricConfig(db, 'commits', {threshold: 3.0});
            setTeamMetricConfig(db, 'frontend', 'commits', {method: 'percentage_change'});

            expect(resolveMetricConfig(db, 'commits', 'frontend')).toMatchObject({
                method: 'percentage_change', // team override
                threshold: 3.0, // global override inherited
                baselineWindow: 8, // default inherited
            });
            expect(resolveMetricConfig(db, 'commits', 'backend')).toMatchObject({
                method: 'statistical',
                threshold: 3.0,
            });
        });

        it('drops invalid stored fields and falls back to the default', () => {
            // Simulate a hand-edited / corrupt row.
            db.prepare(
                `INSERT INTO settings (scope, scope_name, key, value, updated_at)
                 VALUES ('global', '', 'anomaly_config', ?, '2026-01-01T00:00:00.000Z')`,
            ).run(JSON.stringify({commits: {method: 'bogus', threshold: -5, baselineWindow: 1}}));

            // method bogus → default; threshold -5 (<=0) → default; window 1 (<2) → default.
            expect(resolveMetricConfig(db, 'commits')).toMatchObject({
                method: 'statistical',
                threshold: 2.0,
                baselineWindow: 8,
            });
        });
    });

    describe('resolveEngineParams', () => {
        it('returns defaults when nothing is stored', () => {
            expect(resolveEngineParams(db)).toEqual(DEFAULT_ENGINE_PARAMS);
        });

        it('merges global then team overrides', () => {
            setGlobalEngineParams(db, {minBaselinePeriods: 6});
            setTeamEngineParams(db, 'frontend', {statisticalHighZ: 3.0});

            expect(resolveEngineParams(db)).toMatchObject({minBaselinePeriods: 6, statisticalHighZ: 2.5});
            expect(resolveEngineParams(db, 'frontend')).toMatchObject({
                minBaselinePeriods: 6,
                statisticalHighZ: 3.0,
            });
        });

        it('rejects an invalid minimum-baseline (< 1) and keeps the default', () => {
            setGlobalEngineParams(db, {minBaselinePeriods: 0});
            expect(resolveEngineParams(db).minBaselinePeriods).toBe(DEFAULT_ENGINE_PARAMS.minBaselinePeriods);
        });
    });
});
