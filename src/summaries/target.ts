/**
 * Summary target addressing (Task 3.9 / #78).
 *
 * A summary is addressed by three coordinates: its level (weekly/monthly/
 * quarterly/yearly), its period key, and the scope it covers (a team or the org).
 * This module owns the parsing/validation of those coordinates and the mapping
 * from a (level, period) pair to the inclusive [start, end] day range and the
 * prior comparable period — pure, DB-free helpers shared by the generator, the
 * staleness check, and the CLI so the three cannot disagree on what a target means.
 *
 * The period key form is per level and matches the numbers-only payload's label
 * allowlist exactly: weekly `YYYY-Wnn`, monthly `YYYY-MM`, quarterly `YYYY-Qn`,
 * yearly `YYYY`. Validating here means a malformed period is rejected before any
 * DB work, and the resulting label is guaranteed to pass the input-builder gate.
 */

import {
    isoWeekRange,
    priorIsoWeek,
    monthRange,
    priorMonth,
    quarterRange,
    priorQuarter,
    yearRange,
    priorYear,
    type DateRange,
} from '../aggregation/dates';
import type {SummaryLevel} from './model-client';
import type {SummaryScope} from './input-builder';

/** The four levels, as a runtime list for validation/iteration. */
export const SUMMARY_LEVELS: readonly SummaryLevel[] = [
    'weekly',
    'monthly',
    'quarterly',
    'yearly',
] as const;

/** A fully-resolved summary address: what to generate, for when, for whom. */
export interface SummaryTarget {
    level: SummaryLevel;
    /** Period key in the level's canonical form (YYYY-Wnn / YYYY-MM / YYYY-Qn / YYYY). */
    period: string;
    scope: SummaryScope;
}

/** Per-level period-key shape, used to reject a malformed `--period` up front. */
const PERIOD_RE: Record<SummaryLevel, RegExp> = {
    weekly: /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/,
    monthly: /^\d{4}-(0[1-9]|1[0-2])$/,
    quarterly: /^\d{4}-Q[1-4]$/,
    yearly: /^\d{4}$/,
};

/** Narrow an arbitrary string to a SummaryLevel, or throw with the valid set. */
export function parseLevel(value: string): SummaryLevel {
    if ((SUMMARY_LEVELS as readonly string[]).includes(value)) {
        return value as SummaryLevel;
    }
    throw new Error(`Invalid level "${value}" (expected one of: ${SUMMARY_LEVELS.join(', ')})`);
}

/**
 * Parse a CLI/API scope token into a SummaryScope. `org` covers the whole
 * organisation; `team:NAME` covers a single team. The team name is taken verbatim
 * (the registry's own label) and later validated by the numbers-only gate's
 * scope-name allowlist, so a name carrying odd characters fails at the privacy
 * boundary rather than here.
 */
export function parseScope(value: string): SummaryScope {
    const trimmed = value.trim();
    if (trimmed === 'org') {
        return {type: 'org', name: 'org'};
    }
    if (trimmed.startsWith('team:')) {
        const name = trimmed.slice('team:'.length).trim();
        if (name.length === 0) {
            throw new Error('Invalid scope "team:" — a team name is required (e.g. team:backend)');
        }
        return {type: 'team', name};
    }
    throw new Error(`Invalid scope "${value}" (expected "org" or "team:<name>")`);
}

/** Validate that `period` matches `level`'s canonical key form, returning it. */
export function validatePeriod(level: SummaryLevel, period: string): string {
    if (!PERIOD_RE[level].test(period)) {
        throw new Error(`Invalid ${level} period "${period}" (expected ${describePeriodForm(level)})`);
    }
    return period;
}

function describePeriodForm(level: SummaryLevel): string {
    switch (level) {
        case 'weekly':
            return 'YYYY-Wnn, e.g. 2026-W21';
        case 'monthly':
            return 'YYYY-MM, e.g. 2026-05';
        case 'quarterly':
            return 'YYYY-Qn, e.g. 2026-Q2';
        case 'yearly':
            return 'YYYY, e.g. 2026';
    }
}

/** The inclusive [start, end] day range for a (level, period). Validates the key. */
export function periodRange(level: SummaryLevel, period: string): DateRange {
    validatePeriod(level, period);
    switch (level) {
        case 'weekly':
            return isoWeekRange(period);
        case 'monthly':
            return monthRange(period);
        case 'quarterly':
            return quarterRange(period);
        case 'yearly':
            return yearRange(period);
    }
}

/** The previous comparable period key for a (level, period). Validates the key. */
export function priorPeriod(level: SummaryLevel, period: string): string {
    validatePeriod(level, period);
    switch (level) {
        case 'weekly':
            return priorIsoWeek(period);
        case 'monthly':
            return priorMonth(period);
        case 'quarterly':
            return priorQuarter(period);
        case 'yearly':
            return priorYear(period);
    }
}
