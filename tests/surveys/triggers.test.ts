import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {randomUUID} from 'crypto';
import {runMigrations} from '../../src/storage/migrator';
import {addTeam} from '../../src/registry/teams';
import {addDeveloper} from '../../src/registry/developers';
import {
    anomalyCandidate,
    detectAllTriggers,
    detectPlanChanges,
    detectUnusedNewSeats,
    detectUsageDrops,
} from '../../src/surveys/triggers';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function seedDev(db: Database.Database, name: string): string {
    return addDeveloper(db, name, 'eng', `${name.toLowerCase()}@example.com`).id;
}

function insertMonthly(
    db: Database.Database,
    devId: string,
    month: string,
    deltaPct: number | null,
): void {
    db.prepare(
        `INSERT INTO monthly_aggregates (id, developer_id, month, team, interaction_delta_pct, computed_at)
         VALUES (?, ?, ?, 'eng', ?, ?)`,
    ).run(randomUUID(), devId, month, deltaPct, new Date().toISOString());
}

function insertSubscription(
    db: Database.Database,
    devId: string,
    tool: string,
    assignedDaysAgo: number | null,
): void {
    const assignedAt =
        assignedDaysAgo === null
            ? null
            : new Date(Date.now() - assignedDaysAgo * 86_400_000).toISOString();
    db.prepare(
        `INSERT INTO subscriptions (id, developer_id, tool, plan, billing_model, monthly_cost, seat_assigned_at, data_source)
         VALUES (?, ?, ?, 'pro', 'company', 20, ?, 'expense')`,
    ).run(randomUUID(), devId, tool, assignedAt);
}

function insertActiveSnapshot(db: Database.Database, devId: string, tool: string, date: string): void {
    db.prepare(
        `INSERT INTO tool_snapshots (id, developer_id, date, tool, data_source, data_quality, is_active)
         VALUES (?, ?, ?, ?, 'api', 'high', 1)`,
    ).run(randomUUID(), devId, date, tool);
}

function isoDaysAgo(days: number): string {
    return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

describe('detectUsageDrops', () => {
    let db: Database.Database;
    beforeEach(() => {
        db = makeDb();
        addTeam(db, 'eng');
    });
    afterEach(() => db.close());

    it('flags a developer whose latest month dropped past the threshold', () => {
        const dev = seedDev(db, 'Alice');
        insertMonthly(db, dev, '2026-04', null); // first month: no delta
        insertMonthly(db, dev, '2026-05', -50); // latest: big drop
        const candidates = detectUsageDrops(db);
        expect(candidates).toHaveLength(1);
        expect(candidates[0].triggerType).toBe('usage_drop');
        expect(candidates[0].triggerContext.drop_pct).toBe(-50);
        expect(candidates[0].triggerContext.period).toBe('2026-05');
    });

    it('uses only the latest month — an old drop that recovered is not flagged', () => {
        const dev = seedDev(db, 'Bob');
        insertMonthly(db, dev, '2026-04', -60); // old drop
        insertMonthly(db, dev, '2026-05', 10); // recovered latest
        expect(detectUsageDrops(db)).toHaveLength(0);
    });

    it('respects a custom threshold', () => {
        const dev = seedDev(db, 'Cara');
        insertMonthly(db, dev, '2026-05', -25);
        expect(detectUsageDrops(db, {usageDropThresholdPct: 40})).toHaveLength(0);
        expect(detectUsageDrops(db, {usageDropThresholdPct: 20})).toHaveLength(1);
    });
});

describe('detectUnusedNewSeats', () => {
    let db: Database.Database;
    beforeEach(() => {
        db = makeDb();
        addTeam(db, 'eng');
    });
    afterEach(() => db.close());

    it('flags a recently-assigned seat with no activity', () => {
        const dev = seedDev(db, 'Alice');
        insertSubscription(db, dev, 'cursor', 20); // 20d old: past 14d inactivity, within 90d window
        const candidates = detectUnusedNewSeats(db);
        expect(candidates).toHaveLength(1);
        expect(candidates[0].triggerType).toBe('unused_new_seat');
        expect(candidates[0].triggerContext.tool).toBe('cursor');
    });

    it('does not flag a seat that has activity since assignment', () => {
        const dev = seedDev(db, 'Bob');
        insertSubscription(db, dev, 'cursor', 20);
        insertActiveSnapshot(db, dev, 'cursor', isoDaysAgo(2));
        expect(detectUnusedNewSeats(db)).toHaveLength(0);
    });

    it('does not flag a brand-new seat (younger than the inactivity window)', () => {
        const dev = seedDev(db, 'Cara');
        insertSubscription(db, dev, 'cursor', 3); // only 3 days old
        expect(detectUnusedNewSeats(db)).toHaveLength(0);
    });

    it('does not flag an ancient idle seat (older than the new-seat window)', () => {
        const dev = seedDev(db, 'Dan');
        insertSubscription(db, dev, 'cursor', 200); // 200 days: ordinary waste, not "new"
        expect(detectUnusedNewSeats(db)).toHaveLength(0);
    });
});

describe('detectPlanChanges', () => {
    let db: Database.Database;
    beforeEach(() => {
        db = makeDb();
        addTeam(db, 'eng');
    });
    afterEach(() => db.close());

    it('flags a recent plan change with old/new context', () => {
        const dev = seedDev(db, 'Alice');
        db.prepare(
            `INSERT INTO plan_change_events (id, developer_id, tool, old_tool, old_plan, new_plan, changed_at, roi_flagged)
             VALUES (?, ?, 'claude_code', 'copilot', 'business', 'max', ?, 0)`,
        ).run(randomUUID(), dev, new Date(Date.now() - 5 * 86_400_000).toISOString());
        const candidates = detectPlanChanges(db);
        expect(candidates).toHaveLength(1);
        expect(candidates[0].triggerContext.old_tool).toBe('copilot');
        expect(candidates[0].triggerContext.tool).toBe('claude_code');
    });

    it('ignores changes outside the recency window', () => {
        const dev = seedDev(db, 'Bob');
        db.prepare(
            `INSERT INTO plan_change_events (id, developer_id, tool, changed_at, roi_flagged)
             VALUES (?, ?, 'cursor', ?, 0)`,
        ).run(randomUUID(), dev, new Date(Date.now() - 120 * 86_400_000).toISOString());
        expect(detectPlanChanges(db, {planChangeWindowDays: 45})).toHaveLength(0);
    });
});

describe('detectAllTriggers + anomalyCandidate', () => {
    it('combines data-backed detectors and excludes anomaly (no source yet)', () => {
        const db = makeDb();
        addTeam(db, 'eng');
        const dev = seedDev(db, 'Alice');
        insertMonthly(db, dev, '2026-05', -50);
        insertSubscription(db, dev, 'windsurf', 30);
        const all = detectAllTriggers(db);
        const types = all.map((c) => c.triggerType).sort();
        expect(types).toContain('usage_drop');
        expect(types).toContain('unused_new_seat');
        expect(types).not.toContain('anomaly');
        db.close();
    });

    it('anomalyCandidate builds a well-formed candidate for Task 4.7 to feed in', () => {
        const c = anomalyCandidate({
            developerId: 'd1',
            team: 'eng',
            metric: 'commit velocity',
            context: {std_devs: 3},
        });
        expect(c.triggerType).toBe('anomaly');
        expect(c.triggerContext.metric).toBe('commit velocity');
        expect(c.triggerContext.std_devs).toBe(3);
    });
});
