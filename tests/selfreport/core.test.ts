import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {randomUUID} from 'crypto';
import {runMigrations} from '../../src/storage/migrator';
import {addTeam} from '../../src/registry/teams';
import {addDeveloper} from '../../src/registry/developers';
import {
    createSelfReport,
    getSelfReportsForDeveloper,
    SelfReportError,
} from '../../src/selfreport/core';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function seedDev(db: Database.Database, name = 'Alice'): string {
    addTeam(db, 'eng');
    return addDeveloper(db, name, 'eng', `${name.toLowerCase()}@example.com`).id;
}

interface SnapshotRow {
    developer_id: string;
    date: string;
    tool: string;
    data_source: string;
    data_quality: string;
    is_active: number;
    interaction_count: number | null;
    features_used: string | null;
}

function getSnapshot(
    db: Database.Database,
    devId: string,
    date: string,
    tool: string,
): SnapshotRow | undefined {
    return db
        .prepare(
            'SELECT * FROM tool_snapshots WHERE developer_id = ? AND date = ? AND tool = ?',
        )
        .get(devId, date, tool) as SnapshotRow | undefined;
}

describe('createSelfReport', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });

    afterEach(() => {
        db.close();
    });

    it('stores a self_report and marks the developer active for that tool/date', () => {
        const devId = seedDev(db);
        const result = createSelfReport(db, {
            developerId: devId,
            tool: 'cursor',
            minutes: 90,
            taskDescriptor: 'refactor auth',
            date: '2024-03-01',
            sourceInterface: 'cli',
        });

        expect(result.snapshot).toBe('created');

        const stored = db
            .prepare('SELECT * FROM self_reports WHERE id = ?')
            .get(result.report.id) as Record<string, unknown>;
        expect(stored.developer_id).toBe(devId);
        expect(stored.tool).toBe('cursor');
        expect(stored.minutes).toBe(90);
        expect(stored.task_descriptor).toBe('refactor auth');
        expect(stored.source_interface).toBe('cli');

        const snap = getSnapshot(db, devId, '2024-03-01', 'cursor');
        expect(snap).toBeDefined();
        expect(snap?.is_active).toBe(1);
    });

    it('aggregates as data_source="self_report", data_quality="medium" with null counts', () => {
        const devId = seedDev(db);
        createSelfReport(db, {
            developerId: devId,
            tool: 'chatgpt',
            date: '2024-03-02',
            sourceInterface: 'cli',
        });

        const snap = getSnapshot(db, devId, '2024-03-02', 'chatgpt');
        expect(snap?.data_source).toBe('self_report');
        expect(snap?.data_quality).toBe('medium');
        // We never fabricate measured counts from a self-reported time estimate.
        expect(snap?.interaction_count).toBeNull();
        expect(snap?.features_used).toBeNull();
    });

    it('treats minutes and task as optional — tool + date suffice', () => {
        const devId = seedDev(db);
        const result = createSelfReport(db, {
            developerId: devId,
            tool: 'copilot',
            date: '2024-03-03',
            sourceInterface: 'cli',
        });
        expect(result.snapshot).toBe('created');
        expect(result.report.minutes).toBeNull();
        expect(result.report.task_descriptor).toBeNull();
    });

    it('defaults date to today (UTC) when omitted', () => {
        const devId = seedDev(db);
        const today = new Date().toISOString().slice(0, 10);
        const result = createSelfReport(db, {
            developerId: devId,
            tool: 'windsurf',
            sourceInterface: 'cli',
        });
        expect(result.report.date).toBe(today);
        expect(getSnapshot(db, devId, today, 'windsurf')).toBeDefined();
    });

    describe('API-wins rule', () => {
        it('does NOT overwrite an existing API snapshot for the same tool/date', () => {
            const devId = seedDev(db);
            // Pre-existing API snapshot with measured data.
            db.prepare(
                `INSERT INTO tool_snapshots
                 (id, developer_id, date, tool, data_source, data_quality, is_active,
                  interaction_count, acceptance_count, acceptance_rate, features_used,
                  models_used, estimated_cost, tokens_consumed, raw_data)
                 VALUES (?, ?, ?, ?, 'api', 'high', 1, 120, 60, 0.5, ?, NULL, NULL, NULL, NULL)`,
            ).run(randomUUID(), devId, '2024-03-04', 'cursor', JSON.stringify({autocomplete: 60}));

            const result = createSelfReport(db, {
                developerId: devId,
                tool: 'cursor',
                minutes: 30,
                date: '2024-03-04',
                sourceInterface: 'cli',
            });

            expect(result.snapshot).toBe('api_wins');

            // Snapshot untouched: still API/high with its measured counts.
            const snap = getSnapshot(db, devId, '2024-03-04', 'cursor');
            expect(snap?.data_source).toBe('api');
            expect(snap?.data_quality).toBe('high');
            expect(snap?.interaction_count).toBe(120);

            // Exactly one snapshot for that dev/date/tool (no duplicate row).
            const count = db
                .prepare(
                    'SELECT COUNT(*) AS n FROM tool_snapshots WHERE developer_id = ? AND date = ? AND tool = ?',
                )
                .get(devId, '2024-03-04', 'cursor') as {n: number};
            expect(count.n).toBe(1);

            // But the raw self-report is still kept on record.
            const reports = getSelfReportsForDeveloper(db, devId, {tool: 'cursor'});
            expect(reports).toHaveLength(1);
        });

        it('keeps a prior self_report snapshot active on a second self-report (idempotent)', () => {
            const devId = seedDev(db);
            const first = createSelfReport(db, {
                developerId: devId,
                tool: 'cursor',
                date: '2024-03-05',
                sourceInterface: 'cli',
            });
            expect(first.snapshot).toBe('created');

            const second = createSelfReport(db, {
                developerId: devId,
                tool: 'cursor',
                date: '2024-03-05',
                sourceInterface: 'cli',
            });
            expect(second.snapshot).toBe('already_self_report');

            // Still exactly one snapshot, still self_report.
            const count = db
                .prepare(
                    'SELECT COUNT(*) AS n FROM tool_snapshots WHERE developer_id = ? AND date = ? AND tool = ?',
                )
                .get(devId, '2024-03-05', 'cursor') as {n: number};
            expect(count.n).toBe(1);

            // Both raw reports are kept.
            expect(getSelfReportsForDeveloper(db, devId, {tool: 'cursor'})).toHaveLength(2);
        });
    });

    describe('self-only scoping', () => {
        it('rejects logging for a developer that does not exist', () => {
            seedDev(db);
            expect(() =>
                createSelfReport(db, {
                    developerId: 'not-a-real-dev',
                    tool: 'cursor',
                    sourceInterface: 'cli',
                }),
            ).toThrow(SelfReportError);
        });

        it('always attributes the report to the given developer (no cross-developer target)', () => {
            const alice = seedDev(db, 'Alice');
            const bob = addDeveloper(db, 'Bob', 'eng', 'bob@example.com').id;

            const result = createSelfReport(db, {
                developerId: alice,
                tool: 'cursor',
                date: '2024-03-06',
                sourceInterface: 'cli',
            });

            // The report belongs to Alice; nothing was written for Bob.
            expect(result.report.developer_id).toBe(alice);
            expect(getSelfReportsForDeveloper(db, bob)).toHaveLength(0);
            expect(getSnapshot(db, bob, '2024-03-06', 'cursor')).toBeUndefined();
        });
    });

    describe('privacy of task_descriptor', () => {
        it('never copies task_descriptor into the aggregated snapshot', () => {
            const devId = seedDev(db);
            createSelfReport(db, {
                developerId: devId,
                tool: 'cursor',
                taskDescriptor: 'super secret refactor of billing',
                date: '2024-03-07',
                sourceInterface: 'cli',
            });

            // tool_snapshots has no column for it, and no field carries it.
            const snap = getSnapshot(db, devId, '2024-03-07', 'cursor') as Record<string, unknown>;
            const serialized = JSON.stringify(snap);
            expect(serialized).not.toContain('super secret');
        });

        it('exposes task_descriptor only via the per-developer accessor, scoped to that developer', () => {
            const alice = seedDev(db, 'Alice');
            const bob = addDeveloper(db, 'Bob', 'eng', 'bob@example.com').id;
            createSelfReport(db, {
                developerId: alice,
                tool: 'cursor',
                taskDescriptor: 'alice private note',
                date: '2024-03-08',
                sourceInterface: 'cli',
            });

            // Alice sees her own descriptor.
            const aliceReports = getSelfReportsForDeveloper(db, alice);
            expect(aliceReports[0].task_descriptor).toBe('alice private note');

            // Bob's view never includes Alice's reports.
            expect(getSelfReportsForDeveloper(db, bob)).toHaveLength(0);
        });
    });

    describe('input validation', () => {
        it('rejects an unknown tool', () => {
            const devId = seedDev(db);
            expect(() =>
                createSelfReport(db, {developerId: devId, tool: 'notepad', sourceInterface: 'cli'}),
            ).toThrow(SelfReportError);
        });

        it('rejects a malformed date', () => {
            const devId = seedDev(db);
            expect(() =>
                createSelfReport(db, {
                    developerId: devId,
                    tool: 'cursor',
                    date: '03/07/2024',
                    sourceInterface: 'cli',
                }),
            ).toThrow(SelfReportError);
        });

        it('rejects an impossible calendar date that matches the format', () => {
            const devId = seedDev(db);
            expect(() =>
                createSelfReport(db, {
                    developerId: devId,
                    tool: 'cursor',
                    date: '2024-13-40',
                    sourceInterface: 'cli',
                }),
            ).toThrow(SelfReportError);
        });

        it('rejects non-positive or non-integer minutes', () => {
            const devId = seedDev(db);
            for (const bad of [0, -5, 12.5, NaN]) {
                expect(() =>
                    createSelfReport(db, {
                        developerId: devId,
                        tool: 'cursor',
                        minutes: bad,
                        sourceInterface: 'cli',
                    }),
                ).toThrow(SelfReportError);
            }
            // No partial writes from the rejected attempts.
            expect(getSelfReportsForDeveloper(db, devId)).toHaveLength(0);
        });
    });

    describe('getSelfReportsForDeveloper', () => {
        it('filters by tool and date range and respects limit', () => {
            const devId = seedDev(db);
            createSelfReport(db, {developerId: devId, tool: 'cursor', date: '2024-03-01', sourceInterface: 'cli'});
            createSelfReport(db, {developerId: devId, tool: 'copilot', date: '2024-03-02', sourceInterface: 'cli'});
            createSelfReport(db, {developerId: devId, tool: 'cursor', date: '2024-03-10', sourceInterface: 'cli'});

            expect(getSelfReportsForDeveloper(db, devId, {tool: 'cursor'})).toHaveLength(2);
            expect(
                getSelfReportsForDeveloper(db, devId, {from: '2024-03-02', to: '2024-03-05'}),
            ).toHaveLength(1);
            expect(getSelfReportsForDeveloper(db, devId, {limit: 1})).toHaveLength(1);
        });
    });
});
