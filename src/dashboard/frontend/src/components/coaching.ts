/**
 * PR/review coaching presentation helpers (Task 5.3 / #124).
 *
 * Pure mapping from the engine's structured signals to coaching COPY — kept out
 * of the page components so the wording is unit-testable and reads identically
 * on the developer-private and manager-aggregate surfaces. The tone is
 * deliberately non-judgmental: signals are framed as trajectories and gentle
 * hints, never verdicts or rankings.
 */

import type {BadgeTone} from './Badge';
import {formatPercent} from './format';
import type {
    PRReviewCombinedSignal,
    PRReviewMetricTrend,
    PRReviewScopeVariant,
} from '../api/types';

/**
 * Format a stored period key for a chart tick: a month key (YYYY-MM) reads as
 * "Mon YYYY", an ISO-week key (YYYY-Www) as "Www". Anything unexpected passes
 * through unchanged so a tick never renders blank.
 */
export function formatPeriodTick(period: string | number): string {
    const key = String(period);
    const week = /^(\d{4})-W(\d{2})$/.exec(key);
    if (week) {
        return `W${week[2]}`;
    }
    const month = /^(\d{4})-(\d{2})$/.exec(key);
    if (month) {
        const date = new Date(Date.UTC(Number(month[1]), Number(month[2]) - 1, 1));
        return new Intl.DateTimeFormat(undefined, {month: 'short', year: 'numeric', timeZone: 'UTC'}).format(date);
    }
    return key;
}

/** Short human label for a scope variant. */
export function variantTitle(variant: PRReviewScopeVariant): string {
    return variant === 'all_pr' ? 'All your PRs' : 'Your AI-assisted PRs';
}

/** Team-facing variant label (the manager view talks about the team, never a person). */
export function teamVariantTitle(variant: PRReviewScopeVariant): string {
    return variant === 'all_pr' ? 'All PRs' : 'AI-assisted PRs';
}

export interface SignalCopy {
    label: string;
    tone: BadgeTone;
    /** Plain-language explanation of the combined churn + review signal. */
    guidance: string;
}

/**
 * The combined churn+review signal, explained in plain language with a gentle,
 * actionable hint. `subject` lets the same mapping serve the developer ("your")
 * and manager ("the team's") surfaces without duplicating the wording.
 */
export function combinedSignalCopy(
    signal: PRReviewCombinedSignal,
    subject: 'you' | 'team',
): SignalCopy {
    const possessive = subject === 'you' ? 'your' : "the team's";
    switch (signal) {
        case 'effective':
            return {
                label: 'Effective',
                tone: 'success',
                guidance: `Low churn with clean reviews — ${possessive} changes are landing without much rework.`,
            };
        case 'healthy_iteration':
            return {
                label: 'Healthy iteration',
                tone: 'neutral',
                guidance: `Higher churn but clean reviews usually just means active iteration, not a problem.`,
            };
        case 'struggling':
            return {
                label: 'Worth a look',
                tone: 'warning',
                guidance:
                    subject === 'you'
                        ? 'High churn together with frequent rework can be a hint to review AI output a little more before committing.'
                        : 'Rising rework on these PRs — the team might benefit from sharing AI-output-review practices.',
            };
        default:
            return {
                label: 'Not enough data yet',
                tone: 'neutral',
                guidance: `Once there are a few more PRs in this range, ${possessive} coaching signal will appear here.`,
            };
    }
}

/**
 * A trajectory sentence for the rework trend ("rose from 15% to 30%"), or null
 * when there isn't enough history to claim a trend — the caller then shows a
 * gentle "not enough history yet" line instead of a bare snapshot verdict.
 */
export function reworkTrendSentence(
    trend: PRReviewMetricTrend,
    subjectPhrase: string,
): string | null {
    if (
        trend.direction === 'insufficient_data' ||
        trend.from_value === null ||
        trend.to_value === null
    ) {
        return null;
    }
    const from = formatPercent(trend.from_value);
    const to = formatPercent(trend.to_value);
    switch (trend.direction) {
        case 'rising':
            return `Rework rate on ${subjectPhrase} rose from ${from} to ${to} over this period.`;
        case 'falling':
            return `Rework rate on ${subjectPhrase} eased from ${from} to ${to} over this period.`;
        default:
            return `Rework rate on ${subjectPhrase} held steady around ${to} over this period.`;
    }
}
