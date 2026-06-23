import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import * as settingsStore from '../../src/settings/store';
import {
    CONTRIBUTION_MODELS,
    CONTRIBUTION_MODEL_SETTING_KEY,
    DEFAULT_CONTRIBUTION_MODEL,
    gateForModel,
    isContributionModel,
    modelRequiresLeadToPublish,
    modelUsesEndorsement,
    resolveContributionModel,
} from '../../src/practices/contributionModel';
import {setGlobalSetting, setTeamSetting} from '../../src/settings/store';

describe('contribution model — pure facts (Task 6.2.2)', () => {
    describe('isContributionModel', () => {
        it('accepts exactly the three known models', () => {
            expect(CONTRIBUTION_MODELS).toEqual(['top_down', 'bottom_up', 'hybrid']);
            for (const m of CONTRIBUTION_MODELS) {
                expect(isContributionModel(m)).toBe(true);
            }
        });

        it('rejects unknown / non-string values', () => {
            expect(isContributionModel('topdown')).toBe(false);
            expect(isContributionModel('TOP_DOWN')).toBe(false);
            expect(isContributionModel('')).toBe(false);
            expect(isContributionModel(undefined)).toBe(false);
            expect(isContributionModel(42)).toBe(false);
        });

        it('defaults to top_down', () => {
            expect(DEFAULT_CONTRIBUTION_MODEL).toBe('top_down');
        });
    });

    describe('gateForModel — each model configures the 6.1.2 gate', () => {
        it('top_down requires approval', () => {
            expect(gateForModel('top_down')).toBe('required-approval');
        });
        it('bottom_up and hybrid auto-publish', () => {
            expect(gateForModel('bottom_up')).toBe('auto-publish');
            expect(gateForModel('hybrid')).toBe('auto-publish');
        });
    });

    describe('model predicates', () => {
        it('only top_down lead-gates publishing', () => {
            expect(modelRequiresLeadToPublish('top_down')).toBe(true);
            expect(modelRequiresLeadToPublish('bottom_up')).toBe(false);
            expect(modelRequiresLeadToPublish('hybrid')).toBe(false);
        });
        it('only hybrid uses endorsement', () => {
            expect(modelUsesEndorsement('hybrid')).toBe(true);
            expect(modelUsesEndorsement('top_down')).toBe(false);
            expect(modelUsesEndorsement('bottom_up')).toBe(false);
        });
    });
});

describe('resolveContributionModel — runtime, per-team, no migration (Task 6.2.2)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
    });

    afterEach(() => {
        db.close();
    });

    it('defaults to top_down with nothing configured', () => {
        expect(resolveContributionModel(db)).toBe('top_down');
        expect(resolveContributionModel(db, 'eng')).toBe('top_down');
    });

    it('reads the global default when set', () => {
        setGlobalSetting(db, CONTRIBUTION_MODEL_SETTING_KEY, 'bottom_up');
        expect(resolveContributionModel(db)).toBe('bottom_up');
        // A team with no override inherits the global value.
        expect(resolveContributionModel(db, 'eng')).toBe('bottom_up');
    });

    it('honors a per-team override (switchable at runtime, no migration)', () => {
        setGlobalSetting(db, CONTRIBUTION_MODEL_SETTING_KEY, 'top_down');
        setTeamSetting(db, 'eng', CONTRIBUTION_MODEL_SETTING_KEY, 'hybrid');
        // Same DB, no schema change between writes — the switch takes effect immediately.
        expect(resolveContributionModel(db, 'eng')).toBe('hybrid');
        // Another team is unaffected and still resolves the global default.
        expect(resolveContributionModel(db, 'design')).toBe('top_down');
    });

    it('can switch a team between all three models at runtime', () => {
        for (const model of CONTRIBUTION_MODELS) {
            setTeamSetting(db, 'eng', CONTRIBUTION_MODEL_SETTING_KEY, model);
            expect(resolveContributionModel(db, 'eng')).toBe(model);
        }
    });

    it('falls back to the default for a corrupt stored row (settings layer sanitizes)', () => {
        // Write an out-of-domain value straight into the settings table (simulating
        // registry drift / a hand-edited row), bypassing the registry coercion. The
        // settings store re-coerces on read, so resolveContributionModel still gets
        // a valid model — an end-to-end check that a bad row never surfaces a bad model.
        db.prepare(
            `INSERT INTO settings (scope, scope_name, key, value, updated_at)
             VALUES ('global', '', ?, ?, ?)`,
        ).run(CONTRIBUTION_MODEL_SETTING_KEY, JSON.stringify('anarchy'), '2026-06-23T00:00:00.000Z');
        expect(resolveContributionModel(db)).toBe('top_down');
    });

    it('guards against a non-model value from settings (defense-in-depth fallback)', () => {
        // Force resolveSetting to return an out-of-domain string — something the
        // settings store normally coerces away — to exercise the engine's OWN guard
        // rather than relying on the settings layer to have sanitized first.
        const spy = vi.spyOn(settingsStore, 'resolveSetting').mockReturnValue('chaos');
        try {
            expect(resolveContributionModel(db, 'eng')).toBe(DEFAULT_CONTRIBUTION_MODEL);
        } finally {
            spy.mockRestore();
        }
    });
});
