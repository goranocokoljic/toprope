import {describe, expect, it} from 'vitest';
import {
    inclusiveDayCount,
    isValidDateString,
    presetValue,
    resolvePreset,
    smartDefaultPreset,
} from '../timeRange/range';

const NOW = new Date('2026-05-31T00:00:00.000Z');

function daysBefore(n: number): string {
    const d = new Date(NOW.getTime());
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
}

describe('isValidDateString', () => {
    it('accepts real dates and rejects malformed / rolled-over ones', () => {
        expect(isValidDateString('2026-05-31')).toBe(true);
        expect(isValidDateString('2026-13-01')).toBe(false);
        expect(isValidDateString('2026-02-31')).toBe(false);
        expect(isValidDateString('not-a-date')).toBe(false);
    });
});

describe('inclusiveDayCount', () => {
    it('counts both endpoints', () => {
        expect(inclusiveDayCount('2026-05-01', '2026-05-01')).toBe(1);
        expect(inclusiveDayCount('2026-05-01', '2026-05-30')).toBe(30);
    });
    it('is zero for an inverted range', () => {
        expect(inclusiveDayCount('2026-05-30', '2026-05-01')).toBe(0);
    });
});

describe('resolvePreset', () => {
    it('resolves rolling windows ending today', () => {
        expect(resolvePreset('30d', {now: NOW})).toEqual({from: '2026-05-02', to: '2026-05-31'});
        const ninety = resolvePreset('90d', {now: NOW});
        expect(ninety.to).toBe('2026-05-31');
        expect(inclusiveDayCount(ninety.from, ninety.to)).toBe(90);
        expect(resolvePreset('year', {now: NOW})).toEqual({from: '2025-06-01', to: '2026-05-31'});
    });

    it('resolves lifetime from the scope earliest, collapsing to today with no data', () => {
        expect(resolvePreset('lifetime', {now: NOW, earliest: '2026-01-15'})).toEqual({
            from: '2026-01-15',
            to: '2026-05-31',
        });
        expect(resolvePreset('lifetime', {now: NOW, earliest: null})).toEqual({
            from: '2026-05-31',
            to: '2026-05-31',
        });
    });

    it('presetValue carries the kind alongside the window', () => {
        expect(presetValue('30d', {now: NOW})).toEqual({kind: '30d', from: '2026-05-02', to: '2026-05-31'});
    });
});

describe('smartDefaultPreset', () => {
    it('defaults to 30d when there is no data', () => {
        expect(smartDefaultPreset({now: NOW})).toBe('30d');
        expect(smartDefaultPreset({now: NOW, earliest: null})).toBe('30d');
    });

    it('picks the smallest preset that contains all history', () => {
        expect(smartDefaultPreset({now: NOW, earliest: daysBefore(10)})).toBe('30d');
        expect(smartDefaultPreset({now: NOW, earliest: daysBefore(29)})).toBe('30d'); // span 30
        expect(smartDefaultPreset({now: NOW, earliest: daysBefore(30)})).toBe('90d'); // span 31
        expect(smartDefaultPreset({now: NOW, earliest: daysBefore(200)})).toBe('year');
        expect(smartDefaultPreset({now: NOW, earliest: daysBefore(400)})).toBe('lifetime');
    });
});
