import {describe, it, expect} from 'vitest';
import {
    addDays,
    isoWeekStart,
    weekRange,
    monthRange,
    quarterRange,
    yearRange,
    daysInMonth,
    assertDateRange,
    priorWeekStart,
    priorMonth,
    priorQuarter,
    priorYear,
    monthOf,
    quarterOf,
    yearOf,
    nextMonth,
    nextQuarter,
    enumerateWeekStarts,
    enumerateMonths,
    enumerateQuarters,
    enumerateYears,
    isoWeekLabel,
    isoWeekRange,
    priorIsoWeek,
    isUtcDay,
} from '../../src/aggregation/dates';

/**
 * `isUtcDay` stopped being a local helper in #290: it is now the SINGLE home of the anchored
 * UTC-day shape, read by `raw_author_daily`'s write boundary and date-read filter, by the
 * projection's scan filter, and by the commit-date gate all three git providers call. It had no
 * direct test, and every indirect negative fixture is malformed from character 1 — so the ANCHORS,
 * the property the whole consolidation rests on, were invisible to the suite.
 */
describe('isUtcDay', () => {
    it.each(['2026-07-01', '2024-01-15', '0001-01-01'])('accepts the bare UTC day %s', (day) => {
        expect(isUtcDay(day)).toBe(true);
    });

    it.each([
        // The load-bearing case: a conforming 10-char prefix with trailing junk. Only the
        // trailing `$` rejects it. Drop that anchor and the store's typed `invalid_date` guard
        // stops firing, handing an instant to a schema CHECK that is fully anchored — a raw
        // SQLITE_CONSTRAINT from inside the git run's all-providers write transaction.
        ['a full ISO instant', '2026-07-01T10:00:00.000Z'],
        ['a day with a trailing space', '2026-07-01 '],
        // The mirror case, which only the leading `^` rejects.
        ['a day with a leading space', ' 2026-07-01'],
        ['an unpadded month/day', '2026-7-1'],
        ['a slash-separated day', '2026/07/01'],
        ['the empty string', ''],
        ['a non-date word', 'yesterday'],
    ])('rejects %s', (_label, value) => {
        expect(isUtcDay(value)).toBe(false);
    });
});

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

    it('throws on an out-of-range month rather than rolling it into a valid key', () => {
        expect(() => monthRange('2026-13')).toThrow();
        expect(() => monthRange('2026-00')).toThrow();
    });
});

describe('quarterRange', () => {
    it('maps each quarter to its calendar months', () => {
        expect(quarterRange('2026-Q1')).toEqual({start: '2026-01-01', end: '2026-03-31'});
        expect(quarterRange('2026-Q2')).toEqual({start: '2026-04-01', end: '2026-06-30'});
        expect(quarterRange('2026-Q3')).toEqual({start: '2026-07-01', end: '2026-09-30'});
        expect(quarterRange('2026-Q4')).toEqual({start: '2026-10-01', end: '2026-12-31'});
    });

    it('reflects a leap-year Q1 end (Feb has 29 days but Q1 still ends Mar 31)', () => {
        expect(quarterRange('2024-Q1')).toEqual({start: '2024-01-01', end: '2024-03-31'});
    });

    it('throws on a malformed quarter', () => {
        expect(() => quarterRange('2026-Q5')).toThrow();
        expect(() => quarterRange('2026-1')).toThrow();
        expect(() => quarterRange('2026-QQ')).toThrow();
    });
});

describe('yearRange', () => {
    it('returns Jan 1..Dec 31', () => {
        expect(yearRange('2026')).toEqual({start: '2026-01-01', end: '2026-12-31'});
    });

    it('throws on a malformed year', () => {
        expect(() => yearRange('26')).toThrow();
        expect(() => yearRange('2026-01')).toThrow();
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

describe('addDays', () => {
    it('adds across a month boundary', () => {
        expect(addDays('2026-05-31', 1)).toBe('2026-06-01');
        expect(addDays('2026-06-01', -1)).toBe('2026-05-31');
    });
});

describe('assertDateRange', () => {
    it('accepts a well-formed inclusive range (including a single day)', () => {
        expect(() => assertDateRange('2026-05-04', '2026-05-10')).not.toThrow();
        expect(() => assertDateRange('2026-05-04', '2026-05-04')).not.toThrow();
    });

    it('throws when start is after end', () => {
        expect(() => assertDateRange('2026-05-10', '2026-05-04')).toThrow(/after end/);
    });

    it('throws on a malformed or empty bound', () => {
        expect(() => assertDateRange('', '2026-05-10')).toThrow();
        expect(() => assertDateRange('2026-05-04', 'nope')).toThrow();
    });
});

describe('priorWeekStart', () => {
    it('steps back exactly one ISO week', () => {
        expect(priorWeekStart('2026-05-04')).toBe('2026-04-27');
    });

    it('steps back across a year boundary', () => {
        expect(priorWeekStart('2026-01-05')).toBe('2025-12-29');
    });

    it('throws on a malformed date', () => {
        expect(() => priorWeekStart('2026-05')).toThrow();
    });
});

describe('priorMonth', () => {
    it('steps back one month within a year', () => {
        expect(priorMonth('2026-05')).toBe('2026-04');
    });

    it('rolls over to December of the prior year', () => {
        expect(priorMonth('2026-01')).toBe('2025-12');
    });

    it('throws on a malformed month', () => {
        expect(() => priorMonth('2026-13-01')).toThrow();
    });

    it('throws on an out-of-range month (shape-valid but month > 12 or 00)', () => {
        expect(() => priorMonth('2026-13')).toThrow();
        expect(() => priorMonth('2026-00')).toThrow();
    });
});

describe('priorQuarter', () => {
    it('steps back one quarter within a year', () => {
        expect(priorQuarter('2026-Q3')).toBe('2026-Q2');
    });

    it('rolls over to Q4 of the prior year', () => {
        expect(priorQuarter('2026-Q1')).toBe('2025-Q4');
    });

    it('throws on a malformed quarter', () => {
        expect(() => priorQuarter('2026-Q5')).toThrow();
    });
});

describe('priorYear', () => {
    it('steps back one year', () => {
        expect(priorYear('2026')).toBe('2025');
    });

    it('throws on a malformed year', () => {
        expect(() => priorYear('26')).toThrow();
    });
});

describe('period extractors', () => {
    it('monthOf returns the YYYY-MM of a day', () => {
        expect(monthOf('2026-06-03')).toBe('2026-06');
    });

    it('quarterOf maps months to calendar quarters', () => {
        expect(quarterOf('2026-01-15')).toBe('2026-Q1');
        expect(quarterOf('2026-03-31')).toBe('2026-Q1');
        expect(quarterOf('2026-04-01')).toBe('2026-Q2');
        expect(quarterOf('2026-09-30')).toBe('2026-Q3');
        expect(quarterOf('2026-10-01')).toBe('2026-Q4');
        expect(quarterOf('2026-12-31')).toBe('2026-Q4');
    });

    it('yearOf returns the YYYY of a day', () => {
        expect(yearOf('2026-06-03')).toBe('2026');
    });

    it('extractors reject malformed input', () => {
        expect(() => monthOf('2026/06/03')).toThrow();
        expect(() => quarterOf('not-a-date')).toThrow();
        expect(() => yearOf('2026-13-01')).toThrow();
    });
});

describe('nextMonth / nextQuarter', () => {
    it('nextMonth steps forward within a year', () => {
        expect(nextMonth('2026-01')).toBe('2026-02');
    });

    it('nextMonth rolls over the year', () => {
        expect(nextMonth('2026-12')).toBe('2027-01');
    });

    it('nextMonth throws on a malformed month', () => {
        expect(() => nextMonth('2026-13')).toThrow();
    });

    it('nextQuarter steps forward within a year', () => {
        expect(nextQuarter('2026-Q1')).toBe('2026-Q2');
    });

    it('nextQuarter rolls over the year', () => {
        expect(nextQuarter('2026-Q4')).toBe('2027-Q1');
    });

    it('nextQuarter throws on a malformed quarter', () => {
        expect(() => nextQuarter('2026-Q0')).toThrow();
    });
});

describe('enumerateWeekStarts', () => {
    it('returns the Monday of the week containing from, even if it precedes from', () => {
        // 2026-06-03 is a Wednesday; its ISO week starts Monday 2026-06-01.
        expect(enumerateWeekStarts('2026-06-03', '2026-06-03')).toEqual(['2026-06-01']);
    });

    it('walks consecutive Mondays through the range, chronologically', () => {
        expect(enumerateWeekStarts('2026-06-01', '2026-06-21')).toEqual([
            '2026-06-01',
            '2026-06-08',
            '2026-06-15',
        ]);
    });

    it('includes the week whose Monday is on or before to but extends past it', () => {
        // to = Tue 2026-06-16; the week starting Mon 2026-06-15 is included.
        const weeks = enumerateWeekStarts('2026-06-01', '2026-06-16');
        expect(weeks).toEqual(['2026-06-01', '2026-06-08', '2026-06-15']);
    });

    it('throws on a reversed range', () => {
        expect(() => enumerateWeekStarts('2026-06-10', '2026-06-01')).toThrow();
    });
});

describe('enumerateMonths', () => {
    it('returns every month from from through to, chronologically across a year boundary', () => {
        expect(enumerateMonths('2025-11-15', '2026-02-03')).toEqual([
            '2025-11',
            '2025-12',
            '2026-01',
            '2026-02',
        ]);
    });

    it('returns a single month when from and to share it', () => {
        expect(enumerateMonths('2026-06-01', '2026-06-30')).toEqual(['2026-06']);
    });
});

describe('enumerateQuarters', () => {
    it('returns every quarter from from through to across a year boundary', () => {
        expect(enumerateQuarters('2025-11-15', '2026-05-01')).toEqual([
            '2025-Q4',
            '2026-Q1',
            '2026-Q2',
        ]);
    });

    it('returns a single quarter when from and to share it', () => {
        expect(enumerateQuarters('2026-04-01', '2026-06-30')).toEqual(['2026-Q2']);
    });
});

describe('enumerateYears', () => {
    it('returns every year from from through to', () => {
        expect(enumerateYears('2024-06-01', '2026-02-01')).toEqual(['2024', '2025', '2026']);
    });

    it('returns a single year when from and to share it', () => {
        expect(enumerateYears('2026-01-01', '2026-12-31')).toEqual(['2026']);
    });
});

describe('isoWeekLabel / isoWeekRange / priorIsoWeek', () => {
    it('labels a date by its ISO week-numbering year and week', () => {
        // 2026-01-01 is a Thursday → ISO week 1 of 2026.
        expect(isoWeekLabel('2026-01-01')).toBe('2026-W01');
        // Monday 2026-05-18 is the start of 2026-W21 (the design's CLI example).
        expect(isoWeekLabel('2026-05-18')).toBe('2026-W21');
    });

    it('attributes an early-January day to the prior year when ISO weeks span the boundary', () => {
        // 2027-01-01 is a Friday → still part of 2026-W53.
        expect(isoWeekLabel('2027-01-01')).toBe('2026-W53');
    });

    it('returns the Monday–Sunday range for a week label', () => {
        expect(isoWeekRange('2026-W21')).toEqual({start: '2026-05-18', end: '2026-05-24'});
        // Week 1 of 2026 starts in the prior calendar year.
        expect(isoWeekRange('2026-W01')).toEqual({start: '2025-12-29', end: '2026-01-04'});
    });

    it('round-trips a label through its range start and back', () => {
        for (const label of ['2024-W01', '2025-W52', '2026-W53', '2021-W01', '2026-W21']) {
            expect(isoWeekLabel(isoWeekRange(label).start)).toBe(label);
        }
    });

    it('rejects a malformed week label', () => {
        expect(() => isoWeekRange('2026-W54')).toThrow(/Invalid ISO week/);
        expect(() => isoWeekRange('2026-21')).toThrow(/Invalid ISO week/);
    });

    it('steps back one week across the year boundary', () => {
        expect(priorIsoWeek('2026-W21')).toBe('2026-W20');
        expect(priorIsoWeek('2026-W01')).toBe('2025-W52');
    });
});
