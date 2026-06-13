import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper} from '../../../src/registry/developers';
import {createUser} from '../../../src/auth/users';
import {setGlobalSetting, setDeveloperPreference} from '../../../src/settings/store';
import {insertLoopEvent} from '../../../src/coaching/realtime/store';
import {
    getOrgManagerCoachingPanel,
    getTeamManagerCoachingPanel,
} from '../../../src/coaching/manager-aggregate/panel';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');
const NOW = new Date('2026-06-15T00:00:00.000Z');
const IN_WINDOW = '2026-06-10T12:00:00.000Z';

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function optedInDev(db: Database.Database, team: string, name: string): string {
    try {
        addTeam(db, team);
    } catch {
        /* exists */
    }
    const id = addDeveloper(db, name, team, `${name}@example.com`, name).id;
    const user = createUser(db, {email: `${name}@test.com`, passwordHash: 'x', role: 'developer', developerId: id});
    setDeveloperPreference(db, user.id, 'capture_opt_in', true);
    return id;
}

describe('manager coaching panel — pillar gating + composition', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });

    afterEach(() => db.close());

    it('echoes the scope and period unit', () => {
        addTeam(db, 'eng');
        const org = getOrgManagerCoachingPanel(db, 'monthly', NOW);
        expect(org.scope).toBe('org');
        expect(org.period_unit).toBe('monthly');
        const team = getTeamManagerCoachingPanel(db, 'eng', 'weekly', NOW);
        expect(team.scope).toBe('eng');
        expect(team.period_unit).toBe('weekly');
    });

    it('enables PR/review and available pillars by default but HIDES loop/nudge until capture is permitted', () => {
        const panel = getOrgManagerCoachingPanel(db, 'monthly', NOW);
        // Pillars 1 & 2 default on.
        expect(panel.pr_review.enabled).toBe(true);
        expect(panel.available.enabled).toBe(true);
        // Pillar 3 (capture) defaults OFF org-wide → no opted-in cohort can exist → hidden.
        expect(panel.loop_nudge.enabled).toBe(false);
    });

    it('exposes the loop/nudge section once capture is permitted, aggregating opted-in developers only', () => {
        setGlobalSetting(db, 'coaching_capture_permitted', true);
        const a = optedInDev(db, 'eng', 'aaa');
        const b = optedInDev(db, 'eng', 'bbb');
        const c = optedInDev(db, 'eng', 'ccc');
        for (const id of [a, b, c]) {
            insertLoopEvent(db, id, {sessionId: 's', detectedAt: IN_WINDOW, similarPromptCount: 4});
        }

        const panel = getTeamManagerCoachingPanel(db, 'eng', 'monthly', NOW);
        expect(panel.loop_nudge.enabled).toBe(true);
        if (panel.loop_nudge.enabled) {
            expect(panel.loop_nudge.opted_in_developers).toBe(3);
            expect(panel.loop_nudge.loops.suppressed).toBe(false);
        }
        // A loop opportunity is synthesized from the floored cell.
        expect(panel.opportunities.map((o) => o.id)).toContain('loops_common');
    });

    it('disabling Pillar 2 hides the PR/review section', () => {
        setGlobalSetting(db, 'coaching_pillar2_enabled', false);
        expect(getOrgManagerCoachingPanel(db, 'monthly', NOW).pr_review.enabled).toBe(false);
    });

    it('disabling Pillar 1 hides the available-data section', () => {
        setGlobalSetting(db, 'coaching_pillar1_enabled', false);
        expect(getOrgManagerCoachingPanel(db, 'monthly', NOW).available.enabled).toBe(false);
    });

    it('a disabled pillar contributes no opportunities', () => {
        // Capture permitted + opted-in loops would normally yield a loop opportunity...
        setGlobalSetting(db, 'coaching_capture_permitted', true);
        const a = optedInDev(db, 'eng', 'aaa');
        const b = optedInDev(db, 'eng', 'bbb');
        const c = optedInDev(db, 'eng', 'ccc');
        for (const id of [a, b, c]) {
            insertLoopEvent(db, id, {sessionId: 's', detectedAt: IN_WINDOW, similarPromptCount: 4});
        }
        // ...but turning capture off removes the cohort and the loop opportunity with it.
        setGlobalSetting(db, 'coaching_capture_permitted', false);
        const panel = getTeamManagerCoachingPanel(db, 'eng', 'monthly', NOW);
        expect(panel.loop_nudge.enabled).toBe(false);
        expect(panel.opportunities.map((o) => o.id)).not.toContain('loops_common');
    });
});
