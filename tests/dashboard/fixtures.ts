import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

export function makeTestDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

export function seedFixtures(db: Database.Database): void {
    db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, ?, ?, ?)').run(
        'frontend', 'engineering', 'alice@test.com', '2026-01-01T00:00:00.000Z',
    );
    db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, ?, ?, ?)').run(
        'backend', 'engineering', 'bob@test.com', '2026-01-01T00:00:00.000Z',
    );

    db.prepare(
        'INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('dev-1', 'Alice Dev', 'alice@test.com', 'frontend', '2026-01-01T00:00:00.000Z');
    db.prepare(
        'INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('dev-2', 'Bob Dev', 'bob@test.com', 'backend', '2026-01-01T00:00:00.000Z');
    db.prepare(
        'INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('dev-3', 'Carol Dev', 'carol@test.com', 'frontend', '2026-01-01T00:00:00.000Z');

    db.prepare(
        `INSERT INTO subscriptions (id, developer_id, tool, plan, billing_model, monthly_cost, data_source)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('sub-1', 'dev-1', 'copilot', 'business', 'company_managed', 19, 'csv');
    db.prepare(
        `INSERT INTO subscriptions (id, developer_id, tool, plan, billing_model, monthly_cost, data_source)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('sub-2', 'dev-2', 'claude_code', 'pro', 'company_managed', 20, 'csv');

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    db.prepare(
        `INSERT INTO tool_snapshots
         (id, developer_id, date, tool, data_source, data_quality, is_active, interaction_count, acceptance_count, acceptance_rate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('snap-1', 'dev-1', today, 'copilot', 'api', 'high', 1, 42, 30, 0.714);
    db.prepare(
        `INSERT INTO tool_snapshots
         (id, developer_id, date, tool, data_source, data_quality, is_active, interaction_count, acceptance_count, acceptance_rate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('snap-2', 'dev-2', today, 'claude_code', 'api', 'high', 1, 100, 80, 0.8);
    db.prepare(
        `INSERT INTO tool_snapshots
         (id, developer_id, date, tool, data_source, data_quality, is_active, interaction_count, acceptance_count, acceptance_rate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('snap-3', 'dev-1', yesterday, 'copilot', 'api', 'high', 1, 20, 15, 0.75);

    db.prepare(
        `INSERT INTO git_snapshots
         (id, developer_id, date, commits, lines_added, lines_removed, ai_signature_score)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('git-1', 'dev-1', today, 5, 200, 50, 0.8);
    db.prepare(
        `INSERT INTO git_snapshots
         (id, developer_id, date, commits, lines_added, lines_removed, ai_signature_score)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('git-2', 'dev-2', today, 3, 100, 30, 0.6);

    db.prepare(
        `INSERT INTO waste_alerts
         (id, developer_id, team, alert_type, tool, details, monthly_waste, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        'waste-1', 'dev-3', 'frontend', 'unused_seat', 'copilot',
        '{"days_inactive":20}', 19, '2026-05-01T00:00:00.000Z',
    );
    db.prepare(
        `INSERT INTO waste_alerts
         (id, developer_id, team, alert_type, tool, details, monthly_waste, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        'waste-2', 'dev-2', 'backend', 'unused_seat', 'windsurf',
        '{"days_inactive":15}', 20, '2026-05-02T00:00:00.000Z',
    );
}
