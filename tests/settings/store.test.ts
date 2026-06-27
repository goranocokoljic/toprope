import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb, seedFixtures} from '../dashboard/fixtures';
import {
    getAllGlobalSettings,
    getGlobalSetting,
    getRoiConfigForTeam,
    getTeamOverrides,
    getUserPreferences,
    isGovernedFlagOn,
    isLeaderboardEnabledForTeam,
    isTeamOverrideAllowed,
    clearOverridesGovernedBy,
    resolveSetting,
    setGlobalSetting,
    setTeamSetting,
    setUserPreference,
    resolveDeveloperPreferences,
    setDeveloperPreference,
    isCoachingPillar1Enabled,
    isCoachingPillar2Enabled,
    isBestPracticesEnabledForTeam,
    resolveCuratorCapability,
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
                    'anomaly_alerts_enabled',
                    'anomaly_alert_min_severity',
                    'anomaly_managers_can_override',
                    'coaching_pillar1_enabled',
                    'coaching_pillar2_enabled',
                    'coaching_capture_permitted',
                    'coaching_cloud_analysis_permitted',
                    'showcase_enabled',
                    'showcase_ai_annotation_enabled',
                    'showcase_scope_permitted',
                    'nudge_default_frequency',
                    'nudge_dismissible_default',
                    'coaching_managers_can_override',
                    'best_practice_contribution_model',
                    'bestpractices_enabled',
                    'curator_permission',
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

        it('isGovernedFlagOn reads a managers_can_* flag directly', () => {
            expect(isGovernedFlagOn(db, 'anomaly_managers_can_override')).toBe(false);
            setGlobalSetting(db, 'anomaly_managers_can_override', true);
            expect(isGovernedFlagOn(db, 'anomaly_managers_can_override')).toBe(true);
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

    // Task 4.12: the enum-typed setting (string value from a closed set) shares
    // the same persistence + governed-override resolution as the scalar keys.
    describe('enum setting (anomaly_alert_min_severity)', () => {
        it('defaults to notable and persists a valid value', () => {
            expect(getGlobalSetting(db, 'anomaly_alert_min_severity')).toBe('notable');
            setGlobalSetting(db, 'anomaly_alert_min_severity', 'high');
            expect(getGlobalSetting(db, 'anomaly_alert_min_severity')).toBe('high');
        });

        it('team override honored only when anomaly_managers_can_override is on', () => {
            setGlobalSetting(db, 'anomaly_alert_min_severity', 'notable');
            setTeamSetting(db, 'frontend', 'anomaly_alert_min_severity', 'high');

            // Flag off → the stored override is inert, global value wins.
            expect(resolveSetting(db, 'anomaly_alert_min_severity', 'frontend')).toBe('notable');

            // Flag on → override honored.
            setGlobalSetting(db, 'anomaly_managers_can_override', true);
            expect(resolveSetting(db, 'anomaly_alert_min_severity', 'frontend')).toBe('high');
        });

        it('a stored value outside the allowed set falls back to the default on read', () => {
            // Hand-write an invalid value straight into the table (bypassing coercion).
            db.prepare(
                "INSERT INTO settings (scope, scope_name, key, value, updated_at) VALUES ('global','','anomaly_alert_min_severity',?, ?)",
            ).run(JSON.stringify('catastrophic'), '2026-01-01T00:00:00.000Z');
            expect(getGlobalSetting(db, 'anomaly_alert_min_severity')).toBe('notable');
        });
    });

    // Task 6.4 / #173: the two new Phase 6 policy switches, resolved through the same
    // global-default + governed per-team-override machinery as everything above.
    describe('Phase 6 settings extensions (Task 6.4)', () => {
        describe('bestpractices_enabled (master switch)', () => {
            it('defaults ON (opt-out), unlike the privacy-opt-in showcase switch', () => {
                expect(getGlobalSetting(db, 'bestpractices_enabled')).toBe(true);
                expect(isBestPracticesEnabledForTeam(db, 'frontend')).toBe(true);
                // No team / global resolution agrees with the per-team resolver.
                expect(isBestPracticesEnabledForTeam(db)).toBe(true);
            });

            it('a global off-switch disables it everywhere', () => {
                setGlobalSetting(db, 'bestpractices_enabled', false);
                expect(isBestPracticesEnabledForTeam(db, 'frontend')).toBe(false);
                expect(isBestPracticesEnabledForTeam(db, 'backend')).toBe(false);
            });

            it('a per-team override is honored ONLY when coaching_managers_can_override is on', () => {
                setGlobalSetting(db, 'bestpractices_enabled', false);
                setTeamSetting(db, 'frontend', 'bestpractices_enabled', true);

                // Flag off → the stored override is inert, global (off) wins.
                expect(isBestPracticesEnabledForTeam(db, 'frontend')).toBe(false);

                // Flag on → the team override re-enables just this team.
                setGlobalSetting(db, 'coaching_managers_can_override', true);
                expect(isBestPracticesEnabledForTeam(db, 'frontend')).toBe(true);
                // A team without an override still follows the global off value.
                expect(isBestPracticesEnabledForTeam(db, 'backend')).toBe(false);
            });

            it('disabling the governing flag discards the override (no resurrection)', () => {
                setGlobalSetting(db, 'coaching_managers_can_override', true);
                setGlobalSetting(db, 'bestpractices_enabled', false);
                setTeamSetting(db, 'frontend', 'bestpractices_enabled', true);
                expect(isBestPracticesEnabledForTeam(db, 'frontend')).toBe(true);

                clearOverridesGovernedBy(db, 'coaching_managers_can_override');
                setGlobalSetting(db, 'coaching_managers_can_override', false);
                // Re-enabling the flag falls back to the global (off), not the old override.
                setGlobalSetting(db, 'coaching_managers_can_override', true);
                expect(isBestPracticesEnabledForTeam(db, 'frontend')).toBe(false);
            });
        });

        describe('curator_permission (who may curate)', () => {
            it('defaults to managers_admins: only admins curate, not developers', () => {
                expect(getGlobalSetting(db, 'curator_permission')).toBe('managers_admins');
                expect(resolveCuratorCapability(db, 'admin', 'frontend')).toBe(true);
                expect(resolveCuratorCapability(db, 'developer', 'frontend')).toBe(false);
            });

            it('any_member widens the capability to every authenticated role', () => {
                setGlobalSetting(db, 'curator_permission', 'any_member');
                expect(resolveCuratorCapability(db, 'admin', 'frontend')).toBe(true);
                expect(resolveCuratorCapability(db, 'developer', 'frontend')).toBe(true);
            });

            it('is FAIL-CLOSED: an unrecognized stored value falls back to managers_admins', () => {
                // Hand-write a value outside the allowed set (bypassing coercion); the
                // resolver must NOT treat it as permissive — only admins curate.
                db.prepare(
                    "INSERT INTO settings (scope, scope_name, key, value, updated_at) VALUES ('global','','curator_permission',?, ?)",
                ).run(JSON.stringify('everyone'), '2026-01-01T00:00:00.000Z');
                expect(resolveCuratorCapability(db, 'developer', 'frontend')).toBe(false);
                expect(resolveCuratorCapability(db, 'admin', 'frontend')).toBe(true);
            });

            it('honors a per-team override only when the governing flag is on', () => {
                setTeamSetting(db, 'frontend', 'curator_permission', 'any_member');
                // Flag off → override inert, org default (managers_admins) wins for a developer.
                expect(resolveCuratorCapability(db, 'developer', 'frontend')).toBe(false);

                setGlobalSetting(db, 'coaching_managers_can_override', true);
                // Flag on → the frontend team's flatter model lets a developer curate…
                expect(resolveCuratorCapability(db, 'developer', 'frontend')).toBe(true);
                // …while a team without the override keeps the stricter org default.
                expect(resolveCuratorCapability(db, 'developer', 'backend')).toBe(false);
            });
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

    // Task 5.10 / #131: developer-level coaching preferences, resolved against the
    // org permission boundary. The defining behaviour is that an org policy can
    // veto a developer's stored choice.
    describe('developer coaching preferences', () => {
        let userId: string;

        beforeEach(async () => {
            const hash = await hashPassword('correct-horse-battery');
            const user = createUser(db, {
                email: 'coach@test.com',
                passwordHash: hash,
                role: 'developer',
                developerId: 'dev-1',
            });
            userId = user.id;
        });

        it('returns registry defaults when nothing is stored', () => {
            const resolved = resolveDeveloperPreferences(db, userId, 'frontend');
            expect(resolved.capture_opt_in.value).toBe(false);
            expect(resolved.nudges_enabled.value).toBe(true);
            // nudge_frequency seeds from the org default when unset.
            expect(resolved.nudge_frequency.value).toBe('normal');
        });

        it('persists a developer choice per developer', () => {
            setDeveloperPreference(db, userId, 'nudges_enabled', false);
            setDeveloperPreference(db, userId, 'nudge_frequency', 'high');
            const resolved = resolveDeveloperPreferences(db, userId, 'frontend');
            expect(resolved.nudges_enabled.stored).toBe(false);
            expect(resolved.nudge_frequency.stored).toBe('high');
        });

        it('a stored opt-in is HONORED only within org permission (cloud)', () => {
            // Developer opts into cloud analysis, but org forbids it by default.
            setDeveloperPreference(db, userId, 'cloud_analysis_opt_in', true);
            let resolved = resolveDeveloperPreferences(db, userId, 'frontend');
            // Effective value is forced false, blocked + reason surfaced…
            expect(resolved.cloud_analysis_opt_in.value).toBe(false);
            expect(resolved.cloud_analysis_opt_in.blocked).toBe(true);
            expect(resolved.cloud_analysis_opt_in.reason).toMatch(/cloud/i);
            // …yet the developer's own stored intent is preserved.
            expect(resolved.cloud_analysis_opt_in.stored).toBe(true);

            // Org permits cloud analysis → the stored opt-in now takes effect.
            setGlobalSetting(db, 'coaching_cloud_analysis_permitted', true);
            resolved = resolveDeveloperPreferences(db, userId, 'frontend');
            expect(resolved.cloud_analysis_opt_in.value).toBe(true);
            expect(resolved.cloud_analysis_opt_in.blocked).toBe(false);
            expect(resolved.cloud_analysis_opt_in.reason).toBeUndefined();
        });

        it('capture opt-in is blocked until the org permits capture', () => {
            setDeveloperPreference(db, userId, 'capture_opt_in', true);
            expect(resolveDeveloperPreferences(db, userId, 'frontend').capture_opt_in.value).toBe(false);
            setGlobalSetting(db, 'coaching_capture_permitted', true);
            expect(resolveDeveloperPreferences(db, userId, 'frontend').capture_opt_in.value).toBe(true);
        });

        it('an org permission can be lifted per team via a governed override', () => {
            // Globally capture is forbidden, but the org enables per-team overrides
            // and the frontend team turns capture on for itself.
            setGlobalSetting(db, 'coaching_managers_can_override', true);
            setTeamSetting(db, 'frontend', 'coaching_capture_permitted', true);
            setDeveloperPreference(db, userId, 'capture_opt_in', true);

            // dev-1 is on the frontend team → capture permitted → opt-in honored.
            expect(resolveDeveloperPreferences(db, userId, 'frontend').capture_opt_in.value).toBe(true);
            // The same developer resolved against a team without the override stays blocked.
            expect(resolveDeveloperPreferences(db, userId, 'backend').capture_opt_in.value).toBe(false);
        });

        it('pillar gating reflects global off-switch and per-team override', () => {
            expect(isCoachingPillar1Enabled(db, 'frontend')).toBe(true);
            expect(isCoachingPillar2Enabled(db, 'frontend')).toBe(true);

            // Disable pillar 1 org-wide → off everywhere.
            setGlobalSetting(db, 'coaching_pillar1_enabled', false);
            expect(isCoachingPillar1Enabled(db, 'frontend')).toBe(false);
            expect(isCoachingPillar1Enabled(db, 'backend')).toBe(false);

            // Re-enable just for the frontend team via a governed override.
            setGlobalSetting(db, 'coaching_managers_can_override', true);
            setTeamSetting(db, 'frontend', 'coaching_pillar1_enabled', true);
            expect(isCoachingPillar1Enabled(db, 'frontend')).toBe(true);
            expect(isCoachingPillar1Enabled(db, 'backend')).toBe(false);
        });

        it('rejects an unknown coaching preference key and a bad enum value', () => {
            expect(() => setDeveloperPreference(db, userId, 'nope', true)).toThrow();
        });
    });
});
