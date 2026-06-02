import Database from 'better-sqlite3';
import path from 'path';
import {randomUUID} from 'crypto';
import {runMigrations} from '../../src/storage/migrator';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

export function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

export function addDeveloper(db: Database.Database, id: string, team: string): void {
    db.prepare('INSERT OR IGNORE INTO teams (name, created_at) VALUES (?, ?)').run(
        team,
        '2026-01-01T00:00:00.000Z',
    );
    db.prepare(
        'INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, `Dev ${id}`, `${id}@test.com`, team, '2026-01-01T00:00:00.000Z');
}

export interface GitFields {
    commits?: number;
    lines_added?: number;
    lines_removed?: number;
    files_changed?: number;
    prs_opened?: number;
    prs_merged?: number;
    review_comments_given?: number;
    code_churn_rate?: number | null;
    ai_signature_score?: number | null;
}

export function addGitSnapshot(
    db: Database.Database,
    developerId: string,
    date: string,
    fields: GitFields,
): void {
    db.prepare(
        `INSERT INTO git_snapshots
         (id, developer_id, date, commits, lines_added, lines_removed, files_changed,
          prs_opened, prs_merged, review_comments_given, code_churn_rate, ai_signature_score)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        randomUUID(),
        developerId,
        date,
        fields.commits ?? 0,
        fields.lines_added ?? 0,
        fields.lines_removed ?? 0,
        fields.files_changed ?? 0,
        fields.prs_opened ?? 0,
        fields.prs_merged ?? 0,
        fields.review_comments_given ?? 0,
        fields.code_churn_rate ?? null,
        fields.ai_signature_score ?? null,
    );
}

export interface ToolFields {
    tool?: string;
    is_active?: number;
    interaction_count?: number | null;
    acceptance_count?: number | null;
    acceptance_rate?: number | null;
    estimated_cost?: number | null;
    data_source?: string;
    data_quality?: string;
}

export function addToolSnapshot(
    db: Database.Database,
    developerId: string,
    date: string,
    fields: ToolFields,
): void {
    db.prepare(
        `INSERT INTO tool_snapshots
         (id, developer_id, date, tool, data_source, data_quality, is_active,
          interaction_count, acceptance_count, acceptance_rate, estimated_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        randomUUID(),
        developerId,
        date,
        fields.tool ?? 'copilot',
        fields.data_source ?? 'api',
        fields.data_quality ?? 'high',
        fields.is_active ?? 1,
        fields.interaction_count ?? null,
        fields.acceptance_count ?? null,
        fields.acceptance_rate ?? null,
        fields.estimated_cost ?? null,
    );
}

export function addSubscription(
    db: Database.Database,
    developerId: string,
    fields: {
        tool?: string;
        monthly_cost: number;
        seat_assigned_at: string | null;
        seat_revoked_at?: string | null;
    },
): void {
    db.prepare(
        `INSERT INTO subscriptions
         (id, developer_id, tool, plan, billing_model, monthly_cost, seat_assigned_at, seat_revoked_at, data_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        randomUUID(),
        developerId,
        fields.tool ?? 'copilot',
        'business',
        'company_managed',
        fields.monthly_cost,
        fields.seat_assigned_at,
        fields.seat_revoked_at ?? null,
        'csv',
    );
}
