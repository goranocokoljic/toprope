import Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import type {Developer, ExternalIds} from './types';

interface DeveloperRow {
    id: string;
    name: string;
    email: string | null;
    team: string;
    external_ids: string | null;
    created_at: string;
}

function parseExternalIds(raw: string | null): ExternalIds {
    if (!raw) return {};
    try {
        return JSON.parse(raw) as ExternalIds;
    } catch {
        return {};
    }
}

function rowToDeveloper(row: DeveloperRow): Developer {
    return {
        id: row.id,
        name: row.name,
        email: row.email,
        team: row.team,
        external_ids: parseExternalIds(row.external_ids),
        created_at: row.created_at,
    };
}

export function addDeveloper(
    db: Database.Database,
    name: string,
    team: string,
    email?: string,
    github?: string,
): Developer {
    const id = randomUUID();
    const now = new Date().toISOString();
    const externalIds: ExternalIds = {};
    if (github) externalIds.github = github;

    db.prepare(
        'INSERT INTO developers (id, name, email, team, external_ids, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, name, email ?? null, team, JSON.stringify(externalIds), now);

    return {id, name, email: email ?? null, team, external_ids: externalIds, created_at: now};
}

export function listDevelopers(db: Database.Database, team?: string): Developer[] {
    const rows = team
        ? (db.prepare('SELECT * FROM developers WHERE team = ? ORDER BY name').all(team) as DeveloperRow[])
        : (db.prepare('SELECT * FROM developers ORDER BY name').all() as DeveloperRow[]);
    return rows.map(rowToDeveloper);
}

export function getDeveloperById(db: Database.Database, id: string): Developer | null {
    const row = db.prepare('SELECT * FROM developers WHERE id = ?').get(id) as DeveloperRow | undefined;
    return row ? rowToDeveloper(row) : null;
}

export function findByGithubUsername(db: Database.Database, github: string): Developer | null {
    const rows = db.prepare('SELECT * FROM developers').all() as DeveloperRow[];
    for (const row of rows) {
        const ext = parseExternalIds(row.external_ids);
        if (ext.github === github) return rowToDeveloper(row);
    }
    return null;
}

export function linkDeveloper(
    db: Database.Database,
    id: string,
    updates: Partial<Pick<ExternalIds, 'copilot' | 'claude' | 'windsurf'>>,
): Developer | null {
    const row = db.prepare('SELECT * FROM developers WHERE id = ?').get(id) as DeveloperRow | undefined;
    if (!row) return null;

    const existing = parseExternalIds(row.external_ids);
    if (updates.copilot !== undefined) existing.copilot = updates.copilot;
    if (updates.claude !== undefined) existing.claude = updates.claude;
    if (updates.windsurf !== undefined) existing.windsurf = updates.windsurf;

    db.prepare('UPDATE developers SET external_ids = ? WHERE id = ?').run(
        JSON.stringify(existing),
        id,
    );

    return rowToDeveloper({...row, external_ids: JSON.stringify(existing)});
}
