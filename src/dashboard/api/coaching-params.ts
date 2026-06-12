/**
 * Shared query-param parsing for the PR/review coaching endpoints (Task 5.3 /
 * #124). Both the developer (/api/me/pr-coaching) and manager (team aggregate)
 * routes accept the same `unit` selector, so the parse + default live in one
 * place rather than drifting between the two.
 */

import type {PRReviewPeriodUnit} from '../../coaching/pr-review/types';

export interface PeriodUnitInput {
    unit?: string;
}

/**
 * Resolve the period unit, defaulting to monthly — the cadence that reads as a
 * trajectory ("this month vs last") rather than the noisier weekly view. Any
 * unrecognized value falls back to monthly rather than erroring, so a stray
 * query param degrades gracefully.
 */
export function parsePeriodUnit(raw: string | undefined): PRReviewPeriodUnit {
    return raw === 'weekly' ? 'weekly' : 'monthly';
}
