/**
 * Encouraging-tone copy for the contextual best-practice display (Task 6.2.7 / #162).
 *
 * The contextual surface is public-facing and sits right next to a developer's own
 * metric, so its TONE is a product requirement, not decoration: the Phase 6 design is
 * explicit that public best-practice surfaces stay encouraging — "here is a practice
 * that may help", never "your churn is bad". A scolding line next to someone's number
 * would read as a reprimand and is exactly what this feature must avoid.
 *
 * Centralizing the copy here (rather than inlining strings in the route or the React
 * component) gives the tone ONE reviewable home, and lets the tone test assert the
 * invariant directly against the very string production emits: every metric's intro is
 * framed as optional help and contains none of the judgemental words that would turn a
 * suggestion into a verdict. The component renders whatever this returns, so the
 * surface can never drift to a harsher register without that test failing.
 */

import {PRACTICE_METRIC_LABELS, type PracticeMetric} from './metrics';

/**
 * The encouraging intro shown above the practices surfaced for a metric. Framed as
 * optional help anchored to the metric's plain-language label — an invitation, not a
 * verdict on the number. Deliberately free of any value judgement ("here are a few
 * practices that may help with code churn"), so it reads the same whether the
 * developer's figure is strong or weak.
 */
export function relatedPracticesIntro(metric: PracticeMetric): string {
    return `Here are a few practices that may help with ${PRACTICE_METRIC_LABELS[metric]}.`;
}
