import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import {setGlobalSetting, setTeamSetting} from '../../src/settings/store';
import {isShowcaseEnabledForTeam, isScopePermittedForTeam} from '../../src/showcase/gate';

const NOW = '2026-06-13T00:00:00.000Z';

describe('showcase gate (Task 5.8)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run('eng', NOW);
    });

    afterEach(() => {
        db.close();
    });

    it('is disabled by default and enabled once showcase_enabled is on', () => {
        expect(isShowcaseEnabledForTeam(db, 'eng')).toBe(false);
        setGlobalSetting(db, 'showcase_enabled', true);
        expect(isShowcaseEnabledForTeam(db, 'eng')).toBe(true);
    });

    it('defaults to team_only — only team scope is permitted', () => {
        expect(isScopePermittedForTeam(db, 'eng', 'team')).toBe(true);
        expect(isScopePermittedForTeam(db, 'eng', 'org')).toBe(false);
    });

    it('permits org scope when showcase_scope_permitted is org_wide', () => {
        setGlobalSetting(db, 'showcase_scope_permitted', 'org_wide');
        // Team scope stays available, and org scope is now permitted too.
        expect(isScopePermittedForTeam(db, 'eng', 'team')).toBe(true);
        expect(isScopePermittedForTeam(db, 'eng', 'org')).toBe(true);
    });

    it('honors a per-team override of the scope when managers may override', () => {
        // Org default stays team_only; a team override widens just this team to org_wide.
        setGlobalSetting(db, 'coaching_managers_can_override', true);
        setTeamSetting(db, 'eng', 'showcase_scope_permitted', 'org_wide');
        expect(isScopePermittedForTeam(db, 'eng', 'org')).toBe(true);
        // A team with no override still follows the org default (team_only).
        expect(isScopePermittedForTeam(db, 'other', 'org')).toBe(false);
    });
});
