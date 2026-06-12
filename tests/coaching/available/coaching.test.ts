import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {randomUUID} from 'crypto';
import {runMigrations} from '../../../src/storage/migrator';
import {addTeam} from '../../../src/registry/teams';
import {addDeveloper} from '../../../src/registry/developers';
import {
    getDeveloperCoaching,
    getOrgCoaching,
    getTeamCoaching,
} from '../../../src/coaching/available/coaching';
import type {CoachingSignalType} from '../../../src/coaching/available/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');
const NOW = new Date('2026-05-20T12:00:00.000Z');

let db: Database.Database;
beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
});
afterEach(() => db.close());

function seedDev(name: string, team = 'eng'): string {
    try {
        addTeam(db, team);
    } catch {
        // already exists
    }
    return addDeveloper(db, name, team, `${name}@example.com`, name).id;
}

function insertSignal(
    devId: string,
    period: string,
    type: CoachingSignalType,
    basis: string,
    observation: string,
    category: string,
): void {
    db.prepare(
        `INSERT INTO coaching_signals
         (id, developer_id, period, signal_type, basis, observation, metric_context, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        randomUUID(),
        devId,
        period,
        type,
        basis,
        observation,
        JSON.stringify({category}),
        '2026-05-20T00:00:00.000Z',
    );
}

describe('getDeveloperCoaching (private view)', () => {
    it('returns only the developer\'s own signals, newest period first then type order', () => {
        const a = seedDev('alice');
        const b = seedDev('bob');
        insertSignal(a, '2026-04', 'acceptance_trend', 'measured', 'A april acceptance', 'rising');
        insertSignal(a, '2026-05', 'personal_insight', 'measured', 'A may personal', 'high');
        insertSignal(a, '2026-05', 'churn_reflection', 'git_estimate', 'A may churn', 'elevated');
        insertSignal(b, '2026-05', 'churn_reflection', 'git_estimate', 'B may churn', 'elevated');

        const result = getDeveloperCoaching(db, a, 'monthly', NOW);
        // Only Alice's three signals, none of Bob's.
        expect(result.signals).toHaveLength(3);
        expect(result.signals.every((s) => s.observation.startsWith('A '))).toBe(true);
        // Newest period first; within 2026-05, churn (order 0) before personal (order 3).
        expect(result.signals[0]).toMatchObject({period: '2026-05', signal_type: 'churn_reflection'});
        expect(result.signals[1]).toMatchObject({period: '2026-05', signal_type: 'personal_insight'});
        expect(result.signals[2]).toMatchObject({period: '2026-04', signal_type: 'acceptance_trend'});
        // The observation text and parsed context are present on the private view.
        expect(result.signals[0].observation).toBe('A may churn');
        expect(result.signals[0].metric_context).toEqual({category: 'elevated'});
    });
});

describe('getTeamCoaching (manager aggregate)', () => {
    it('pools a cell once enough developers contribute, with category tallies and NO text', () => {
        const ids = ['c1', 'c2', 'c3'].map((n) => seedDev(n));
        insertSignal(ids[0], '2026-05', 'churn_reflection', 'git_estimate', 'secret one', 'elevated');
        insertSignal(ids[1], '2026-05', 'churn_reflection', 'git_estimate', 'secret two', 'elevated');
        insertSignal(ids[2], '2026-05', 'churn_reflection', 'git_estimate', 'secret three', 'lower');

        const team = getTeamCoaching(db, 'eng', 'monthly', NOW);
        const churn = team.series.find((s) => s.signal_type === 'churn_reflection')!;
        const may = churn.points.find((p) => p.period === '2026-05')!;
        expect(may.suppressed).toBe(false);
        expect(may.developers).toBe(3);
        expect(may.categories).toEqual({elevated: 2, lower: 1});
        // The whole payload must never carry an observation sentence.
        expect(JSON.stringify(team)).not.toContain('secret');
    });

    it('suppresses a cell below the k-anonymity cohort floor (no numbers leak)', () => {
        const ids = ['d1', 'd2'].map((n) => seedDev(n));
        insertSignal(ids[0], '2026-05', 'churn_reflection', 'git_estimate', 'x', 'elevated');
        insertSignal(ids[1], '2026-05', 'churn_reflection', 'git_estimate', 'y', 'elevated');

        const team = getTeamCoaching(db, 'eng', 'monthly', NOW);
        const may = team.series
            .find((s) => s.signal_type === 'churn_reflection')!
            .points.find((p) => p.period === '2026-05')!;
        expect(may.suppressed).toBe(true);
        expect(may.developers).toBeNull();
        expect(may.categories).toBeNull();
    });

    it('scopes a team strictly to its current members', () => {
        const eng = ['e1', 'e2', 'e3'].map((n) => seedDev(n, 'eng'));
        const sales = ['s1', 's2', 's3'].map((n) => seedDev(n, 'sales'));
        for (const id of eng) insertSignal(id, '2026-05', 'churn_reflection', 'git_estimate', 't', 'elevated');
        for (const id of sales) insertSignal(id, '2026-05', 'journey_coaching', 'git_estimate', 't', 'plateau');

        const team = getTeamCoaching(db, 'eng', 'monthly', NOW);
        // eng contributes churn; sales' journey signals must not appear in eng's aggregate.
        const journeyMay = team.series
            .find((s) => s.signal_type === 'journey_coaching')!
            .points.find((p) => p.period === '2026-05')!;
        expect(journeyMay.suppressed).toBe(true);
    });

    it('org aggregate pools every developer', () => {
        const ids = ['o1', 'o2', 'o3'].map((n) => seedDev(n));
        for (const id of ids) insertSignal(id, '2026-05', 'personal_insight', 'measured', 't', 'high');
        const org = getOrgCoaching(db, 'monthly', NOW);
        const may = org.series
            .find((s) => s.signal_type === 'personal_insight')!
            .points.find((p) => p.period === '2026-05')!;
        expect(may.suppressed).toBe(false);
        expect(may.developers).toBe(3);
    });
});
