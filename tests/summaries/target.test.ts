import {describe, it, expect} from 'vitest';
import {
    parseLevel,
    parseScope,
    validatePeriod,
    periodRange,
    priorPeriod,
} from '../../src/summaries/target';

describe('parseLevel', () => {
    it('accepts the four levels', () => {
        expect(parseLevel('weekly')).toBe('weekly');
        expect(parseLevel('yearly')).toBe('yearly');
    });
    it('rejects an unknown level', () => {
        expect(() => parseLevel('daily')).toThrow(/Invalid level/);
    });
});

describe('parseScope', () => {
    it('parses the org scope', () => {
        expect(parseScope('org')).toEqual({type: 'org', name: 'org'});
    });
    it('parses a team scope', () => {
        expect(parseScope('team:backend')).toEqual({type: 'team', name: 'backend'});
    });
    it('trims surrounding whitespace on the team name', () => {
        expect(parseScope('team:  platform ')).toEqual({type: 'team', name: 'platform'});
    });
    it('rejects an empty team name', () => {
        expect(() => parseScope('team:')).toThrow(/team name is required/);
    });
    it('rejects an unrecognized scope token', () => {
        expect(() => parseScope('squad:backend')).toThrow(/Invalid scope/);
    });
});

describe('validatePeriod', () => {
    it('accepts each level’s canonical key form', () => {
        expect(validatePeriod('weekly', '2026-W21')).toBe('2026-W21');
        expect(validatePeriod('monthly', '2026-05')).toBe('2026-05');
        expect(validatePeriod('quarterly', '2026-Q2')).toBe('2026-Q2');
        expect(validatePeriod('yearly', '2026')).toBe('2026');
    });
    it('rejects a key in the wrong form for the level', () => {
        expect(() => validatePeriod('weekly', '2026-05-18')).toThrow(/Invalid weekly period/);
        expect(() => validatePeriod('monthly', '2026-13')).toThrow(/Invalid monthly period/);
        expect(() => validatePeriod('quarterly', '2026-Q5')).toThrow(/Invalid quarterly period/);
    });
});

describe('periodRange / priorPeriod', () => {
    it('resolves the range for each level', () => {
        expect(periodRange('weekly', '2026-W21')).toEqual({start: '2026-05-18', end: '2026-05-24'});
        expect(periodRange('monthly', '2026-05')).toEqual({start: '2026-05-01', end: '2026-05-31'});
        expect(periodRange('quarterly', '2026-Q2')).toEqual({start: '2026-04-01', end: '2026-06-30'});
        expect(periodRange('yearly', '2026')).toEqual({start: '2026-01-01', end: '2026-12-31'});
    });
    it('resolves the prior period for each level', () => {
        expect(priorPeriod('weekly', '2026-W21')).toBe('2026-W20');
        expect(priorPeriod('monthly', '2026-01')).toBe('2025-12');
        expect(priorPeriod('quarterly', '2026-Q1')).toBe('2025-Q4');
        expect(priorPeriod('yearly', '2026')).toBe('2025');
    });
});
