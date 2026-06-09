import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb, seedFixtures} from '../dashboard/fixtures';
import {
    DEFAULT_ENGINE_PARAMS,
    METRIC_DEFS,
    getAnomalyConfigSnapshot,
    isTeamAnomalyOverrideAllowed,
    metricsForScope,
    resolveEngineParams,
    resolveMetricConfig,
    setGlobalEngineParams,
    setGlobalMetricConfig,
    setTeamEngineParams,
    setTeamMetricConfig,
    validateEngineParamsPatch,
    validateMetricConfigPatch,
} from '../../src/anomaly/config';
import {setGlobalSetting} from '../../src/settings/store';

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
            // Per-team overrides require the managers_can_override flag (Task 4.12).
            setGlobalSetting(db, 'anomaly_managers_can_override', true);
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
            setGlobalSetting(db, 'anomaly_managers_can_override', true);
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

    // Task 4.12: per-team anomaly overrides honored only when the admin has
    // enabled anomaly_managers_can_override — the same gate as the flat settings.
    describe('per-team override gating (anomaly_managers_can_override)', () => {
        it('isTeamAnomalyOverrideAllowed reflects the global flag', () => {
            expect(isTeamAnomalyOverrideAllowed(db)).toBe(false);
            setGlobalSetting(db, 'anomaly_managers_can_override', true);
            expect(isTeamAnomalyOverrideAllowed(db)).toBe(true);
        });

        it('ignores a stored team metric override while the flag is off', () => {
            setGlobalMetricConfig(db, 'commits', {threshold: 3.0});
            setTeamMetricConfig(db, 'frontend', 'commits', {threshold: 9.0});

            // Flag off → team layer dropped, falls through to global.
            expect(resolveMetricConfig(db, 'commits', 'frontend').threshold).toBe(3.0);

            // Flag on → the stored team override now takes effect (no re-write needed).
            setGlobalSetting(db, 'anomaly_managers_can_override', true);
            expect(resolveMetricConfig(db, 'commits', 'frontend').threshold).toBe(9.0);
        });

        it('ignores a stored team engine override while the flag is off', () => {
            setTeamEngineParams(db, 'frontend', {minBaselinePeriods: 10});
            expect(resolveEngineParams(db, 'frontend').minBaselinePeriods).toBe(
                DEFAULT_ENGINE_PARAMS.minBaselinePeriods,
            );
            setGlobalSetting(db, 'anomaly_managers_can_override', true);
            expect(resolveEngineParams(db, 'frontend').minBaselinePeriods).toBe(10);
        });
    });

    describe('strict validators (settings API)', () => {
        it('accepts a valid partial metric config', () => {
            const r = validateMetricConfigPatch({method: 'percentage_change', threshold: 25, baselineWindow: 6});
            expect(r.ok).toBe(true);
            if (r.ok) {
                expect(r.value).toEqual({method: 'percentage_change', threshold: 25, baselineWindow: 6});
            }
        });

        it('rejects unknown fields, bad method, non-positive threshold, small window', () => {
            expect(validateMetricConfigPatch({bogus: 1}).ok).toBe(false);
            expect(validateMetricConfigPatch({method: 'nope'}).ok).toBe(false);
            expect(validateMetricConfigPatch({threshold: 0}).ok).toBe(false);
            expect(validateMetricConfigPatch({threshold: -3}).ok).toBe(false);
            expect(validateMetricConfigPatch({baselineWindow: 1}).ok).toBe(false);
            expect(validateMetricConfigPatch({baselineWindow: 2.5}).ok).toBe(false);
            expect(validateMetricConfigPatch('not-an-object').ok).toBe(false);
        });

        it('validates engine params and rejects bad values', () => {
            expect(validateEngineParamsPatch({minBaselinePeriods: 5, statisticalHighZ: 3}).ok).toBe(true);
            expect(validateEngineParamsPatch({minBaselinePeriods: 0}).ok).toBe(false);
            expect(validateEngineParamsPatch({statisticalHighZ: 0}).ok).toBe(false);
            expect(validateEngineParamsPatch({nope: 1}).ok).toBe(false);
        });
    });

    describe('getAnomalyConfigSnapshot', () => {
        it('returns every metric in registry order with effective config + engine', () => {
            const snap = getAnomalyConfigSnapshot(db);
            expect(snap.metrics.map((m) => m.metric)).toEqual(Object.keys(METRIC_DEFS));
            expect(snap.engine).toEqual(DEFAULT_ENGINE_PARAMS);
            const commits = snap.metrics.find((m) => m.metric === 'commits');
            expect(commits?.config).toMatchObject({method: 'statistical', threshold: 2.0, baselineWindow: 8});
            expect(commits?.basis).toBe('git_estimate');
        });

        it('reflects the team layer only when the flag is on', () => {
            setGlobalSetting(db, 'anomaly_managers_can_override', true);
            setTeamMetricConfig(db, 'frontend', 'commits', {threshold: 4});
            const snap = getAnomalyConfigSnapshot(db, 'frontend');
            expect(snap.metrics.find((m) => m.metric === 'commits')?.config.threshold).toBe(4);
        });
    });
});
