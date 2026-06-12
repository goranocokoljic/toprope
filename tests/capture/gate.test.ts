import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import {captureGate} from '../../src/capture/gate';

/** Thin projection used throughout: the gate's boolean enablement for a user/team. */
const isCaptureEnabled = (db: Database.Database, userId: string, team?: string | null): boolean =>
    captureGate(db, userId, team).enabled;
import {setGlobalSetting, setTeamSetting, setDeveloperPreference} from '../../src/settings/store';

const USER = 'user-1';
const TEAM = 'eng';

describe('capture opt-in gate (Task 5.4)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)')
            .run(TEAM, '2026-01-01T00:00:00.000Z');
        // A user row is needed for the FK on user_preferences; role/email are
        // irrelevant to the gate, which keys on user id + team.
        db.prepare(
            "INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, 'x', 'developer', ?)",
        ).run(USER, 'u1@test.com', '2026-01-01T00:00:00.000Z');
    });

    afterEach(() => db.close());

    it('is inert by default (developer has not opted in)', () => {
        expect(isCaptureEnabled(db, USER, TEAM)).toBe(false);
        expect(captureGate(db, USER, TEAM).reason).toBeTruthy();
    });

    it('stays inert when the developer opts in but the org does NOT permit capture', () => {
        setDeveloperPreference(db, USER, 'capture_opt_in', true);
        // coaching_capture_permitted defaults false → blocked by org policy.
        const gate = captureGate(db, USER, TEAM);
        expect(gate.enabled).toBe(false);
        expect(gate.reason).toMatch(/organization/i);
    });

    it('enables capture only when the developer opted in AND the org permits it', () => {
        setGlobalSetting(db, 'coaching_capture_permitted', true);
        setDeveloperPreference(db, USER, 'capture_opt_in', true);
        expect(isCaptureEnabled(db, USER, TEAM)).toBe(true);
    });

    it('opting out stops capture immediately (next read is inert)', () => {
        setGlobalSetting(db, 'coaching_capture_permitted', true);
        setDeveloperPreference(db, USER, 'capture_opt_in', true);
        expect(isCaptureEnabled(db, USER, TEAM)).toBe(true);
        setDeveloperPreference(db, USER, 'capture_opt_in', false);
        expect(isCaptureEnabled(db, USER, TEAM)).toBe(false);
    });

    it('a per-team capture-forbidden override blocks an opted-in developer on that team', () => {
        // Org permits globally and the developer opts in...
        setGlobalSetting(db, 'coaching_capture_permitted', true);
        setDeveloperPreference(db, USER, 'capture_opt_in', true);
        expect(isCaptureEnabled(db, USER, TEAM)).toBe(true);
        // ...but the team overrides capture off (allowed when managers may override).
        setGlobalSetting(db, 'coaching_managers_can_override', true);
        setTeamSetting(db, TEAM, 'coaching_capture_permitted', false);
        expect(isCaptureEnabled(db, USER, TEAM)).toBe(false);
    });
});
