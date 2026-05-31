import {describe, expect, it} from 'vitest';
import {parseTimeRange} from '../../src/dashboard/api/range';
import {presetValue} from '../../src/dashboard/frontend/src/timeRange/range';
import type {TimeRangePreset} from '../../src/dashboard/frontend/src/api/types';

/**
 * The dashboard duplicates the backend range arithmetic client-side (see the
 * note atop src/dashboard/api/range.ts). This test is the guard that keeps the
 * two from drifting: for every preset, the frontend's resolved window must equal
 * the window the backend parser produces for the same `now` and `earliest`.
 */
const NOW = new Date('2026-05-31T00:00:00.000Z');
const EARLIEST = '2024-03-15';
const PRESETS: TimeRangePreset[] = ['30d', '90d', 'year', 'lifetime'];

describe('frontend/backend time-range parity', () => {
    for (const preset of PRESETS) {
        it(`resolves the same window for "${preset}"`, () => {
            const backend = parseTimeRange({range: preset}, {now: NOW, earliest: () => EARLIEST});
            const frontend = presetValue(preset, {now: NOW, earliest: EARLIEST});
            expect({from: frontend.from, to: frontend.to}).toEqual({from: backend.from, to: backend.to});
        });
    }

    it('agrees on lifetime when the scope has no data', () => {
        const backend = parseTimeRange({range: 'lifetime'}, {now: NOW, earliest: () => null});
        const frontend = presetValue('lifetime', {now: NOW, earliest: null});
        expect({from: frontend.from, to: frontend.to}).toEqual({from: backend.from, to: backend.to});
    });

    it('agrees on lifetime when earliest is malformed (both fall back to today)', () => {
        const backend = parseTimeRange({range: 'lifetime'}, {now: NOW, earliest: () => '2026-02-31'});
        const frontend = presetValue('lifetime', {now: NOW, earliest: '2026-02-31'});
        expect({from: frontend.from, to: frontend.to}).toEqual({from: backend.from, to: backend.to});
        expect(frontend.from).toBe('2026-05-31'); // today, not the bad date
    });
});
