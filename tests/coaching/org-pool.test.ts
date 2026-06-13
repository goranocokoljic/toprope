import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {addTeam} from '../../src/registry/teams';
import {addDeveloper} from '../../src/registry/developers';
import {orgDeveloperIdsWhereTeamEnabled} from '../../src/coaching/org-pool';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

let db: Database.Database;
beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
});
afterEach(() => db.close());

function seedDev(name: string, team: string): string {
    try {
        addTeam(db, team);
    } catch {
        /* exists */
    }
    return addDeveloper(db, name, team, `${name}@example.com`, name).id;
}

describe('orgDeveloperIdsWhereTeamEnabled', () => {
    it('keeps only developers whose team passes the predicate', () => {
        const a = seedDev('a', 'eng');
        const b = seedDev('b', 'eng');
        seedDev('c', 'optout');

        const ids = orgDeveloperIdsWhereTeamEnabled(db, (team) => team !== 'optout');
        expect(new Set(ids)).toEqual(new Set([a, b]));
    });

    it('resolves the predicate once per distinct team', () => {
        seedDev('a', 'eng');
        seedDev('b', 'eng');
        seedDev('c', 'design');
        seedDev('d', 'design');

        const seen: string[] = [];
        orgDeveloperIdsWhereTeamEnabled(db, (team) => {
            seen.push(team);
            return true;
        });
        // Two developers per team, but the predicate runs once per distinct team.
        expect(seen.sort()).toEqual(['design', 'eng']);
    });

    it('returns an empty list for an org with no developers', () => {
        expect(orgDeveloperIdsWhereTeamEnabled(db, () => true)).toEqual([]);
    });
});
