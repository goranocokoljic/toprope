import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {addTeam} from '../../src/registry/teams';
import {addDeveloper} from '../../src/registry/developers';
import {
    resolveSelfDeveloperId,
    DEVELOPER_ID_ENV,
    DEVELOPER_EMAIL_ENV,
} from '../../src/selfreport/identity';
import {SelfReportError} from '../../src/selfreport/core';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

describe('resolveSelfDeveloperId', () => {
    let db: Database.Database;
    let devId: string;

    beforeEach(() => {
        db = makeDb();
        addTeam(db, 'eng');
        devId = addDeveloper(db, 'Alice', 'eng', 'alice@example.com').id;
    });

    afterEach(() => {
        db.close();
    });

    it('resolves via TOPROPE_DEVELOPER_ID', () => {
        const env = {[DEVELOPER_ID_ENV]: devId};
        expect(resolveSelfDeveloperId(db, env)).toBe(devId);
    });

    it('resolves via TOPROPE_DEVELOPER_EMAIL', () => {
        const env = {[DEVELOPER_EMAIL_ENV]: 'alice@example.com'};
        expect(resolveSelfDeveloperId(db, env)).toBe(devId);
    });

    it('prefers the id over the email when both are set', () => {
        const bob = addDeveloper(db, 'Bob', 'eng', 'bob@example.com').id;
        const env = {[DEVELOPER_ID_ENV]: bob, [DEVELOPER_EMAIL_ENV]: 'alice@example.com'};
        expect(resolveSelfDeveloperId(db, env)).toBe(bob);
    });

    it('throws when no identity is configured', () => {
        expect(() => resolveSelfDeveloperId(db, {})).toThrow(SelfReportError);
    });

    it('throws when the id does not match a developer', () => {
        const env = {[DEVELOPER_ID_ENV]: 'nope'};
        expect(() => resolveSelfDeveloperId(db, env)).toThrow(SelfReportError);
    });

    it('throws when the email does not match a developer', () => {
        const env = {[DEVELOPER_EMAIL_ENV]: 'ghost@example.com'};
        expect(() => resolveSelfDeveloperId(db, env)).toThrow(SelfReportError);
    });
});
