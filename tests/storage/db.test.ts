import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations, getMigrationStatus} from '../../src/storage/migrator';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    return db;
}

describe('runMigrations', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });

    afterEach(() => {
        db.close();
    });

    it('applies all 8 migrations on a fresh database', () => {
        const count = runMigrations(db, MIGRATIONS_DIR);
        expect(count).toBe(9);
    });

    it('is idempotent — running twice applies nothing the second time', () => {
        runMigrations(db, MIGRATIONS_DIR);
        const count = runMigrations(db, MIGRATIONS_DIR);
        expect(count).toBe(0);
    });

    it('creates the schema_migrations tracking table', () => {
        runMigrations(db, MIGRATIONS_DIR);
        const row = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
            .get();
        expect(row).toBeDefined();
    });
});

describe('getMigrationStatus', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });

    afterEach(() => {
        db.close();
    });

    it('returns 8 entries after all migrations are applied', () => {
        runMigrations(db, MIGRATIONS_DIR);
        const statuses = getMigrationStatus(db, MIGRATIONS_DIR);
        expect(statuses).toHaveLength(9);
    });

    it('marks all 8 migrations as applied', () => {
        runMigrations(db, MIGRATIONS_DIR);
        const statuses = getMigrationStatus(db, MIGRATIONS_DIR);
        expect(statuses.every((s) => s.applied)).toBe(true);
    });

    it('marks all migrations as not applied on a fresh database', () => {
        const statuses = getMigrationStatus(db, MIGRATIONS_DIR);
        expect(statuses.every((s) => !s.applied)).toBe(true);
    });
});

describe('table creation', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        runMigrations(db, MIGRATIONS_DIR);
    });

    afterEach(() => {
        db.close();
    });

    function tableExists(name: string): boolean {
        const row = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
            .get(name);
        return row !== undefined;
    }

    it('creates the developers table', () => {
        expect(tableExists('developers')).toBe(true);
    });

    it('creates the teams table', () => {
        expect(tableExists('teams')).toBe(true);
    });

    it('creates the subscriptions table', () => {
        expect(tableExists('subscriptions')).toBe(true);
    });

    it('creates the tool_snapshots table', () => {
        expect(tableExists('tool_snapshots')).toBe(true);
    });

    it('creates the git_snapshots table', () => {
        expect(tableExists('git_snapshots')).toBe(true);
    });

    it('creates the weekly_aggregates table', () => {
        expect(tableExists('weekly_aggregates')).toBe(true);
    });

    it('creates the monthly_aggregates table', () => {
        expect(tableExists('monthly_aggregates')).toBe(true);
    });

    it('creates the quarterly_aggregates table', () => {
        expect(tableExists('quarterly_aggregates')).toBe(true);
    });

    it('creates the summaries table', () => {
        expect(tableExists('summaries')).toBe(true);
    });

    it('creates the waste_alerts table', () => {
        expect(tableExists('waste_alerts')).toBe(true);
    });
});

describe('basic CRUD', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        runMigrations(db, MIGRATIONS_DIR);
    });

    afterEach(() => {
        db.close();
    });

    it('inserts and selects a team', () => {
        db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, ?, ?, ?)').run(
            'frontend',
            'engineering',
            'goran',
            '2026-05-24T00:00:00.000Z',
        );
        const row = db.prepare('SELECT * FROM teams WHERE name = ?').get('frontend') as {
            name: string;
            department: string;
        };
        expect(row.name).toBe('frontend');
        expect(row.department).toBe('engineering');
    });

    it('inserts and selects a developer', () => {
        db.prepare('INSERT INTO teams (name, created_at) VALUES (?, ?)').run(
            'backend',
            '2026-05-24T00:00:00.000Z',
        );
        db.prepare(
            'INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)',
        ).run('dev-1', 'Alice', 'alice@example.com', 'backend', '2026-05-24T00:00:00.000Z');

        const row = db.prepare('SELECT * FROM developers WHERE id = ?').get('dev-1') as {
            name: string;
            email: string;
            team: string;
        };
        expect(row.name).toBe('Alice');
        expect(row.email).toBe('alice@example.com');
        expect(row.team).toBe('backend');
    });

    it('inserts and selects a subscription', () => {
        db.prepare('INSERT INTO teams (name, created_at) VALUES (?, ?)').run(
            'backend',
            '2026-05-24T00:00:00.000Z',
        );
        db.prepare(
            'INSERT INTO developers (id, name, team, created_at) VALUES (?, ?, ?, ?)',
        ).run('dev-1', 'Alice', 'backend', '2026-05-24T00:00:00.000Z');
        db.prepare(
            'INSERT INTO subscriptions (id, developer_id, tool, billing_model, monthly_cost, data_source) VALUES (?, ?, ?, ?, ?, ?)',
        ).run('sub-1', 'dev-1', 'copilot', 'company_managed', 19, 'api');

        const row = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get('sub-1') as {
            tool: string;
            monthly_cost: number;
        };
        expect(row.tool).toBe('copilot');
        expect(row.monthly_cost).toBe(19);
    });

    it('inserts and selects a tool_snapshot', () => {
        db.prepare('INSERT INTO teams (name, created_at) VALUES (?, ?)').run(
            'backend',
            '2026-05-24T00:00:00.000Z',
        );
        db.prepare(
            'INSERT INTO developers (id, name, team, created_at) VALUES (?, ?, ?, ?)',
        ).run('dev-1', 'Alice', 'backend', '2026-05-24T00:00:00.000Z');
        db.prepare(
            `INSERT INTO tool_snapshots
             (id, developer_id, date, tool, data_source, data_quality, is_active, interaction_count, acceptance_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run('snap-1', 'dev-1', '2026-05-24', 'copilot', 'api', 'high', 1, 42, 30);

        const row = db.prepare('SELECT * FROM tool_snapshots WHERE id = ?').get('snap-1') as {
            tool: string;
            interaction_count: number;
            acceptance_count: number;
        };
        expect(row.tool).toBe('copilot');
        expect(row.interaction_count).toBe(42);
        expect(row.acceptance_count).toBe(30);
    });

    it('inserts and selects a git_snapshot', () => {
        db.prepare('INSERT INTO teams (name, created_at) VALUES (?, ?)').run(
            'backend',
            '2026-05-24T00:00:00.000Z',
        );
        db.prepare(
            'INSERT INTO developers (id, name, team, created_at) VALUES (?, ?, ?, ?)',
        ).run('dev-1', 'Alice', 'backend', '2026-05-24T00:00:00.000Z');
        db.prepare(
            `INSERT INTO git_snapshots
             (id, developer_id, date, commits, lines_added, lines_removed)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).run('git-1', 'dev-1', '2026-05-24', 5, 200, 50);

        const row = db.prepare('SELECT * FROM git_snapshots WHERE id = ?').get('git-1') as {
            commits: number;
            lines_added: number;
        };
        expect(row.commits).toBe(5);
        expect(row.lines_added).toBe(200);
    });

    it('inserts and selects a weekly_aggregate', () => {
        db.prepare('INSERT INTO teams (name, created_at) VALUES (?, ?)').run(
            'backend',
            '2026-05-24T00:00:00.000Z',
        );
        db.prepare(
            'INSERT INTO developers (id, name, team, created_at) VALUES (?, ?, ?, ?)',
        ).run('dev-1', 'Alice', 'backend', '2026-05-24T00:00:00.000Z');
        db.prepare(
            `INSERT INTO weekly_aggregates
             (id, developer_id, week_start, team, active_days, total_interactions, computed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run('wa-1', 'dev-1', '2026-05-19', 'backend', 4, 120, '2026-05-24T00:00:00.000Z');

        const row = db.prepare('SELECT * FROM weekly_aggregates WHERE id = ?').get('wa-1') as {
            active_days: number;
            total_interactions: number;
        };
        expect(row.active_days).toBe(4);
        expect(row.total_interactions).toBe(120);
    });

    it('inserts and selects a summary', () => {
        db.prepare(
            `INSERT INTO summaries
             (id, scope, scope_name, period_type, period_value, summary_text, model_used, data_hash, generated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            'sum-1',
            'team',
            'backend',
            'weekly',
            '2026-W21',
            'Team had a productive week.',
            'claude-haiku-4-5',
            'abc123',
            '2026-05-24T00:00:00.000Z',
        );

        const row = db.prepare('SELECT * FROM summaries WHERE id = ?').get('sum-1') as {
            summary_text: string;
            scope_name: string;
        };
        expect(row.summary_text).toBe('Team had a productive week.');
        expect(row.scope_name).toBe('backend');
    });

    it('inserts and selects a waste_alert', () => {
        db.prepare('INSERT INTO teams (name, created_at) VALUES (?, ?)').run(
            'backend',
            '2026-05-24T00:00:00.000Z',
        );
        db.prepare(
            `INSERT INTO waste_alerts
             (id, team, alert_type, details, monthly_waste, detected_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
            'alert-1',
            'backend',
            'unused_seat',
            '{"tool":"copilot","days_inactive":20}',
            19,
            '2026-05-24T00:00:00.000Z',
        );

        const row = db.prepare('SELECT * FROM waste_alerts WHERE id = ?').get('alert-1') as {
            alert_type: string;
            monthly_waste: number;
        };
        expect(row.alert_type).toBe('unused_seat');
        expect(row.monthly_waste).toBe(19);
    });

    it('enforces unique constraint on tool_snapshots (developer_id, date, tool)', () => {
        db.prepare('INSERT INTO teams (name, created_at) VALUES (?, ?)').run(
            'backend',
            '2026-05-24T00:00:00.000Z',
        );
        db.prepare(
            'INSERT INTO developers (id, name, team, created_at) VALUES (?, ?, ?, ?)',
        ).run('dev-1', 'Alice', 'backend', '2026-05-24T00:00:00.000Z');

        const insert = db.prepare(
            `INSERT INTO tool_snapshots
             (id, developer_id, date, tool, data_source, data_quality, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        insert.run('snap-1', 'dev-1', '2026-05-24', 'copilot', 'api', 'high', 1);
        expect(() =>
            insert.run('snap-2', 'dev-1', '2026-05-24', 'copilot', 'api', 'high', 1),
        ).toThrow();
    });
});
