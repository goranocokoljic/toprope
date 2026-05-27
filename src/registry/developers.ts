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

// Optional git identities that can be attached to a developer for commit/PR
// attribution across providers.
export interface DeveloperIdentities {
    bitbucket?: string;
    gitlab?: string;
    gitEmails?: string[];
}

// Normalize a set of git emails into a deduped, lowercased comma-separated string.
function joinGitEmails(emails: string[]): string {
    const seen = new Set<string>();
    for (const e of emails) {
        const trimmed = e.trim().toLowerCase();
        if (trimmed) seen.add(trimmed);
    }
    return [...seen].join(',');
}

export function addDeveloper(
    db: Database.Database,
    name: string,
    team: string,
    email?: string,
    github?: string,
    identities?: DeveloperIdentities,
): Developer {
    const id = randomUUID();
    const now = new Date().toISOString();
    const externalIds: ExternalIds = {};
    if (github) externalIds.github = github;
    if (identities?.bitbucket) externalIds.bitbucket = identities.bitbucket;
    if (identities?.gitlab) externalIds.gitlab = identities.gitlab;
    if (identities?.gitEmails && identities.gitEmails.length > 0) {
        const joined = joinGitEmails(identities.gitEmails);
        if (joined) externalIds.git_emails = joined;
    }

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

export interface LinkUpdates {
    github?: string;
    copilot?: string;
    claude?: string;
    windsurf?: string;
    bitbucket?: string;
    gitlab?: string;
    // Additional git commit emails; appended to any existing ones.
    gitEmails?: string[];
}

export function linkDeveloper(
    db: Database.Database,
    id: string,
    updates: LinkUpdates,
): Developer | null {
    const row = db.prepare('SELECT * FROM developers WHERE id = ?').get(id) as DeveloperRow | undefined;
    if (!row) return null;

    const existing = parseExternalIds(row.external_ids);
    if (updates.github !== undefined) existing.github = updates.github;
    if (updates.copilot !== undefined) existing.copilot = updates.copilot;
    if (updates.claude !== undefined) existing.claude = updates.claude;
    if (updates.windsurf !== undefined) existing.windsurf = updates.windsurf;
    if (updates.bitbucket !== undefined) existing.bitbucket = updates.bitbucket;
    if (updates.gitlab !== undefined) existing.gitlab = updates.gitlab;
    if (updates.gitEmails && updates.gitEmails.length > 0) {
        const current = existing.git_emails ? existing.git_emails.split(',') : [];
        existing.git_emails = joinGitEmails([...current, ...updates.gitEmails]);
    }

    db.prepare('UPDATE developers SET external_ids = ? WHERE id = ?').run(
        JSON.stringify(existing),
        id,
    );

    return rowToDeveloper({...row, external_ids: JSON.stringify(existing)});
}
