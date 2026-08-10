/**
 * The git run's `[since, until]` window bounds, validated ONCE where they are derived (#309).
 *
 * WHAT THE TWO STRINGS ARE. `fetchProviderData` (`sync.ts`) derives exactly one `since` and one
 * `until` per provider per run — from the stored `git_last_sync` cursor, from `firstSyncSince`,
 * from `catchUpUntil`, or from a backfill's `[since, until]` slice — and hands the same PAIR to
 * every provider's `getCommits` AND to `getPullRequests`. Both are UTC ISO instants, or `''`
 * meaning "no bound" (a first sync with no configured window walks everything; removing that
 * early return would refuse every first sync).
 *
 * WHY THE CHECK LIVES HERE AND NOT PER PROVIDER. #304 pinned these bounds inside
 * `BitbucketProvider.getCommits`, which was where the in-memory comparison lived — but the defect
 * is not Bitbucket's. `github.ts` / `gitlab.ts` push both bounds into a query string, so a value
 * that parses to year 10000 plausibly returns an empty result set as a SUCCESS and the run records
 * an unwalked window as covered; and `getPullRequests` on all three still hand-rolls
 * `since ? new Date(since) : null`, where an Invalid Date makes the `reachedSince` break
 * unreachable and the walk pages the entire PR history back as "the requested window". Checking
 * the pair once, at the point of derivation, closes every one of those at the same time —
 * including for a provider not written yet — instead of adding a fourth, fifth and sixth
 * per-provider copy of the same rule.
 *
 * FAIL-CLOSED BY THROWING, never by degrading to "no bound". A throw out of `fetchProviderData`
 * is caught by `runSync`, which records the provider as unusable and moves no cursor (#231) — so
 * the window is re-fetched intact once the bad value is repaired. Substituting `null` would do the
 * opposite: walk the repo's entire history, record it as the requested window, and advance the
 * cursor over data nobody asked for.
 */

import {isPlainYearInstant} from '../../../aggregation/dates.js';

/** The parsed pair, with `null` for a bound that was blank (i.e. "no bound"). */
export interface CommitWindow {
    since: Date | null;
    until: Date | null;
}

/**
 * What every refusal below points the operator at. The two `sync_state` rows these bounds are
 * read from — naming them is the difference between an unexplained brick and a two-minute repair.
 */
const STATE_KEY_HINT =
    'Check the git_last_sync / git_earliest_sync sync_state rows for this provider.';

/**
 * Parse one bound, refusing anything a comparison against it could silently mis-order.
 *
 * The OFFENDING VALUE is deliberately never interpolated into the message. It reaches an operator
 * terminal and `sync_logs.errors` through the caller's error line, and it comes from stored,
 * unvalidated `sync_state` rows; the STATE KEYS that hold it are named instead, which leaks
 * nothing and still points somewhere.
 */
function parseBound(value: string, label: 'since' | 'until'): Date | null {
    if (!value) return null;
    if (!isPlainYearInstant(value)) {
        throw new Error(
            `Git commit window bound "${label}" is not a plain four-digit-year UTC instant — ` +
                'refusing to fetch with a bound whose comparisons would silently exclude every ' +
                `row. ${STATE_KEY_HINT}`,
        );
    }
    return new Date(value);
}

/**
 * Validate and parse the run's window pair, or throw.
 *
 * ONE function, TWO callers, so the rule cannot drift between the place it is enforced for every
 * provider and the place Bitbucket actually needs the `Date` objects:
 *   - `fetchProviderData` calls it once per provider per run, purely for the refusal — the run's
 *     bounds travel onward as the strings they already were;
 *   - `BitbucketProvider.getCommits` calls it and USES the returned pair for its in-memory
 *     window filter. It keeps its own call rather than trusting the hoist because `getCommits` is
 *     a public `GitProvider` method with its own direct callers (its contract tests among them),
 *     and it needs the parsed pair regardless — so delegating here costs nothing and asking for
 *     the parse without the check would be the fail-open version of the same line.
 *
 * AN INVERTED WINDOW IS THE SAME DEFECT AS AN UNPARSEABLE BOUND, and the reachable one (#304
 * review cycle 2). Each bound can be individually perfect while the PAIR is impossible:
 * `catchUpUntil` clamps `until` to `now` while `since` is whatever the cursor says, so a host
 * clock that jumped forward once — or a hand-edited `git_last_sync` — MANUFACTURES
 * `since > until`. Unrefused, that window matches no commit anywhere, every walk returns empty as
 * a success, and the run records the span between the last honest sync and now as covered with no
 * drop, no error and no divergence to read.
 *
 * `>` and not `>=`: a chunk whose bounds coincide asks for a zero-length span, which is a
 * legitimate no-op the cursor logic produces, not a corrupt cursor. Only when BOTH bounds exist —
 * a blank one is "no bound", which cannot be inverted.
 */
export function resolveCommitWindow(since: string, until: string): CommitWindow {
    const sinceDate = parseBound(since, 'since');
    const untilDate = parseBound(until, 'until');
    if (sinceDate && untilDate && sinceDate.getTime() > untilDate.getTime()) {
        // WHAT THE MESSAGE MAY AND MAY NOT SAY. The likeliest cause is a host clock that ran ahead
        // when the cursor was stamped and has since been corrected, so the first thing it names is
        // the clock. The line used to go on to FORBID lowering that cursor: re-importing an
        // already-covered span was the permanent double-count #262 documents, because the
        // cross-run merge ADDED commit metrics on a premise of disjoint windows. IG1 (#316)
        // removed the premise — commits are sha-keyed in `raw_commits` and each author-day is
        // recomputed from it — so lowering the cursor now costs only re-fetching, and the message
        // says that instead of prescribing a caution that is no longer true. It still states the
        // blast radius, because this refusal stalls the whole provider until the value is
        // corrected — better than the silent alternative it replaces, but not something to
        // discover.
        throw new Error(
            'Git commit window is inverted ("since" is after "until") — refusing to fetch with a ' +
                'window no commit can satisfy, which would record an untouched span as covered. ' +
                'Every repo of this provider is stalled until it is corrected. Usual cause: the ' +
                'host clock ran ahead when the git_last_sync sync_state row was stamped. Correct ' +
                'the clock first; if that cursor is itself too far ahead, lowering it is safe — ' +
                're-importing an already-covered span re-observes commits that are already stored ' +
                'by sha and changes no counter, so it costs API calls only (IG1, #316).',
        );
    }
    return {since: sinceDate, until: untilDate};
}
