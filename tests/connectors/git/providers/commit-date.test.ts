/**
 * #290 — the shared commit-date pin and its drop-reason classifier.
 *
 * `commit-date-contract.test.ts` proves every provider CALLS these through the real HTTP path;
 * this file pins what they decide, including the input classes a route-level fixture cannot
 * reasonably express (a non-string body value, a shape-valid but unparseable day).
 */
import {describe, it, expect} from 'vitest';
import {
    commitDropReason,
    isAttributableDate,
} from '../../../../src/connectors/git/providers/commit-date';
import {
    COMMIT_DROP_REASONS,
    NO_AUTHOR_DATE_DROP_REASON,
    UNATTRIBUTABLE_DATE_DROP_REASON,
} from '../../../../src/connectors/git/providers/types';

describe('COMMIT_DROP_REASONS', () => {
    it('keeps every reason distinct, so grouping cannot merge two operator next-steps', () => {
        // `formatLossGroups` (sync.ts) keys its groups on the reason STRING, so two members that
        // ever became equal — a copy-paste when a fourth is added beside the #304 one — would
        // silently fold two different "what do I do about this" answers into one advisory group
        // while every test comparing against the constants stayed green. Asserted over the whole
        // tuple rather than as a pair, so it also covers the member that does not exist yet.
        expect(new Set(COMMIT_DROP_REASONS).size).toBe(COMMIT_DROP_REASONS.length);
    });
});

describe('isAttributableDate', () => {
    it.each([
        ['a normal UTC instant', '2024-01-15T10:00:00.000Z'],
        ['a bare day with no time', '2024-01-15'],
        // Accepted deliberately: the store accepts it too, and rejecting it here would DROP a
        // commit the pipeline would have keyed (to the offset-local day, which is a small
        // mis-attribution rather than a loss).
        ['an offset instant', '2024-01-15T22:00:00-05:00'],
        // Same reasoning — calendar validity is not pinned at either boundary.
        ['a calendar-invalid but well-shaped day', '2024-02-30T00:00:00.000Z'],
    ])('accepts %s', (_label, value) => {
        expect(isAttributableDate(value)).toBe(true);
    });

    it('rejects an ISO expanded year — the value that bricks the run one frame down', () => {
        // `git commit --date=@999999999999`. It round-trips through `toISOString()` and parses
        // finitely, so ONLY the anchored day-shape conjunct rejects it.
        expect(isAttributableDate('+033658-09-27T01:46:39.000Z')).toBe(false);
    });

    it('rejects a well-shaped day that does not parse', () => {
        // `analyzer.ts` orders commits by `new Date(c.date).getTime()`; a NaN there makes the
        // comparator non-total. This is the one conjunct stricter than the store, and this is the
        // only input class that exercises it — the shape check alone would accept this string.
        expect(isAttributableDate('9999-99-99T00:00:00Z')).toBe(false);
    });

    it.each([
        ['undefined', undefined],
        ['null', null],
        ['an empty string', ''],
        ['a number', 1_705_312_800_000],
        // The coercion case the `typeof` guard exists for: `RegExp.test` stringifies its
        // argument, so a single-element array from an odd JSON body would match the day regex
        // and sail through without it.
        ['a single-element array of a valid date', ['2024-01-15T10:00:00.000Z']],
        ['a plain non-date string', 'not-a-date'],
    ])('rejects %s', (_label, value) => {
        expect(isAttributableDate(value)).toBe(false);
    });
});

describe('commitDropReason', () => {
    it('names the unusable-timestamp reason when a date string was present', () => {
        expect(commitDropReason('+033658-09-27T01:46:39.000Z')).toBe(
            UNATTRIBUTABLE_DATE_DROP_REASON,
        );
    });

    it.each([
        ['absent', undefined],
        ['null', null],
        ['blank', ''],
    ])('names the truncated-response reason when the date is %s', (_label, value) => {
        // `date: null` and `date: ''` are what a garbled body actually yields; calling those
        // "present but unattributable" would send the operator hunting for a real commit with an
        // odd timestamp.
        expect(commitDropReason(value)).toBe(NO_AUTHOR_DATE_DROP_REASON);
    });

    it.each([
        ['a number', 1_705_312_800_000],
        ['a single-element array', ['2024-01-15T10:00:00.000Z']],
    ])('names the unusable-timestamp reason for %s — the body DID carry a date', (_label, value) => {
        // The sibling block above proves `isAttributableDate` refuses these. They must not then be
        // classified as a truncated response: the payload is sitting right there with a date in
        // it, and sending the operator to look for a missing one inverts the only distinction the
        // two reasons draw. This is the arm a `typeof === 'string'` presence test gets wrong.
        expect(commitDropReason(value)).toBe(UNATTRIBUTABLE_DATE_DROP_REASON);
    });

    it('reports unusable when ANY consulted copy carried a date', () => {
        // GitHub holds two copies (detail response, list row) and consults both. If either had a
        // date, the commit is a real one with a timestamp this pipeline cannot key on — not a
        // truncated response — whichever copy it came from.
        expect(commitDropReason(undefined, '+033658-09-27T01:46:39.000Z')).toBe(
            UNATTRIBUTABLE_DATE_DROP_REASON,
        );
        expect(commitDropReason('+033658-09-27T01:46:39.000Z', undefined)).toBe(
            UNATTRIBUTABLE_DATE_DROP_REASON,
        );
    });

    it('reports the truncated-response reason only when EVERY copy is absent', () => {
        expect(commitDropReason(undefined, null)).toBe(NO_AUTHOR_DATE_DROP_REASON);
    });
});
