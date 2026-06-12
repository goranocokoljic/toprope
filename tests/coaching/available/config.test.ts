import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../../src/storage/migrator';
import {
    DEFAULT_AVAILABLE_COACHING_THRESHOLDS,
    resolveAvailableCoachingThresholds,
    setAvailableCoachingThresholds,
} from '../../../src/coaching/available/config';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');

let db: Database.Database;
beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, MIGRATIONS_DIR);
});
afterEach(() => db.close());

describe('available coaching config', () => {
    it('returns the hardcoded defaults with no override row', () => {
        expect(resolveAvailableCoachingThresholds(db)).toEqual(DEFAULT_AVAILABLE_COACHING_THRESHOLDS);
    });

    it('merges a partial override over the defaults', () => {
        setAvailableCoachingThresholds(db, {churnChangeThreshold: 0.5, minActiveDays: 4});
        const resolved = resolveAvailableCoachingThresholds(db);
        expect(resolved.churnChangeThreshold).toBe(0.5);
        expect(resolved.minActiveDays).toBe(4);
        // Untouched fields keep their defaults.
        expect(resolved.baselinePeriods).toBe(DEFAULT_AVAILABLE_COACHING_THRESHOLDS.baselinePeriods);
    });

    it('drops invalid / out-of-range override fields, degrading to the default', () => {
        setAvailableCoachingThresholds(db, {churnChangeThreshold: 0.4});
        // Hand-write a bad value directly: a ratio > 1 and a non-integer baseline.
        db.prepare(
            `UPDATE settings SET value = ? WHERE key = 'available_coaching_thresholds'`,
        ).run(JSON.stringify({churnChangeThreshold: 5, baselinePeriods: 2.5, minActiveDays: 3}));
        const resolved = resolveAvailableCoachingThresholds(db);
        expect(resolved.churnChangeThreshold).toBe(
            DEFAULT_AVAILABLE_COACHING_THRESHOLDS.churnChangeThreshold,
        );
        expect(resolved.baselinePeriods).toBe(
            DEFAULT_AVAILABLE_COACHING_THRESHOLDS.baselinePeriods,
        );
        expect(resolved.minActiveDays).toBe(3); // the one valid field is applied
    });
});
