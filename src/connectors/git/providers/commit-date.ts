/**
 * The commit-date pin every provider decides on, and the drop reason it classifies (#275 / #290).
 *
 * WHY IT IS PINNED AT THE PROVIDER BOUNDARY. The day key is derived by a bare
 * `isoDate.slice(0, 10)` (`analyzer.ts`, `churn.ts`), and the write boundary then hard-rejects
 * anything that is not a `YYYY-MM-DD` day. Until #302 that rejection was a THROW inside the run's
 * single all-providers write transaction, which rolled back every provider's window and re-threw
 * identically on every subsequent run — so an ISO 8601 expanded year (`+033658-09-27T…`, which
 * `git commit --date=@999999999999` produces) had to be caught HERE or it bricked the whole git
 * connector one frame down. Same hazard class as #233's expanded-year watermark, and the same
 * fix: pin the shape at the boundary.
 *
 * #302 REMOVED THAT TAIL BUT NOT THIS GATE'S JOB. The sync now asks the same validator before
 * writing and skips the row, so an ungated date costs its author-day rather than the run. What
 * it cannot do is NAME the commit: down there the row is keyed by (author, day) and the shas
 * were folded into its counters before the store saw it, so the loss is reported as "this author,
 * this unusable day" and nothing more. Catching it here still costs exactly one commit AND puts
 * its sha on `onDrop`, which is the difference between an operator who can look the commit up and
 * one who cannot.
 *
 * WHY IT IS ONE MODULE rather than a copy per provider (#290). #275 pinned only GitHub, and
 * documented the agreement between its gate and the store's `UTC_DAY_RE` in a COMMENT — which
 * meant tightening one silently diverged the other and re-armed the brick. The predicate now has a
 * single home (`isUtcDay`, in `aggregation/dates.ts`) that the store and the projection also read,
 * so the agreement is enforced by the import graph instead of by prose. All three providers gate
 * here; that is what lets `GitProvider.getCommits` state the rule without an exception list.
 *
 * WHAT THIS DOES NOT CLOSE, said here so the docstring above is not read as more than it is. This
 * module gates the COMMIT AUTHOR DATE, and nothing else. The PR and review-comment day keys
 * (`toDateString(pr.createdAt / pr.mergedAt / comment.createdAt)` in `analyzer.ts`) and the NaN
 * `avg_time_to_merge_hours` those two timestamps compute still reach the store ungated by any
 * provider. What changed in #302 is what happens NEXT: those dates no longer roll the run back.
 * The sync asks `findRawAuthorDailyDefect` — the same body the store's refusal delegates to —
 * for every raw row and `findPRRecordDefect` for every `pr_records` row (the OTHER write in the
 * same transaction, whose `created_at` is a `NOT NULL` column bound from an unvalidated field),
 * skips the ones either write would refuse, and reports them under `AUTHOR_DAYS_SKIPPED_PREFIX`
 * / `PR_RECORDS_SKIPPED_PREFIX`. That is total over every field those writes validate and over
 * every future provider, which is why it is a write-boundary skip and not a fourth gate here.
 * It is scoped to the DATE class at those two writes — it is not a claim that nothing else in
 * the transaction can ever throw.
 *
 * So the division of labour is: the write boundary keeps ONE bad value from costing the run, and
 * this module keeps a bad AUTHOR DATE from costing more than the one commit it belongs to — and,
 * unlike the skip, it can still name that commit's sha (`onDrop`), because down there the row is
 * keyed by (author, day) and the commits have already been summed into it. Do not read either as
 * making the other redundant.
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

/**
 * Was a date supplied at all, as opposed to absent/null/blank?
 *
 * Deliberately NOT `typeof date === 'string'`. {@link isAttributableDate} is total over
 * `unknown` precisely because a response body can hold a number or an array where the interface
 * claims a string — and such a body DID carry a date, just not one this pipeline can key on.
 * Classifying it as "no date" would send the operator hunting for a truncated response over a
 * commit that is sitting right there in the payload, which is the exact inversion the two
 * reasons exist to prevent.
 */
function hasDate(date: unknown): boolean {
    return date !== undefined && date !== null && date !== '';
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
 * "Present" is `!== undefined && !== null && !== ''`, not `!== undefined` alone: `date: null` and
 * `date: ''` are what a truncated or garbled body actually yields, and calling those "present but
 * unattributable" sends the operator looking for a real commit with an odd timestamp — the precise
 * opposite of the truth, and it inverts the only distinction the two reasons exist to draw. See
 * {@link hasDate} for why it is not a `typeof === 'string'` test either.
 *
 * The first candidate is a REQUIRED parameter rather than part of the rest, so a call with no
 * arguments cannot compile. `[].some(…)` is `false`, which would make a zero-arity call assert
 * "no date was present" — a positive claim about a body nobody looked at, landing on the reason
 * whose remedy is "go find the truncated response".
 *
 * Call this ONLY once {@link isAttributableDate} has refused every candidate; on an attributable
 * input it would name a drop that is not happening.
 */
export function commitDropReason(first: unknown, ...rest: unknown[]): GitCommitDropReason {
    return [first, ...rest].some(hasDate)
        ? UNATTRIBUTABLE_DATE_DROP_REASON
        : NO_AUTHOR_DATE_DROP_REASON;
}
