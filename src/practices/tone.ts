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
 * component) gives the tone ONE reviewable home and lets a test assert the invariant
 * directly: every metric's intro is framed as optional help and contains none of the
 * judgemental words ({@link SCOLDING_WORDS}) that would turn a suggestion into a
 * verdict. The component renders whatever this module returns, so the surface can
 * never drift to a harsher register without this test failing.
 */

import {practiceMetricLabel, type PracticeMetric} from './metrics';

/**
 * Words/phrases that would make the copy scold rather than encourage — a judgement on
 * the developer's number instead of an offer of help. The tone test asserts no intro
 * contains any of these (case-insensitively), and they double as the documented
 * definition of "scolding" for anyone editing the copy. Lowercase; matched as
 * substrings, so "problem" also catches "problems".
 */
export const SCOLDING_WORDS: readonly string[] = [
    'bad',
    'poor',
    'worst',
    'terrible',
    'wrong',
    'fail',
    'problem',
    'fault',
    'blame',
    'should have',
    'too high',
    'too low',
    'your fault',
];

/**
 * The encouraging intro shown above the practices surfaced for a metric. Framed as
 * optional help anchored to the metric's plain-language label — an invitation, not a
 * verdict on the number. Deliberately free of any value judgement ("here are a few
 * practices that may help with code churn"), so it reads the same whether the
 * developer's figure is strong or weak.
 */
export function relatedPracticesIntro(metric: PracticeMetric): string {
    return `Here are a few practices that may help with ${practiceMetricLabel(metric)}.`;
}

/**
 * Whether a line of copy stays encouraging — i.e. contains none of the
 * {@link SCOLDING_WORDS}. Exported so the route/UI (and the test) can assert the
 * invariant on any copy, not just the canned intro.
 */
export function isEncouraging(copy: string): boolean {
    const lower = copy.toLowerCase();
    return !SCOLDING_WORDS.some((word) => lower.includes(word));
}
