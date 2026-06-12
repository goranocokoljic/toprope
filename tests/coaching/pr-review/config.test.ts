import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../../src/storage/migrator';
import {
    DEFAULT_PR_REVIEW_THRESHOLDS,
    resolvePRReviewThresholds,
    setPRReviewThresholds,
} from '../../../src/coaching/pr-review/config';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../src/storage/migrations');

describe('PR review thresholds config', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db, MIGRATIONS_DIR);
    });

    afterEach(() => {
        db.close();
    });

    it('returns the issue defaults when nothing is stored', () => {
        expect(resolvePRReviewThresholds(db)).toEqual(DEFAULT_PR_REVIEW_THRESHOLDS);
        expect(DEFAULT_PR_REVIEW_THRESHOLDS.churnHighThreshold).toBe(0.2);
        expect(DEFAULT_PR_REVIEW_THRESHOLDS.rejectThreshold).toBe(0.3);
    });

    it('merges a partial override over the defaults', () => {
        setPRReviewThresholds(db, {minPrs: 5, rejectThreshold: 0.5});
        const resolved = resolvePRReviewThresholds(db);
        expect(resolved.minPrs).toBe(5);
        expect(resolved.rejectThreshold).toBe(0.5);
        // Unset fields inherit defaults
        expect(resolved.churnHighThreshold).toBe(DEFAULT_PR_REVIEW_THRESHOLDS.churnHighThreshold);
        expect(resolved.baselinePeriods).toBe(DEFAULT_PR_REVIEW_THRESHOLDS.baselinePeriods);
    });

    it('merges successive overrides instead of replacing them', () => {
        setPRReviewThresholds(db, {minPrs: 5});
        setPRReviewThresholds(db, {rejectThreshold: 0.5});
        const resolved = resolvePRReviewThresholds(db);
        expect(resolved.minPrs).toBe(5);
        expect(resolved.rejectThreshold).toBe(0.5);
    });

    it('drops invalid stored fields and inherits the default for them', () => {
        db.prepare(
            `INSERT INTO settings (scope, scope_name, key, value, updated_at)
             VALUES ('global', '', 'pr_review_thresholds', ?, ?)`,
        ).run(
            JSON.stringify({minPrs: -2, rejectThreshold: 'high', baselinePeriods: 4, junk: true}),
            new Date().toISOString(),
        );
        const resolved = resolvePRReviewThresholds(db);
        expect(resolved.minPrs).toBe(DEFAULT_PR_REVIEW_THRESHOLDS.minPrs);
        expect(resolved.rejectThreshold).toBe(DEFAULT_PR_REVIEW_THRESHOLDS.rejectThreshold);
        expect(resolved.baselinePeriods).toBe(4);
    });

    it('drops rate-like thresholds outside [0,1] — absurd values cannot disable the signals', () => {
        db.prepare(
            `INSERT INTO settings (scope, scope_name, key, value, updated_at)
             VALUES ('global', '', 'pr_review_thresholds', ?, ?)`,
        ).run(
            JSON.stringify({rejectThreshold: 50, churnHighThreshold: 9, aiSignatureThreshold: -0.1}),
            new Date().toISOString(),
        );
        const resolved = resolvePRReviewThresholds(db);
        expect(resolved.rejectThreshold).toBe(DEFAULT_PR_REVIEW_THRESHOLDS.rejectThreshold);
        expect(resolved.churnHighThreshold).toBe(DEFAULT_PR_REVIEW_THRESHOLDS.churnHighThreshold);
        expect(resolved.aiSignatureThreshold).toBe(DEFAULT_PR_REVIEW_THRESHOLDS.aiSignatureThreshold);
    });

    it('survives a malformed stored row (falls back to defaults)', () => {
        db.prepare(
            `INSERT INTO settings (scope, scope_name, key, value, updated_at)
             VALUES ('global', '', 'pr_review_thresholds', 'not json', ?)`,
        ).run(new Date().toISOString());
        expect(resolvePRReviewThresholds(db)).toEqual(DEFAULT_PR_REVIEW_THRESHOLDS);
    });
});
