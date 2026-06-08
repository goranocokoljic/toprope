import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import {
    clearOpenAnomaly,
    listAnomalies,
    setAnomalyStatus,
    upsertAnomaly,
    type UpsertAnomalyInput,
} from '../../src/anomaly/store';

const baseInput = (overrides: Partial<UpsertAnomalyInput> = {}): UpsertAnomalyInput => ({
    scope: 'developer',
    scopeId: 'dev-1',
    metric: 'commits',
    period: '2026-05-04',
    method: 'statistical',
    observedValue: 30,
    expectedValue: 10,
    deviation: 3.2,
    severity: 'high',
    basis: 'git_estimate',
    ...overrides,
});

describe('anomaly store', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
    });

    afterEach(() => {
        db.close();
    });

    describe('upsert + idempotency', () => {
        it('inserts a new anomaly', () => {
            upsertAnomaly(db, baseInput());
            const rows = listAnomalies(db);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                scope: 'developer',
                scope_id: 'dev-1',
                metric: 'commits',
                period: '2026-05-04',
                status: 'open',
                deviation: 3.2,
            });
        });

        it('re-upserting the same coordinate does not duplicate', () => {
            upsertAnomaly(db, baseInput());
            upsertAnomaly(db, baseInput());
            upsertAnomaly(db, baseInput({observedValue: 35, deviation: 3.8}));
            const rows = listAnomalies(db);
            expect(rows).toHaveLength(1);
            // Latest measurement wins on conflict.
            expect(rows[0].observed_value).toBe(35);
            expect(rows[0].deviation).toBe(3.8);
        });

        it('preserves human status across re-detection', () => {
            upsertAnomaly(db, baseInput());
            const id = listAnomalies(db)[0].id;
            expect(setAnomalyStatus(db, id, 'acknowledged')).toBe(true);

            // Re-scan flags it again with refreshed numbers.
            upsertAnomaly(db, baseInput({observedValue: 40, deviation: 4.1}));
            const rows = listAnomalies(db);
            expect(rows).toHaveLength(1);
            expect(rows[0].status).toBe('acknowledged'); // not reset to open
            expect(rows[0].observed_value).toBe(40); // measurement still refreshed
            expect(rows[0].id).toBe(id); // same row, same id
        });

        it('keeps distinct coordinates as separate rows', () => {
            upsertAnomaly(db, baseInput());
            upsertAnomaly(db, baseInput({metric: 'churn'}));
            upsertAnomaly(db, baseInput({scope: 'team', scopeId: 'frontend'}));
            expect(listAnomalies(db)).toHaveLength(3);
        });
    });

    describe('clearOpenAnomaly', () => {
        it('removes an open anomaly for the coordinate', () => {
            upsertAnomaly(db, baseInput());
            expect(clearOpenAnomaly(db, 'developer', 'dev-1', 'commits', '2026-05-04')).toBe(true);
            expect(listAnomalies(db)).toHaveLength(0);
        });

        it('leaves acknowledged/resolved anomalies in place', () => {
            upsertAnomaly(db, baseInput());
            const id = listAnomalies(db)[0].id;
            setAnomalyStatus(db, id, 'acknowledged');
            expect(clearOpenAnomaly(db, 'developer', 'dev-1', 'commits', '2026-05-04')).toBe(false);
            expect(listAnomalies(db)).toHaveLength(1);
        });

        it('is a no-op (returns false) when nothing matches', () => {
            expect(clearOpenAnomaly(db, 'developer', 'nobody', 'commits', '2026-05-04')).toBe(false);
        });
    });

    describe('listAnomalies filters', () => {
        beforeEach(() => {
            upsertAnomaly(db, baseInput());
            upsertAnomaly(db, baseInput({scope: 'team', scopeId: 'frontend', metric: 'cost'}));
            upsertAnomaly(db, baseInput({period: '2026-05-11', metric: 'prs_merged'}));
        });

        it('filters by scope', () => {
            expect(listAnomalies(db, {scope: 'team'})).toHaveLength(1);
            expect(listAnomalies(db, {scope: 'developer'})).toHaveLength(2);
        });

        it('filters by period', () => {
            expect(listAnomalies(db, {period: '2026-05-11'})).toHaveLength(1);
        });

        it('filters by status', () => {
            expect(listAnomalies(db, {status: 'open'})).toHaveLength(3);
            expect(listAnomalies(db, {status: 'resolved'})).toHaveLength(0);
        });

        it('respects a positive limit', () => {
            expect(listAnomalies(db, {limit: 2})).toHaveLength(2);
        });
    });

    describe('setAnomalyStatus', () => {
        it('returns false for an unknown id', () => {
            expect(setAnomalyStatus(db, 'no-such-id', 'resolved')).toBe(false);
        });
    });

    describe('ordering', () => {
        it('ranks severity high > notable > info, not lexically', () => {
            upsertAnomaly(db, baseInput({metric: 'commits', severity: 'notable'}));
            upsertAnomaly(db, baseInput({metric: 'churn', severity: 'high'}));
            upsertAnomaly(db, baseInput({metric: 'prs_merged', severity: 'info'}));
            // Pin all rows to the same detected_at so the severity rank is the
            // sole tiebreak (lexical ordering would have put 'high' last).
            db.prepare("UPDATE anomalies SET detected_at = '2026-05-04T00:00:00.000Z'").run();
            const order = listAnomalies(db).map((a) => a.severity);
            expect(order).toEqual(['high', 'notable', 'info']);
        });
    });

    describe('detected_at is first-detection, preserved across re-detection', () => {
        it('keeps the original detected_at on re-upsert while refreshing measurement', () => {
            upsertAnomaly(db, baseInput());
            // Backdate to a known first-detection time.
            db.prepare("UPDATE anomalies SET detected_at = '2026-04-01T00:00:00.000Z'").run();

            upsertAnomaly(db, baseInput({observedValue: 99, deviation: 5.5, severity: 'notable'}));
            const row = listAnomalies(db)[0];
            expect(row.detected_at).toBe('2026-04-01T00:00:00.000Z'); // not bumped
            expect(row.observed_value).toBe(99); // measurement refreshed
            expect(row.severity).toBe('notable');
        });
    });
});
