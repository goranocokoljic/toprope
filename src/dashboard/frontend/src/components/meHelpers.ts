import type {MeJourney} from '../api/types';

/**
 * Earliest `started_on` across all of the developer's journey tools, or null
 * when none is recorded. The developer screens feed this into `useTimeRange` so
 * the "all time" preset spans from a developer's true first day of tool use —
 * never reaching beyond their own data. Shared by My Tools and My Activity
 * (Task 2.9) so both resolve "lifetime" identically.
 */
export function earliestJourneyStart(journey: MeJourney | undefined): string | null {
    if (!journey) {
        return null;
    }
    let earliest: string | null = null;
    for (const tool of journey.tools) {
        if (tool.started_on && (earliest === null || tool.started_on < earliest)) {
            earliest = tool.started_on;
        }
    }
    return earliest;
}
