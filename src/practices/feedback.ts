/**
 * Best-Practice feedback mechanics — the "richer than an upvote" layer (Task 6.2.4 / #159).
 *
 * Two jobs sit here, both built on the 6.2.1 store (no new tables, no parallel
 * stacks — Epic 6.2 cross-cutting criterion):
 *
 *   1. TOGGLABLE CAPTURE. A developer has at most one CURRENT signal per practice
 *      (the store's UPSERT contract). {@link toggleFeedback} layers the "togglable"
 *      semantics the issue asks for: pressing the signal you already hold clears it
 *      (toggle off); pressing the other one flips it. So the UI's two buttons behave
 *      like a pair of toggles rather than a write-only vote.
 *
 *   2. HELPFUL-RATIO RANKING INPUT. The bottom-up / hybrid pool is ordered by a
 *      developer's helpful-RATIO, not a raw net (helpful − notHelpful) tally —
 *      "8 of 10 found this helpful" is a better quality signal than "+6 net". A raw
 *      ratio, though, hands a single lone upvote a perfect 1.0 and floats it above a
 *      battle-tested 40/50 practice. {@link feedbackRankScore} uses the Wilson score
 *      interval's LOWER bound instead: it discounts the proportion by how little
 *      evidence backs it, so confidence grows with sample size. That lower bound is
 *      the value the ranking sorts on (6.2.4 acceptance criterion: ranking reflects
 *      helpful-ratio for bottom-up/hybrid).
 *
 * Pure functions where it can be (the Wilson math, the raw ratio) so they are
 * trivially testable; the one stateful entry, {@link toggleFeedback}, runs its
 * read-then-write in a transaction so a concurrent writer can't wedge between the
 * "what does this developer currently hold?" read and the toggle decision.
 */

import type Database from 'better-sqlite3';
import {getFeedback, recordFeedback, removeFeedback} from './store';
import type {FeedbackCounts, FeedbackSignal} from './types';

/**
 * The z value for a two-sided 95% confidence interval (1.96). A constant, not a
 * knob: the ranking only needs ONE consistent confidence level, and pinning it
 * keeps {@link feedbackRankScore} a pure, deterministic function of the counts.
 */
const WILSON_Z = 1.96;
const WILSON_Z2 = WILSON_Z * WILSON_Z;

/**
 * The Wilson score interval's LOWER bound for the proportion of helpful votes —
 * a confidence-adjusted helpful-ratio in [0, 1].
 *
 * With `total` = 0 there is no evidence, so the lower bound is 0. Otherwise it is
 * the standard Wilson lower bound at 95% confidence: it sits below the raw
 * proportion `helpful/total` and the gap shrinks as `total` grows, so a 1/1 (raw
 * 1.0) scores well under a 40/45 (raw ~0.89) — exactly the "don't let one vote
 * outrank a proven practice" property the ranking needs. Deterministic and pure.
 */
export function wilsonLowerBound(helpful: number, total: number): number {
    if (total <= 0) {
        return 0;
    }
    const phat = helpful / total;
    const numerator =
        phat + WILSON_Z2 / (2 * total) - WILSON_Z * Math.sqrt((phat * (1 - phat) + WILSON_Z2 / (4 * total)) / total);
    const denominator = 1 + WILSON_Z2 / total;
    return numerator / denominator;
}

/**
 * The RAW helpful-ratio (`helpful / (helpful + notHelpful)`) in [0, 1], or null when
 * there is no feedback at all. This is the human-readable "X% found this helpful"
 * figure for display — the ranking itself sorts on {@link feedbackRankScore}, which
 * is confidence-adjusted; this unadjusted ratio is not a ranking key.
 */
export function helpfulRatio(counts: FeedbackCounts): number | null {
    const total = counts.helpful + counts.notHelpful;
    if (total === 0) {
        return null;
    }
    return counts.helpful / total;
}

/**
 * The value the practice pool sorts on for bottom-up / hybrid: the confidence-
 * adjusted helpful-ratio (Wilson lower bound over helpful / total). Higher means a
 * more confidently-helpful practice. A practice with no feedback scores 0.
 */
export function feedbackRankScore(counts: FeedbackCounts): number {
    return wilsonLowerBound(counts.helpful, counts.helpful + counts.notHelpful);
}

/** Inputs for {@link toggleFeedback}: who is signalling what on which practice. */
export interface ToggleFeedbackInput {
    contributionId: string;
    developerId: string;
    /** The signal the developer pressed. */
    signal: FeedbackSignal;
    /** UTC ISO timestamp; defaults to now (set by the store) when a signal is set. */
    createdAt?: string;
}

/** The outcome of a toggle: the developer's resulting current signal (null = cleared). */
export interface ToggleFeedbackResult {
    /** The signal now in effect for this developer, or null when the toggle cleared it. */
    signal: FeedbackSignal | null;
    /** True when this call removed an existing signal (pressed the one already held). */
    removed: boolean;
}

/**
 * Apply a togglable helpful / not-helpful press, preserving "one current signal per
 * developer":
 *
 *   * No current signal  → record the pressed one          → { signal, removed: false }
 *   * Pressed the SAME signal already held → clear it       → { signal: null, removed: true }
 *   * Pressed the OTHER signal → flip to it                 → { signal, removed: false }
 *
 * The read of the existing signal and the resulting write run in ONE transaction so
 * a concurrent toggle can't land between them and turn a flip into a duplicate or a
 * clear into a stale row. Returns the resulting state for the caller to echo back.
 */
export function toggleFeedback(db: Database.Database, input: ToggleFeedbackInput): ToggleFeedbackResult {
    return db.transaction((): ToggleFeedbackResult => {
        const existing = getFeedback(db, input.contributionId, input.developerId);
        if (existing && existing.signal === input.signal) {
            removeFeedback(db, input.contributionId, input.developerId);
            return {signal: null, removed: true};
        }
        recordFeedback(db, {
            contributionId: input.contributionId,
            developerId: input.developerId,
            signal: input.signal,
            createdAt: input.createdAt,
        });
        return {signal: input.signal, removed: false};
    })();
}
