import type {BadgeTone} from './Badge';
import {SIGNIFICANCE_DAYS} from './dataState';

/**
 * Confidence tiering for data coverage, kept in its own module so both the
 * <CoverageBadge> component and other data-state surfaces (e.g.
 * <PartialCoverage>) classify against the same thresholds rather than
 * re-inventing them.
 */

export type ConfidenceLevel = 'none' | 'low' | 'medium' | 'high';

export interface ConfidenceTier {
    level: ConfidenceLevel;
    tone: BadgeTone;
    label: string;
}

/**
 * Map a data-day count to a confidence tier. 14 days is the platform's
 * significance threshold (see the waste model: 14 days of inactivity = unused),
 * so a fortnight of real data is treated as high confidence.
 */
export function confidenceTier(dataDays: number): ConfidenceTier {
    const days = Math.max(0, Math.floor(dataDays));
    if (days <= 0) return {level: 'none', tone: 'neutral', label: 'No data'};
    if (days < 7) return {level: 'low', tone: 'danger', label: 'Low confidence'};
    if (days < SIGNIFICANCE_DAYS) return {level: 'medium', tone: 'warning', label: 'Medium confidence'};
    return {level: 'high', tone: 'success', label: 'High confidence'};
}
