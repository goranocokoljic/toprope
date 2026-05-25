import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {runMigrations} from '../../src/storage/migrator';
import {addTeam} from '../../src/registry/teams';
import {addDeveloper} from '../../src/registry/developers';
import {importCsv, parseCsvLine} from '../../src/expenses/importer';
import type {ExpensesConfig} from '../../src/config/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');
const FIXTURES_DIR = path.resolve(__dirname, '../fixtures/expenses');

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}

function seedDevelopers(db: Database.Database): {alice: string; bob: string; jane: string} {
    addTeam(db, 'engineering');
    addTeam(db, 'backend');
    const alice = addDeveloper(db, 'Alice Smith', 'engineering', 'alice@example.com');
    const bob = addDeveloper(db, 'Bob Jones', 'backend', 'bob@example.com');
    const jane = addDeveloper(db, 'Jane Doe', 'engineering', 'jane@example.com');
    return {alice: alice.id, bob: bob.id, jane: jane.id};
}

describe('parseCsvLine', () => {
    it('parses simple comma-separated line', () => {
        expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
    });

    it('handles quoted fields with commas', () => {
        expect(parseCsvLine('"hello, world",b,c')).toEqual(['hello, world', 'b', 'c']);
    });

    it('handles escaped quotes inside quoted fields', () => {
        expect(parseCsvLine('"say ""hi""",b')).toEqual(['say "hi"', 'b']);
    });

    it('trims whitespace from unquoted fields', () => {
        expect(parseCsvLine(' a , b , c ')).toEqual(['a', 'b', 'c']);
    });

    it('handles empty fields', () => {
        expect(parseCsvLine('a,,c')).toEqual(['a', '', 'c']);
    });
});

describe('importCsv — standard format', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        seedDevelopers(db);
    });

    afterEach(() => {
        db.close();
    });

    it('imports all rows from standard CSV', () => {
        const config: ExpensesConfig = {subscription_defaults: {}};
        const result = importCsv(db, path.join(FIXTURES_DIR, 'standard.csv'), config);
        expect(result.imported).toBe(4);
        expect(result.skipped).toBe(0);
        expect(result.warnings).toHaveLength(0);
    });

    it('creates subscription records linked to correct developers', () => {
        const config: ExpensesConfig = {subscription_defaults: {}};
        importCsv(db, path.join(FIXTURES_DIR, 'standard.csv'), config);

        const subs = db.prepare('SELECT * FROM subscriptions WHERE seat_revoked_at IS NULL').all() as {
            developer_id: string;
            tool: string;
            plan: string;
            monthly_cost: number;
            billing_model: string;
        }[];

        const aliceRow = db.prepare('SELECT id FROM developers WHERE email = ?').get('alice@example.com') as {id: string};
        const aliceSub = subs.find((s) => s.developer_id === aliceRow.id && s.tool === 'copilot');
        expect(aliceSub).toBeDefined();
        expect(aliceSub?.plan).toBe('business');
        expect(aliceSub?.monthly_cost).toBe(19);
        expect(aliceSub?.billing_model).toBe('company_managed');
    });

    it('upserts on re-import (no duplicates)', () => {
        const config: ExpensesConfig = {subscription_defaults: {}};
        importCsv(db, path.join(FIXTURES_DIR, 'standard.csv'), config);
        importCsv(db, path.join(FIXTURES_DIR, 'standard.csv'), config);

        const count = (
            db
                .prepare('SELECT COUNT(*) as n FROM subscriptions WHERE seat_revoked_at IS NULL')
                .get() as {n: number}
        ).n;
        expect(count).toBe(4);
    });
});

describe('importCsv — renamed columns with column_mapping', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        seedDevelopers(db);
    });

    afterEach(() => {
        db.close();
    });

    it('imports CSV with renamed columns using column_mapping config', () => {
        const config: ExpensesConfig = {
            subscription_defaults: {},
            column_mapping: {
                developer_email: 'email',
                tool: 'ai_tool',
                plan: 'subscription_tier',
                monthly_cost: 'cost_usd',
                billing_model: 'payment_method',
            },
        };
        const result = importCsv(db, path.join(FIXTURES_DIR, 'renamed-columns.csv'), config);
        expect(result.imported).toBe(2);
        expect(result.skipped).toBe(0);
    });

    it('stores correct data with renamed-column mapping', () => {
        const config: ExpensesConfig = {
            subscription_defaults: {},
            column_mapping: {
                developer_email: 'email',
                tool: 'ai_tool',
                plan: 'subscription_tier',
                monthly_cost: 'cost_usd',
                billing_model: 'payment_method',
            },
        };
        importCsv(db, path.join(FIXTURES_DIR, 'renamed-columns.csv'), config);

        const aliceRow = db.prepare('SELECT id FROM developers WHERE email = ?').get('alice@example.com') as {id: string};
        const sub = db.prepare('SELECT * FROM subscriptions WHERE developer_id = ? AND tool = ?').get(aliceRow.id, 'claude_code') as {
            plan: string;
            monthly_cost: number;
        };
        expect(sub).toBeDefined();
        expect(sub.plan).toBe('max');
        expect(sub.monthly_cost).toBe(200);
    });
});

describe('importCsv — minimal format with default costs', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        seedDevelopers(db);
    });

    afterEach(() => {
        db.close();
    });

    it('applies default costs when monthly_cost column is absent', () => {
        const config: ExpensesConfig = {
            subscription_defaults: {
                copilot_business: 19,
                cursor_pro: 20,
            },
        };
        const result = importCsv(db, path.join(FIXTURES_DIR, 'minimal.csv'), config);
        expect(result.imported).toBe(2);

        const aliceRow = db.prepare('SELECT id FROM developers WHERE email = ?').get('alice@example.com') as {id: string};
        const sub = db.prepare('SELECT monthly_cost FROM subscriptions WHERE developer_id = ? AND tool = ?').get(aliceRow.id, 'copilot') as {monthly_cost: number};
        expect(sub.monthly_cost).toBe(19);
    });

    it('sets null cost when no default exists for tool+plan combo', () => {
        const config: ExpensesConfig = {subscription_defaults: {}};
        importCsv(db, path.join(FIXTURES_DIR, 'minimal.csv'), config);

        const aliceRow = db.prepare('SELECT id FROM developers WHERE email = ?').get('alice@example.com') as {id: string};
        const sub = db.prepare('SELECT monthly_cost FROM subscriptions WHERE developer_id = ? AND tool = ?').get(aliceRow.id, 'copilot') as {monthly_cost: number | null};
        expect(sub.monthly_cost).toBeNull();
    });
});

describe('importCsv — missing developers', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
        addTeam(db, 'engineering');
        // Only add Alice, not Bob or Jane
        addDeveloper(db, 'Alice Smith', 'engineering', 'alice@example.com');
    });

    afterEach(() => {
        db.close();
    });

    it('warns for unknown emails without crashing', () => {
        const config: ExpensesConfig = {subscription_defaults: {}};
        const result = importCsv(db, path.join(FIXTURES_DIR, 'standard.csv'), config);
        expect(result.imported).toBeGreaterThanOrEqual(1);
        expect(result.skipped).toBeGreaterThan(0);
        const missingWarnings = result.warnings.filter((w) => w.includes('no developer'));
        expect(missingWarnings.length).toBeGreaterThan(0);
    });
});

describe('importCsv — malformed rows', () => {
    let db: Database.Database;
    let tmpFile: string;

    beforeEach(() => {
        db = makeDb();
        addTeam(db, 'engineering');
        addDeveloper(db, 'Alice Smith', 'engineering', 'alice@example.com');
        tmpFile = path.join(os.tmpdir(), `govproxy-test-${Date.now()}.csv`);
    });

    afterEach(() => {
        db.close();
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    });

    it('skips rows with missing required fields and includes line number in warning', () => {
        fs.writeFileSync(
            tmpFile,
            [
                'developer_email,tool,plan,monthly_cost,billing_model',
                'alice@example.com,copilot,business,19,company_managed',
                ',cursor,pro,20,personal', // missing email
                'alice@example.com,,business,19,company_managed', // missing tool
            ].join('\n'),
        );

        const config: ExpensesConfig = {subscription_defaults: {}};
        const result = importCsv(db, tmpFile, config);
        expect(result.imported).toBe(1);
        expect(result.skipped).toBe(2);
        expect(result.warnings.some((w) => w.includes('Line 3'))).toBe(true);
        expect(result.warnings.some((w) => w.includes('Line 4'))).toBe(true);
    });

    it('skips rows with invalid monthly_cost and warns', () => {
        fs.writeFileSync(
            tmpFile,
            [
                'developer_email,tool,plan,monthly_cost,billing_model',
                'alice@example.com,copilot,business,not-a-number,company_managed',
            ].join('\n'),
        );

        const config: ExpensesConfig = {subscription_defaults: {}};
        const result = importCsv(db, tmpFile, config);
        expect(result.imported).toBe(1); // row imported with null cost
        expect(result.warnings.some((w) => w.includes('invalid monthly_cost'))).toBe(true);
    });

    it('throws when required email column is missing from header', () => {
        fs.writeFileSync(tmpFile, 'tool,plan\ncopilot,business\n');
        const config: ExpensesConfig = {subscription_defaults: {}};
        expect(() => importCsv(db, tmpFile, config)).toThrow('developer_email');
    });

    it('throws when file does not exist', () => {
        const config: ExpensesConfig = {subscription_defaults: {}};
        expect(() => importCsv(db, '/nonexistent/path.csv', config)).toThrow('File not found');
    });
});

describe('importCsv — billing model normalization', () => {
    let db: Database.Database;
    let tmpFile: string;

    beforeEach(() => {
        db = makeDb();
        addTeam(db, 'engineering');
        addDeveloper(db, 'Alice Smith', 'engineering', 'alice@example.com');
        tmpFile = path.join(os.tmpdir(), `govproxy-test-${Date.now()}.csv`);
    });

    afterEach(() => {
        db.close();
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    });

    it('normalizes known billing model aliases', () => {
        fs.writeFileSync(
            tmpFile,
            [
                'developer_email,tool,plan,monthly_cost,billing_model',
                'alice@example.com,copilot,business,19,company',
            ].join('\n'),
        );

        const config: ExpensesConfig = {subscription_defaults: {}};
        importCsv(db, tmpFile, config);

        const aliceRow = db.prepare('SELECT id FROM developers WHERE email = ?').get('alice@example.com') as {id: string};
        const sub = db.prepare('SELECT billing_model FROM subscriptions WHERE developer_id = ?').get(aliceRow.id) as {billing_model: string};
        expect(sub.billing_model).toBe('company_managed');
    });

    it('defaults unknown billing model to "unknown"', () => {
        fs.writeFileSync(
            tmpFile,
            [
                'developer_email,tool,plan,monthly_cost,billing_model',
                'alice@example.com,copilot,business,19,something_else',
            ].join('\n'),
        );

        const config: ExpensesConfig = {subscription_defaults: {}};
        importCsv(db, tmpFile, config);

        const aliceRow = db.prepare('SELECT id FROM developers WHERE email = ?').get('alice@example.com') as {id: string};
        const sub = db.prepare('SELECT billing_model FROM subscriptions WHERE developer_id = ?').get(aliceRow.id) as {billing_model: string};
        expect(sub.billing_model).toBe('unknown');
    });
});
