/**
 * Available-data coaching — the pure signal builders (Task 5.1 / #122).
 *
 * Side-effect-free functions that turn already-computed scalars (a period's mean
 * churn vs the developer's own baseline, their acceptance trend, the journey
 * annotations, their tier) into coaching drafts. No database, no period
 * arithmetic, no clock — those live in generator.ts. Keeping the math pure makes
 * every acceptance criterion directly unit-testable: each signal type, the
 * basis labelling, the "acceptance absent (not faked) for git-only" rule, and
 * the within-developer framing.
 *
 * Every signal is framed against the developer's OWN trajectory (their baseline,
 * their journey) — never against another developer. A builder returns null when
 * there isn't enough of the developer's own data to say something honest, so the
 * generator simply omits that signal rather than inventing one.
 */

import type {JourneyAnnotation, JourneyAnnotationType, JourneyTier} from '../../dashboard/api/journey';
import type {
    AcceptanceDirection,
    AvailableCoachingThresholds,
    CoachingSignalDraft,
    SignalDirection,
} from './types';

/** Round to 4dp so stored context numbers are clean, not float noise. */
function round4(value: number): number {
    return Math.round(value * 1e4) / 1e4;
}

/**
 * The basis for a tier-aware signal: measured tool data → `measured`, anything
 * else (git activity, expense-only) → `git_estimate`. At launch (git-only) this
 * resolves to `git_estimate`, exactly as the issue expects.
 */
export function basisForTier(tier: JourneyTier): 'measured' | 'git_estimate' {
    return tier === 'high' ? 'measured' : 'git_estimate';
}

/**
 * Churn self-reflection from the developer's OWN churn trajectory: this period's
 * mean code-churn vs their trailing baseline. Returns null unless there is both
 * a current value and a baseline to compare it to and the developer was active
 * enough in the period to coach on (a single stray commit is not a trend).
 *
 * Churn is always a git-derived signal, so the basis is always `git_estimate`.
 */
export function buildChurnReflection(
    currentChurn: number | null,
    baselineChurn: number | null,
    activeDays: number,
    thresholds: AvailableCoachingThresholds,
): CoachingSignalDraft | null {
    if (currentChurn === null || baselineChurn === null) return null;
    if (baselineChurn <= 0) return null; // no meaningful relative comparison
    if (activeDays < thresholds.minActiveDays) return null;

    const deltaRatio = (currentChurn - baselineChurn) / baselineChurn;
    let direction: SignalDirection = 'steady';
    if (deltaRatio >= thresholds.churnChangeThreshold) direction = 'elevated';
    else if (deltaRatio <= -thresholds.churnChangeThreshold) direction = 'lower';

    const observation =
        direction === 'elevated'
            ? 'Your code churn is elevated versus your own recent baseline — a pattern ' +
              'worth noticing. Developers who review AI output carefully before committing ' +
              'tend to see lower churn.'
            : direction === 'lower'
              ? 'Your code churn has come down versus your own recent baseline — a good ' +
                'sign that the code you commit is holding up without rework.'
              : 'Your code churn is steady versus your own recent baseline — no notable ' +
                'change in how much committed code is being rewritten.';

    return {
        signalType: 'churn_reflection',
        basis: 'git_estimate',
        observation,
        metricContext: {
            category: direction,
            current: round4(currentChurn),
            baseline: round4(baselineChurn),
            delta_ratio: round4(deltaRatio),
        },
    };
}

/**
 * Acceptance-rate trend — ONLY when tool data exists. `currentAcceptance` is
 * null for a git-only developer (no tool_snapshots acceptance to measure), and
 * this returns null in that case: the signal is honestly ABSENT, never
 * fabricated. Also null without a baseline (a trend needs a prior period).
 *
 * Acceptance is a measured tool-API signal, so the basis is always `measured`.
 */
export function buildAcceptanceTrend(
    currentAcceptance: number | null,
    baselineAcceptance: number | null,
    thresholds: AvailableCoachingThresholds,
): CoachingSignalDraft | null {
    // The privacy/honesty-critical guard: no tool acceptance data → no signal.
    if (currentAcceptance === null) return null;
    if (baselineAcceptance === null) return null;

    const delta = currentAcceptance - baselineAcceptance;
    let direction: AcceptanceDirection = 'steady';
    if (delta >= thresholds.acceptanceChangeThreshold) direction = 'rising';
    else if (delta <= -thresholds.acceptanceChangeThreshold) direction = 'falling';

    const observation =
        direction === 'rising'
            ? 'Your suggestion acceptance rate has climbed versus your own recent ' +
              'baseline — you are getting better at prompting for what you actually need.'
            : direction === 'falling'
              ? 'Your suggestion acceptance rate has dipped versus your own recent ' +
                'baseline — it can help to give the tool more context or a sharper prompt.'
              : 'Your suggestion acceptance rate is holding steady versus your own ' +
                'recent baseline.';

    return {
        signalType: 'acceptance_trend',
        basis: 'measured',
        observation,
        metricContext: {
            category: direction,
            current: round4(currentAcceptance),
            baseline: round4(baselineAcceptance),
            delta: round4(delta),
        },
    };
}

/** Salience order when two annotations share the latest week — later beat wins. */
const ANNOTATION_SALIENCE: Record<JourneyAnnotationType, number> = {
    plateau: 3,
    sustained_ramp: 2,
    first_active_week: 1,
};

/**
 * Pick the annotation to coach on: the most recent moment on the journey, with
 * salience (plateau > ramp > first week) breaking a same-week tie. Exported for
 * direct unit testing of the selection rule.
 */
export function mostSalientAnnotation(
    annotations: JourneyAnnotation[],
): JourneyAnnotation | null {
    let best: JourneyAnnotation | null = null;
    for (const a of annotations) {
        if (
            best === null ||
            a.week_start > best.week_start ||
            (a.week_start === best.week_start &&
                ANNOTATION_SALIENCE[a.type] > ANNOTATION_SALIENCE[best.type])
        ) {
            best = a;
        }
    }
    return best;
}

/**
 * Adoption-journey coaching: a gentle interpretation of the Phase 4 journey's
 * detected moments (first active week, sustained ramp, plateau). Returns null
 * when the journey has no annotations yet (nothing to interpret).
 *
 * Tier-aware basis: a journey built only from git signals is an estimate
 * (`git_estimate`); once tool data backs it, it becomes `measured`.
 */
export function buildJourneyCoaching(
    annotations: JourneyAnnotation[],
    tier: JourneyTier,
): CoachingSignalDraft | null {
    const annotation = mostSalientAnnotation(annotations);
    if (!annotation) return null;

    const observation =
        annotation.type === 'plateau'
            ? "You've settled into a steady rhythm with AI assistance. Many developers " +
              'find that trying agent or chat features unlocks a step change beyond ' +
              'autocomplete.'
            : annotation.type === 'sustained_ramp'
              ? 'Your AI usage has been ramping steadily — you are building real momentum. ' +
                'Keep leaning into the workflows that are working for you.'
              : "You've started using AI assistance — it's early days. Consistency over " +
                'the next few weeks is what turns it into a durable habit.';

    return {
        signalType: 'journey_coaching',
        basis: basisForTier(tier),
        observation,
        metricContext: {
            category: annotation.type,
            week_start: annotation.week_start,
            tier,
        },
    };
}

/** The developer's own activity in the period — input to the personal insight. */
export interface PeriodActivity {
    activeDays: number;
    commits: number;
    interactions: number;
}

/**
 * Tier-aware personal insight on the developer's OWN data. The shape of the
 * insight depends on the developer's data tier:
 *   - high   : measured tool data — a grounded usage observation (`measured`)
 *   - medium : git-only — estimated, with a nudge that connecting tools unlocks
 *              measured signals (`git_estimate`)
 *   - low    : an expense-only seat with no measured activity yet (`git_estimate`)
 *   - none   : no data at all → null (no false coaching on no data)
 *
 * For the high/medium tiers the developer must have been active enough in the
 * period (minActiveDays) to ground the insight; the low tier has no activity by
 * definition, so it always speaks to the unused seat.
 */
export function buildPersonalInsight(
    tier: JourneyTier,
    activity: PeriodActivity,
    thresholds: AvailableCoachingThresholds,
): CoachingSignalDraft | null {
    if (tier === 'none') return null;

    if (tier === 'low') {
        return {
            signalType: 'personal_insight',
            basis: 'git_estimate',
            observation:
                'We can see an AI tool subscription for you but no measured activity yet. ' +
                'Once your usage starts flowing in, this becomes personalized coaching on ' +
                'your own data.',
            metricContext: {
                category: tier,
                active_days: activity.activeDays,
                commits: activity.commits,
                interactions: activity.interactions,
            },
        };
    }

    if (activity.activeDays < thresholds.minActiveDays) return null;

    const observation =
        tier === 'high'
            ? `Across measured tool data you were active on ${activity.activeDays} day(s) ` +
              `this period with ${activity.interactions} interaction(s) — your usage is ` +
              'well-instrumented, so your coaching here is measured rather than estimated.'
            : `This period's insights are estimated from your git activity ` +
              `(${activity.commits} commit(s) across ${activity.activeDays} active day(s)). ` +
              'Connecting your AI tool accounts would unlock measured acceptance and usage signals.';

    return {
        signalType: 'personal_insight',
        basis: basisForTier(tier),
        observation,
        metricContext: {
            category: tier,
            active_days: activity.activeDays,
            commits: activity.commits,
            interactions: activity.interactions,
        },
    };
}
