import {describe, it, expect} from 'vitest';
import {parseTimeRange, TimeRangeError} from '../../src/dashboard/api/range';

const NOW = new Date('2026-05-30T12:00:00.000Z');

describe('parseTimeRange', () => {
    it('defaults to 30d when nothing is supplied', () => {
        expect(parseTimeRange({}, {now: NOW})).toEqual({
            range: '30d',
            from: '2026-05-01',
            to: '2026-05-30',
        });
    });

    it('resolves 30d as a trailing 30-day window', () => {
        const r = parseTimeRange({range: '30d'}, {now: NOW});
        expect(r).toEqual({range: '30d', from: '2026-05-01', to: '2026-05-30'});
    });

    it('resolves 90d as a trailing 90-day window', () => {
        const r = parseTimeRange({range: '90d'}, {now: NOW});
        expect(r).toEqual({range: '90d', from: '2026-03-02', to: '2026-05-30'});
    });

    it('resolves year as a trailing 12-month window', () => {
        const r = parseTimeRange({range: 'year'}, {now: NOW});
        expect(r).toEqual({range: 'year', from: '2025-05-31', to: '2026-05-30'});
    });

    it('resolves lifetime from the earliest available record', () => {
        const r = parseTimeRange({range: 'lifetime'}, {now: NOW, earliest: () => '2025-01-10'});
        expect(r).toEqual({range: 'lifetime', from: '2025-01-10', to: '2026-05-30'});
    });

    it('collapses lifetime to today when no data exists', () => {
        const r = parseTimeRange({range: 'lifetime'}, {now: NOW, earliest: () => null});
        expect(r).toEqual({range: 'lifetime', from: '2026-05-30', to: '2026-05-30'});
    });

    it('accepts a valid custom range', () => {
        const r = parseTimeRange({range: 'custom', from: '2026-01-01', to: '2026-02-01'}, {now: NOW});
        expect(r).toEqual({range: 'custom', from: '2026-01-01', to: '2026-02-01'});
    });

    it('infers custom when from and to are present without an explicit range', () => {
        const r = parseTimeRange({from: '2026-01-01', to: '2026-02-01'}, {now: NOW});
        expect(r.range).toBe('custom');
    });

    it('rejects a custom range missing from or to', () => {
        expect(() => parseTimeRange({range: 'custom', from: '2026-01-01'})).toThrow(TimeRangeError);
        expect(() => parseTimeRange({range: 'custom', to: '2026-01-01'})).toThrow(TimeRangeError);
    });

    it('rejects a custom range where from > to', () => {
        expect(() =>
            parseTimeRange({range: 'custom', from: '2026-02-01', to: '2026-01-01'}),
        ).toThrow(TimeRangeError);
    });

    it('rejects invalid custom dates', () => {
        expect(() =>
            parseTimeRange({range: 'custom', from: '2026-13-01', to: '2026-12-01'}),
        ).toThrow(TimeRangeError);
        expect(() =>
            parseTimeRange({range: 'custom', from: '2026-02-31', to: '2026-03-01'}),
        ).toThrow(TimeRangeError);
        expect(() =>
            parseTimeRange({range: 'custom', from: 'nope', to: '2026-03-01'}),
        ).toThrow(TimeRangeError);
    });

    it('rejects an unknown range keyword', () => {
        expect(() => parseTimeRange({range: 'weekly'})).toThrow(TimeRangeError);
    });
});
