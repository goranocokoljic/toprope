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

// Find a developer whose external_ids[provider] equals value. Used to prevent
// two developers from sharing a git-attribution identity (which would make
// commit attribution ambiguous).
export function findByExternalId(
    db: Database.Database,
    provider: 'github' | 'bitbucket' | 'gitlab' | 'slack',
    value: string,
): Developer | null {
    const rows = db.prepare('SELECT * FROM developers').all() as DeveloperRow[];
    for (const row of rows) {
        const ext = parseExternalIds(row.external_ids);
        if (ext[provider] === value) return rowToDeveloper(row);
    }
    return null;
}

export function findByGithubUsername(db: Database.Database, github: string): Developer | null {
    return findByExternalId(db, 'github', github);
}

// Find the developer mapped to a given Slack user id. Used by the Slack bot
// (Task 4.2) to attribute a self-report to the right developer. Returns null
// when no developer is linked to that Slack id (the "unlinked user" path).
export function findBySlackUserId(db: Database.Database, slackUserId: string): Developer | null {
    const target = slackUserId.trim();
    if (!target) return null;
    return findByExternalId(db, 'slack', target);
}

// Find a developer who already owns a git commit email — either as their
// primary `email` or in their `git_emails`. Matching is case-insensitive.
// Used to keep an email from mapping to two developers (which would make
// commit attribution ambiguous).
export function findByEmail(db: Database.Database, email: string): Developer | null {
    const target = email.trim().toLowerCase();
    if (!target) return null;
    const rows = db.prepare('SELECT * FROM developers').all() as DeveloperRow[];
    for (const row of rows) {
        const dev = rowToDeveloper(row);
        if (dev.email && dev.email.toLowerCase() === target) return dev;
        const gitEmails = dev.external_ids.git_emails;
        if (gitEmails && gitEmails.split(',').some((e) => e.trim().toLowerCase() === target)) {
            return dev;
        }
    }
    return null;
}

export interface LinkUpdates {
    github?: string;
    copilot?: string;
    claude?: string;
    windsurf?: string;
    cursor?: string;
    bitbucket?: string;
    gitlab?: string;
    slack?: string;
    // Additional git commit emails; appended to any existing ones.
    gitEmails?: string[];
}

/**
 * Move a developer to a different team. Returns the updated developer, or null
 * if the developer does not exist. The team name is stored as-is; callers are
 * responsible for verifying the target team exists.
 */
export function setDeveloperTeam(db: Database.Database, id: string, team: string): Developer | null {
    const row = db.prepare('SELECT * FROM developers WHERE id = ?').get(id) as DeveloperRow | undefined;
    if (!row) return null;
    db.prepare('UPDATE developers SET team = ? WHERE id = ?').run(team, id);
    return rowToDeveloper({...row, team});
}

// Editable identity map for the admin UI. Unlike LinkUpdates, an empty string
// clears the field (the UI sends what the form shows), and `gitEmails` REPLACES
// the stored set rather than appending — the admin edits the full list.
export interface IdentityUpdates {
    github?: string;
    copilot?: string;
    claude?: string;
    windsurf?: string;
    cursor?: string;
    bitbucket?: string;
    gitlab?: string;
    slack?: string;
    gitEmails?: string[];
}

const PROVIDER_KEYS = ['github', 'copilot', 'claude', 'windsurf', 'cursor', 'bitbucket', 'gitlab', 'slack'] as const;

/**
 * Replace a developer's identity mapping from the admin UI. Each provided
 * provider key is set to its value, or removed when the value is empty/blank.
 * `gitEmails`, when provided, replaces the whole git-email set (deduped,
 * lowercased). Keys omitted from `updates` are left untouched. Returns the
 * updated developer, or null if it does not exist.
 */
export function setDeveloperIdentities(
    db: Database.Database,
    id: string,
    updates: IdentityUpdates,
): Developer | null {
    const row = db.prepare('SELECT * FROM developers WHERE id = ?').get(id) as DeveloperRow | undefined;
    if (!row) return null;

    const existing = parseExternalIds(row.external_ids);
    for (const key of PROVIDER_KEYS) {
        const value = updates[key];
        if (value === undefined) continue;
        const trimmed = value.trim();
        if (trimmed) {
            existing[key] = trimmed;
        } else {
            delete existing[key];
        }
    }
    if (updates.gitEmails !== undefined) {
        const joined = joinGitEmails(updates.gitEmails);
        if (joined) {
            existing.git_emails = joined;
        } else {
            delete existing.git_emails;
        }
    }

    db.prepare('UPDATE developers SET external_ids = ? WHERE id = ?').run(
        JSON.stringify(existing),
        id,
    );
    return rowToDeveloper({...row, external_ids: JSON.stringify(existing)});
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
    if (updates.cursor !== undefined) existing.cursor = updates.cursor;
    if (updates.bitbucket !== undefined) existing.bitbucket = updates.bitbucket;
    if (updates.gitlab !== undefined) existing.gitlab = updates.gitlab;
    // Trim the Slack id on write so it matches the trimmed lookup in
    // findBySlackUserId — a padded value must not become an unresolvable mapping.
    if (updates.slack !== undefined) existing.slack = updates.slack.trim();
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
