/**
 * The commit-date pin every provider decides on, and the drop reason it classifies (#275 / #290).
 *
 * WHY IT IS PINNED AT THE PROVIDER BOUNDARY. The day key is derived by a bare
 * `isoDate.slice(0, 10)` (`analyzer.ts`, `churn.ts`), and the write boundary then hard-rejects
 * anything that is not a `YYYY-MM-DD` day — by THROWING, inside the run's single all-providers
 * write transaction, which rolls back every provider's window and re-throws identically on every
 * subsequent run. So an ISO 8601 expanded year (`+033658-09-27T…`, which
 * `git commit --date=@999999999999` produces) has to be caught HERE, where it costs one reported
 * commit, rather than one frame down where it bricks the whole git connector. Same hazard class as
 * #233's expanded-year watermark, and the same fix: pin the shape at the boundary.
 *
 * WHY IT IS ONE MODULE rather than a copy per provider (#290). #275 pinned only GitHub, and
 * documented the agreement between its gate and the store's `UTC_DAY_RE` in a COMMENT — which
 * meant tightening one silently diverged the other and re-armed the brick. The predicate now has a
 * single home (`isUtcDay`, in `aggregation/dates.ts`) that the store and the projection also read,
 * so the agreement is enforced by the import graph instead of by prose. All three providers gate
 * here; that is what lets `GitProvider.getCommits` state the rule without an exception list.
 *
 * WHAT THIS DOES NOT CLOSE, said here so the docstring above is not read as more than it is. This
 * module gates the COMMIT AUTHOR DATE. The same rollback is still reachable through the PR and
 * review-comment day keys (`toDateString(pr.createdAt / pr.mergedAt / comment.createdAt)` in
 * `analyzer.ts`, which key a metrics row that reaches the store verbatim) and through the NaN
 * `avg_time_to_merge_hours` those two timestamps compute. No provider gates any of them. Closing
 * that class needs a per-row skip at the WRITE boundary rather than a fifth gate here — total over
 * every date field and every future provider, and a data-integrity decision of #231/#235's weight,
 * so it is tracked separately in #302. Do not read this module as protecting the run outright.
 */

import {isUtcDay} from '../../../aggregation/dates.js';
import {
    NO_AUTHOR_DATE_DROP_REASON,
    UNATTRIBUTABLE_DATE_DROP_REASON,
    type GitCommitDropReason,
} from './types.js';

/**
 * Can this author date be attributed to a day by the pipeline downstream?
 *
 * WHAT IT PINS, exactly — it validates the DAY KEY the pipeline will actually derive, using the
 * same predicate the store validates with ({@link isUtcDay}, which `raw-author-daily.ts` now
 * imports rather than restating). That agreement is the point, so this is deliberately NOT
 * stricter than the store:
 *   - `typeof` first, because `.test()` COERCES — an array from an odd JSON body would stringify
 *     into a matching value and sail through. `unknown` rather than `string | undefined` so the
 *     guard is TOTAL over whatever an unvalidated response body actually holds, not only over the
 *     shapes a provider's interface claims.
 *   - `isUtcDay` on the sliced day, so this asks the SAME question the store asks.
 *   - `Date.parse` finite, because the shape check alone accepts `9999-99-99T00:00:00Z`. This one
 *     conjunct IS stricter than the store, on purpose: `analyzer.ts` orders commits by
 *     `new Date(c.date).getTime()`, and a NaN there makes the comparator non-total — the graduated
 *     determinism rule. A day the store accepts is worth nothing if the sort that reads it is
 *     undefined.
 * Calendar validity (`2024-02-30`) and UTC-ness (an `-05:00` offset attributes to the offset-local
 * day) are NOT pinned, because the store accepts both: rejecting them here would DROP commits the
 * store would have stored, trading a small mis-attribution for a real loss. A bare day with no time
 * (`2024-01-15`) is accepted for the same reason — no reader in this pipeline consumes the time
 * component (every one of them is `slice(0, 10)` or a parsed instant), so rejecting it would lose a
 * commit the store would have keyed correctly. Both remaining gaps are pre-existing and shared by
 * all three providers; fixing them belongs at the write boundary, for every provider at once.
 */
export function isAttributableDate(date: unknown): boolean {
    return (
        typeof date === 'string' &&
        isUtcDay(date.slice(0, 10)) &&
        Number.isFinite(Date.parse(date))
    );
}

/** Was a date STRING supplied at all, as opposed to absent/null/blank? */
function hasDate(date: unknown): boolean {
    return typeof date === 'string' && date !== '';
}

/**
 * Which {@link GitCommitDropReason} describes a commit none of whose `candidates` is attributable.
 *
 * Variadic because a provider may hold more than one copy of the same author date — GitHub reads
 * the commit-detail response and falls back to the list row — and the classification must consider
 * every copy it actually looked at. Callers with one copy pass one.
 *
 * The two reasons are distinguished by whether a date was PRESENT at all, because the operator's
 * next step differs: absent on every copy means a truncated response, while present-but-unusable
 * means a real commit whose timestamp this pipeline cannot key on.
 *
 * `typeof … === 'string' && !== ''`, not `!== undefined`: `date: null` and `date: ''` are what a
 * truncated or garbled body actually yields, and calling those "present but unattributable" sends
 * the operator looking for a real commit with an odd timestamp — the precise opposite of the truth,
 * and it inverts the only distinction the two reasons exist to draw.
 *
 * Call this ONLY once {@link isAttributableDate} has refused every candidate; on an attributable
 * input it would name a drop that is not happening.
 */
export function commitDropReason(...candidates: unknown[]): GitCommitDropReason {
    return candidates.some(hasDate)
        ? UNATTRIBUTABLE_DATE_DROP_REASON
        : NO_AUTHOR_DATE_DROP_REASON;
}
