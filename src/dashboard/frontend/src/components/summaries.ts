import type {SummaryLevel} from '../api/types';

/**
 * Presentation helpers for the AI summaries view (Task 3.12), kept beside the
 * components so the prominent cards, the history list, and the team panel all
 * label a summary's cadence and period identically.
 */

/** Display name for each summary cadence. */
export const SUMMARY_LEVEL_LABEL: Record<SummaryLevel, string> = {
    weekly: 'Weekly',
    monthly: 'Monthly',
    quarterly: 'Quarterly',
    yearly: 'Yearly',
};

/** Heading for a summary, e.g. "Weekly · 2026-W21". */
export function summaryHeading(level: SummaryLevel, periodValue: string): string {
    return `${SUMMARY_LEVEL_LABEL[level]} · ${periodValue}`;
}

/** A generated-at ISO timestamp as a short, locale-aware date-time. */
export function formatGeneratedAt(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return iso;
    }
    return new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    }).format(date);
}
