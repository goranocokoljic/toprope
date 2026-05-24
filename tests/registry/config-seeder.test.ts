import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {seedTeamsFromConfig} from '../../src/registry/config-seeder';
import {listTeams, teamExists} from '../../src/registry/teams';
import type {TeamConfig} from '../../src/config/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

describe('seedTeamsFromConfig', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });

    afterEach(() => {
        db.close();
    });

    it('creates teams from config on empty database', () => {
        const teams: TeamConfig[] = [
            {name: 'frontend', department: 'engineering', manager: 'alice'},
            {name: 'backend', department: 'engineering'},
        ];
        seedTeamsFromConfig(db, teams);
        expect(listTeams(db)).toHaveLength(2);
        expect(teamExists(db, 'frontend')).toBe(true);
        expect(teamExists(db, 'backend')).toBe(true);
    });

    it('is idempotent — running twice does not create duplicates', () => {
        const teams: TeamConfig[] = [{name: 'devops'}];
        seedTeamsFromConfig(db, teams);
        seedTeamsFromConfig(db, teams);
        expect(listTeams(db)).toHaveLength(1);
    });

    it('skips teams that already exist', () => {
        const teams: TeamConfig[] = [{name: 'frontend'}];
        seedTeamsFromConfig(db, teams);
        seedTeamsFromConfig(db, [{name: 'frontend'}, {name: 'backend'}]);
        expect(listTeams(db)).toHaveLength(2);
    });

    it('handles empty config teams array', () => {
        seedTeamsFromConfig(db, []);
        expect(listTeams(db)).toHaveLength(0);
    });

    it('preserves department and manager from config', () => {
        seedTeamsFromConfig(db, [{name: 'platform', department: 'infra', manager: 'bob'}]);
        const teams = listTeams(db);
        expect(teams[0].department).toBe('infra');
        expect(teams[0].manager).toBe('bob');
    });
});
