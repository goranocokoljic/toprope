import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {addTeam, archiveTeam, getTeam, listTeams} from '../../src/registry/teams';
import {discoverOrgMembers} from '../../src/registry/discovery';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

/**
 * Only the default-team resolution is exercised here — the member fetch is unmocked live
 * HTTP and is not under test. These cases reach a decision BEFORE any network call, which
 * is why they need no mock: the team gate was moved ahead of the fetch in #256 so an
 * unusable team fails immediately instead of after paginating a whole org.
 */
describe('discoverOrgMembers — default team resolution (#256)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });

    afterEach(() => {
        db.close();
    });

    it('refuses an ARCHIVED team before making any API call', async () => {
        addTeam(db, 'discovered');
        archiveTeam(db, 'discovered');

        // A live fetch would time out or throw a network error; the assertion below is on
        // the team message specifically, so it can only pass by failing at the gate.
        await expect(discoverOrgMembers(db, 'acme', 'token', 'discovered')).rejects.toThrow(
            /Team 'discovered' is archived/,
        );
    });

    it('refuses an archived DEFAULT team (no --team supplied)', async () => {
        addTeam(db, 'discovered');
        archiveTeam(db, 'discovered');

        await expect(discoverOrgMembers(db, 'acme', 'token')).rejects.toThrow(/is archived/);
    });

    it('does not resurrect or duplicate the archived team', async () => {
        addTeam(db, 'discovered');
        archiveTeam(db, 'discovered');

        await expect(discoverOrgMembers(db, 'acme', 'token', 'discovered')).rejects.toThrow();

        expect(listTeams(db, true)).toHaveLength(1);
        expect(getTeam(db, 'discovered')?.archived_at).not.toBeNull();
    });
});
