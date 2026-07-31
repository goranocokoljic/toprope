import {normalizeContainer} from '../connectors/git/providers/container';
import {GIT_PROVIDER_TYPES, type GitProviderType} from '../connectors/git/providers/types';

/**
 * Shared trust-boundary parsing for the git admin CLI commands (#286).
 *
 * `--provider` and `--container` arrive as arbitrary CLI strings on every one of these
 * commands, and each one has to make the same two decisions: is this provider type one that
 * exists, and is this container the value the write path actually persisted. Those decisions
 * were duplicated character-for-character between `./git-cache` and `./git-history-floor`,
 * including the operator-facing message strings — a second copy of an allowlist and its
 * vocabulary, which is the graduated "reuse the canonical helper instead of cloning shared
 * logic" rule. Two copies drift: a fourth provider type, or one improved message, and the two
 * commands start disagreeing about what a valid provider is called.
 */

/** A parsed argument, or the refusal to show the operator. Never throws. */
export type ParsedArg<T> = {ok: true; value: T} | {ok: false; message: string};

/**
 * Resolve `--provider` against the runtime allowlist.
 *
 * Runtime, not the compile-time union: the value arrives as an arbitrary CLI string, so the
 * union proves nothing here. An unrecognized one matches no row, and "0 rows affected" would
 * read as a fact about the store ("nothing was there") rather than as the typo it is.
 */
export function parseProviderType(raw: string): ParsedArg<GitProviderType> {
    const providerType = GIT_PROVIDER_TYPES.find((t) => t === raw);
    if (!providerType) {
        return {
            ok: false,
            message: `unknown provider type: ${raw} (expected one of: ${GIT_PROVIDER_TYPES.join(', ')})`,
        };
    }
    return {ok: true, value: providerType};
}

/**
 * Canonicalize `--container` the way the write path does.
 *
 * Through the SHARED `normalizeContainer` (#266), not a local `.trim()`: every stored container
 * — in `commit_diffstats` rows and in `git_last_sync:`/`git_earliest_sync:` keys alike — is
 * casefolded, so `--container " ACME "` must reach the rows filed under `acme` rather than
 * silently match nothing and have the miss reported as a state fact (the graduated #255 rule:
 * check and store the same normalized value).
 *
 * Total over `null`/`undefined` as well as a blank string: `normalizeContainer` maps all three
 * to `''`, which is refused. A blank that fell through would drop the term, and a dropped term
 * WIDENS.
 */
export function parseContainer(raw: string | undefined): ParsedArg<string> {
    const container = normalizeContainer(raw);
    if (container === '') {
        return {ok: false, message: '--container must not be empty'};
    }
    return {ok: true, value: container};
}
