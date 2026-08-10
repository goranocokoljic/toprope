/**
 * #309 — the run's `[since, until]` pair, checked ONCE where it is derived.
 *
 * #304 pinned these bounds inside `BitbucketProvider.getCommits`, the only walk that compares them
 * in memory. The defect is not Bitbucket's: `github.ts`/`gitlab.ts` push both bounds into a query
 * string (an expanded year parsed as year 10000 plausibly returns an empty result set as a
 * SUCCESS, after which the run records an unwalked window as covered), and all three PR walks
 * hand-roll `since ? new Date(since) : null`, where an Invalid Date makes the `reachedSince` break
 * unreachable and the walk pages the whole PR history back as "the requested window".
 *
 * These are the predicate's own tests. The end-to-end half — that `fetchProviderData` refuses
 * before a single request reaches ANY provider, and before the PR walk as well as the commit walk
 * — is in `tests/connectors/git/future-author-dates.test.ts`.
 */
import {describe, it, expect} from 'vitest';
import {resolveCommitWindow} from '../../../../src/connectors/git/providers/window-bounds';

const VALID_SINCE = '2024-01-01T00:00:00.000Z';
const VALID_UNTIL = '2024-01-31T00:00:00.000Z';

describe('resolveCommitWindow', () => {
    it('parses a well-formed pair into the two Dates the in-memory walk compares against', () => {
        const window = resolveCommitWindow(VALID_SINCE, VALID_UNTIL);
        expect(window.since?.toISOString()).toBe(VALID_SINCE);
        expect(window.until?.toISOString()).toBe(VALID_UNTIL);
    });

    it('reads a BLANK bound as "no bound" rather than refusing it', () => {
        // Load-bearing, not lenient: `fetchProviderData` derives `since: ''` for a first sync with
        // no configured window, meaning walk everything. Refusing it would refuse every first sync.
        expect(resolveCommitWindow('', VALID_UNTIL)).toEqual({
            since: null,
            until: new Date(VALID_UNTIL),
        });
        expect(resolveCommitWindow('', '')).toEqual({since: null, until: null});
    });

    // BOTH refusal classes, per bound. The unparseable one is the obvious half; the EXPANDED YEAR
    // is the half a `Number.isNaN` check alone would miss, and it is the worse failure — it parses
    // to a finite instant in the future, so as a `since` it excludes every row while the run
    // reports success and advances the cursor over an entirely unwalked window.
    it.each([
        ['until', 'unparseable', 'not-a-date', VALID_SINCE, 'not-a-date'],
        ['since', 'unparseable', 'not-a-date', 'not-a-date', VALID_UNTIL],
        ['until', 'an expanded year', '+010000-01-01T00:00:00.000Z', VALID_SINCE, '+010000-01-01T00:00:00.000Z'],
        ['since', 'an expanded year', '+010000-01-01T00:00:00.000Z', '+010000-01-01T00:00:00.000Z', VALID_UNTIL],
    ] as const)('refuses the window when %s is %s', (label, _kind, offendingValue, since, until) => {
        const call = (): unknown => resolveCommitWindow(since, until);
        expect(call).toThrow(new RegExp(`"${label}"`));
        // THE REFUSAL CLASS, not just the bound name — without it half this table is green for the
        // wrong reason. An expanded-year `since` paired with an ordinary `until` is ALSO an
        // inverted window (year 10000 > 2024), and that guard's message names "since" too, so with
        // the shape pin deleted this row would still pass.
        expect(call).toThrow(/four-digit-year/);
        // The message names the state keys that hold the value and NEVER the value itself: it
        // reaches an operator terminal and `sync_logs.errors`, and the bounds are read from stored,
        // unvalidated `sync_state` rows. `(got: <value>)` is the obvious "make it debuggable" edit;
        // this is what stops it landing unnoticed. Asserted on the BAD operand only — the valid
        // partner could not appear either way, so asserting on it could not fail.
        expect(call).toThrow(/git_last_sync/);
        let message = '';
        try {
            call();
        } catch (e) {
            message = e instanceof Error ? e.message : String(e);
        }
        expect(message).not.toContain(offendingValue);
    });

    it('refuses an INVERTED window, where each bound is valid but the pair is impossible', () => {
        // The reachable half of the same defect (#304 review cycle 2). `catchUpUntil` clamps
        // `until` to `now` while `since` is whatever the cursor says, so a host clock that jumped
        // forward once — or a hand-edited `git_last_sync` — hands the run a window no commit can
        // satisfy. Unrefused, every walk returns empty as a SUCCESS and the run records the span
        // as covered. Nothing else here catches it: both bounds pass the shape check individually.
        expect(() => resolveCommitWindow(VALID_UNTIL, VALID_SINCE)).toThrow(/inverted/);
    });

    it('allows a window whose bounds are equal — an empty span is not an inverted one', () => {
        // `>` and not `>=` on the pair: a chunk whose bounds coincide asks for a zero-length span,
        // which is a legitimate no-op the cursor logic produces, not a corrupt cursor. Refusing it
        // would fail a run that is behaving correctly.
        expect(resolveCommitWindow(VALID_SINCE, VALID_SINCE)).toEqual({
            since: new Date(VALID_SINCE),
            until: new Date(VALID_SINCE),
        });
    });

    it('cannot invert against a blank bound, which is an absent one rather than an early instant', () => {
        // `''` byte-sorts below every instant, so a pair check written on the STRINGS would read
        // `('2024-…', '')` as inverted and refuse every first sync that has an upper bound.
        expect(() => resolveCommitWindow(VALID_SINCE, '')).not.toThrow();
        expect(() => resolveCommitWindow('', VALID_UNTIL)).not.toThrow();
    });
});
