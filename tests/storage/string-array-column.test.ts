/**
 * The shared JSON-string-array column codec (#289) — used by `sync_logs.errors` and
 * `git_providers.last_sync_advisories`.
 *
 * Both columns exist so that something REPORTED cannot vanish, which makes the decoder's
 * tolerance load-bearing rather than defensive padding: the cases below are the ones where a
 * naive `JSON.parse(...) as string[]` either throws (taking the whole surface down with it) or
 * hands back a non-array the caller then iterates.
 */
import {describe, it, expect} from 'vitest';
import {
    decodeStringArrayColumn,
    encodeStringArrayColumn,
} from '../../src/storage/string-array-column';

describe('encodeStringArrayColumn', () => {
    it('encodes a non-empty list as JSON', () => {
        expect(encodeStringArrayColumn(['a', 'b'])).toBe('["a","b"]');
    });

    it('encodes an empty list as NULL, not "[]"', () => {
        // The NULL-for-empty rule is what lets a reader test the column itself for "did the
        // last run report anything" without parsing. Two spellings of "nothing" would make
        // that test wrong for exactly one of them.
        expect(encodeStringArrayColumn([])).toBeNull();
    });

    it('round-trips through the decoder', () => {
        const lines = ['Commits dropped as unattributable: [github/api] 3', 'Unmatched: bot'];
        expect(decodeStringArrayColumn(encodeStringArrayColumn(lines) as string)).toEqual(lines);
    });
});

describe('decodeStringArrayColumn', () => {
    it('decodes a JSON array of strings', () => {
        expect(decodeStringArrayColumn('["x","y"]')).toEqual(['x', 'y']);
    });

    it('decodes an empty JSON array to an empty list', () => {
        // Reachable from a hand-written row even though the encoder never produces it.
        expect(decodeStringArrayColumn('[]')).toEqual([]);
    });

    it('surfaces an unparseable blob as its raw text rather than throwing or dropping it', () => {
        expect(decodeStringArrayColumn('not json at all')).toEqual(['not json at all']);
    });

    it('surfaces valid JSON that is not an array as its raw text', () => {
        // The case a bare cast gets wrong most quietly: `JSON.parse` succeeds, and the caller
        // then iterates an object as if it were a list of lines.
        expect(decodeStringArrayColumn('{"errors":["a"]}')).toEqual(['{"errors":["a"]}']);
        expect(decodeStringArrayColumn('"a bare string"')).toEqual(['"a bare string"']);
        expect(decodeStringArrayColumn('null')).toEqual(['null']);
    });

    it('coerces non-string array members instead of leaking them to a string consumer', () => {
        expect(decodeStringArrayColumn('[1,null,true]')).toEqual(['1', 'null', 'true']);
    });
});
