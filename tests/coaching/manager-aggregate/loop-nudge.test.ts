import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper} from '../../../src/registry/developers';
import {createUser} from '../../../src/auth/users';
import {setGlobalSetting, setDeveloperPreference} from '../../../src/settings/store';
import {insertLoopEvent, insertNudgeEvent} from '../../../src/coaching/realtime/store';
import {
    aggregateLoopNudge,
    getOrgLoopNudgeAggregate,
    getTeamLoopNudgeAggregate,
    type LoopContribution,
    type NudgeContribution,
} from '../../../src/coaching/manager-aggregate/loop-nudge';
import {MIN_TEAM_COHORT} from '../../../src/coaching/pr-review/guidance';
import type {NudgeType} from '../../../src/coaching/realtime/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');
const NOW = new Date('2026-06-15T00:00:00.000Z');
// Within the default monthly window (which starts at the first day of the oldest
// of the last 6 months), so seeded events are counted.
const IN_WINDOW = '2026-06-10T12:00:00.000Z';
// Comfortably before the window start (>6 months before NOW) → excluded.
const OUT_OF_WINDOW = '2025-01-01T12:00:00.000Z';

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

/** Create a developer, a linked user account, and (optionally) their capture opt-in. */
function devWithOptIn(db: Database.Database, team: string, name: string, optedIn: boolean): string {
    try {
        addTeam(db, team);
    } catch {
        /* exists */
    }
    const id = addDeveloper(db, name, team, `${name}@example.com`, name).id;
    const user = createUser(db, {
        email: `${name}@test.com`,
        passwordHash: 'x',
        role: 'developer',
        developerId: id,
    });
    if (optedIn) {
        setDeveloperPreference(db, user.id, 'capture_opt_in', true);
    }
    return id;
}

const loops = (...ids: string[]): LoopContribution[] => ids.map((developerId) => ({developerId}));
const nudges = (pairs: Array<[string, NudgeType]>): NudgeContribution[] =>
    pairs.map(([developerId, nudgeType]) => ({developerId, nudgeType}));

describe('aggregateLoopNudge — pure flooring math', () => {
    it('floors a loop cell on DISTINCT developers, not event count', () => {
        // 5 loop events but from a single developer → still 1 developer → suppressed.
        const agg = aggregateLoopNudge('eng', 'monthly', 1, loops('a', 'a', 'a', 'a', 'a'), []);
        expect(agg.loops.suppressed).toBe(true);
        expect(agg.loops.developers).toBeNull();
        expect(agg.loops.total).toBeNull();
    });

    it('surfaces a loop cell once at least the floor of distinct developers contribute', () => {
        // 3 distinct developers (the floor) with 4 total events.
        const agg = aggregateLoopNudge('eng', 'monthly', 3, loops('a', 'b', 'c', 'a'), []);
        expect(MIN_TEAM_COHORT).toBe(3);
        expect(agg.loops.suppressed).toBe(false);
        expect(agg.loops.developers).toBe(3);
        expect(agg.loops.total).toBe(4);
    });

    it('floors each nudge type independently', () => {
        // missing_context: 3 distinct devs → shown. missing_error: 1 dev → suppressed.
        const agg = aggregateLoopNudge(
            'eng',
            'monthly',
            3,
            [],
            nudges([
                ['a', 'missing_context'],
                ['b', 'missing_context'],
                ['c', 'missing_context'],
                ['a', 'missing_error'],
            ]),
        );
        const ctx = agg.nudges.find((n) => n.nudge_type === 'missing_context')!;
        const err = agg.nudges.find((n) => n.nudge_type === 'missing_error')!;
        expect(ctx.suppressed).toBe(false);
        expect(ctx.developers).toBe(3);
        expect(ctx.total).toBe(3);
        expect(err.suppressed).toBe(true);
        expect(err.developers).toBeNull();
        expect(err.total).toBeNull();
    });

    it('returns a cell for every nudge type, in the canonical order', () => {
        const agg = aggregateLoopNudge('eng', 'monthly', 0, [], []);
        expect(agg.nudges.map((n) => n.nudge_type)).toEqual([
            'short_prompt',
            'missing_context',
            'missing_error',
            'repeated_prompt',
        ]);
        for (const cell of agg.nudges) {
            expect(cell.suppressed).toBe(true);
        }
    });

    it('carries the opted-in eligibility count through when it clears the floor', () => {
        const agg = aggregateLoopNudge('eng', 'monthly', 7, [], []);
        expect(agg.opted_in_developers).toBe(7);
    });

    it('floors the opted-in eligibility count: exact at 0 or >= floor, null in between', () => {
        // 0 → exact (distinguishes "nobody opted in").
        expect(aggregateLoopNudge('eng', 'monthly', 0, [], []).opted_in_developers).toBe(0);
        // 1 and 2 (below floor of 3) → suppressed to null, so a manager can't read
        // off which single individual enabled capture in a tiny scope.
        expect(aggregateLoopNudge('eng', 'monthly', 1, [], []).opted_in_developers).toBeNull();
        expect(aggregateLoopNudge('eng', 'monthly', 2, [], []).opted_in_developers).toBeNull();
        // 3 (the floor) → exact.
        expect(aggregateLoopNudge('eng', 'monthly', 3, [], []).opted_in_developers).toBe(3);
    });
});

describe('getTeamLoopNudgeAggregate / getOrgLoopNudgeAggregate — opted-in only', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        setGlobalSetting(db, 'coaching_capture_permitted', true);
    });

    afterEach(() => db.close());

    it('counts ONLY opted-in developers and ignores everyone else entirely', () => {
        const a = devWithOptIn(db, 'eng', 'aaa', true);
        const b = devWithOptIn(db, 'eng', 'bbb', true);
        const c = devWithOptIn(db, 'eng', 'ccc', true);
        // Not opted in — their events must never reach the aggregate.
        const d = devWithOptIn(db, 'eng', 'ddd', false);

        for (const id of [a, b, c, d]) {
            insertLoopEvent(db, id, {sessionId: 's', detectedAt: IN_WINDOW, similarPromptCount: 3});
        }

        const agg = getTeamLoopNudgeAggregate(db, 'eng', 'monthly', NOW);
        expect(agg.opted_in_developers).toBe(3); // d excluded
        // 3 opted-in contributors → cleared the floor; d's loop is not counted.
        expect(agg.loops.suppressed).toBe(false);
        expect(agg.loops.developers).toBe(3);
        expect(agg.loops.total).toBe(3); // not 4 — d's event is excluded
    });

    it('suppresses when fewer than the floor of OPTED-IN developers contributed', () => {
        const a = devWithOptIn(db, 'eng', 'aaa', true);
        const b = devWithOptIn(db, 'eng', 'bbb', true);
        // Two more developers hit loops but are NOT opted in.
        const c = devWithOptIn(db, 'eng', 'ccc', false);
        const d = devWithOptIn(db, 'eng', 'ddd', false);

        for (const id of [a, b, c, d]) {
            insertLoopEvent(db, id, {sessionId: 's', detectedAt: IN_WINDOW, similarPromptCount: 3});
        }

        const agg = getTeamLoopNudgeAggregate(db, 'eng', 'monthly', NOW);
        // Only 2 opted-in (below the floor) → eligibility count suppressed to null too.
        expect(agg.opted_in_developers).toBeNull();
        expect(agg.loops.suppressed).toBe(true);
        expect(agg.loops.developers).toBeNull();
    });

    it('excludes events before the window start AND after the window end (future-dated)', () => {
        const a = devWithOptIn(db, 'eng', 'aaa', true);
        const b = devWithOptIn(db, 'eng', 'bbb', true);
        const c = devWithOptIn(db, 'eng', 'ccc', true);
        // a & b in window; c's event is FUTURE-dated (clock skew on a local agent) →
        // it must NOT count, so only 2 in-window contributors → suppressed.
        insertLoopEvent(db, a, {sessionId: 's', detectedAt: IN_WINDOW, similarPromptCount: 3});
        insertLoopEvent(db, b, {sessionId: 's', detectedAt: IN_WINDOW, similarPromptCount: 3});
        insertLoopEvent(db, c, {sessionId: 's', detectedAt: '2026-12-31T00:00:00.000Z', similarPromptCount: 3});

        const agg = getTeamLoopNudgeAggregate(db, 'eng', 'monthly', NOW);
        expect(agg.loops.suppressed).toBe(true);
    });

    it('excludes events outside the trajectory window', () => {
        const a = devWithOptIn(db, 'eng', 'aaa', true);
        const b = devWithOptIn(db, 'eng', 'bbb', true);
        const c = devWithOptIn(db, 'eng', 'ccc', true);
        // a & b in window; c out of window → only 2 in-window contributors → suppressed.
        insertLoopEvent(db, a, {sessionId: 's', detectedAt: IN_WINDOW, similarPromptCount: 3});
        insertLoopEvent(db, b, {sessionId: 's', detectedAt: IN_WINDOW, similarPromptCount: 3});
        insertLoopEvent(db, c, {sessionId: 's', detectedAt: OUT_OF_WINDOW, similarPromptCount: 3});

        const agg = getTeamLoopNudgeAggregate(db, 'eng', 'monthly', NOW);
        expect(agg.loops.suppressed).toBe(true);
    });

    it('returns a fully-suppressed, zero-eligibility aggregate when nobody opted in', () => {
        devWithOptIn(db, 'eng', 'aaa', false);
        devWithOptIn(db, 'eng', 'bbb', false);
        const agg = getTeamLoopNudgeAggregate(db, 'eng', 'monthly', NOW);
        expect(agg.opted_in_developers).toBe(0);
        expect(agg.loops.suppressed).toBe(true);
        expect(agg.nudges.every((n) => n.suppressed)).toBe(true);
    });

    it('aggregates nudge types across opted-in developers org-wide', () => {
        const a = devWithOptIn(db, 'eng', 'aaa', true);
        const b = devWithOptIn(db, 'platform', 'bbb', true);
        const c = devWithOptIn(db, 'platform', 'ccc', true);
        for (const id of [a, b, c]) {
            insertNudgeEvent(db, id, {sessionId: 's', nudgeType: 'missing_context', deliveredAt: IN_WINDOW});
        }
        const agg = getOrgLoopNudgeAggregate(db, 'monthly', NOW);
        const ctx = agg.nudges.find((n) => n.nudge_type === 'missing_context')!;
        expect(agg.scope).toBe('org');
        expect(ctx.suppressed).toBe(false);
        expect(ctx.developers).toBe(3);
    });
});
