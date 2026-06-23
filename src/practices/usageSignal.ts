/**
 * Usage-signal correlation for best practices (Task 6.2.4 / #159).
 *
 * The differentiated signal only this product can produce: because the platform
 * already sees each developer's metrics, it can ask "did developers who ENGAGED with
 * this practice (viewed / applied it next to a metric) subsequently see that metric
 * move?". The raw material is the append-only `practice_usage_events` log (6.2.1);
 * the metric movement comes from the immutable daily snapshots via the aggregation
 * engine's {@link computePeriodMetrics}.
 *
 * This is deliberately LIGHTWEIGHT and DIRECTIONAL, never causal (the Phase 6 design
 * is explicit about not overclaiming):
 *
 *   * Per engaged developer, compare their metric in a window BEFORE their first
 *     engagement against the window AFTER it. A developer counts toward the signal
 *     only when BOTH windows have a value to compare (a "measurable" developer).
 *   * Aggregate the measurable developers into improved / worsened / flat tallies.
 *   * MIN-SAMPLE GUARD: below {@link DEFAULT_MIN_SAMPLE} measurable developers the
 *     result is withheld (`shown: false`) — a handful of developers is noise, and
 *     showing it would invite a causal read of a coincidence.
 *   * The shown result carries a reviewed DIRECTIONAL, NON-CAUSAL disclaimer
 *     ({@link DIRECTIONAL_DISCLAIMER}) and an encouraging, plain-language headline —
 *     "developers who engaged with this saw X improve", never "this practice improved X".
 *
 * Nothing here writes; it is a pure read over the usage log + snapshots, so it can be
 * recomputed any time the surfacing layer (6.2.7) needs it.
 */

import type Database from 'better-sqlite3';
import {computePeriodMetrics, type PeriodMetrics} from '../aggregation/compute';
import {addDays} from '../aggregation/dates';
import {listUsageEvents} from './store';
import {isPracticeMetric, type PracticeMetric} from './metrics';
import type {UsageEventType} from './types';

/** YYYY-MM-DD — the day form the snapshot windows are keyed on. */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Below this many MEASURABLE developers (both before/after windows present) the
 * correlation is withheld. Five is a deliberately conservative floor for a
 * directional signal — enough that "most improved" isn't one or two coincidences,
 * low enough that a real team can clear it. Overridable per call.
 */
export const DEFAULT_MIN_SAMPLE = 5;

/** Days on each side of an engagement that the before / after metric windows span. */
export const DEFAULT_WINDOW_DAYS = 14;

/**
 * The event kinds that count as ENGAGEMENT for the correlation. Viewing or applying
 * a surfaced practice is engagement; other log kinds (e.g. a future `dismissed`) are
 * not, so they never anchor a before/after comparison. Overridable per call.
 */
export const ENGAGEMENT_EVENTS: readonly UsageEventType[] = ['viewed', 'applied'];

/**
 * The mandatory directional / non-causal disclaimer shown with every usage signal.
 * Reviewed copy (6.2.4 acceptance criterion: the usage signal is labeled
 * directional/non-causal): it asserts correlation only and explicitly disclaims
 * cause, so the figure can never be read as "this practice caused the improvement".
 */
export const DIRECTIONAL_DISCLAIMER =
    'Directional signal only — correlation, not causation. ' +
    'This shows whether developers who engaged with this practice saw the metric move afterward; ' +
    'it does not claim the practice caused the change.';

/** Whether a metric IMPROVES when its value goes down (true) or up (false). */
const METRIC_IMPROVES_DOWNWARD: Record<PracticeMetric, boolean> = {
    churn: true, // less churn is better
    cost_per_pr: true, // cheaper per PR is better
    estimated_cost: true, // lower spend is better
    acceptance_rate: false, // higher acceptance is better
    ai_signature_score: false, // more AI-signature (adoption) reads as better here
};

/** Human-readable metric labels for the directional headline. */
const METRIC_LABELS: Record<PracticeMetric, string> = {
    churn: 'code churn',
    cost_per_pr: 'cost per PR',
    estimated_cost: 'estimated cost',
    acceptance_rate: 'acceptance rate',
    ai_signature_score: 'AI-signature score',
};

/** Pull the comparable value for a metric out of a computed period's metrics. */
function metricValue(metrics: PeriodMetrics, metric: PracticeMetric): number | null {
    switch (metric) {
        case 'churn':
            return metrics.avg_code_churn;
        case 'acceptance_rate':
            return metrics.avg_acceptance_rate;
        case 'cost_per_pr':
            return metrics.cost_per_pr;
        case 'ai_signature_score':
            return metrics.avg_ai_signature_score;
        case 'estimated_cost':
            return metrics.estimated_total_cost;
        default: {
            // Exhaustive over PracticeMetric; a new metric without a case fails to compile.
            const _never: never = metric;
            return _never;
        }
    }
}

/** How a single developer's metric moved across their engagement. */
export type MovementDirection = 'improved' | 'worsened' | 'flat';

/** Classify a before→after change for a metric, honoring the metric's polarity. */
function classifyMovement(before: number, after: number, metric: PracticeMetric): MovementDirection {
    if (after === before) {
        return 'flat';
    }
    const wentDown = after < before;
    const improved = METRIC_IMPROVES_DOWNWARD[metric] ? wentDown : !wentDown;
    return improved ? 'improved' : 'worsened';
}

/** Options for {@link analyzeUsageSignal}; all default to the module constants. */
export interface UsageSignalOptions {
    /** Days on each side of engagement to average the metric over. Default {@link DEFAULT_WINDOW_DAYS}. */
    windowDays?: number;
    /** Minimum measurable developers before the signal is shown. Default {@link DEFAULT_MIN_SAMPLE}. */
    minSample?: number;
    /** Which event kinds count as engagement. Default {@link ENGAGEMENT_EVENTS}. */
    engagementEvents?: readonly UsageEventType[];
}

/** The correlation result — either withheld (below sample) or a shown directional signal. */
export interface UsageSignalResult {
    contributionId: string;
    metric: PracticeMetric;
    /** Developers with a measurable before AND after window — the sample the guard checks. */
    sampleSize: number;
    /** The minimum sample that was required to show the signal. */
    minSample: number;
    /** True only when `sampleSize >= minSample`; false withholds the directional figures. */
    shown: boolean;
    /** Measurable developers whose metric improved after engaging (null when withheld). */
    improved: number | null;
    /** Measurable developers whose metric worsened after engaging (null when withheld). */
    worsened: number | null;
    /** Measurable developers whose metric did not move (null when withheld). */
    flat: number | null;
    /** improved / sampleSize in [0, 1] (null when withheld). */
    improvedShare: number | null;
    /** Encouraging, plain-language directional headline (null when withheld). */
    headline: string | null;
    /** The mandatory non-causal disclaimer — present whether shown or withheld. */
    disclaimer: string;
}

/** A withheld result: sample too small, no directional figures, but still labeled. */
function withheld(
    contributionId: string,
    metric: PracticeMetric,
    sampleSize: number,
    minSample: number,
): UsageSignalResult {
    return {
        contributionId,
        metric,
        sampleSize,
        minSample,
        shown: false,
        improved: null,
        worsened: null,
        flat: null,
        improvedShare: null,
        headline: null,
        disclaimer: DIRECTIONAL_DISCLAIMER,
    };
}

/**
 * Correlate engagement with a practice against subsequent movement in a developer's
 * own metric, returning a directional (never causal) signal guarded by a minimum
 * sample.
 *
 * For each developer in the practice's usage log, the FIRST engagement event whose
 * `metricContext` matches `metric` anchors a before/after comparison: the metric is
 * averaged over [day−window, day−1] and [day+1, day+window] from that developer's
 * daily snapshots. A developer is MEASURABLE only when both windows yield a value;
 * developers with a gap on either side are excluded from the sample rather than
 * counted as "no change". The measurable developers are tallied into improved /
 * worsened / flat (per the metric's polarity).
 *
 * If fewer than `minSample` developers are measurable the signal is WITHHELD
 * (`shown: false`, figures null) — only the sample size and the non-causal
 * disclaimer come back. At or above the threshold the result is shown with an
 * encouraging directional headline and the same disclaimer.
 *
 * Throws on an unknown `metric` (not in the practice vocabulary) — a typo must fail
 * loudly rather than silently correlate against nothing.
 */
export function analyzeUsageSignal(
    db: Database.Database,
    contributionId: string,
    metric: PracticeMetric,
    options: UsageSignalOptions = {},
): UsageSignalResult {
    if (!isPracticeMetric(metric)) {
        throw new Error(`[practices] unknown metric '${String(metric)}' for usage-signal correlation`);
    }
    const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
    const minSample = options.minSample ?? DEFAULT_MIN_SAMPLE;
    const engagementEvents = new Set(options.engagementEvents ?? ENGAGEMENT_EVENTS);
    if (windowDays < 1) {
        throw new Error(`[practices] windowDays must be >= 1 for usage-signal correlation (got ${windowDays})`);
    }

    // Earliest matching engagement DAY per developer. listUsageEvents is oldest-first,
    // so the first row we see for a developer is their first engagement — later rows
    // for the same developer are ignored. Only events whose metric_context matches the
    // metric under study, and whose kind counts as engagement, anchor a comparison.
    const firstEngagementDay = new Map<string, string>();
    for (const ev of listUsageEvents(db, contributionId)) {
        if (ev.metricContext !== metric || !engagementEvents.has(ev.event)) {
            continue;
        }
        if (firstEngagementDay.has(ev.developerId)) {
            continue;
        }
        const day = ev.occurredAt.slice(0, 10);
        if (!DAY_RE.test(day)) {
            // A malformed timestamp can't anchor a window; skip this developer
            // defensively rather than letting computePeriodMetrics throw on the range.
            console.warn(
                `[practices] usage event ${ev.id} has an unparseable occurred_at '${ev.occurredAt}'; skipping for correlation`,
            );
            continue;
        }
        firstEngagementDay.set(ev.developerId, day);
    }

    let improved = 0;
    let worsened = 0;
    let flat = 0;
    for (const [developerId, day] of firstEngagementDay) {
        const before = metricValue(
            computePeriodMetrics(db, developerId, addDays(day, -windowDays), addDays(day, -1)),
            metric,
        );
        const after = metricValue(
            computePeriodMetrics(db, developerId, addDays(day, 1), addDays(day, windowDays)),
            metric,
        );
        if (before === null || after === null) {
            continue; // not measurable — excluded from the sample, not counted as flat
        }
        const movement = classifyMovement(before, after, metric);
        if (movement === 'improved') {
            improved += 1;
        } else if (movement === 'worsened') {
            worsened += 1;
        } else {
            flat += 1;
        }
    }

    const sampleSize = improved + worsened + flat;
    if (sampleSize < minSample) {
        return withheld(contributionId, metric, sampleSize, minSample);
    }

    const improvedShare = improved / sampleSize;
    const label = METRIC_LABELS[metric];
    const headline = `Among ${sampleSize} developers who engaged with this practice, ${improved} saw their ${label} improve afterward.`;
    return {
        contributionId,
        metric,
        sampleSize,
        minSample,
        shown: true,
        improved,
        worsened,
        flat,
        improvedShare,
        headline,
        disclaimer: DIRECTIONAL_DISCLAIMER,
    };
}
