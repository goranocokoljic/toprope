import {describe, it, expect} from 'vitest';
import {
    addDays,
    isoWeekStart,
    weekRange,
    monthRange,
    daysInMonth,
    eachDay,
} from '../../src/aggregation/dates';

describe('isoWeekStart', () => {
    // 2026-05-04 is a Monday; 2026-05-10 the Sunday that closes that ISO week.
    it('returns the same date for a Monday', () => {
        expect(isoWeekStart('2026-05-04')).toBe('2026-05-04');
    });

    it('maps a mid-week day back to its Monday', () => {
        expect(isoWeekStart('2026-05-07')).toBe('2026-05-04');
    });

    it('maps Sunday back to the Monday six days earlier (not forward)', () => {
        expect(isoWeekStart('2026-05-10')).toBe('2026-05-04');
    });

    it('rolls to the next Monday on the following week', () => {
        expect(isoWeekStart('2026-05-11')).toBe('2026-05-11');
    });

    it('crosses a month boundary correctly', () => {
        // 2026-06-01 is a Monday; 2026-05-31 (Sunday) belongs to the prior week.
        expect(isoWeekStart('2026-05-31')).toBe('2026-05-25');
        expect(isoWeekStart('2026-06-01')).toBe('2026-06-01');
    });

    it('throws on a malformed date', () => {
        expect(() => isoWeekStart('2026-5-4')).toThrow();
        expect(() => isoWeekStart('not-a-date')).toThrow();
    });
});

describe('weekRange', () => {
    it('returns Monday..Sunday for any day in the week', () => {
        expect(weekRange('2026-05-06')).toEqual({start: '2026-05-04', end: '2026-05-10'});
        expect(weekRange('2026-05-10')).toEqual({start: '2026-05-04', end: '2026-05-10'});
    });
});

describe('monthRange', () => {
    it('returns first..last day of a 31-day month', () => {
        expect(monthRange('2026-05')).toEqual({start: '2026-05-01', end: '2026-05-31'});
    });

    it('handles a non-leap February', () => {
        expect(monthRange('2026-02')).toEqual({start: '2026-02-01', end: '2026-02-28'});
    });

    it('handles a leap February', () => {
        expect(monthRange('2024-02')).toEqual({start: '2024-02-01', end: '2024-02-29'});
    });

    it('throws on a malformed month', () => {
        expect(() => monthRange('2026-5')).toThrow();
        expect(() => monthRange('2026-05-01')).toThrow();
    });
});

describe('daysInMonth', () => {
    it('counts days in the containing calendar month', () => {
        expect(daysInMonth('2026-05-10')).toBe(31);
        expect(daysInMonth('2026-02-15')).toBe(28);
        expect(daysInMonth('2024-02-15')).toBe(29);
        expect(daysInMonth('2026-04-30')).toBe(30);
    });
});

describe('addDays / eachDay', () => {
    it('adds across a month boundary', () => {
        expect(addDays('2026-05-31', 1)).toBe('2026-06-01');
        expect(addDays('2026-06-01', -1)).toBe('2026-05-31');
    });

    it('enumerates every day in an inclusive range', () => {
        expect(eachDay({start: '2026-05-04', end: '2026-05-06'})).toEqual([
            '2026-05-04',
            '2026-05-05',
            '2026-05-06',
        ]);
    });
});
