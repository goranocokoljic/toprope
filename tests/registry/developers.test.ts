import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {addTeam} from '../../src/registry/teams';
import {
    addDeveloper,
    listDevelopers,
    getDeveloperById,
    linkDeveloper,
    findByGithubUsername,
    findByExternalId,
    findByEmail,
    findBySlackUserId,
} from '../../src/registry/developers';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function seedTeam(db: Database.Database, name = 'frontend'): void {
    addTeam(db, name);
}

describe('addDeveloper', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        seedTeam(db);
    });

    afterEach(() => {
        db.close();
    });

    it('creates a developer with all fields', () => {
        const dev = addDeveloper(db, 'Alice', 'frontend', 'alice@example.com', 'alice-gh');
        expect(dev.name).toBe('Alice');
        expect(dev.team).toBe('frontend');
        expect(dev.email).toBe('alice@example.com');
        expect(dev.external_ids.github).toBe('alice-gh');
        expect(dev.id).toBeTruthy();
        expect(dev.created_at).toBeTruthy();
    });

    it('creates a developer with only required fields', () => {
        const dev = addDeveloper(db, 'Bob', 'frontend');
        expect(dev.name).toBe('Bob');
        expect(dev.email).toBeNull();
        expect(dev.external_ids).toEqual({});
    });

    it('stores bitbucket and gitlab identities', () => {
        const dev = addDeveloper(db, 'Dana', 'frontend', 'dana@x.com', undefined, {
            bitbucket: 'dana-bb',
            gitlab: 'dana-gl',
        });
        expect(dev.external_ids.bitbucket).toBe('dana-bb');
        expect(dev.external_ids.gitlab).toBe('dana-gl');
        expect(dev.external_ids.github).toBeUndefined();
    });

    it('normalizes git emails (lowercase, dedupe) into a comma-separated list', () => {
        const dev = addDeveloper(db, 'Dana', 'frontend', undefined, undefined, {
            gitEmails: ['Dana@Work.com', 'dana@work.com', 'dana@home.com'],
        });
        expect(dev.external_ids.git_emails).toBe('dana@work.com,dana@home.com');
    });

    it('omits git_emails when no git emails provided', () => {
        const dev = addDeveloper(db, 'Dana', 'frontend', undefined, undefined, {bitbucket: 'd'});
        expect(dev.external_ids.git_emails).toBeUndefined();
    });

    it('generates a unique id for each developer', () => {
        const d1 = addDeveloper(db, 'Alice', 'frontend');
        const d2 = addDeveloper(db, 'Bob', 'frontend');
        expect(d1.id).not.toBe(d2.id);
    });

    it('persists the developer to the database', () => {
        const dev = addDeveloper(db, 'Alice', 'frontend', 'alice@example.com');
        const row = db.prepare('SELECT * FROM developers WHERE id = ?').get(dev.id) as {
            name: string;
            email: string;
            team: string;
        };
        expect(row).toBeDefined();
        expect(row.name).toBe('Alice');
        expect(row.email).toBe('alice@example.com');
        expect(row.team).toBe('frontend');
    });
});

describe('listDevelopers', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        addTeam(db, 'frontend');
        addTeam(db, 'backend');
    });

    afterEach(() => {
        db.close();
    });

    it('returns empty array when no developers exist', () => {
        expect(listDevelopers(db)).toEqual([]);
    });

    it('returns all developers ordered by name', () => {
        addDeveloper(db, 'Zara', 'frontend');
        addDeveloper(db, 'Alice', 'backend');
        addDeveloper(db, 'Mike', 'frontend');
        const devs = listDevelopers(db);
        expect(devs.map((d) => d.name)).toEqual(['Alice', 'Mike', 'Zara']);
    });

    it('filters by team when --team is provided', () => {
        addDeveloper(db, 'Alice', 'frontend');
        addDeveloper(db, 'Bob', 'backend');
        addDeveloper(db, 'Carol', 'frontend');
        const frontendDevs = listDevelopers(db, 'frontend');
        expect(frontendDevs).toHaveLength(2);
        expect(frontendDevs.every((d) => d.team === 'frontend')).toBe(true);
    });

    it('returns empty array when no developers match team filter', () => {
        addDeveloper(db, 'Alice', 'backend');
        expect(listDevelopers(db, 'frontend')).toEqual([]);
    });

    it('parses external_ids JSON correctly', () => {
        addDeveloper(db, 'Alice', 'frontend', undefined, 'alice-gh');
        const [dev] = listDevelopers(db);
        expect(dev.external_ids.github).toBe('alice-gh');
    });
});

describe('getDeveloperById', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        seedTeam(db);
    });

    afterEach(() => {
        db.close();
    });

    it('returns the developer for a known id', () => {
        const dev = addDeveloper(db, 'Alice', 'frontend');
        const found = getDeveloperById(db, dev.id);
        expect(found).not.toBeNull();
        expect(found!.name).toBe('Alice');
    });

    it('returns null for an unknown id', () => {
        expect(getDeveloperById(db, 'nonexistent-id')).toBeNull();
    });
});

describe('linkDeveloper', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        seedTeam(db);
    });

    afterEach(() => {
        db.close();
    });

    it('updates copilot external id', () => {
        const dev = addDeveloper(db, 'Alice', 'frontend');
        const updated = linkDeveloper(db, dev.id, {copilot: 'alice-copilot'});
        expect(updated).not.toBeNull();
        expect(updated!.external_ids.copilot).toBe('alice-copilot');
    });

    it('updates claude and windsurf external ids', () => {
        const dev = addDeveloper(db, 'Alice', 'frontend');
        const updated = linkDeveloper(db, dev.id, {
            claude: 'alice@company.com',
            windsurf: 'alice@company.com',
        });
        expect(updated!.external_ids.claude).toBe('alice@company.com');
        expect(updated!.external_ids.windsurf).toBe('alice@company.com');
    });

    it('preserves existing external_ids when adding new ones', () => {
        const dev = addDeveloper(db, 'Alice', 'frontend', undefined, 'alice-gh');
        linkDeveloper(db, dev.id, {copilot: 'alice-copilot'});
        const updated = getDeveloperById(db, dev.id);
        expect(updated!.external_ids.github).toBe('alice-gh');
        expect(updated!.external_ids.copilot).toBe('alice-copilot');
    });

    it('accumulates multiple link calls', () => {
        const dev = addDeveloper(db, 'Alice', 'frontend');
        linkDeveloper(db, dev.id, {copilot: 'alice-copilot'});
        linkDeveloper(db, dev.id, {claude: 'alice@company.com'});
        const updated = getDeveloperById(db, dev.id);
        expect(updated!.external_ids.copilot).toBe('alice-copilot');
        expect(updated!.external_ids.claude).toBe('alice@company.com');
    });

    it('persists updates to the database', () => {
        const dev = addDeveloper(db, 'Alice', 'frontend');
        linkDeveloper(db, dev.id, {copilot: 'alice-copilot'});
        const row = db.prepare('SELECT external_ids FROM developers WHERE id = ?').get(dev.id) as {
            external_ids: string;
        };
        const ext = JSON.parse(row.external_ids) as {copilot: string};
        expect(ext.copilot).toBe('alice-copilot');
    });

    it('returns null for an unknown developer id', () => {
        expect(linkDeveloper(db, 'nonexistent', {copilot: 'x'})).toBeNull();
    });

    it('updates github, bitbucket, and gitlab identities', () => {
        const dev = addDeveloper(db, 'Alice', 'frontend');
        const updated = linkDeveloper(db, dev.id, {
            github: 'alice-gh',
            bitbucket: 'alice-bb',
            gitlab: 'alice-gl',
        });
        expect(updated!.external_ids.github).toBe('alice-gh');
        expect(updated!.external_ids.bitbucket).toBe('alice-bb');
        expect(updated!.external_ids.gitlab).toBe('alice-gl');
    });

    it('appends and dedupes git emails across multiple link calls', () => {
        const dev = addDeveloper(db, 'Alice', 'frontend', undefined, undefined, {
            gitEmails: ['alice@work.com'],
        });
        linkDeveloper(db, dev.id, {gitEmails: ['Alice@Personal.com', 'alice@work.com']});
        const updated = getDeveloperById(db, dev.id);
        expect(updated!.external_ids.git_emails).toBe('alice@work.com,alice@personal.com');
    });
});

describe('findByExternalId', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        seedTeam(db);
    });

    afterEach(() => {
        db.close();
    });

    it('finds a developer by bitbucket and gitlab identity', () => {
        addDeveloper(db, 'Alice', 'frontend', undefined, undefined, {
            bitbucket: 'alice-bb',
            gitlab: 'alice-gl',
        });
        expect(findByExternalId(db, 'bitbucket', 'alice-bb')!.name).toBe('Alice');
        expect(findByExternalId(db, 'gitlab', 'alice-gl')!.name).toBe('Alice');
    });

    it('returns null when no developer has that identity', () => {
        addDeveloper(db, 'Alice', 'frontend', undefined, undefined, {bitbucket: 'alice-bb'});
        expect(findByExternalId(db, 'bitbucket', 'someone-else')).toBeNull();
        expect(findByExternalId(db, 'gitlab', 'alice-bb')).toBeNull();
    });
});

describe('findByEmail', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        seedTeam(db);
    });

    afterEach(() => {
        db.close();
    });

    it('matches the primary email case-insensitively', () => {
        addDeveloper(db, 'Alice', 'frontend', 'Alice@Example.com');
        expect(findByEmail(db, 'alice@example.com')!.name).toBe('Alice');
    });

    it('matches a secondary git email', () => {
        addDeveloper(db, 'Alice', 'frontend', 'alice@example.com', undefined, {
            gitEmails: ['alice@work.com'],
        });
        expect(findByEmail(db, 'alice@work.com')!.name).toBe('Alice');
    });

    it('returns null when no developer owns the email', () => {
        addDeveloper(db, 'Alice', 'frontend', 'alice@example.com');
        expect(findByEmail(db, 'bob@example.com')).toBeNull();
    });
});

describe('findByGithubUsername', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        seedTeam(db);
    });

    afterEach(() => {
        db.close();
    });

    it('finds a developer by GitHub username', () => {
        addDeveloper(db, 'Alice', 'frontend', undefined, 'alice-gh');
        const found = findByGithubUsername(db, 'alice-gh');
        expect(found).not.toBeNull();
        expect(found!.name).toBe('Alice');
    });

    it('returns null when no developer has that GitHub username', () => {
        addDeveloper(db, 'Alice', 'frontend');
        expect(findByGithubUsername(db, 'unknown-gh')).toBeNull();
    });

    it('returns null when no developers exist', () => {
        expect(findByGithubUsername(db, 'anyone')).toBeNull();
    });
});

describe('duplicate detection', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        seedTeam(db);
    });

    afterEach(() => {
        db.close();
    });

    it('allows finding an existing developer before attempting to add a duplicate', () => {
        addDeveloper(db, 'Alice', 'frontend', undefined, 'alice-gh');
        const duplicate = findByGithubUsername(db, 'alice-gh');
        expect(duplicate).not.toBeNull();
        expect(duplicate!.external_ids.github).toBe('alice-gh');
    });
});

describe('slack identity mapping', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        seedTeam(db);
    });

    afterEach(() => {
        db.close();
    });

    it('links a slack user id and resolves it back to the developer', () => {
        const dev = addDeveloper(db, 'Alice', 'frontend', 'alice@example.com');
        linkDeveloper(db, dev.id, {slack: 'U_ALICE'});
        const found = findBySlackUserId(db, 'U_ALICE');
        expect(found?.id).toBe(dev.id);
        expect(found?.external_ids.slack).toBe('U_ALICE');
    });

    it('returns null for an unmapped or blank slack id', () => {
        addDeveloper(db, 'Alice', 'frontend');
        expect(findBySlackUserId(db, 'U_NOBODY')).toBeNull();
        expect(findBySlackUserId(db, '   ')).toBeNull();
    });

    it('trims a padded slack id on write so it resolves on lookup', () => {
        const dev = addDeveloper(db, 'Alice', 'frontend');
        linkDeveloper(db, dev.id, {slack: '  U_ALICE  '});
        const stored = getDeveloperById(db, dev.id);
        expect(stored?.external_ids.slack).toBe('U_ALICE');
        expect(findBySlackUserId(db, 'U_ALICE')?.id).toBe(dev.id);
    });

    it('finds a slack-linked developer via findByExternalId for conflict checks', () => {
        const dev = addDeveloper(db, 'Bob', 'frontend');
        linkDeveloper(db, dev.id, {slack: 'U_BOB'});
        const conflict = findByExternalId(db, 'slack', 'U_BOB');
        expect(conflict?.id).toBe(dev.id);
    });
});
