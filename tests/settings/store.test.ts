import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb, seedFixtures} from '../dashboard/fixtures';
import {
    getAllGlobalSettings,
    getGlobalSetting,
    getRoiConfigForTeam,
    getTeamOverrides,
    getUserPreferences,
    isLeaderboardEnabledForTeam,
    isTeamOverrideAllowed,
    clearOverridesGovernedBy,
    resolveSetting,
    setGlobalSetting,
    setTeamSetting,
    setUserPreference,
} from '../../src/settings/store';
import {createUser} from '../../src/auth/users';
import {hashPassword} from '../../src/auth/password';

describe('settings store', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        seedFixtures(db);
    });

    afterEach(() => {
        db.close();
    });

    describe('global defaults and persistence', () => {
        it('returns registry defaults when nothing is stored', () => {
            expect(getGlobalSetting(db, 'leaderboard_enabled')).toBe(false);
            expect(getGlobalSetting(db, 'roi_threshold')).toBe(3.0);
            expect(getGlobalSetting(db, 'roi_settling_days')).toBe(30);
            expect(getGlobalSetting(db, 'roi_managers_can_override')).toBe(false);
        });

        it('persists and returns a set global value', () => {
            setGlobalSetting(db, 'roi_threshold', 5.5);
            expect(getGlobalSetting(db, 'roi_threshold')).toBe(5.5);
            setGlobalSetting(db, 'leaderboard_enabled', true);
            expect(getGlobalSetting(db, 'leaderboard_enabled')).toBe(true);
        });

        it('upserts (second write wins)', () => {
            setGlobalSetting(db, 'roi_threshold', 2);
            setGlobalSetting(db, 'roi_threshold', 4);
            expect(getGlobalSetting(db, 'roi_threshold')).toBe(4);
        });

        it('getAllGlobalSettings includes every key', () => {
            const all = getAllGlobalSettings(db);
            expect(Object.keys(all).sort()).toEqual(
                [
                    'leaderboard_enabled',
                    'leaderboard_managers_can_enable',
                    'roi_managers_can_override',
                    'roi_settling_days',
                    'roi_threshold',
                    'survey_usage_drop_auto',
                    'survey_unused_new_seat_auto',
                    'survey_plan_change_auto',
                    'survey_anomaly_auto',
                    'survey_managers_can_override',
                ].sort(),
            );
        });

        it('throws on unknown keys', () => {
            expect(() => getGlobalSetting(db, 'nope')).toThrow();
            expect(() => setGlobalSetting(db, 'nope', 1)).toThrow();
        });
    });

    describe('team override resolution', () => {
        it('falls back to global when no override exists', () => {
            setGlobalSetting(db, 'roi_threshold', 4);
            expect(resolveSetting(db, 'roi_threshold', 'frontend')).toBe(4);
        });

        it('honors a team override ONLY when the governing flag is on', () => {
            setGlobalSetting(db, 'roi_threshold', 3);
            setTeamSetting(db, 'frontend', 'roi_threshold', 7);

            // Flag off → override ignored, global wins.
            expect(getGlobalSetting(db, 'roi_managers_can_override')).toBe(false);
            expect(resolveSetting(db, 'roi_threshold', 'frontend')).toBe(3);

            // Flag on → override honored.
            setGlobalSetting(db, 'roi_managers_can_override', true);
            expect(resolveSetting(db, 'roi_threshold', 'frontend')).toBe(7);
        });

        it('leaderboard override gated by its own flag', () => {
            setGlobalSetting(db, 'leaderboard_enabled', false);
            setTeamSetting(db, 'frontend', 'leaderboard_enabled', true);

            expect(isLeaderboardEnabledForTeam(db, 'frontend')).toBe(false);
            setGlobalSetting(db, 'leaderboard_managers_can_enable', true);
            expect(isLeaderboardEnabledForTeam(db, 'frontend')).toBe(true);
            // A different team without an override still sees the global value.
            expect(isLeaderboardEnabledForTeam(db, 'backend')).toBe(false);
        });

        it('resolveSetting with no team always returns the global value', () => {
            setGlobalSetting(db, 'roi_managers_can_override', true);
            setTeamSetting(db, 'frontend', 'roi_threshold', 9);
            expect(resolveSetting(db, 'roi_threshold')).toBe(3.0);
            expect(resolveSetting(db, 'roi_threshold', null)).toBe(3.0);
        });

        it('isTeamOverrideAllowed reflects the governing flag', () => {
            expect(isTeamOverrideAllowed(db, 'roi_threshold')).toBe(false);
            // Non-overridable global flags are never team-overridable.
            expect(isTeamOverrideAllowed(db, 'roi_managers_can_override')).toBe(false);
            setGlobalSetting(db, 'roi_managers_can_override', true);
            expect(isTeamOverrideAllowed(db, 'roi_threshold')).toBe(true);
            expect(isTeamOverrideAllowed(db, 'roi_settling_days')).toBe(true);
        });

        it('getTeamOverrides returns raw stored overrides regardless of flag', () => {
            setTeamSetting(db, 'frontend', 'roi_threshold', 8);
            const overrides = getTeamOverrides(db, 'frontend');
            expect(overrides.roi_threshold).toBe(8);
        });

        it('deleting a team cascades away its overrides (no ghost rows)', () => {
            setTeamSetting(db, 'frontend', 'roi_threshold', 8);
            setTeamSetting(db, 'backend', 'roi_threshold', 5);
            db.prepare('DELETE FROM teams WHERE name = ?').run('frontend');
            expect(getTeamOverrides(db, 'frontend')).toEqual({});
            // The other team's overrides are untouched.
            expect(getTeamOverrides(db, 'backend').roi_threshold).toBe(5);
        });

        it('clearOverridesGovernedBy discards overrides for the keys a flag gates', () => {
            setTeamSetting(db, 'frontend', 'roi_threshold', 8);
            setTeamSetting(db, 'frontend', 'roi_settling_days', 14);
            // An override governed by a *different* flag must survive.
            setTeamSetting(db, 'frontend', 'leaderboard_enabled', true);

            clearOverridesGovernedBy(db, 'roi_managers_can_override');

            const overrides = getTeamOverrides(db, 'frontend');
            expect(overrides.roi_threshold).toBeUndefined();
            expect(overrides.roi_settling_days).toBeUndefined();
            expect(overrides.leaderboard_enabled).toBe(true);
        });

        it('disabling a flag clears its overrides so a re-enable cannot resurrect them', () => {
            setGlobalSetting(db, 'roi_managers_can_override', true);
            setTeamSetting(db, 'frontend', 'roi_threshold', 7);
            expect(resolveSetting(db, 'roi_threshold', 'frontend')).toBe(7);

            // Admin turns the flag off: the override is discarded, not merely suppressed.
            clearOverridesGovernedBy(db, 'roi_managers_can_override');
            setGlobalSetting(db, 'roi_managers_can_override', false);

            // Re-enabling the flag falls back to the global value, not the old override.
            setGlobalSetting(db, 'roi_managers_can_override', true);
            expect(resolveSetting(db, 'roi_threshold', 'frontend')).toBe(3.0);
        });

        it('clearOverridesGovernedBy is a no-op for a flag that governs nothing', () => {
            setTeamSetting(db, 'frontend', 'roi_threshold', 8);
            clearOverridesGovernedBy(db, 'leaderboard_enabled');
            expect(getTeamOverrides(db, 'frontend').roi_threshold).toBe(8);
        });

        it('getRoiConfigForTeam composes both ROI keys', () => {
            setGlobalSetting(db, 'roi_managers_can_override', true);
            setGlobalSetting(db, 'roi_threshold', 2);
            setTeamSetting(db, 'frontend', 'roi_settling_days', 14);
            expect(getRoiConfigForTeam(db, 'frontend')).toEqual({threshold: 2, settlingDays: 14});
            // Org-wide (no team) uses globals/defaults.
            expect(getRoiConfigForTeam(db)).toEqual({threshold: 2, settlingDays: 30});
        });
    });

    describe('user preferences', () => {
        let userId: string;

        beforeEach(async () => {
            const hash = await hashPassword('correct-horse-battery');
            const user = createUser(db, {email: 'pref@test.com', passwordHash: hash, role: 'developer'});
            userId = user.id;
        });

        it('returns defaults when nothing is set', () => {
            expect(getUserPreferences(db, userId)).toEqual({default_time_range: '30d', dark_mode: false});
        });

        it('persists set preferences over the defaults', () => {
            setUserPreference(db, userId, 'dark_mode', true);
            setUserPreference(db, userId, 'default_time_range', 'lifetime');
            expect(getUserPreferences(db, userId)).toEqual({default_time_range: 'lifetime', dark_mode: true});
        });

        it('throws on unknown preference keys', () => {
            expect(() => setUserPreference(db, userId, 'nope', true)).toThrow();
        });
    });
});
